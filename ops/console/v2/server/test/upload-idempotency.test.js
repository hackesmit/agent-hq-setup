// Uploads: idempotency and lifecycle. Same id twice, different content on the
// same id, a live retry while the first is streaming, delete, keep, expiry.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { dayOf } from "../src/upload/index.js";
import { begin, bytes, listDir, readManifestLines, sha256, startUploads, upload } from "./upload-harness.js";

const DAY_MS = 24 * 60 * 60 * 1000;

test("retry of a committed id with the same size and hash returns 200 and reads no bytes", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const content = bytes(2048, 0x44);

  const first = await upload(h, { id: "r-1", name: "x.bin", content });
  assert.equal(first.status, 201);
  const readAfterFirst = h.uploads.stats.bytesRead;
  assert.equal(readAfterFirst, content.length);

  const again = await upload(h, { id: "r-1", name: "x.bin", content });
  assert.equal(again.status, 200);
  assert.equal(again.json.path, first.json.path);
  assert.equal(again.json.duplicateOf, "r-1");
  // the whole point: the retry costs no bytes and creates no second file
  assert.equal(h.uploads.stats.bytesRead, readAfterFirst);
  assert.equal(h.uploads.stats.dedupes, 1);
  assert.deepEqual(listDir(path.join(h.dir, "files", dayOf(h.clock.ms))), ["x.bin"]);
  assert.equal(readManifestLines(h.dir).length, 1);
  assert.equal(h.uploads.store.liveBytes(), content.length);
});

test("same id with a different hash is 409 before any byte is accepted", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const a = bytes(512, 0x41);
  const b = bytes(512, 0x42);

  assert.equal((await upload(h, { id: "r-2", content: a })).status, 201);
  const read = h.uploads.stats.bytesRead;

  const clash = await upload(h, { id: "r-2", content: b });
  assert.equal(clash.status, 409);
  assert.match(clash.json.error, /different content/);
  assert.equal(h.uploads.stats.bytesRead, read);

  // a different declared size is the same rejection
  const sized = await upload(h, { id: "r-2", content: bytes(600, 0x41) });
  assert.equal(sized.status, 409);
  assert.equal(h.uploads.stats.bytesRead, read);
  assert.deepEqual(listDir(path.join(h.dir, "files", dayOf(h.clock.ms))), ["note.txt"]);
});

test("a second request for an id that is still streaming is 409 with retry-after", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const content = bytes(4096, 0x45);

  const live = begin(h, { id: "r-3", name: "live.bin", content });
  await new Promise((r) => setTimeout(r, 30)); // let the headers reach the server

  const row = h.uploads.store.get("r-3");
  assert.equal(row.state, "in-progress");

  const second = await upload(h, { id: "r-3", name: "live.bin", content });
  assert.equal(second.status, 409);
  assert.match(second.json.error, /in progress/);
  assert.equal(second.headers["retry-after"], "5");

  // the first request is untouched and still completes
  live.send();
  const first = await live.done;
  assert.equal(first.status, 201);
  assert.equal(h.uploads.store.get("r-3").state, "committed");
  assert.deepEqual(listDir(path.join(h.dir, "files", dayOf(h.clock.ms))), ["live.bin"]);
});

test("the owning request heartbeats its row while it streams", async (t) => {
  const h = await startUploads({ limits: { heartbeatMs: 10 } });
  t.after(() => h.close());
  const content = bytes(1024, 0x48);

  const live = begin(h, { id: "hb-1", name: "slow.bin", content });
  await new Promise((r) => setTimeout(r, 40));
  const first = Number(h.uploads.store.get("hb-1").heartbeat);
  assert.equal(first, h.clock.ms);

  h.clock.ms += 45_000; // still inside the 60 s window, and the row says so
  await new Promise((r) => setTimeout(r, 40));
  const second = Number(h.uploads.store.get("hb-1").heartbeat);
  assert.equal(second, h.clock.ms, "the heartbeat column tracks the clock");
  assert.ok(second > first);

  live.send();
  assert.equal((await live.done).status, 201);
});

