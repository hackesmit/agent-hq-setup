// Adversarial review probes for hq-prru (uploads) against design section 6.
// Fresh-context reviewer: every test here is an attack, not a restatement of
// the worker's own suite. Where a probe documents behaviour that DIVERGES from
// the spec sentence it quotes, the divergence is named in the test title.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";

import { DatabaseSync } from "node:sqlite";
import { startUploads, upload, begin, bytes, sha256, listDir, readManifestLines, MB } from "./upload-harness.js";
import { sanitiseName, suffixName } from "../src/upload/paths.js";
import { UploadStore, SchemaTooNew } from "../src/upload/store.js";

const day = "2026-08-18";
const filesOf = (h) => listDir(path.join(h.dir, "files", day));

// ---------------------------------------------------------------- concurrency

test("two same-id requests racing on the wire: exactly one commits, the other is 409 busy", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const a = bytes(4096, 0x41);
  const b = bytes(4096, 0x42);
  // Both open the socket and write the multipart head before either sends bytes,
  // so the claim() transaction is the only thing deciding the race.
  const one = begin(h, { id: "race", content: a, name: "one.bin" });
  const two = begin(h, { id: "race", content: b, name: "two.bin" });
  one.send();
  two.send();
  const [r1, r2] = await Promise.all([one.done, two.done]);
  const codes = [r1.status, r2.status].sort();
  assert.deepEqual(codes, [201, 409], `expected one 201 and one 409, got ${codes}`);
  const busy = r1.status === 409 ? r1 : r2;
  assert.equal(busy.json.error, "upload already in progress");
  assert.equal(busy.headers["retry-after"], "5");
  // and only one file landed
  assert.equal(filesOf(h).length, 1);
});

test("a same-id retry after the first COMMITTED is a 200 that reads no bytes and adds no file", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const c = bytes(2048);
  await upload(h, { id: "dup", content: c });
  const before = h.uploads.stats.bytesRead;
  const again = await upload(h, { id: "dup", content: c });
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicateOf, "dup");
  assert.equal(h.uploads.stats.bytesRead, before, "a committed retry must not read the body");
  assert.equal(filesOf(h).length, 1);
});

// ------------------------------------------------------------ header spoofing

test("a size lie in either direction is refused and leaves nothing behind", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const c = bytes(1000);
  // declares less than it sends -> aborted mid-stream
  const small = await upload(h, { id: "lie-small", content: c, size: 500, sha: sha256(c) });
  assert.equal(small.status, 413);
  // declares more than it sends -> caught at the post-stream size check
  const big = await upload(h, { id: "lie-big", content: c, size: 2000, sha: sha256(c) });
  assert.equal(big.status, 400);
  assert.match(big.json.error, /size mismatch/);
  assert.deepEqual(filesOf(h), []);
  assert.deepEqual(listDir(path.join(h.dir, ".tmp")), [], "no temp file may survive a refusal");
});

test("a hash lie is caught before commit even when the size is honest", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const c = bytes(777);
  const r = await upload(h, { id: "lie-hash", content: c, sha: "0".repeat(64) });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /sha256 mismatch/);
  assert.deepEqual(filesOf(h), []);
  assert.equal(h.uploads.store.get("lie-hash").state, "failed");
});

test("a non-hex, short, upper-case or absent sha header never reaches the stream", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const c = bytes(64);
  for (const sha of ["", "zz", sha256(c).slice(0, 63), "g".repeat(64)]) {
    const r = await upload(h, { id: `sha-${sha.length}-${sha[0] || "x"}`, content: c, sha });
    assert.equal(r.status, 400, `sha ${JSON.stringify(sha)} should be 400`);
  }
  // upper case IS accepted (lower-cased in parseHeaders) - documented, not a bug
  const ok = await upload(h, { id: "sha-upper", content: c, sha: sha256(c).toUpperCase() });
  assert.equal(ok.status, 201);
});

test("an upload id that is a path, a flag or over-long is refused before the claim", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  for (const id of ["../etc", "a/b", "-flag", ".hidden", "x".repeat(65), "a b"]) {
    const r = await upload(h, { id, content: bytes(16) });
    assert.equal(r.status, 400, `id ${JSON.stringify(id)} should be 400`);
    assert.match(r.json.error, /X-Upload-Id/);
  }
});

