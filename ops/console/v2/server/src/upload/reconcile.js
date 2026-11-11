// Uploads: the boot reconcile.
//
// Design section 6 fixes the ordering so that every crash window is
// recoverable, and this is the code that recovers them. It runs once, on the
// real server's real start (never in --check), and it runs in BOTH directions:
//
//   table -> disk : a committed row whose file is gone becomes a deleted row
//                   plus a card (someone deleted it outside the console).
//   disk  -> table: a final file with no committed row is matched to its
//                   sidecar by the recorded final path, re-hashed, and
//                   committed; without a sidecar it is quarantined with a card
//                   rather than guessed at.
//   manifest      : rebuilt from the table, which drops lines whose file is
//                   missing or size-mismatched and adds lines a crash lost.
//
// Every in-progress row is abandoned at boot by definition: the request that
// owned it cannot have survived the restart.

import fs from "node:fs";
import path from "node:path";

import { UploadState } from "./store.js";
import {
  SIDECAR_SUFFIX,
  exists,
  hashFileSync,
  readJson,
  rewriteManifest,
  statOrNull,
  unlinkSafe,
  walkFiles,
} from "./paths.js";

/** Stale .tmp entries older than this are swept at boot (design section 6). */
export const TMP_SWEEP_MS = 60 * 60 * 1000;

