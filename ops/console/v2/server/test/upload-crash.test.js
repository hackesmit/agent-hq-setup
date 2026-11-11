// Uploads: the crash windows and the boot reconcile.
//
// Each test kills the request at a point the design names, then restarts the
// module and asserts that boot() produced a consistent state: the row, the
// file, the manifest and the temp tree all agreeing.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { UploadCrash, dayOf } from "../src/upload/index.js";
import { bytes, listDir, readManifestLines, sha256, startUploads, upload } from "./upload-harness.js";

const crashAt = (where) => () => {
  throw new UploadCrash(where);
};

function sidecars(h) {
  return listDir(path.join(h.dir, ".tmp")).filter((f) => f.endsWith(".meta.json"));
}

test("crash after link, before the row commit: boot verifies and commits the row", async (t) => {
  const h = await startUploads({ faults: { afterLink: crashAt("afterLink") } });
  t.after(() => h.close());
  const content = bytes(2048, 0x41);
  const day = dayOf(h.clock.ms);

  const res = await upload(h, { id: "w1", name: "half.bin", content });
  assert.equal(res.status, 0, "the request died with the process");

  // the window: file linked, row still in-progress, sidecar still there
  const target = path.join(h.dir, "files", day, "half.bin");
  assert.equal(fs.existsSync(target), true);
  assert.equal(h.uploads.store.get("w1").state, "in-progress");
  assert.equal(sidecars(h).length, 1);
  assert.equal(readManifestLines(h.dir).length, 0);

  const report = h.restart();
  assert.equal(report.recovered, 1);
  assert.equal(report.quarantined, 0);

  const row = h.uploads.store.get("w1");
  assert.equal(row.state, "committed");
  assert.equal(row.path, target);
  assert.equal(Number(row.size), content.length);
  assert.equal(row.sha256, sha256(content));
  assert.equal(h.uploads.store.liveBytes(), content.length);
  assert.deepEqual(
    readManifestLines(h.dir).map((l) => l.id),
    ["w1"],
  );
  assert.deepEqual(listDir(path.join(h.dir, ".tmp")), [], "sidecar and temp file cleaned up");

  // and the client's retry is now the cheap 200, not a suffixed duplicate
  const retry = await upload(h, { id: "w1", name: "half.bin", content });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.path, target);
  assert.deepEqual(listDir(path.join(h.dir, "files", day)), ["half.bin"]);
});

test("crash after the row commit, before the manifest: boot regenerates the line", async (t) => {
  const h = await startUploads({ faults: { afterRowCommit: crashAt("afterRowCommit") } });
  t.after(() => h.close());
  const content = bytes(1024, 0x42);
  const day = dayOf(h.clock.ms);

  const res = await upload(h, { id: "w2", name: "late.bin", content });
  assert.equal(res.status, 0);

  const target = path.join(h.dir, "files", day, "late.bin");
  assert.equal(h.uploads.store.get("w2").state, "committed", "the row is the atomic record");
  assert.equal(fs.existsSync(target), true);
  assert.equal(readManifestLines(h.dir).length, 0, "the manifest lagged");
  assert.equal(sidecars(h).length, 1);

  const report = h.restart();
  assert.equal(report.manifestLines, 1);
  assert.deepEqual(
    readManifestLines(h.dir).map((l) => l.path),
    [target],
  );
  assert.deepEqual(listDir(path.join(h.dir, ".tmp")), []);
  assert.equal(h.uploads.store.liveBytes(), content.length);
  assert.equal((await upload(h, { id: "w2", name: "late.bin", content })).status, 200);
});

test("crash after the sidecar, before the link: boot drops the bytes and keeps the id", async (t) => {
  const h = await startUploads({ faults: { afterSidecar: crashAt("afterSidecar") } });
  t.after(() => h.close());
  const content = bytes(700, 0x43);
  const day = dayOf(h.clock.ms);

  assert.equal((await upload(h, { id: "w3", name: "never.bin", content })).status, 0);
  assert.equal(h.uploads.store.get("w3").state, "in-progress");
  assert.equal(listDir(path.join(h.dir, "files", day)).length, 0);

  const report = h.restart();
  assert.equal(report.failed, 1);
  assert.equal(report.recovered, 0);
  assert.equal(report.quarantined, 0);
  assert.equal(h.uploads.store.get("w3").state, "failed");
  assert.deepEqual(listDir(path.join(h.dir, ".tmp")), []);
  assert.equal(h.uploads.store.liveBytes(), 0);
  assert.equal(readManifestLines(h.dir).length, 0);

  // the id is retryable: nothing was committed under it
  assert.equal((await upload(h, { id: "w3", name: "never.bin", content })).status, 201);
});

