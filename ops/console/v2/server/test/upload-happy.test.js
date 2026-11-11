// Uploads: the happy path, placement, the manifest, and name collisions.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { dayOf } from "../src/upload/index.js";
import { bytes, listDir, readManifestLines, sha256, startUploads, upload } from "./upload-harness.js";

test("happy path: 201, file placed 0644 under files/<day>, row committed, manifest appended", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const content = bytes(4096, 0x41);

  const res = await upload(h, { id: "up-happy", name: "Reporte Final.pdf", content });
  assert.equal(res.status, 201);
  assert.equal(res.json.id, "up-happy");
  assert.equal(res.json.size, content.length);
  assert.equal(res.json.sha256, sha256(content));
  assert.equal(res.json.duplicateOf, undefined);

  const day = dayOf(h.clock.ms);
  const expected = path.join(h.dir, "files", day, "Reporte Final.pdf");
  assert.equal(res.json.path, expected);
  const st = fs.statSync(expected);
  assert.equal(st.size, content.length);
  assert.equal(st.mode & 0o777, 0o644);
  assert.equal(fs.statSync(path.join(h.dir, "files", day)).mode & 0o777, 0o755);
  assert.deepEqual(fs.readFileSync(expected), content);

  // the row is the record
  const row = h.uploads.store.get("up-happy");
  assert.equal(row.state, "committed");
  assert.equal(Number(row.size), content.length);
  assert.equal(row.sha256, sha256(content));
  assert.equal(row.day, day);
  assert.equal(Number(row.keep), 0);

  // manifest line is the derived projection
  const lines = readManifestLines(h.dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, "up-happy");
  assert.equal(lines[0].path, expected);
  assert.equal(lines[0].sha256, sha256(content));

  // temp file and sidecar are gone, the reservation is released
  assert.deepEqual(listDir(path.join(h.dir, ".tmp")), []);
  assert.equal(h.uploads.admission.active.size, 0);
  assert.equal(h.uploads.store.liveBytes(), content.length);

  // and it lists
  const entries = h.uploads.list(day);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "Reporte Final.pdf");
  assert.equal(entries[0].keep, false);
  assert.equal(typeof entries[0].expiresAt, "string");
});

test("name collision gets a -2 then -3 suffix, never an overwrite", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const day = dayOf(h.clock.ms);

  const a = await upload(h, { id: "c-1", name: "report.pdf", content: bytes(100, 0x41) });
  const b = await upload(h, { id: "c-2", name: "report.pdf", content: bytes(200, 0x42) });
  const c = await upload(h, { id: "c-3", name: "report.pdf", content: bytes(300, 0x43) });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(c.status, 201);

  assert.equal(path.basename(a.json.path), "report.pdf");
  assert.equal(path.basename(b.json.path), "report-2.pdf");
  assert.equal(path.basename(c.json.path), "report-3.pdf");
  assert.deepEqual(listDir(path.join(h.dir, "files", day)), ["report-2.pdf", "report-3.pdf", "report.pdf"]);
  // the first file is untouched: link() never replaces
  assert.equal(fs.statSync(a.json.path).size, 100);
});

test("filenames are sanitised: no traversal, no directories, no hidden files", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const day = dayOf(h.clock.ms);

  const res = await upload(h, { id: "s-1", name: "../../etc/pass wd;rm -rf.txt", content: bytes(10) });
  assert.equal(res.status, 201);
  assert.equal(path.dirname(res.json.path), path.join(h.dir, "files", day));
  assert.equal(path.basename(res.json.path), "pass wd_rm -rf.txt");

  const dotted = await upload(h, { id: "s-2", name: "...", content: bytes(10) });
  assert.equal(dotted.status, 201);
  assert.equal(path.basename(dotted.json.path), "file");
});

test("two files in one day both land and both list", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const day = dayOf(h.clock.ms);
  await upload(h, { id: "m-1", name: "a.txt", content: bytes(11) });
  await upload(h, { id: "m-2", name: "b.txt", content: bytes(22) });

  const entries = h.uploads.list(day);
  assert.deepEqual(
    entries.map((e) => e.name),
    ["a.txt", "b.txt"],
  );
  assert.equal(h.uploads.store.liveBytes(), 33);
  assert.equal(readManifestLines(h.dir).length, 2);
  assert.equal(h.uploads.list("2020-01-01").length, 0);
});