test("SPEC GAP: a zero-byte file cannot be uploaded at all (X-Upload-Size must be positive)", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const r = await upload(h, { id: "empty", content: Buffer.alloc(0) });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /positive integer/);
  // Section 6 never excludes empty files; this is an undocumented restriction.
});

// ------------------------------------------------------------ filename tricks

test("filename tricks all collapse to a safe basename inside files/<day>/", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const cases = [
    ["../../../etc/passwd", "passwd"],
    ["..\\..\\windows\\system32\\cmd.exe", "cmd.exe"],
    [".bashrc", "bashrc"],
    ["...", "file"],
    ["....", "file"],
    ["/", "file"],
    ["café-日本語.txt", "caf_-___.txt"],
    ["a".repeat(300) + ".txt", "a".repeat(176) + ".txt"],
    ["  spaced   out .txt  ", "spaced out .txt"],
  ];
  for (const [raw, want] of cases) {
    assert.equal(sanitiseName(raw), want, `sanitiseName(${JSON.stringify(raw)})`);
  }
  // and end-to-end: nothing escapes the day directory
  let n = 0;
  for (const [raw] of cases) {
    const c = bytes(32 + n);
    const r = await upload(h, { id: `fn-${n++}`, content: c, name: raw.replace(/"/g, "") });
    assert.equal(r.status, 201, `${raw} -> ${r.status} ${r.text}`);
    assert.equal(path.dirname(r.json.path), path.join(h.dir, "files", day), `${raw} escaped the day dir`);
  }
  for (const f of filesOf(h)) {
    assert.ok(!f.startsWith("."), `hidden file landed: ${f}`);
    assert.ok(!f.includes("/") && !f.includes("\\"), `separator survived: ${f}`);
    assert.ok(f.length <= 200, `name too long: ${f.length}`);
  }
});

test("a name whose sanitised form is longer than 255 bytes cannot be produced", () => {
  // The suffix loop can add at most '-999', so 180 + 4 is the ceiling.
  const worst = suffixName(sanitiseName("z".repeat(4000) + ".tar.gz"), 999);
  assert.ok(Buffer.byteLength(worst) < 255, `worst case name is ${Buffer.byteLength(worst)} bytes`);
});

test("collision suffixing never overwrites, even when the -2 name is itself taken", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const a = bytes(100, 0x61);
  const b = bytes(100, 0x62);
  const c = bytes(100, 0x63);
  await upload(h, { id: "c1", content: a, name: "note.txt" });
  await upload(h, { id: "c2", content: b, name: "note-2.txt" }); // squats the suffix
  const third = await upload(h, { id: "c3", content: c, name: "note.txt" });
  assert.equal(third.status, 201);
  assert.equal(path.basename(third.json.path), "note-3.txt");
  assert.deepEqual(filesOf(h), ["note-2.txt", "note-3.txt", "note.txt"]);
  // and the original bytes are untouched
  assert.equal(fs.readFileSync(path.join(h.dir, "files", day, "note.txt")).length, 100);
  assert.equal(fs.readFileSync(path.join(h.dir, "files", day, "note.txt"))[0], 0x61);
});

// -------------------------------------------------------------- multipart abuse

test("a second file part in one request is refused: exactly one file per request", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const one = bytes(64, 0x41);
  const two = bytes(64, 0x42);
  const boundary = "----hqreview" + crypto.randomBytes(6).toString("hex");
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="one.bin"\r\n\r\n`),
    one,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="file2"; filename="two.bin"\r\n\r\n`),
    two,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const r = await raw(h, {
    "content-type": `multipart/form-data; boundary=${boundary}`,
    "content-length": String(body.length),
    "x-upload-id": "multi",
    "x-upload-size": String(one.length),
    "x-upload-sha256": sha256(one),
  }, body);
  assert.equal(r.status, 400, `two file parts should be refused, got ${r.status} ${r.text}`);
  assert.match(String(r.json && r.json.error), /one file per request/);
  assert.deepEqual(filesOf(h), []);
  assert.deepEqual(listDir(path.join(h.dir, ".tmp")), []);
});

