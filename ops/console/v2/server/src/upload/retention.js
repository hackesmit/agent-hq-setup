// Uploads: lifecycle. The row is forever (it is the idempotency record), the
// bytes are not.
//
// Design section 6: "Uploads are retained for 30 days by default (per-file
// 'keep' pins one indefinitely), the console offers delete and 'keep' on each
// entry, and expiry or deletion removes the file and marks the row {deleted,
// when} (the id then answers a retry with 'gone', never a silent re-upload),
// so the 5 GB quota counts only live files and the inbox never becomes
// permanently read-only."

import path from "node:path";

import { UploadState } from "./store.js";
import { rewriteManifest, unlinkSafe } from "./paths.js";
import { refFor } from "./refs.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function createRetention(ctx) {
  const { store, paths, log, now, limits } = ctx;

  function retentionMs() {
    return limits.retentionDays * DAY_MS;
  }

  /** null when pinned: a kept file has no expiry. */
  function expiresAt(row) {
    if (!row || row.keep) return null;
    if (!row.committedAt) return null;
    return new Date(Date.parse(row.committedAt) + retentionMs()).toISOString();
  }

  /** @returns {import("../../../shared/api.js").UploadEntry} */
  function entryOf(row) {
    return {
      id: row.id,
      name: row.name,
      // The stable way to cite this file. `path` is still here because the FILES IN card
      // shows it and the owner copies it, but a ref is what belongs in a bead, a note or a
      // worker seed: it survives the bytes being swept and it resolves through a gate.
      ref: refFor(row.id),
      path: row.path,
      size: Number(row.size),
      sha256: row.sha256,
      committedAt: row.committedAt,
      keep: Boolean(row.keep),
      expiresAt: expiresAt(row),
    };
  }

  function refreshManifest() {
    try {
      rewriteManifest(paths.manifest, store.listCommitted());
    } catch (e) {
      log(`manifest rewrite failed: ${e && e.message} (boot will rebuild it)`);
    }
  }

  /** Remove the bytes, mark the row deleted. Shared by delete and expiry. */
  function drop(row, reason) {
    if (row.path) unlinkSafe(row.path);
    const out = store.markDeleted(row.id, reason);
    return out;
  }

  function list(dateStr) {
    const day = dateStr || null;
    const rows = day ? store.listDay(day) : store.listCommitted();
    return rows.map(entryOf);
  }

  function setKeep(id, keep) {
    const row = store.get(id);
    if (!row) return { ok: false, status: 404, error: "no such upload" };
    if (row.state !== UploadState.committed) {
      return { ok: false, status: row.state === UploadState.deleted ? 410 : 409, error: `upload is ${row.state}` };
    }
    const updated = store.setKeep(id, keep);
    return { ok: true, entry: entryOf(updated) };
  }

  function remove(id) {
    const row = store.get(id);
    if (!row) return { ok: false, status: 404, error: "no such upload" };
    if (row.state === UploadState.deleted) return { ok: false, status: 410, error: "upload was already deleted" };
    if (row.state !== UploadState.committed) return { ok: false, status: 409, error: `upload is ${row.state}` };
    drop(row, "deleted from the console");
    refreshManifest();
    log(`upload ${id} deleted (${path.basename(String(row.path))})`);
    return { ok: true };
  }

  /** Expiry sweep: unpinned committed rows past the retention window. */
  function sweep() {
    const cutoff = new Date(now() - retentionMs()).toISOString();
    const expired = store.listExpired(cutoff);
    for (const row of expired) drop(row, `expired after ${limits.retentionDays} days`);
    if (expired.length) {
      refreshManifest();
      log(`uploads retention: ${expired.length} expired`);
    }
    return { expired: expired.length };
  }

  return { list, setKeep, remove, sweep, entryOf, expiresAt };
}
