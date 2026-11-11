// Incremental SHA-256 over a file's stream.
//
// The upload contract (design doc section 6) wants the sha256 in a request header BEFORE
// any byte is sent, and Web Crypto has no streaming digest: crypto.subtle.digest takes one
// buffer, which for a 200 MB file on a phone means 200 MB of memory. So the hash is folded
// chunk by chunk over file.stream(); arrayBuffer() is never called on an upload.
//
// The implementation is the plain FIPS 180-4 compression function. It is verified against
// crypto.subtle.digest in src/__tests__/now-hash.test.ts, chunk boundaries included.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const HEX = "0123456789abcdef";

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

export class Sha256 {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  private readonly block = new Uint8Array(64);
  private readonly w = new Uint32Array(64);
  private held = 0;
  private total = 0;
  private finished = false;

  /** Fold one chunk in. Chunk boundaries are irrelevant to the result. */
  update(chunk: Uint8Array): this {
    if (this.finished) throw new Error("sha256: update after digest");
    this.total += chunk.length;

    let offset = 0;
    if (this.held > 0) {
      const want = Math.min(64 - this.held, chunk.length);
      this.block.set(chunk.subarray(0, want), this.held);
      this.held += want;
      offset = want;
      if (this.held === 64) {
        this.compress(this.block, 0);
        this.held = 0;
      }
    }

    while (offset + 64 <= chunk.length) {
      this.compress(chunk, offset);
      offset += 64;
    }

    if (offset < chunk.length) {
      this.block.set(chunk.subarray(offset), 0);
      this.held = chunk.length - offset;
    }
    return this;
  }

  /** Lowercase hex digest. The hasher is single-use after this. */
  hex(): string {
    if (!this.finished) {
      this.finish();
      this.finished = true;
    }
    let out = "";
    for (let i = 0; i < 8; i += 1) {
      const word = this.h[i]!;
      for (let shift = 28; shift >= 0; shift -= 4) {
        out += HEX[(word >>> shift) & 0xf];
      }
    }
    return out;
  }

  private finish(): void {
    const bytes = this.total;
    // Length is in BITS, and a 200 MB file overflows 32 bits once multiplied by 8, so the
    // high word is computed by division rather than by a shift.
    const high = Math.floor(bytes / 0x20000000);
    const low = (bytes % 0x20000000) * 8;

    this.block[this.held] = 0x80;
    this.held += 1;
    if (this.held > 56) {
      this.block.fill(0, this.held);
      this.compress(this.block, 0);
      this.held = 0;
    }
    this.block.fill(0, this.held, 56);
    const view = new DataView(this.block.buffer, this.block.byteOffset, 64);
    view.setUint32(56, high >>> 0, false);
    view.setUint32(60, low >>> 0, false);
    this.compress(this.block, 0);
    this.held = 0;
  }

  private compress(source: Uint8Array, offset: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i += 1) {
      const at = offset + i * 4;
      w[i] =
        ((source[at]! << 24) | (source[at + 1]! << 16) | (source[at + 2]! << 8) | source[at + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = this.h[0]!;
    let b = this.h[1]!;
    let c = this.h[2]!;
    let d = this.h[3]!;
    let e = this.h[4]!;
    let f = this.h[5]!;
    let g = this.h[6]!;
    let h = this.h[7]!;

    for (let i = 0; i < 64; i += 1) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    this.h[0] = (this.h[0]! + a) >>> 0;
    this.h[1] = (this.h[1]! + b) >>> 0;
    this.h[2] = (this.h[2]! + c) >>> 0;
    this.h[3] = (this.h[3]! + d) >>> 0;
    this.h[4] = (this.h[4]! + e) >>> 0;
    this.h[5] = (this.h[5]! + f) >>> 0;
    this.h[6] = (this.h[6]! + g) >>> 0;
    this.h[7] = (this.h[7]! + h) >>> 0;
  }
}

/** Convenience for tests and small buffers. */
export function sha256Hex(bytes: Uint8Array): string {
  return new Sha256().update(bytes).hex();
}

export interface HashProgress {
  (bytesRead: number): void;
}

/**
 * Hash a readable byte stream incrementally. Reports bytes read so the UI can show a
 * hashing bar for a large file, which on a phone takes long enough to look stuck.
 */
export async function hashStream(
  stream: ReadableStream<Uint8Array>,
  onProgress?: HashProgress,
  signal?: AbortSignal,
): Promise<{ hex: string; size: number }> {
  const hasher = new Sha256();
  const reader = stream.getReader();
  let size = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new Error("hashing cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      hasher.update(value);
      size += value.byteLength;
      onProgress?.(size);
    }
  } finally {
    reader.releaseLock();
  }
  return { hex: hasher.hex(), size };
}

/** Hash a File/Blob over file.stream(); never arrayBuffer() (design doc section 6). */
export async function hashFile(
  file: Blob,
  onProgress?: HashProgress,
  signal?: AbortSignal,
): Promise<{ hex: string; size: number }> {
  if (typeof file.stream !== "function") {
    throw new Error("this browser cannot stream files; upload is disabled");
  }
  return hashStream(file.stream() as ReadableStream<Uint8Array>, onProgress, signal);
}