test("an in-progress row whose heartbeat went stale is taken over, temp bytes dropped", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const content = bytes(256, 0x46);

  // A crashed request: the row exists, its temp file exists, nobody updates it.
  const claimed = h.uploads.store.claim({ id: "r-4", declaredSize: 999, declaredSha: "0".repeat(64) });
  assert.equal(claimed.outcome, "claimed");
  const orphanTmp = h.uploads.paths.tmpFile(claimed.row.tmpUuid);
  fs.writeFileSync(orphanTmp, bytes(99));

  // Not yet stale: a retry is refused rather than stealing a live upload.
  h.clock.ms += 30_000;
  assert.equal((await upload(h, { id: "r-4", content })).status, 409);

  h.clock.ms += 40_000; // now past the 60 s heartbeat window
  const res = await upload(h, { id: "r-4", name: "taken.bin", content });
  assert.equal(res.status, 201);
  assert.equal(fs.existsSync(orphanTmp), false, "the abandoned temp file is removed");
  assert.deepEqual(listDir(path.join(h.dir, ".tmp")), []);
});

test("delete removes the bytes and the id then answers gone", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const content = bytes(1024, 0x47);

  const res = await upload(h, { id: "d-1", name: "gone.txt", content });
  assert.equal(res.status, 201);
  assert.equal(h.uploads.store.liveBytes(), 1024);

  const removed = h.uploads.remove("d-1");
  assert.deepEqual(removed, { ok: true });
  assert.equal(fs.existsSync(res.json.path), false);
  assert.equal(h.uploads.store.get("d-1").state, "deleted");
  assert.equal(h.uploads.store.liveBytes(), 0, "the quota counts only live files");
  assert.equal(readManifestLines(h.dir).length, 0);
  assert.equal(h.uploads.list(dayOf(h.clock.ms)).length, 0);

  const retry = await upload(h, { id: "d-1", name: "gone.txt", content });
  assert.equal(retry.status, 410);
  assert.match(retry.json.error, /deleted/);
  assert.equal(h.uploads.remove("d-1").status, 410);
  assert.equal(h.uploads.remove("nope").status, 404);
});

test("retention expires an unpinned upload and keeps a pinned one", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const day = dayOf(h.clock.ms);

  const old = await upload(h, { id: "e-1", name: "old.txt", content: bytes(64, 0x41) });
  const pin = await upload(h, { id: "e-2", name: "pinned.txt", content: bytes(64, 0x42) });
  assert.equal(old.status, 201);
  assert.equal(pin.status, 201);

  const kept = h.uploads.setKeep("e-2", true);
  assert.equal(kept.ok, true);
  assert.equal(kept.entry.keep, true);
  assert.equal(kept.entry.expiresAt, null, "a pinned upload has no expiry");

  h.clock.ms += 31 * DAY_MS;
  const swept = h.uploads.sweep();
  assert.equal(swept.expired, 1);

  assert.equal(fs.existsSync(old.json.path), false);
  assert.equal(fs.existsSync(pin.json.path), true);
  assert.equal(h.uploads.store.get("e-1").state, "deleted");
  assert.equal(h.uploads.store.get("e-2").state, "committed");
  assert.equal(h.uploads.store.liveBytes(), 64);
  assert.deepEqual(
    readManifestLines(h.dir).map((l) => l.id),
    ["e-2"],
  );
  assert.deepEqual(
    h.uploads.list(day).map((e) => e.id),
    ["e-2"],
  );

  // unpinning puts it back on the clock; the next sweep takes it
  assert.equal(h.uploads.setKeep("e-2", false).entry.keep, false);
  assert.equal(h.uploads.sweep().expired, 1);
  assert.equal(fs.existsSync(pin.json.path), false);
  assert.equal(h.uploads.store.liveBytes(), 0);
});

test("keep on a missing or deleted id is refused, never silently ignored", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  assert.equal(h.uploads.setKeep("nope", true).status, 404);
  const res = await upload(h, { id: "k-1", content: bytes(32) });
  assert.equal(res.status, 201);
  h.uploads.remove("k-1");
  assert.equal(h.uploads.setKeep("k-1", true).status, 410);
});