test("a row commit that FAILS unlinks the file, releases after cleanup and pins an alert", async (t) => {
  const h = await startUploads({
    faults: {
      rowCommit: () => {
        throw new Error("disk I/O error");
      },
    },
  });
  t.after(() => h.close());
  const content = bytes(1500, 0x44);
  const day = dayOf(h.clock.ms);

  const res = await upload(h, { id: "w4", name: "doomed.bin", content });
  assert.equal(res.status, 500);
  assert.match(res.json.error, /record could not be written/);

  assert.deepEqual(listDir(path.join(h.dir, "files", day)), [], "the file must not outlive a failed row");
  assert.deepEqual(listDir(path.join(h.dir, ".tmp")), []);
  assert.equal(h.uploads.store.get("w4").state, "failed");
  assert.equal(h.uploads.store.liveBytes(), 0, "committed quota never disagrees with the disk");
  assert.equal(h.uploads.admission.active.size, 0, "the reservation is released after the cleanup");

  const alert = h.alerts.list().find((a) => a.id === "upload-commit-w4");
  assert.ok(alert, "a card is pinned");
  assert.equal(alert.severity, "P1");
  assert.equal(alert.source, "uploads");

  // boot finds nothing to do, and the id retries cleanly once the fault clears
  const report = h.restart();
  assert.deepEqual([report.recovered, report.quarantined, report.missingFiles], [0, 0, 0]);
  assert.equal((await upload(h, { id: "w4", name: "doomed.bin", content })).status, 201);
});

test("an orphan final file with a sidecar is adopted by the boot reconcile", async (t) => {
  const h = await startUploads({ faults: { afterLink: crashAt("afterLink") } });
  t.after(() => h.close());
  const content = bytes(900, 0x45);
  const day = dayOf(h.clock.ms);

  assert.equal((await upload(h, { id: "w5", name: "orphan.bin", content })).status, 0);
  // a partial earlier recovery already gave up on the row; only the sidecar ties
  // the file to its id now
  h.uploads.store.fail("w5", "half-recovered");
  assert.equal(h.uploads.store.get("w5").state, "failed");

  const report = h.restart();
  assert.equal(report.orphansAdopted, 1);
  const row = h.uploads.store.get("w5");
  assert.equal(row.state, "committed");
  assert.equal(row.path, path.join(h.dir, "files", day, "orphan.bin"));
  assert.equal(row.sha256, sha256(content));
  assert.deepEqual(listDir(path.join(h.dir, ".tmp")), []);
  assert.equal(readManifestLines(h.dir).length, 1);
});

test("a file with no row and no sidecar is quarantined with a card, never guessed at", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const day = dayOf(h.clock.ms);
  const dir = path.join(h.dir, "files", day);
  fs.mkdirSync(dir, { recursive: true });
  const stray = path.join(dir, "stray.bin");
  fs.writeFileSync(stray, bytes(32));

  const report = h.restart();
  assert.equal(report.quarantined, 1);
  assert.equal(fs.existsSync(stray), true, "quarantine leaves the bytes alone");
  assert.equal(h.uploads.store.liveBytes(), 0);
  const alert = h.alerts.list().find((a) => a.title === "Unmatched file in the inbox");
  assert.ok(alert);
  assert.match(alert.detail, /stray\.bin/);
});

test("a file deleted outside the console becomes a deleted row plus a card", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const keepIt = await upload(h, { id: "x-1", name: "stays.bin", content: bytes(50, 0x41) });
  const goes = await upload(h, { id: "x-2", name: "goes.bin", content: bytes(60, 0x42) });
  assert.equal(keepIt.status, 201);
  assert.equal(goes.status, 201);

  fs.unlinkSync(goes.json.path); // someone ran rm

  const report = h.restart();
  assert.equal(report.missingFiles, 1);
  assert.equal(h.uploads.store.get("x-2").state, "deleted");
  assert.equal(h.uploads.store.get("x-1").state, "committed");
  assert.equal(h.uploads.store.liveBytes(), 50);
  assert.deepEqual(
    readManifestLines(h.dir).map((l) => l.id),
    ["x-1"],
    "manifest lines whose file is missing are dropped",
  );
  assert.ok(h.alerts.list().find((a) => a.id === "upload-missing-x-2"));

  // a retry of the deleted id is told gone, never a silent re-upload
  const retry = await upload(h, { id: "x-2", name: "goes.bin", content: bytes(60, 0x42) });
  assert.equal(retry.status, 410);
});

test("stale .tmp entries older than an hour are swept at boot", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const tmpDir = path.join(h.dir, ".tmp");
  const stale = path.join(tmpDir, "11111111-2222-3333-4444-555555555555");
  const fresh = path.join(tmpDir, "66666666-7777-8888-9999-000000000000");
  fs.writeFileSync(stale, bytes(10));
  fs.writeFileSync(fresh, bytes(10));
  const sec = h.clock.ms / 1000;
  fs.utimesSync(stale, sec - 7200, sec - 7200);
  fs.utimesSync(fresh, sec - 60, sec - 60);

  const report = h.restart();
  assert.equal(report.tmpSwept, 1);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
});
