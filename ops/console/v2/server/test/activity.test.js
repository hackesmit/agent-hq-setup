import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  activityFromAlerts,
  activityFromGit,
  activityFromOps,
  activityFromRequests,
  mergeActivity,
  readOpsDir,
  ACTIVITY_CAP,
} from "../src/activity.js";
import { opMeta } from "../src/actions.js";
import { startTestApp } from "./helpers.js";

test("activityFromGit parses the wrapper format and keeps tabs inside subjects", () => {
  const stdout = [
    "aaaa1111bbbb2222\t1755550000\towner\tconsole v2: phase 1 wiring",
    "cccc3333dddd4444\t1755540000\towner\tMerge branch 'bead/xd-1' into main",
    "eeee5555ffff6666\t1755530000\towner\tsubject with\ta tab in it",
    "",
    "not a real line",
  ].join("\n");
  const events = activityFromGit("acme-dashboard", stdout);
  assert.equal(events.length, 3);
  assert.equal(events[0].type, "commit");
  assert.equal(events[0].rig, "acme-dashboard");
  assert.equal(events[0].ts, new Date(1755550000 * 1000).toISOString());
  assert.equal(events[1].type, "merge");
  assert.equal(events[2].title, "subject with a tab in it");
  assert.ok(events.every((e) => e.id.startsWith("git-acme-dashboard-")));
});

test("activityFromOps maps verbs to types and surfaces failures as P2", () => {
  const recs = [
    {
      id: "op-1",
      verb: "dispatch",
      state: "done",
      startedAt: "2026-08-18T10:00:00Z",
      finishedAt: "2026-08-18T10:00:05Z",
      meta: { bead: "xd-9", rig: "acme-dashboard" },
    },
    {
      id: "op-2",
      verb: "finish",
      state: "failed",
      startedAt: "2026-08-18T11:00:00Z",
      finishedAt: "2026-08-18T11:01:00Z",
      error: "conflict in src/app.js",
      meta: { session: "t-1a2b" },
    },
    { id: "op-3", verb: "focus", state: "done", startedAt: "2026-08-18T12:00:00Z", finishedAt: null },
    { verb: "broken, no id" },
  ];
  const events = activityFromOps(recs);
  assert.equal(events.length, 3);
  assert.equal(events[0].type, "dispatch");
  assert.equal(events[0].bead, "xd-9");
  assert.equal(events[0].ts, "2026-08-18T10:00:05Z");
  assert.match(events[0].title, /dispatch xd-9 on acme-dashboard/);
  assert.equal(events[1].type, "finish");
  assert.equal(events[1].sev, "P2");
  assert.match(events[1].title, /^failed: finish/);
  assert.equal(events[1].detail, "conflict in src/app.js");
  assert.equal(events[2].type, "op");
  assert.equal(events[2].ts, "2026-08-18T12:00:00Z");
});

test("activityFromRequests emits an ask, and an answer only once settled", () => {
  const requests = [
    {
      id: "r-1",
      kind: "run",
      severity: "P1",
      state: "open",
      rig: "hq",
      session: "t-1",
      bead: null,
      createdAt: "2026-08-18T09:00:00Z",
      question: "run the migration?",
      answer: null,
      settledAt: null,
    },
    {
      id: "r-2",
      kind: "decide",
      severity: "P2",
      state: "answered",
      rig: null,
      session: null,
      bead: "hq-7",
      createdAt: "2026-08-18T08:00:00Z",
      question: "keep or revert?",
      answer: "keep it",
      settledAt: "2026-08-18T08:30:00Z",
    },
    {
      id: "r-3",
      kind: "info",
      severity: "P2",
      state: "cancelled",
      createdAt: "2026-08-18T07:00:00Z",
      question: "gone",
      settledAt: "2026-08-18T07:10:00Z",
    },
  ];
  const events = activityFromRequests(requests);
  const asks = events.filter((e) => e.type === "ask");
  const answers = events.filter((e) => e.type === "answer");
  assert.equal(asks.length, 3);
  assert.equal(answers.length, 1, "a cancelled request settles without an answer event");
  assert.equal(asks[0].sev, "P1");
  assert.equal(answers[0].title, "keep it");
  assert.equal(answers[0].detail, "keep or revert?");
  assert.equal(answers[0].ts, "2026-08-18T08:30:00Z");
});

test("activityFromAlerts carries severity and detail", () => {
  const events = activityFromAlerts([
    { id: "a-1", severity: "P1", title: "upload commit failed", detail: "disk full", createdAt: "2026-08-18T06:00:00Z", source: "uploads" },
    { id: "no-ts", severity: "P2", title: "dropped" },
  ]);
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].type, events[0].sev, events[0].detail], ["error", "P1", "disk full"]);
});