export function createReconcile(ctx) {
  const { store, paths, alerts, log, now } = ctx;

  function card(id, title, detail, severity = "P1") {
    if (!alerts) return;
    alerts.add({ id, severity, title, detail, source: "uploads" });
  }

  /** Every sidecar on disk, indexed by the final path it intended. */
  function sidecarIndex() {
    const byFinal = new Map();
    const byUuid = new Map();
    let entries = [];
    try {
      entries = fs.readdirSync(paths.tmpDir);
    } catch {
      return { byFinal, byUuid };
    }
    for (const e of entries) {
      if (!e.endsWith(SIDECAR_SUFFIX)) continue;
      const file = path.join(paths.tmpDir, e);
      const rec = readJson(file);
      if (!rec || !rec.finalPath) continue;
      rec.__file = file;
      rec.__uuid = e.slice(0, -SIDECAR_SUFFIX.length);
      byFinal.set(path.resolve(rec.finalPath), rec);
      byUuid.set(rec.__uuid, rec);
    }
    return { byFinal, byUuid };
  }

  /**
   * Commit a row from a file that is already linked. Used for the "crashed
   * after link, before the row commit" window and for orphan adoption.
   * @returns {boolean} true when the row was committed
   */
  function adopt(row, finalPath, side) {
    const st = statOrNull(finalPath);
    if (!st) return false;
    if (Number(side.size) !== st.size) {
      card(
        `upload-size-${row.id}`,
        "Recovered upload has the wrong size",
        `${finalPath}: sidecar says ${side.size} bytes, the file is ${st.size}. Left in place for inspection.`,
      );
      return false;
    }
    const sha = hashFileSync(finalPath);
    if (sha !== side.sha256) {
      card(
        `upload-hash-${row.id}`,
        "Recovered upload failed its hash check",
        `${finalPath}: sidecar says ${side.sha256}, the file hashes to ${sha}. Left in place for inspection.`,
      );
      return false;
    }
    store.commit({
      id: row.id,
      name: side.name || path.basename(finalPath),
      path: finalPath,
      day: side.day || path.basename(path.dirname(finalPath)),
      size: st.size,
      sha256: sha,
      committedAt: side.ts || new Date(now()).toISOString(),
    });
    return true;
  }

  function run() {
    const report = {
      inProgress: 0,
      recovered: 0,
      failed: 0,
      orphansAdopted: 0,
      quarantined: 0,
      missingFiles: 0,
      tmpSwept: 0,
      manifestLines: 0,
    };
    const side = sidecarIndex();

    // 1. In-progress rows: nobody owns them after a restart.
    for (const row of store.listInProgress()) {
      report.inProgress++;
      const rec = row.tmpUuid ? side.byUuid.get(row.tmpUuid) : null;
      if (rec && exists(rec.finalPath) && adopt(row, path.resolve(rec.finalPath), rec)) {
        report.recovered++;
        side.byFinal.delete(path.resolve(rec.finalPath));
        unlinkSafe(rec.__file);
        if (row.tmpUuid) unlinkSafe(paths.tmpFile(row.tmpUuid));
        continue;
      }
      // Nothing was linked (or it did not verify): drop the temp bytes, keep
      // the id. A sidecar whose final file exists is kept: step 3 still needs
      // it, and a file that failed verification must stay inspectable.
      if (row.tmpUuid) unlinkSafe(paths.tmpFile(row.tmpUuid));
      if (rec && !exists(rec.finalPath)) unlinkSafe(rec.__file);
      store.fail(row.id, "abandoned at boot");
      report.failed++;
    }

    // 2. Committed rows whose file vanished (a manual rm outside the console).
    const committed = store.listCommitted();
    const known = new Set();
    for (const row of committed) {
      if (!row.path) continue;
      const st = statOrNull(row.path);
      if (!st) {
        store.markDeleted(row.id, "file missing at boot");
        report.missingFiles++;
        card(
          `upload-missing-${row.id}`,
          "Uploaded file disappeared",
          `${row.path} is recorded as committed but is not on disk. The row is now marked deleted; a retry of that id answers "gone".`,
          "P2",
        );
        continue;
      }
      if (st.size !== Number(row.size)) {
        card(
          `upload-drift-${row.id}`,
          "Uploaded file changed on disk",
          `${row.path}: the record says ${row.size} bytes, the file is ${st.size}. Something outside the console wrote to the inbox.`,
        );
      }
      known.add(path.resolve(row.path));
      // A late sidecar (crash between the row commit and the sidecar removal).
      const rec = side.byFinal.get(path.resolve(row.path));
      if (rec) {
        unlinkSafe(rec.__file);
        if (rec.__uuid) unlinkSafe(paths.tmpFile(rec.__uuid));
        side.byFinal.delete(path.resolve(row.path));
      }
    }

    // 3. Final files with no committed row: adopt from the sidecar or quarantine.
    for (const file of walkFiles(paths.filesDir)) {
      const abs = path.resolve(file);
      if (known.has(abs)) continue;
      const rec = side.byFinal.get(abs);
      if (rec && rec.uploadId) {
        const row = store.get(rec.uploadId);
        if (row && row.state !== UploadState.committed && row.state !== UploadState.deleted) {
          // The row exists but was failed in step 1 before we saw the file;
          // re-claim it so the adopt path can commit it.
          const reclaimed = store.claim({
            id: rec.uploadId,
            declaredSize: Number(rec.size),
            declaredSha: String(rec.sha256),
            note: rec.note,
            staleMs: -1,
          });
          if (reclaimed.outcome === "claimed" && adopt(reclaimed.row, abs, rec)) {
            report.orphansAdopted++;
            report.recovered++;
            known.add(abs);
            unlinkSafe(rec.__file);
            if (rec.__uuid) unlinkSafe(paths.tmpFile(rec.__uuid));
            continue;
          }
        }
      }
      report.quarantined++;
      card(
        `upload-orphan-${abs}`,
        "Unmatched file in the inbox",
        `${abs} has no upload record and no sidecar to recover from. It was left in place; move or delete it by hand.`,
      );
    }

    // 4. Stale .tmp entries: anything older than an hour that no live row owns.
    const cutoff = now() - TMP_SWEEP_MS;
    let tmpEntries = [];
    try {
      tmpEntries = fs.readdirSync(paths.tmpDir);
    } catch {
      tmpEntries = [];
    }
    const liveUuids = new Set(store.listInProgress().map((r) => r.tmpUuid).filter(Boolean));
    for (const e of tmpEntries) {
      const uuid = e.endsWith(SIDECAR_SUFFIX) ? e.slice(0, -SIDECAR_SUFFIX.length) : e;
      if (liveUuids.has(uuid)) continue;
      const file = path.join(paths.tmpDir, e);
      const st = statOrNull(file);
      if (!st || st.mtimeMs > cutoff) continue;
      if (unlinkSafe(file)) report.tmpSwept++;
    }

    // 5. The manifest is derived: rebuild it from the table.
    const rows = store.listCommitted();
    rewriteManifest(paths.manifest, rows);
    report.manifestLines = rows.length;

    log(
      `uploads reconcile: ${report.recovered} recovered, ${report.failed} abandoned, ` +
        `${report.orphansAdopted} adopted, ${report.quarantined} quarantined, ` +
        `${report.missingFiles} missing, ${report.tmpSwept} temp files swept`,
    );
    return report;
  }

  return { run };
}
