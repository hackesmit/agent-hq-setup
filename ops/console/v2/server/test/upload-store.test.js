// Uploads: the durable record itself, the schema version gate, and the config
// resolution. The expand-then-contract rule (design section 3) is what makes a
// release rollback safe, so it gets a test rather than a comment.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { SCHEMA_VERSION, UploadStore, dayOf, sanitiseName, uploadConfig } from "../src/upload/index.js";
import { SchemaTooNew } from "../src/upload/store.js";
import { suffixName } from "../src/upload/paths.js";
import { GB, MB, tmpInbox } from "./upload-harness.js";

function store(dir, now) {
  return new UploadStore(path.join(dir, "uploads.sqlite"), { now: now || (() => 1_000_000) });
}

test("the schema carries a version table and reopening is idempotent", (t) => {
  const dir = tmpInbox();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const a = store(dir);
  assert.equal(a.version(), SCHEMA_VERSION);
  const rows = a.db.prepare("SELECT component, version FROM schema_version").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].component, "uploads");
  a.close();

  const b = store(dir);
  assert.equal(b.version(), SCHEMA_VERSION);
  assert.equal(b.db.prepare("SELECT COUNT(*) AS n FROM schema_version").get().n, 1);
  b.close();
});

test("a store written by a newer release is refused, not corrupted", (t) => {
  const dir = tmpInbox();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const a = store(dir);
  a.db.prepare("UPDATE schema_version SET version = ? WHERE component = ?").run(SCHEMA_VERSION + 5, "uploads");
  a.close();

  assert.throws(() => store(dir), SchemaTooNew);
});

test("expand-then-contract: a column added by a newer release is ignored, not fatal", (t) => {
  const dir = tmpInbox();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const a = store(dir);
  a.claim({ id: "s-1", declaredSize: 10, declaredSha: "a".repeat(64) });
  // release N+1 adds a column with a default; release N must still open it
  a.db.exec("ALTER TABLE uploads ADD COLUMN futureThing TEXT DEFAULT NULL");
  a.close();

  const b = store(dir);
  assert.equal(b.version(), SCHEMA_VERSION);
  const row = b.get("s-1");
  assert.equal(row.state, "in-progress");
  b.commit({
    id: "s-1",
    name: "f.txt",
    path: path.join(dir, "files", "2026-08-18", "f.txt"),
    day: "2026-08-18",
    size: 10,
    sha256: "b".repeat(64),
    committedAt: "2026-08-18T12:00:00.000Z",
  });
  assert.equal(b.get("s-1").state, "committed");
  b.close();
});

test("claim is the idempotency gate and covers every prior state", (t) => {
  const dir = tmpInbox();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { ms: 1_000_000 };
  const s = store(dir, () => clock.ms);
  t.after(() => s.close());
  const decl = { id: "g-1", declaredSize: 10, declaredSha: "c".repeat(64) };

  assert.equal(s.claim(decl).outcome, "claimed");
  assert.equal(s.claim(decl).outcome, "busy", "a fresh heartbeat is busy");

  clock.ms += 61_000;
  const taken = s.claim(decl);
  assert.equal(taken.outcome, "claimed", "a stale heartbeat is taken over");
  assert.ok(taken.abandoned, "the previous attempt is reported so its temp file can be dropped");

  s.commit({
    id: "g-1",
    name: "f.txt",
    path: "/x/f.txt",
    day: "2026-08-18",
    size: 10,
    sha256: "d".repeat(64),
    committedAt: "2026-08-18T12:00:00.000Z",
  });
  assert.equal(s.claim(decl).outcome, "existing");
  assert.equal(s.claim({ ...decl, declaredSize: 11 }).outcome, "mismatch");
  assert.equal(s.claim({ ...decl, declaredSha: "e".repeat(64) }).outcome, "mismatch");

  s.markDeleted("g-1", "test");
  assert.equal(s.claim(decl).outcome, "gone");
  assert.equal(s.liveBytes(), 0);
});

test("commit refuses a row that is not in progress", (t) => {
  const dir = tmpInbox();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = store(dir);
  t.after(() => s.close());
  assert.throws(
    () =>
      s.commit({
        id: "absent",
        name: "f",
        path: "/x/f",
        day: "2026-08-18",
        size: 1,
        sha256: "f".repeat(64),
        committedAt: "2026-08-18T12:00:00.000Z",
      }),
    /was not in progress/,
  );
});

test("upload config: defaults, the dev inbox, and every environment override", () => {
  const prod = uploadConfig({ hqRoot: "/home/owner/hq" }, {});
  assert.equal(prod.inboxDir, "/var/lib/hqconsole/inbox");
  assert.equal(prod.maxFile, 200 * MB);
  assert.equal(prod.concurrency, 2);
  assert.equal(prod.quota, 5 * GB);
  assert.equal(prod.freeFloor, 10 * GB);
  assert.equal(prod.retentionDays, 30);
  assert.equal(prod.heartbeatMs, 10_000);
  assert.equal(prod.heartbeatStaleMs, 60_000);

  const dev = uploadConfig({ hqRoot: "/home/owner/hq", devNoAuth: true }, {});
  assert.equal(dev.inboxDir, "/home/owner/hq/state/console-v2/inbox");

  const over = uploadConfig(
    { hqRoot: "/home/owner/hq" },
    {
      CONSOLE_INBOX_DIR: "/srv/inbox",
      CONSOLE_UPLOAD_MAX_FILE: "1024",
      CONSOLE_UPLOAD_CONCURRENCY: "4",
      CONSOLE_INBOX_QUOTA: "2048",
      CONSOLE_FREE_FLOOR: "4096",
      CONSOLE_UPLOAD_RETENTION_DAYS: "7",
    },
  );
  assert.deepEqual(
    [over.inboxDir, over.maxFile, over.concurrency, over.quota, over.freeFloor, over.retentionDays],
    ["/srv/inbox", 1024, 4, 2048, 4096, 7],
  );
  assert.throws(() => uploadConfig({}, { CONSOLE_UPLOAD_MAX_FILE: "lots" }), /must be a non-negative integer/);
});

test("name sanitising and collision suffixes", () => {
  assert.equal(sanitiseName("../../etc/shadow"), "shadow");
  assert.equal(sanitiseName("C:\\Users\\Dan\\a.txt"), "a.txt");
  assert.equal(sanitiseName(".hidden"), "hidden");
  assert.equal(sanitiseName(""), "file");
  assert.equal(sanitiseName(null), "file");
  assert.equal(sanitiseName("a\u0000b.txt"), "ab.txt");
  assert.equal(sanitiseName("reporte anual (final).pdf"), "reporte anual _final_.pdf");
  assert.equal(sanitiseName("x".repeat(400) + ".pdf").length <= 180, true);

  assert.equal(suffixName("a.txt", 1), "a.txt");
  assert.equal(suffixName("a.txt", 2), "a-2.txt");
  assert.equal(suffixName("noext", 3), "noext-3");
  assert.equal(suffixName("a.tar.gz", 2), "a.tar-2.gz");
});

test("dayOf is the local calendar day", () => {
  const ms = Date.parse("2026-08-18T12:00:00.000Z");
  assert.match(dayOf(ms), /^\d{4}-\d{2}-\d{2}$/);
  const d = new Date(ms);
  assert.equal(dayOf(ms), `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
});