test("mergeActivity sorts newest first, dedupes ids and caps the stream", () => {
  const mk = (id, ts) => ({ id, ts, type: "commit", rig: null, session: null, bead: null, title: id, detail: null, sev: null });
  const merged = mergeActivity([
    [mk("a", "2026-08-18T01:00:00Z"), mk("b", "2026-08-18T03:00:00Z")],
    [mk("a", "2026-08-18T05:00:00Z"), mk("c", "2026-08-18T02:00:00Z"), { id: "bad-ts", ts: "not a date" }],
  ]);
  assert.deepEqual(merged.map((e) => e.id), ["b", "c", "a"], "first occurrence of a duplicate id wins");
  const big = mergeActivity([Array.from({ length: ACTIVITY_CAP + 50 }, (_, i) => mk(`e${i}`, new Date(1755500000000 + i * 1000).toISOString()))]);
  assert.equal(big.length, ACTIVITY_CAP);
});

test("readOpsDir returns newest first and skips junk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-activity-"));
  try {
    fs.writeFileSync(path.join(dir, "op-old.json"), JSON.stringify({ id: "op-old", verb: "focus" }));
    fs.utimesSync(path.join(dir, "op-old.json"), new Date(0), new Date(1000000));
    fs.writeFileSync(path.join(dir, "op-new.json"), JSON.stringify({ id: "op-new", verb: "dispatch" }));
    fs.writeFileSync(path.join(dir, "garbage.json"), "{not json");
    fs.writeFileSync(path.join(dir, "not-an-op.txt"), "ignored");
    const recs = readOpsDir(dir);
    assert.deepEqual(recs.map((r) => r.id), ["op-new", "op-old"]);
    assert.deepEqual(readOpsDir(path.join(dir, "missing")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("opMeta keeps id-shaped fields and drops free text and options", () => {
  assert.deepEqual(opMeta({ rig: "hq", bead: "hq-1", session: "t-1", text: "free text!" }), {
    rig: "hq",
    bead: "hq-1",
    session: "t-1",
  });
  assert.deepEqual(opMeta({ rid: "r-9", reason: "a long reason" }), { rid: "r-9" });
  assert.deepEqual(opMeta({ beads: ["a-1", "bad one", "b-2"] }), { beads: "a-1,b-2" });
  assert.equal(opMeta({ rig: "-flag" }), null, "an option-shaped value never lands in meta");
  assert.equal(opMeta({}), null);
});

test("the activity slice is served over /api/state and /api/state/activity", async () => {
  const gitOut = "abcd1234abcd1234\t1755550000\towner\tconsole v2: a change\n";
  const t = await startTestApp({ sources: { gitLog: async (dir) => (dir.endsWith("hq") ? gitOut : "") } });
  try {
    const full = await t.request("GET", "/api/state");
    assert.equal(full.status, 200);
    assert.ok(Array.isArray(full.json.activity), "activity must be a ConsoleState slice");
    const one = await t.request("GET", "/api/state/activity");
    assert.equal(one.status, 200);
    assert.equal(one.json.slice, "activity");
    const commit = one.json.data.find((e) => e.id.startsWith("git-hq-"));
    assert.ok(commit, `the hq git source should land in the stream, got ${JSON.stringify(one.json.data)}`);
    assert.equal(commit.title, "console v2: a change");
  } finally {
    await t.close();
  }
});

test("an op executed through a verb appears in the activity stream with its meta", async () => {
  const t = await startTestApp({
    runner: async () => ({ code: 0, stdout: "ok", stderr: "" }),
    sources: { gitLog: async () => "" },
  });
  try {
    const r = await t.request("POST", "/api/dispatch", {
      body: { rig: "hq", bead: "hq-42", model: "claude-sonnet-5" },
      headers: { "x-console-key": t.key },
    });
    assert.equal(r.status, 202, r.text);
    for (let i = 0; i < 50; i++) {
      const op = await t.request("GET", `/api/op/${r.json.id}`);
      if (op.json && op.json.state !== "running") break;
      await new Promise((res) => setTimeout(res, 20));
    }
    const slice = await t.request("GET", "/api/state/activity");
    const ev = slice.json.data.find((e) => e.id === `op-${r.json.id}`);
    assert.ok(ev, "the dispatch op must appear in activity");
    assert.equal(ev.type, "dispatch");
    assert.equal(ev.bead, "hq-42");
    assert.equal(ev.rig, "hq");
  } finally {
    await t.close();
  }
});
