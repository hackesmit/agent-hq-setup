// Per-session replay buffer: the last N bytes of terminal output, in memory.
//
// Interactive and meta streams are never written to disk (design section 3: a
// PTY stream echoes keystrokes, so a pasted token would land in a file), so
// this is the only replay they have. Worker output is also appended to
// <RUNNER_TERM_DIR>/<sid>.log; the ring is still what an attach replays,
// because reading the tail of a file on every attach is slower and racy.

/**
 * Chunks are kept whole and dropped from the front, so replay never splits a
 * UTF-8 sequence. Only the oldest surviving chunk is ever sliced, and the
 * slice is repaired if it lands on a lone surrogate half.
 */
export class Ring {
  /** @param {number} limit bytes */
  constructor(limit) {
    this.limit = Math.max(1024, Number(limit) || 256 * 1024);
    /** @type {{s: string, n: number}[]} */
    this.chunks = [];
    this.bytes = 0;
    this.totalBytes = 0;
  }

  push(str) {
    const s = String(str);
    if (!s) return;
    const n = Buffer.byteLength(s, "utf8");
    this.chunks.push({ s, n });
    this.bytes += n;
    this.totalBytes += n;
    while (this.bytes > this.limit && this.chunks.length > 1) {
      const drop = this.chunks.shift();
      this.bytes -= drop.n;
    }
    if (this.bytes > this.limit && this.chunks.length === 1) {
      // one oversized chunk: keep its tail
      const only = this.chunks[0];
      const keep = tailBytes(only.s, this.limit);
      this.chunks[0] = { s: keep, n: Buffer.byteLength(keep, "utf8") };
      this.bytes = this.chunks[0].n;
    }
  }

  toString() {
    return this.chunks.map((c) => c.s).join("");
  }

  clear() {
    this.chunks = [];
    this.bytes = 0;
  }
}

/** Last `limit` bytes of a string, never starting on a lone low surrogate. */
function tailBytes(s, limit) {
  const b = Buffer.from(s, "utf8");
  if (b.length <= limit) return s;
  // toString on a mid-sequence start yields replacement chars, which is fine
  // for a terminal replay; the surrogate repair below covers the JS side.
  let out = b.subarray(b.length - limit).toString("utf8");
  const first = out.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) out = out.slice(1);
  return out;
}
