// Uploads: admission control.
//
// Design section 6: "Admission is serialised and does not trust
// client-declared sizes: at most 2 uploads stream concurrently, each reserves
// the full per-file maximum (200 MB) against the quota and the free-space
// floor under a lock before streaming, bytes are counted as they arrive and
// the stream aborts the moment the reservation would be exceeded, the
// reservation is released on completion or failure, and the quota is
// rechecked under the same lock before commit."
//
// The lock is JavaScript's run-to-completion: every check here is synchronous
// (sqlite is sync, statfs is sync), so no two requests can interleave between
// reading the counters and reserving against them. Nothing in this file may
// become async without introducing a real mutex.

/** @typedef {{ok: true, size: number, release: (finalSize?: number) => void}} Grant */

export class Admission {
  /**
   * @param {{
   *   maxFile: number, concurrency: number, quota: number, freeFloor: number,
   *   dir: string, store: {liveBytes: () => number}, statfs: (dir: string) => {bavail: number, bsize: number},
   *   retryAfterSec?: number,
   * }} opts
   */
  constructor(opts) {
    this.maxFile = opts.maxFile;
    this.concurrency = opts.concurrency;
    this.quota = opts.quota;
    this.freeFloor = opts.freeFloor;
    this.dir = opts.dir;
    this.store = opts.store;
    this.statfs = opts.statfs;
    this.retryAfterSec = opts.retryAfterSec || 5;
    /** @type {Set<object>} */
    this.active = new Set();
  }

  /** Bytes reserved by in-flight requests: the full per-file max each. */
  get reserved() {
    let total = 0;
    for (const g of this.active) total += g.reserved;
    return total;
  }

  freeBytes() {
    const st = this.statfs(this.dir);
    if (!st) return Infinity;
    return Number(st.bavail) * Number(st.bsize);
  }

  /**
   * Reserve the full per-file maximum. Returns a grant or a refusal carrying
   * the HTTP status the handler should answer with.
   * @returns {{ok: true, grant: object} | {ok: false, status: number, error: string, headers?: Record<string,string>}}
   */
  acquire() {
    if (this.active.size >= this.concurrency) {
      return {
        ok: false,
        status: 503,
        error: `too many concurrent uploads (limit ${this.concurrency})`,
        headers: { "retry-after": String(this.retryAfterSec) },
      };
    }
    const verdict = this.check(this.maxFile);
    if (!verdict.ok) return verdict;
    const grant = { reserved: this.maxFile, released: false };
    this.active.add(grant);
    return { ok: true, grant };
  }

  /**
   * The same quota and free-floor arithmetic used for the reservation and for
   * the recheck before commit. `extra` is the bytes about to be added on top
   * of everything already reserved by other in-flight uploads.
   */
  check(extra, self) {
    const live = this.store.liveBytes();
    let reserved = 0;
    for (const g of this.active) if (g !== self) reserved += g.reserved;
    if (live + reserved + extra > this.quota) {
      return {
        ok: false,
        status: 507,
        error: `inbox quota exceeded (${live + reserved + extra} bytes of ${this.quota})`,
      };
    }
    const free = this.freeBytes();
    if (free - reserved - extra < this.freeFloor) {
      return {
        ok: false,
        status: 507,
        error: `free space floor reached (${free} bytes free, floor ${this.freeFloor})`,
      };
    }
    return { ok: true };
  }

  /** Rechecked under the same lock before the commit, with the real size. */
  recheck(grant, actualSize) {
    return this.check(actualSize, grant);
  }

  release(grant) {
    if (!grant || grant.released) return;
    grant.released = true;
    this.active.delete(grant);
  }
}

/** Real free space; injectable so the tests can simulate a full disk. */
export function realStatfs(fsMod) {
  return (dir) => {
    try {
      const st = fsMod.statfsSync(dir);
      return { bavail: st.bavail, bsize: st.bsize };
    } catch {
      return null; // an unreadable filesystem must not block uploads outright
    }
  };
}
