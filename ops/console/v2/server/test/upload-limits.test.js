// Uploads: the limits. Header validation, size overrun, hash mismatch, the
// inbox quota, the free-space floor and the concurrency cap. Every refusal
// must leave the inbox exactly as it found it.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { dayOf } from "../src/upload/index.js";
import { GB, MB, begin, bytes, listDir, sha256, startUploads, until, upload } from "./upload-harness.js";

function inboxEmpty(h) {
  assert.deepEqual(listDir(path.join(h.dir, ".tmp")), [], "no temp file left behind");
  assert.deepEqual(listDir(path.join(h.dir, "files", dayOf(h.clock.ms))), [], "no file left behind");
  assert.equal(h.uploads.admission.active.size, 0, "the reservation was released");
  assert.equal(h.uploads.store.liveBytes(), 0, "the quota is unchanged");
}

test("missing or malformed headers are 400 before anything is touched", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const content = bytes(64);

  assert.equal((await upload(h, { id: null, content })).status, 400);
  assert.equal((await upload(h, { size: null, content })).status, 400);
  assert.equal((await upload(h, { sha: null, content })).status, 400);
  assert.equal((await upload(h, { id: "bad id!", content })).status, 400);
  assert.equal((await upload(h, { sha: "nothex", content })).status, 400);
  assert.equal((await upload(h, { size: "0", content })).status, 400);
  assert.equal((await upload(h, { size: "-5", content })).status, 400);
  const badType = await upload(h, { content, headers: { "content-type": "application/json" } });
  assert.equal(badType.status, 400);
  assert.equal(h.uploads.stats.bytesRead, 0);
  inboxEmpty(h);
});

test("a declared size over the per-file maximum is 413 with no bytes read", async (t) => {
  const h = await startUploads({ limits: { maxFile: 1024 } });
  t.after(() => h.close());
  const content = bytes(2048);

  const res = await upload(h, { id: "big-1", content });
  assert.equal(res.status, 413);
  assert.match(res.json.error, /too large/);
  assert.equal(h.uploads.stats.bytesRead, 0);
  assert.equal(h.uploads.store.get("big-1"), null, "no row is created for a rejected header");
  inboxEmpty(h);
});

test("a client that sends more than it declared is aborted at 413 and cleaned up", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const content = bytes(8192, 0x41);

  // declares 100 bytes, sends 8192
  const res = await upload(h, { id: "over-1", content, size: 100, sha: sha256(content.subarray(0, 100)) });
  assert.equal(res.status, 413);
  assert.match(res.json.error, /exceeded/);
  assert.equal(h.uploads.store.get("over-1").state, "failed");
  inboxEmpty(h);
});

test("a client that lies about the hash fails its own upload at 400", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const content = bytes(512, 0x42);

  const res = await upload(h, { id: "lie-1", content, sha: "b".repeat(64) });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /sha256 mismatch/);
  assert.equal(h.uploads.store.get("lie-1").state, "failed");
  inboxEmpty(h);

  // the id is reusable once the client sends what it promised
  const good = await upload(h, { id: "lie-1", content });
  assert.equal(good.status, 201);
});

test("a short body is a 400 size mismatch, not a truncated file", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const content = bytes(64, 0x43);

  const res = await upload(h, { id: "short-1", content, size: 1000, sha: sha256(content) });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /size mismatch/);
  inboxEmpty(h);
});

test("the inbox quota answers 507 and reserves the full per-file maximum", async (t) => {
  // quota 3.5 MB, per-file max 1 MB: three committed files plus one FULL
  // reservation (not the tiny declared size) overshoot it, so the fourth
  // upload is refused before a byte is read even though it is 16 bytes long.
  const h = await startUploads({ limits: { maxFile: 1 * MB, quota: 3.5 * MB } });
  t.after(() => h.close());

  for (let i = 1; i <= 3; i++) {
    const res = await upload(h, { id: `q-${i}`, name: `f${i}.bin`, content: bytes(1 * MB, 0x40 + i) });
    assert.equal(res.status, 201, `upload ${i}`);
  }
  assert.equal(h.uploads.store.liveBytes(), 3 * MB);

  const full = await upload(h, { id: "q-4", name: "tiny.bin", content: bytes(16) });
  assert.equal(full.status, 507);
  assert.match(full.json.error, /quota/);
  assert.equal(h.uploads.store.liveBytes(), 3 * MB);
  assert.deepEqual(listDir(path.join(h.dir, ".tmp")), []);

  // deleting one frees the room again: the inbox never becomes read-only
  assert.equal(h.uploads.remove("q-1").ok, true);
  const after = await upload(h, { id: "q-5", name: "tiny.bin", content: bytes(16) });
  assert.equal(after.status, 201);
});

test("the free-space floor answers 507 and is checked before any byte", async (t) => {
  const h = await startUploads({ limits: { freeFloor: 10 * GB }, free: 10 * GB + 512 * 1024 });
  t.after(() => h.close());

  const res = await upload(h, { id: "fs-1", content: bytes(64) });
  assert.equal(res.status, 507);
  assert.match(res.json.error, /free space/);
  assert.equal(h.uploads.stats.bytesRead, 0);
  inboxEmpty(h);

  // room appears, the same id works
  h.state.free = 100 * GB;
  assert.equal((await upload(h, { id: "fs-1", content: bytes(64) })).status, 201);
});

test("at most two uploads stream concurrently; the third is 503 with retry-after", async (t) => {
  const h = await startUploads({ limits: { concurrency: 2 } });
  t.after(() => h.close());
  const content = bytes(1024, 0x44);

  const a = begin(h, { id: "cc-1", name: "a.bin", content });
  const b = begin(h, { id: "cc-2", name: "b.bin", content });
  // Wait for the condition rather than betting forty milliseconds is enough: it is on an
  // idle box and is not under a full suite, which is exactly how this failed.
  await until(() => h.uploads.admission.active.size === 2, { what: "both uploads to be streaming" });

  const third = await upload(h, { id: "cc-3", name: "c.bin", content });
  assert.equal(third.status, 503);
  assert.match(third.json.error, /concurrent/);
  assert.equal(third.headers["retry-after"], "5");
  assert.equal(h.uploads.store.get("cc-3").state, "failed");

  a.send();
  b.send();
  assert.equal((await a.done).status, 201);
  assert.equal((await b.done).status, 201);
  assert.equal(h.uploads.admission.active.size, 0);

  // and the refused id is free to retry once a slot opens
  assert.equal((await upload(h, { id: "cc-3", name: "c.bin", content })).status, 201);
});
