import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Goals } from "../src/goals.js";
import { tmpDir } from "./helpers.js";

const mk = (over = {}) => new Goals({ dir: tmpDir("goals"), now: () => Date.parse("2026-10-06T12:00:00Z"), ...over });

test("goals: add, list, replay, remove, and the file reloads to the same state", async () => {
  const g = mk().load();
  const a = await g.add({ op: "g1", label: "Cover the month", kind: "in", targetCents: 6000000, currency: "MXN" });
  assert.equal(a.replayed, false);
  assert.match(a.goal.id, /^g-[0-9a-f]{12}$/);
  assert.deepEqual({ ...a.goal, id: "x", createdAt: "t" }, {
    id: "x", label: "Cover the month", kind: "in", targetCents: 6000000, currency: "MXN", month: null, by: null, client: null, createdAt: "t",
  });
  const b = await g.add({ op: "g2", kind: "out", targetCents: 500000, currency: "MXN", month: "2026-10", client: "acme" });
  const c = await g.add({ op: "g3", kind: "net", targetCents: 20000000, currency: "MXN", by: "2026-12-31" });
  assert.equal((await g.add({ op: "g1", kind: "in", targetCents: 1, currency: "USD" })).replayed, true, "an op key replays");
  assert.deepEqual(g.list().map((x) => x.id), [a.goal.id, b.goal.id, c.goal.id], "oldest first");
  const rm = await g.remove({ op: "r1", target: b.goal.id });
  assert.equal(rm.target, b.goal.id);
  assert.equal((await g.remove({ op: "r1", target: b.goal.id })).replayed, true);
  await assert.rejects(g.remove({ op: "r2", target: b.goal.id }), /already removed/);
  await assert.rejects(g.remove({ op: "r3", target: "g-000000000000" }), /no such goal/);
  assert.deepEqual(g.list().map((x) => x.id), [a.goal.id, c.goal.id]);
  const again = new Goals({ dir: path.dirname(g.file) }).load();
  assert.deepEqual(again.list(), g.list(), "a reload reads back exactly what was written");
});

test("goals: every refusal is a 400 with a reason, and nothing is written", async () => {
  const g = mk().load();
  const bad = [
    [{ kind: "in", targetCents: 100, currency: "MXN" }, /op/],
    [{ op: "x1", kind: "sideways", targetCents: 100, currency: "MXN" }, /kind/],
    [{ op: "x2", kind: "in", targetCents: 0, currency: "MXN" }, /targetCents/],
    [{ op: "x3", kind: "in", targetCents: 12.5, currency: "MXN" }, /targetCents/],
    [{ op: "x4", kind: "in", targetCents: 100, currency: "EUR" }, /currency/],
    [{ op: "x5", kind: "in", targetCents: 100, currency: "MXN", month: "2026-13" }, /month/],
    [{ op: "x6", kind: "net", targetCents: 100, currency: "MXN", month: "2026-10" }, /net goal has no month/],
    [{ op: "x7", kind: "in", targetCents: 100, currency: "MXN", by: "2026-12-31" }, /only a net goal/],
    [{ op: "x8", kind: "net", targetCents: 100, currency: "MXN", by: "2026-02-30" }, /real yyyy-mm-dd/],
    [{ op: "x9", kind: "in", targetCents: 100, currency: "MXN", client: "Orbit Acme" }, /slug/],
    [{ op: "x10", kind: "net", targetCents: 100, currency: "MXN", client: "acme" }, /not one client/],
  ];
  for (const [body, re] of bad) {
    await assert.rejects(g.add(body), (e) => re.test(e.message) && e.status === 400, `${JSON.stringify(body)} should fail ${re}`);
  }
  assert.equal(fs.existsSync(g.file), false, "no refused goal reaches disk");
});

test("goals: a torn final line is dropped, a bad middle line marks the store corrupt, read-only never writes", async () => {
  const g = mk().load();
  await g.add({ op: "g1", kind: "in", targetCents: 100, currency: "MXN" });
  fs.appendFileSync(g.file, '{"t":"goal","id":"g-aaaaaaaaaaaa","op":"g2","ts":"2026-10-06T12:00:00.000Z","kind":"in","target');
  const torn = new Goals({ dir: path.dirname(g.file) }).load();
  assert.equal(torn.corrupt, null);
  assert.equal(torn.list().length, 1);
  assert.equal(fs.readFileSync(g.file, "utf8").split("\n").filter(Boolean).length, 1, "the torn tail was truncated away");

  fs.appendFileSync(g.file, '{"t":"goal","id":"g-bbbbbbbbbbbb","op":"g3","ts":"2026-10-06T12:00:00.000Z","kind":"in","targetCents":-5,"currency":"MXN"}\n');
  const corrupt = new Goals({ dir: path.dirname(g.file) }).load();
  assert.match(corrupt.corrupt, /corruption/);
  assert.throws(() => corrupt.list(), /corruption/);
  await assert.rejects(corrupt.add({ op: "g4", kind: "in", targetCents: 1, currency: "MXN" }), (e) => e.status === 503);

  const ro = new Goals({ dir: tmpDir("goals-ro"), readOnly: true }).load();
  await assert.rejects(ro.add({ op: "g1", kind: "in", targetCents: 1, currency: "MXN" }), /read-only/);
});

test("goals: a failed append poisons the store until a reload, so a retry cannot write the op twice", async () => {
  const g = mk().load();
  await g.add({ op: "g1", kind: "in", targetCents: 100, currency: "MXN" });
  const realFsync = fs.fsyncSync;
  fs.fsyncSync = () => {
    throw new Error("EIO: simulated");
  };
  try {
    await assert.rejects(g.add({ op: "g2", kind: "in", targetCents: 200, currency: "MXN" }), (e) => e.status === 503 && /mid-write/.test(e.message));
    await assert.rejects(g.add({ op: "g2", kind: "in", targetCents: 200, currency: "MXN" }), (e) => e.status === 503, "the retry is refused, not duplicated");
  } finally {
    fs.fsyncSync = realFsync;
  }
  const reloaded = new Goals({ dir: path.dirname(g.file) }).load();
  assert.equal(reloaded.corrupt, null, "what reached disk is a clean file either way");
  assert.ok(reloaded.list().length >= 1);
});