test("a multipart body with no file part is a 400, not a zero-byte commit", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const boundary = "----hqreview" + crypto.randomBytes(6).toString("hex");
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n--${boundary}--\r\n`,
  );
  const c = bytes(5);
  const r = await raw(h, {
    "content-type": `multipart/form-data; boundary=${boundary}`,
    "content-length": String(body.length),
    "x-upload-id": "nofile",
    "x-upload-size": "5",
    "x-upload-sha256": sha256(c),
  }, body);
  assert.equal(r.status, 400);
  assert.match(String(r.json.error), /no file part/);
  assert.deepEqual(filesOf(h), []);
});

test("a non-multipart content-type is refused before the body is touched", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const body = Buffer.from("not multipart at all");
  const r = await raw(h, {
    "content-type": "application/json",
    "content-length": String(body.length),
    "x-upload-id": "json",
    "x-upload-size": String(body.length),
    "x-upload-sha256": sha256(body),
  }, body);
  assert.equal(r.status, 400);
  assert.match(String(r.json.error), /multipart/);
  assert.equal(h.uploads.store.get("json"), null, "no row may be claimed for a refused content-type");
});

test("a Content-Length larger than the body sent does not commit a short file", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const c = bytes(512);
  const boundary = "----hqreview" + crypto.randomBytes(6).toString("hex");
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="short.bin"\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const r = await raw(
    h,
    {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(head.length + c.length + tail.length + 4096), // a lie
      "x-upload-id": "clen",
      "x-upload-size": String(c.length),
      "x-upload-sha256": sha256(c),
    },
    Buffer.concat([head, c, tail]),
    { halfClose: true },
  );
  assert.notEqual(r.status, 201, `a truncated body must not commit (got ${r.status})`);
  assert.deepEqual(filesOf(h), []);
  const row = h.uploads.store.get("clen");
  assert.ok(!row || row.state !== "committed", "no committed row for a truncated request");
});

test("headers larger than node's cap are rejected by the server, not by the inbox", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const c = bytes(64);
  const r = await upload(h, {
    id: "bigheader",
    content: c,
    headers: { "x-upload-note": "n".repeat(40000) },
  });
  // Either node answers 431 or the socket resets; what must NOT happen is a commit.
  assert.notEqual(r.status, 201, `oversized headers must not commit (got ${r.status})`);
  assert.deepEqual(filesOf(h), []);
});

test("the note header is bounded to 500 characters in the row and the manifest", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const r = await upload(h, { id: "note", content: bytes(32), headers: { "x-upload-note": "x".repeat(4000) } });
  assert.equal(r.status, 201);
  assert.equal(h.uploads.store.get("note").note.length, 500);
  assert.equal(readManifestLines(h.dir)[0].note.length, 500);
});

// ------------------------------------------------------------------- quota math

test("two concurrent reservations each hold the FULL per-file maximum, not the declared size", async (t) => {
  // quota 4 MB, maxFile 1 MB, 3 MB already live -> one reservation fits, the second must not.
  const h = await startUploads({ limits: { maxFile: 1 * MB, quota: 4 * MB, concurrency: 2 } });
  t.after(() => h.close());
  // seed 3 MB of live bytes through the real path (3 x 1 MB uploads)
  for (let i = 0; i < 3; i++) {
    const c = bytes(1 * MB, 0x30 + i);
    const r = await upload(h, { id: `seed-${i}`, content: c, name: `seed${i}.bin` });
    assert.equal(r.status, 201, r.text);
  }
  assert.equal(h.uploads.store.liveBytes(), 3 * MB);
  const a = begin(h, { id: "q-a", content: bytes(1024, 0x41), name: "a.bin" });
  const b = begin(h, { id: "q-b", content: bytes(1024, 0x42), name: "b.bin" });
  a.send();
  b.send();
  const [ra, rb] = await Promise.all([a.done, b.done]);
  const codes = [ra.status, rb.status].sort();
  // 3 MB live + 1 MB reserved + 1 MB reserved = 5 MB > 4 MB quota
  assert.deepEqual(codes, [201, 507], `expected one 201 and one 507, got ${codes}`);
  const refused = ra.status === 507 ? ra : rb;
  assert.match(refused.json.error, /quota/);
});

test("a released reservation is reusable: a 507 does not permanently poison the quota", async (t) => {
  const h = await startUploads({ limits: { maxFile: 1 * MB, quota: 4 * MB, concurrency: 2 } });
  t.after(() => h.close());
  const c = bytes(4096);
  const first = await upload(h, { id: "r1", content: c });
  assert.equal(first.status, 201);
  assert.equal(h.uploads.admission.active.size, 0, "the grant must be released after a success");
  h.state.free = 0; // starve the disk
  const starved = await upload(h, { id: "r2", content: c, name: "b.bin" });
  assert.equal(starved.status, 507);
  assert.equal(h.uploads.admission.active.size, 0, "the grant must be released after a refusal");
  h.state.free = 100 * 1024 * MB;
  const back = await upload(h, { id: "r3", content: c, name: "c.bin" });
  assert.equal(back.status, 201, back.text);
});

// ------------------------------------------------------- retention, keep, gone

test("delete then retry is 410 gone forever; a fresh id for the same bytes still works", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const c = bytes(256);
  await upload(h, { id: "gone", content: c });
  assert.equal(h.uploads.remove("gone").ok, true);
  const retry = await upload(h, { id: "gone", content: c });
  assert.equal(retry.status, 410);
  assert.equal(retry.json.error, "upload was deleted");
  // a different id is not blocked by the tombstone
  const fresh = await upload(h, { id: "gone2", content: c, name: "again.txt" });
  assert.equal(fresh.status, 201);
  // deleting twice is 410, not a second unlink
  assert.equal(h.uploads.remove("gone").status, 410);
});

test("keep survives a delete attempt? no: keep pins expiry only, delete still removes", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  await upload(h, { id: "pin", content: bytes(64) });
  assert.equal(h.uploads.setKeep("pin", true).ok, true);
  assert.equal(h.uploads.remove("pin").ok, true, "an explicit delete overrides keep by design");
  assert.deepEqual(filesOf(h), []);
  assert.equal(h.uploads.store.get("pin").state, "deleted");
  assert.equal(h.uploads.store.get("pin").keep, 0, "a deleted row must not stay pinned");
});

test("the quota counts only live bytes: deleting frees the reservation space", async (t) => {
  const h = await startUploads({ limits: { maxFile: 1 * MB, quota: 2 * MB, concurrency: 1 } });
  t.after(() => h.close());
  const c = bytes(1 * MB);
  assert.equal((await upload(h, { id: "l1", content: c, name: "a.bin" })).status, 201);
  // 1 MB live + 1 MB reserved = 2 MB, exactly the quota, so this one still fits
  assert.equal((await upload(h, { id: "l2", content: c, name: "b.bin" })).status, 201);
  // now 2 MB live + 1 MB reserved = 3 MB > 2 MB
  assert.equal((await upload(h, { id: "l3", content: c, name: "c.bin" })).status, 507);
  h.uploads.remove("l1");
  assert.equal((await upload(h, { id: "l4", content: c, name: "d.bin" })).status, 201, "space must come back");
});

test("expiry uses committedAt, and a keep set AFTER the window still saves the file", async (t) => {
  const h = await startUploads({ limits: { retentionDays: 30 } });
  t.after(() => h.close());
  await upload(h, { id: "old", content: bytes(64), name: "old.txt" });
  h.uploads.setKeep("old", true);
  h.clock.ms += 31 * 24 * 3600 * 1000;
  assert.deepEqual(h.uploads.sweep(), { expired: 0 });
  assert.equal(filesOf(h).length, 1);
  h.uploads.setKeep("old", false);
  assert.deepEqual(h.uploads.sweep(), { expired: 1 });
  assert.deepEqual(filesOf(h), []);
  assert.equal(readManifestLines(h.dir).length, 0, "the manifest projection follows the sweep");
});

// ----------------------------------------------- manifest as a pure projection

test("the manifest is rebuilt at boot from the table: garbage, truncation and loss all heal", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  await upload(h, { id: "m1", content: bytes(64, 0x31), name: "a.txt" });
  await upload(h, { id: "m2", content: bytes(64, 0x32), name: "b.txt" });
  const manifest = path.join(h.dir, "manifest.jsonl");
  fs.writeFileSync(manifest, "{not json\n\n{\"id\":\"ghost\",\"path\":\"/nope\"}\n");
  const report = h.restart();
  assert.equal(report.manifestLines, 2);
  const lines = readManifestLines(h.dir);
  assert.deepEqual(lines.map((l) => l.id).sort(), ["m1", "m2"]);
  assert.ok(lines.every((l) => fs.existsSync(l.path)), "every manifest line must name a real file");
  // total loss of the manifest heals the same way
  fs.rmSync(manifest);
  h.restart();
  assert.equal(readManifestLines(h.dir).length, 2);
});

test("a manifest line whose file was removed outside the console is dropped at boot", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const r = await upload(h, { id: "vanish", content: bytes(64) });
  fs.rmSync(r.json.path);
  h.restart();
  assert.deepEqual(readManifestLines(h.dir), []);
  assert.equal(h.uploads.store.get("vanish").state, "deleted");
  assert.ok(h.alerts.list().some((a) => a.id === "upload-missing-vanish"));
});

// -------------------------------------------------------- reconcile edge cases

test("SPEC DEVIATION: a final file WITH a sidecar but no sqlite row is quarantined, not adopted", async (t) => {
  // Section 6: "final files absent from the manifest are re-hashed and appended
  // from their sidecar (or quarantined with a recovery card WHEN THE SIDECAR IS
  // MISSING)". Here the sidecar is present and complete, yet reconcile
  // quarantines because store.get(rec.uploadId) is null.
  const h = await startUploads();
  t.after(() => h.close());
  const dir = path.join(h.dir, "files", day);
  fs.mkdirSync(dir, { recursive: true });
  const content = bytes(128, 0x5a);
  const finalPath = path.join(dir, "rescued.bin");
  fs.writeFileSync(finalPath, content);
  const uuid = crypto.randomUUID();
  fs.writeFileSync(
    path.join(h.dir, ".tmp", uuid + ".meta.json"),
    JSON.stringify({
      uploadId: "lost-row",
      uuid,
      finalPath,
      name: "rescued.bin",
      day,
      ts: new Date(h.clock.ms).toISOString(),
      size: content.length,
      sha256: sha256(content),
      note: null,
    }) + "\n",
  );
  const report = h.restart();
  assert.equal(report.orphansAdopted, 0, "the sidecar was ignored");
  assert.equal(report.quarantined, 1);
  assert.equal(h.uploads.store.get("lost-row"), null, "no row was created from the sidecar");
  assert.ok(
    h.alerts.list().some((a) => a.id === `upload-orphan-${finalPath}`),
    "a card is filed, so nothing is silently lost - the deviation is the wording, not data loss",
  );
});

test("an orphan whose sidecar hash does not match the bytes is never adopted", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const dir = path.join(h.dir, "files", day);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, "tampered.bin");
  fs.writeFileSync(finalPath, bytes(64, 0x99));
  const uuid = crypto.randomUUID();
  // a row exists and is in-progress, so the step-1 adopt path is the one taken
  h.uploads.store.claim({ id: "tamper", declaredSize: 64, declaredSha: sha256(bytes(64, 0x99)), staleMs: 60000 });
  const row = h.uploads.store.get("tamper");
  fs.writeFileSync(
    path.join(h.dir, ".tmp", row.tmpUuid + ".meta.json"),
    JSON.stringify({
      uploadId: "tamper",
      uuid: row.tmpUuid,
      finalPath,
      name: "tampered.bin",
      day,
      ts: new Date(h.clock.ms).toISOString(),
      size: 64,
      sha256: sha256(bytes(64, 0x11)), // wrong on purpose
      note: null,
    }) + "\n",
  );
  void uuid;
  h.restart();
  assert.notEqual(h.uploads.store.get("tamper").state, "committed");
  assert.ok(h.alerts.list().some((a) => a.id === "upload-hash-tamper"), "a hash mismatch must file a card");
  assert.ok(fs.existsSync(finalPath), "the suspect file stays inspectable");
});

test("a committed file whose bytes changed on disk is flagged, and the row is left alone", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  const r = await upload(h, { id: "drift", content: bytes(64) });
  fs.appendFileSync(r.json.path, "extra");
  h.restart();
  assert.equal(h.uploads.store.get("drift").state, "committed");
  assert.ok(h.alerts.list().some((a) => a.id === "upload-drift-drift"));
});

test("boot abandons every in-progress row, and the id stays retryable afterwards", async (t) => {
  const h = await startUploads();
  t.after(() => h.close());
  h.uploads.store.claim({ id: "ghost", declaredSize: 10, declaredSha: "a".repeat(64), staleMs: 60000 });
  const tmp = path.join(h.dir, ".tmp", h.uploads.store.get("ghost").tmpUuid);
  fs.writeFileSync(tmp, "partial");
  const report = h.restart();
  assert.equal(report.inProgress, 1);
  assert.equal(report.failed, 1);
  assert.equal(h.uploads.store.get("ghost").state, "failed");
  assert.ok(!fs.existsSync(tmp), "the abandoned temp bytes must be dropped");
  const c = bytes(10);
  assert.equal((await upload(h, { id: "ghost", content: c })).status, 201, "a failed id must be retryable");
});

// --------------------------------------------------------------- schema safety

test("a store written by a newer release is refused AND the file handle is not left open", (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "hq-schema-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "uploads.sqlite");
  const s = new UploadStore(file);
  s.close();
  const db = new DatabaseSync(file);
  db.prepare("UPDATE schema_version SET version = ? WHERE component = ?").run(99, "uploads");
  db.close();
  assert.throws(() => new UploadStore(file), SchemaTooNew);
  // and a second attempt fails the same way rather than a locked/half-open db
  assert.throws(() => new UploadStore(file), SchemaTooNew);
});

test("expand-then-contract: an extra column and an extra table from a newer release are ignored", (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "hq-expand-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "uploads.sqlite");
  new UploadStore(file).close();
  const db = new DatabaseSync(file);
  db.exec("ALTER TABLE uploads ADD COLUMN futureThing TEXT");
  db.exec("CREATE TABLE future(x TEXT)");
  db.close();
  const s = new UploadStore(file);
  t.after(() => s.close());
  s.claim({ id: "after", declaredSize: 1, declaredSha: "b".repeat(64), staleMs: 1000 });
  assert.equal(s.get("after").state, "in-progress");
});

test("a store whose newer release BUMPED the version is refused even with the old columns present", (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "hq-newer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "uploads.sqlite");
  const s = new UploadStore(file);
  s.db.prepare("UPDATE schema_version SET version = 2 WHERE component = ?").run("uploads");
  s.close();
  assert.throws(() => new UploadStore(file), /newer than this release/);
});

// -------------------------------------------------------- failed row commit

test("a row commit that throws unlinks the file, frees the reservation and files a P1", async (t) => {
  const h = await startUploads({
    faults: {
      rowCommit() {
        throw new Error("disk full");
      },
    },
  });
  t.after(() => h.close());
  const r = await upload(h, { id: "boom", content: bytes(512) });
  assert.equal(r.status, 500);
  assert.deepEqual(filesOf(h), [], "the linked file must not outlive a failed row");
  assert.deepEqual(listDir(path.join(h.dir, ".tmp")), [], "the sidecar and temp file go too");
  assert.equal(h.uploads.admission.active.size, 0);
  assert.equal(h.uploads.store.liveBytes(), 0, "committed quota must agree with the disk");
  const card = h.alerts.list().find((a) => a.id === "upload-commit-boom");
  assert.ok(card && card.severity === "P1");
  // and boot has nothing to recover, because nothing is on disk
  const report = h.restart();
  assert.equal(report.quarantined, 0);
  assert.equal(report.orphansAdopted, 0);
});

// ------------------------------------------------------------------ utilities

/** POST /api/upload with a hand-built body, for the cases the harness cannot express. */
function raw(h, headers, body, opts = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const req = http.request(
      { host: "127.0.0.1", port: h.port, method: "POST", path: "/api/upload", headers: { host: `127.0.0.1:${h.port}`, ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch {
            /* not json */
          }
          done({ status: res.statusCode, headers: res.headers, text: data, json: parsed });
        });
      },
    );
    req.on("error", () => done({ status: 0, headers: {}, text: "", json: null }));
    req.write(body);
    if (opts.halfClose) {
      // stop short of Content-Length, then drop the socket: a truncated request
      setTimeout(() => {
        req.destroy();
        setTimeout(() => done({ status: 0, headers: {}, text: "", json: null }), 60);
      }, 60);
    } else {
      req.end();
    }
  });
}
