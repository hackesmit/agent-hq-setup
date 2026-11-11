// The incremental hasher must agree with the platform digest, byte for byte, whatever the
// chunk boundaries are: the server rejects an upload whose bytes do not match the declared
// sha256, so a hasher that is wrong at a block boundary would silently break every upload
// over 64 bytes (bead hq-prru).

import { describe, expect, it } from "vitest";
import { hashStream, Sha256, sha256Hex } from "../now/sha256";

async function platformHex(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", view.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pattern(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (i * 31 + (i >> 3)) & 0xff;
  return bytes;
}

function chunk(bytes: Uint8Array, sizes: number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  let i = 0;
  while (at < bytes.length) {
    const size = Math.max(1, sizes[i % sizes.length]!);
    out.push(bytes.subarray(at, Math.min(bytes.length, at + size)));
    at += size;
    i += 1;
  }
  return out;
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]!);
      index += 1;
    },
  });
}

describe("Sha256", () => {
  it("matches the known empty-input digest", async () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex(new Uint8Array(0))).toBe(await platformHex(new Uint8Array(0)));
  });

  it("matches the platform digest for the classic vector", async () => {
    const abc = new TextEncoder().encode("abc");
    expect(sha256Hex(abc)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(abc)).toBe(await platformHex(abc));
  });

  it("is independent of chunk boundaries around the 64-byte block", async () => {
    const bytes = pattern(700);
    const expected = await platformHex(bytes);
    for (const sizes of [[1], [3], [7, 13], [63], [64], [65], [100, 1], [512]]) {
      const hasher = new Sha256();
      for (const part of chunk(bytes, sizes)) hasher.update(part);
      expect(hasher.hex(), `chunk sizes ${sizes.join(",")}`).toBe(expected);
    }
  });

  it("handles the padding edge cases (55, 56, 57, 63, 64, 65 bytes)", async () => {
    for (const length of [55, 56, 57, 63, 64, 65, 119, 120, 128]) {
      const bytes = pattern(length);
      expect(sha256Hex(bytes), `length ${length}`).toBe(await platformHex(bytes));
    }
  });

  it("refuses to be reused after a digest", () => {
    const hasher = new Sha256().update(new TextEncoder().encode("x"));
    hasher.hex();
    expect(() => hasher.update(new Uint8Array([1]))).toThrow(/after digest/);
  });
});

describe("hashStream", () => {
  it("equals the digest of the whole buffer and reports the size", async () => {
    const bytes = pattern(200_000);
    const expected = await platformHex(bytes);
    const seen: number[] = [];
    const result = await hashStream(streamOf(chunk(bytes, [65_536])), (read) => seen.push(read));
    expect(result.hex).toBe(expected);
    expect(result.size).toBe(bytes.length);
    expect(seen.at(-1)).toBe(bytes.length);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it("hashes an empty stream", async () => {
    const result = await hashStream(streamOf([]));
    expect(result.size).toBe(0);
    expect(result.hex).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(hashStream(streamOf(chunk(pattern(1000), [100])), undefined, controller.signal)).rejects.toThrow(
      /cancelled/,
    );
  });
});
