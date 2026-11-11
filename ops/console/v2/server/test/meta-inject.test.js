// meta-inject consumer (proposal 25, Option A): PRE-FILL a queued transcript into
// the live Capri session only when a passkey-attached tab is present; never
// submit (no trailing newline) so it cannot answer a permission prompt; hold an
// undeliverable one as a card; never lose one on a failure or a restart.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MetaInjectConsumer, sanitizeInjectText } from "../src/meta-inject.js";

function queueFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-mi-"));
  return path.join(dir, "meta-inject.jsonl");
}
function append(file, rec) {
  fs.appendFileSync(file, JSON.stringify(rec) + "\n");
}
function harness(over = {}) {
  const file = over.file || queueFile();
  const stateFile = over.stateFile === undefined ? file + ".seen.json" : over.stateFile;
  const drafted = [];
  const held = [];
  let now = over.now0 || Date.parse("2026-08-25T12:00:00Z");
  const c = new MetaInjectConsumer({
    file,
    stateFile,
    liveMetaSid: over.liveMetaSid || (() => "s1abc"),
    hasAttachment: over.hasAttachment || (() => true),
    pushDraft: over.pushDraft || ((sid, draft) => { drafted.push({ sid, ...draft }); return 1; }),
    hold: (text, id) => held.push({ text, id }),
    now: () => now,
    maxAgeMs: over.maxAgeMs || 60_000,
    log: () => {},
  });
  return { c, file, stateFile, drafted, held, advance: (ms) => { now += ms; } };
}
const ts = "2026-08-25T12:00:00Z"; // age 0 at now0

test("sanitize strips CR/LF and control bytes so a pre-fill is one inert line", () => {
  assert.equal(sanitizeInjectText("restart\r\nthe server"), "restart the server");
  assert.equal(sanitizeInjectText("a" + String.fromCharCode(3) + "b" + String.fromCharCode(27) + "c"), "a b c");
  assert.equal(sanitizeInjectText("  spaced  "), "spaced");
});

test("pushes a sanitized draft to the attached live meta tab; server never writes the PTY", async () => {
  const h = harness();
  append(h.file, { id: "mi-1", ts, text: "restart the acme dev server" });
  const r = await h.c.drainOnce();
  assert.deepEqual(r, [{ id: "mi-1", action: "delivered" }]);
  assert.deepEqual(h.drafted, [{ sid: "s1abc", id: "mi-1", text: "restart the acme dev server" }]);
  // a draft carries no control bytes: the tab shows it, the owner commits it
  assert.ok(!/[\u0000-\u001f]/.test(h.drafted[0].text));
});

test("delivers each entry exactly once across repeated drains", async () => {
  const h = harness();
  append(h.file, { id: "mi-1", ts, text: "one" });
  await h.c.drainOnce();
  await h.c.drainOnce();
  append(h.file, { id: "mi-2", ts, text: "two" });
  await h.c.drainOnce();
  assert.deepEqual(h.drafted.map((x) => x.text), ["one", "two"]);
});

test("age is checked before attachment: an expired entry is held even if a tab attaches late", async () => {
  let attached = false;
  const h = harness({ hasAttachment: () => attached });
  append(h.file, { id: "mi-1", ts, text: "too late" });
  await h.c.drainOnce();          // young, no tab -> waiting
  h.advance(61_000);             // now expired
  attached = true;               // a tab attaches AFTER expiry
  const r = await h.c.drainOnce();
  assert.deepEqual(r, [{ id: "mi-1", action: "held" }]);
  assert.equal(h.drafted.length, 0, "an expired entry must never be delivered");
  assert.deepEqual(h.held, [{ text: "too late", id: "mi-1" }]);
});

test("a push that reaches zero sockets retries rather than being marked delivered", async () => {
  const h = harness({ pushDraft: () => 0 }); // attachment said yes, but the socket vanished
  append(h.file, { id: "mi-1", ts, text: "gone" });
  let r = await h.c.drainOnce();
  assert.deepEqual(r, [{ id: "mi-1", action: "retry" }]);
  assert.ok(!h.c.seen.has("mi-1"), "a 0-reach push stays unseen to retry");
});

test("a young entry with no tab is delivered once a tab attaches", async () => {
  let attached = false;
  const h = harness({ hasAttachment: () => attached });
  append(h.file, { id: "mi-1", ts, text: "soon" });
  await h.c.drainOnce();
  assert.equal(h.drafted.length, 0);
  attached = true;
  await h.c.drainOnce();
  assert.deepEqual(h.drafted, [{ sid: "s1abc", id: "mi-1", text: "soon" }]);
});

test("an inject failure is retried, not lost: it stays unseen and delivers next drain", async () => {
  let fail = true;
  const pushed = [];
  const h = harness({ pushDraft: (sid, draft) => { if (fail) throw new Error("push failed"); pushed.push(draft); return 1; } });
  append(h.file, { id: "mi-1", ts, text: "resilient" });
  let r = await h.c.drainOnce();
  assert.deepEqual(r, [{ id: "mi-1", action: "retry" }]);
  fail = false;
  r = await h.c.drainOnce();
  assert.deepEqual(r, [{ id: "mi-1", action: "delivered" }]);
  assert.equal(pushed.length, 1);
});

