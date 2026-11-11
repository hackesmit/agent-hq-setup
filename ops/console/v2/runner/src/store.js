// Session records on disk: /var/lib/hqconsole/state/runner.json.
//
// This is a record, not a resurrection mechanism. A PTY cannot outlive the
// process that owns its master fd, so sessions do not survive a runner
// restart; what survives is the fact that they existed, how they ended, and
// where their log is. The console shows that, and the drain protocol (not this
// file) is how the runner is updated without ending a session.
//
// Store compatibility (release/README.md): expand-then-contract. Add fields
// with defaults, never rename or repurpose one, so a rollback still reads it.

import fs from "node:fs";
import path from "node:path";

export const STORE_VERSION = 1;

export class Store {
  /** @param {{file: string, log?: Function}} opts */
  constructor(opts) {
    this.file = opts.file;
    this.log = opts.log || (() => {});
  }

  /** @returns {{version: number, release: string|null, updatedAt: string|null, sessions: any[]}} */
  load() {
    const empty = { version: STORE_VERSION, release: null, updatedAt: null, sessions: [], meta: [], terms: [] };
    let raw;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return empty;
    }
    try {
      const j = JSON.parse(raw);
      if (!j || typeof j !== "object") return empty;
      return {
        version: Number(j.version) || STORE_VERSION,
        release: typeof j.release === "string" ? j.release : null,
        updatedAt: typeof j.updatedAt === "string" ? j.updatedAt : null,
        sessions: Array.isArray(j.sessions) ? j.sessions : [],
        meta: Array.isArray(j.meta) ? j.meta : [],
        terms: Array.isArray(j.terms) ? j.terms : [],
      };
    } catch (e) {
      // A corrupt record must not stop the daemon from serving terminals.
      this.log(`state file unreadable, starting empty: ${e && e.message}`);
      return empty;
    }
  }

  /** Atomic: write a sibling temp file, fsync, rename. */
  save(snapshot) {
    const dir = path.dirname(this.file);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    } catch {
      /* already there, or not ours to create */
    }
    const body =
      JSON.stringify(
        {
          version: STORE_VERSION,
          release: snapshot.release || null,
          updatedAt: new Date().toISOString(),
          sessions: snapshot.sessions || [],
          meta: snapshot.meta || [],
          // Persistent console terminals (tmux-hosted): the records that let a
          // restarted runner re-attach to, or resume, every live terminal.
          terms: snapshot.terms || [],
        },
        null,
        1,
      ) + "\n";
    const tmp = `${this.file}.tmp.${process.pid}`;
    let fd;
    try {
      fd = fs.openSync(tmp, "w", 0o640);
      fs.writeFileSync(fd, body);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, this.file);
      return true;
    } catch (e) {
      this.log(`could not persist state: ${e && e.message}`);
      try {
        if (fd !== undefined) fs.closeSync(fd);
        fs.unlinkSync(tmp);
      } catch {
        /* nothing to clean */
      }
      return false;
    }
  }
}

/**
 * The release pin file (releases/.pinned, one sha per line) keeps activate.sh
 * from pruning a release a running runner still executes. Adding and removing
 * our own line is a read-modify-write; nothing else writes this file.
 */
export function pinRelease(file, sha, log = () => {}) {
  if (!sha || sha === "dev") return false;
  return rewritePins(file, (shas) => (shas.includes(sha) ? shas : [...shas, sha]), log);
}

export function unpinRelease(file, sha, log = () => {}) {
  if (!sha || sha === "dev") return false;
  return rewritePins(file, (shas) => shas.filter((s) => s !== sha), log);
}

function rewritePins(file, fn, log) {
  let shas = [];
  try {
    shas = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    /* no pins yet */
  }
  const next = fn(shas);
  try {
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, next.length ? next.join("\n") + "\n" : "", { mode: 0o644 });
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    log(`could not update the release pin file: ${e && e.message}`);
    return false;
  }
}