test("a persistent failure eventually holds the entry rather than looping forever", async () => {
  const h = harness({ pushDraft: () => { throw new Error("push gone"); } });
  append(h.file, { id: "mi-1", ts, text: "doomed" });
  await h.c.drainOnce();          // retry
  h.advance(61_000);
  const r = await h.c.drainOnce(); // now expired -> held
  assert.deepEqual(r, [{ id: "mi-1", action: "held" }]);
  assert.deepEqual(h.held, [{ text: "doomed", id: "mi-1" }]);
});

test("durable disposition: a restart re-drafts nothing handled and loses nothing unhandled", async () => {
  const now0 = Date.parse("2026-08-25T12:00:00Z");
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  const file = queueFile();
  const stateFile = file + ".seen.json";
  // run 1: two young tasks arrive while a tab is attached; both drafted+persisted
  append(file, { id: "a", ts: iso(now0 - 5_000), text: "first" });
  append(file, { id: "b", ts: iso(now0 - 4_000), text: "second" });
  const h1 = harness({ file, stateFile, now0 });
  h1.c.prime();
  await h1.c.drainOnce();
  assert.deepEqual(h1.drafted.map((d) => d.id), ["a", "b"]);
  // a THIRD task is queued but not yet processed (simulating console going down)
  append(file, { id: "c", ts: iso(now0 - 2_000), text: "third, undelivered" });
  // run 2: a fresh consumer (restart) loads the durable disposition
  const h2 = harness({ file, stateFile, now0 });
  h2.c.prime();
  const r = await h2.c.drainOnce();
  const byId = Object.fromEntries(r.map((x) => [x.id, x.action]));
  assert.equal(byId.a, undefined, "an already-drafted task is not re-drafted after restart");
  assert.equal(byId.b, undefined, "nor the second");
  assert.equal(byId.c, "delivered", "the undelivered task survives the restart and is drafted");
  assert.deepEqual(h2.drafted.map((d) => d.id), ["c"]);
});

test("an expired undelivered entry is carded on the next drain, not lost", async () => {
  const h = harness();
  append(h.file, { id: "mi-1", ts, text: "stale" });
  h.advance(61_000);
  const r = await h.c.drainOnce();
  assert.deepEqual(r, [{ id: "mi-1", action: "held" }]);
  assert.deepEqual(h.held, [{ text: "stale", id: "mi-1" }]);
});

test("seen and held are pruned to ids still in the capped file", async () => {
  const h = harness();
  append(h.file, { id: "mi-1", ts, text: "one" });
  await h.c.drainOnce();
  assert.ok(h.c.seen.has("mi-1"));
  // the queue is rewritten without mi-1 (the ctl cap dropped it)
  fs.writeFileSync(h.file, JSON.stringify({ id: "mi-2", ts, text: "two" }) + "\n");
  await h.c.drainOnce();
  assert.ok(!h.c.seen.has("mi-1"), "an id no longer in the file is pruned from seen");
  assert.ok(h.c.seen.has("mi-2"));
});

test("holds an undeliverable entry only once", async () => {
  const h = harness({ liveMetaSid: () => null });
  append(h.file, { id: "mi-1", ts, text: "once" });
  h.advance(61_000);
  await h.c.drainOnce();
  await h.c.drainOnce();
  assert.equal(h.held.length, 1);
});

test("an entry that is only control characters is dropped, not delivered", async () => {
  const h = harness();
  append(h.file, { id: "mi-1", ts, text: String.fromCharCode(3) + String.fromCharCode(27) });
  const r = await h.c.drainOnce();
  assert.deepEqual(r, [{ id: "mi-1", action: "empty" }]);
  assert.equal(h.drafted.length, 0);
});

test("torn lines and entries with no text are skipped", async () => {
  const h = harness();
  fs.appendFileSync(h.file, "{ not json\n");
  append(h.file, { id: "mi-1", ts, text: "good" });
  fs.appendFileSync(h.file, JSON.stringify({ id: "mi-2" }) + "\n");
  const r = await h.c.drainOnce();
  assert.deepEqual(r, [{ id: "mi-1", action: "delivered" }]);
});

test("a missing queue file is not an error", async () => {
  const h = harness({ file: path.join(os.tmpdir(), "nope-" + process.pid, "q.jsonl") });
  assert.deepEqual(await h.c.drainOnce(), []);
});

test("a non-ENOENT read error preserves durable state instead of wiping it", async () => {
  const h = harness();
  append(h.file, { id: "mi-1", ts, text: "one" });
  await h.c.drainOnce();
  assert.ok(h.c.seen.has("mi-1"));
  // Point the reader at a DIRECTORY: readFileSync throws EISDIR for every uid
  // (deterministic, unlike chmod which root ignores). The drain must change
  // nothing and keep the durable disposition, not wipe it and redeliver.
  const dirAsFile = fs.mkdtempSync(path.join(os.tmpdir(), "hq-mi-dir-"));
  h.c.file = dirAsFile;
  const r = await h.c.drainOnce();
  assert.deepEqual(r, []);
  assert.ok(h.c.seen.has("mi-1"), "durable disposition survived the unreadable pass");
});
