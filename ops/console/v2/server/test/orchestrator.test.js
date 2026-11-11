// Orchestrator panels on Now (hq-4npjr.5): the hold rule fails closed, the decision log
// and project updates are validated, and the loaded list only ever names committed
// uploads by id.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { computeBadges, liveOrchestrator, mapRequests, orchestratorHolds, ORCH_HOLD_S } from "../src/map.js";
import { LoadedFiles, countEventsToday, loadRoute, readApproved, readProjectUpdates } from "../src/orchestrator.js";
import { startTestApp, tmpDir } from "./helpers.js";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const ago = (s) => new Date(NOW - s * 1000).toISOString();
const orch = (state = "running") => ({ id: "s-orch", name: "orchestrator", state });
const ask = (over = {}) => ({ id: "r-1", state: "open", to: "orchestrator", createdAt: ago(60), severity: "P1", ...over });

// ---------- the hold rule ----------

test("a fresh ask to a live orchestrator is held", () => {
  assert.equal(orchestratorHolds(ask(), [orch()], NOW), true);
  assert.equal(orchestratorHolds(ask(), [orch("waiting")], NOW), true);
  assert.equal(orchestratorHolds(ask(), [orch("idle")], NOW), true);
});

test("fail-closed: no orchestrator, a dead or asleep one, or ten minutes untouched shows the ask", () => {
  assert.equal(orchestratorHolds(ask(), [], NOW), false, "missing orchestrator");
  assert.equal(orchestratorHolds(ask(), [orch("closed")], NOW), false, "crashed orchestrator");
  assert.equal(orchestratorHolds(ask(), [orch("snoozed")], NOW), false, "asleep orchestrator");
  assert.equal(orchestratorHolds(ask(), [orch("finishable")], NOW), false, "exited orchestrator");
  assert.equal(orchestratorHolds(ask({ createdAt: ago(ORCH_HOLD_S) }), [orch()], NOW), false, "cap hit or stuck: ten minutes");
  assert.equal(orchestratorHolds(ask({ createdAt: "garbage" }), [orch()], NOW), false, "unreadable age");
  assert.equal(orchestratorHolds(ask({ to: "owner" }), [orch()], NOW), false, "forwarded");
  assert.equal(orchestratorHolds(ask({ to: null }), [orch()], NOW), false, "pre-routing ask");
  assert.equal(orchestratorHolds(ask({ state: "answered" }), [orch()], NOW), false, "settled");
  // a session merely carrying another name is not the orchestrator
  assert.equal(orchestratorHolds(ask(), [{ id: "s-x", name: "orchestrator 2", state: "running" }], NOW), false);
});

test("liveOrchestrator picks the running one over an asleep twin", () => {
  assert.equal(liveOrchestrator([orch("snoozed"), { ...orch(), id: "s-2" }]).id, "s-2");
  assert.equal(liveOrchestrator([{ ...orch(), name: " Orchestrator " }]).id, "s-orch");
});

test("the Now badge leaves out held asks and counts them again once the orchestrator is gone", () => {
  const requests = [ask(), ask({ id: "r-2", to: null, severity: "P2" })];
  assert.equal(computeBadges({ requests, sessions: [orch()] }, NOW).now, 1);
  assert.equal(computeBadges({ requests, sessions: [orch()] }, NOW).nowSeverity, "P2");
  assert.equal(computeBadges({ requests, sessions: [] }, NOW).now, 2);
  assert.equal(computeBadges({ requests, sessions: [] }, NOW).nowSeverity, "P1");
});

test("mapRequests carries to and forward_class", () => {
  const [r] = mapRequests({ requests: [{ id: "r-9", question: "q", ts: ago(5), to: "owner", forward_class: "taste" }] }, NOW);
  assert.equal(r.to, "owner");
  assert.equal(r.forwardClass, "taste");
  const [old] = mapRequests({ requests: [{ id: "r-8", question: "q", ts: ago(5) }] }, NOW);
  assert.equal(old.to, null);
});

// ---------- the decision log, events and project updates ----------

function stateWith(files) {
  const dir = tmpDir();
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

test("approved log: newest first, garbage dropped, today counted", () => {
  const lines = [
    { ts: ago(3600), kind: "merge", text: "Merged hq-1", why: "tests pass", bead: "hq-1", rig: "hq" },
    { ts: ago(60), kind: "answer", text: "Answered s-1", why: "from the facts file" },
    { ts: ago(30), kind: "launch-missiles", text: "bad kind" },
    { ts: "yesterday", kind: "merge", text: "bad ts" },
    { ts: ago(10), kind: "merge", text: "" },
    { ts: ago(20), kind: "review", text: "x\u0007y", bead: "../etc" },
    { ts: new Date(NOW - 40 * 3600 * 1000).toISOString(), kind: "snooze", text: "two days ago" },
  ].map((o) => JSON.stringify(o));
  const dir = stateWith({ "orchestrator/approved.jsonl": ["not json", ...lines].join("\n") + "\n" });
  const out = readApproved(dir, NOW);
  assert.deepEqual(out.rows.map((r) => r.text), ["x y", "Answered s-1", "Merged hq-1", "two days ago"]);
  assert.equal(out.rows[0].bead, null, "a path is not a bead id");
  assert.equal(out.rows[2].why, "tests pass");
  assert.ok(out.today >= 2 && out.today <= 3, "the 40 h old row is not today");
  assert.deepEqual(readApproved(tmpDir(), NOW), { rows: [], today: 0 });
});

test("events today is null before the runner exists and counts today's rows after", () => {
  assert.equal(countEventsToday(tmpDir(), NOW), null);
  const dir = stateWith({
    "orchestrator/events.jsonl": [JSON.stringify({ ts: ago(5), type: "done" }), "{torn", JSON.stringify({ ts: new Date(NOW - 50 * 3600e3).toISOString() })].join("\n"),
  });
  assert.equal(countEventsToday(dir, NOW), 1);
});

test("project updates: one valid line per rig, the rest dropped", () => {
  const dir = stateWith({
    "console/project-updates.json": JSON.stringify({
      hq: { at: ago(30), text: "Merged hq-4npjr.5" },
      "../x": { at: ago(30), text: "bad rig" },
      peel: { at: "never", text: "bad time" },
      gym: "not an object",
    }),
  });
  assert.deepEqual(Object.keys(readProjectUpdates(dir)), ["hq"]);
  assert.deepEqual(readProjectUpdates(tmpDir()), {});
});

// ---------- the loaded list ----------

function fakeUploads(rows) {
  return {
    store: { get: (id) => rows[id] || null },
    setKeep(id, keep) {
      const row = rows[id];
      if (!row) return { ok: false, status: 404, error: "no such upload" };
      row.keep = keep;
      return { ok: true, entry: { id, name: row.name, path: `/inbox/files/${row.name}`, size: row.size, ref: `hqconsole://upload/${id}` } };
    },
  };
}

test("load keeps the upload and lists it; unload drops it and undoes only its own keep", () => {
  const rows = { "up-a": { name: "a.pdf", size: 10, keep: false }, "up-b": { name: "b.md", size: 20, keep: true } };
  const uploads = fakeUploads(rows);
  const loaded = new LoadedFiles(path.join(tmpDir(), "orchestrator-loaded.json"), () => NOW);
  assert.equal(loadRoute("/api/orchestrator/load", { id: "up-a" }, { uploads, loaded }).status, 200);
  assert.equal(loadRoute("/api/orchestrator/load", { id: "up-b" }, { uploads, loaded }).status, 200);
  assert.equal(rows["up-a"].keep, true);
  assert.deepEqual(loaded.list().map((f) => f.id), ["up-b", "up-a"]);
  assert.equal(loaded.list()[1].path, "/inbox/files/a.pdf", "the path comes from the store");
  loadRoute("/api/orchestrator/unload", { id: "up-a" }, { uploads, loaded });
  loadRoute("/api/orchestrator/unload", { id: "up-b" }, { uploads, loaded });
  assert.equal(rows["up-a"].keep, false, "the keep this list set is undone");
  assert.equal(rows["up-b"].keep, true, "a keep the owner set stays");
  assert.deepEqual(loaded.list(), []);
});

test("a second load keeps the first load's keptBefore, so unload still clears the keep", () => {
  const rows = { "up-a": { name: "a.pdf", size: 10, keep: false } };
  const uploads = fakeUploads(rows);
  const loaded = new LoadedFiles(path.join(tmpDir(), "orchestrator-loaded.json"), () => NOW);
  assert.equal(loadRoute("/api/orchestrator/load", { id: "up-a" }, { uploads, loaded }).status, 200);
  assert.equal(loadRoute("/api/orchestrator/load", { id: "up-a" }, { uploads, loaded }).status, 200);
  assert.equal(loaded.list().length, 1);
  assert.equal(loaded.list()[0].keptBefore, false);
  loadRoute("/api/orchestrator/unload", { id: "up-a" }, { uploads, loaded });
  assert.equal(rows["up-a"].keep, false, "the retention sweep can take the file again");
});

test("load refuses a bad or unknown id and never takes a path", () => {
  const uploads = fakeUploads({});
  const loaded = new LoadedFiles(path.join(tmpDir(), "l.json"));
  assert.equal(loadRoute("/api/orchestrator/load", { id: "../../etc/passwd" }, { uploads, loaded }).status, 400);
  assert.equal(loadRoute("/api/orchestrator/load", { path: "/etc/passwd" }, { uploads, loaded }).status, 400);
  assert.equal(loadRoute("/api/orchestrator/load", { id: "up-none" }, { uploads, loaded }).status, 404);
  assert.equal(loadRoute("/api/orchestrator/unload", { id: "up-none" }, { uploads, loaded }).status, 404);
  assert.equal(loadRoute("/api/other", { id: "x" }, { uploads, loaded }), null);
  assert.deepEqual(loaded.list(), []);
});

// ---------- over HTTP ----------

test("GET /api/orchestrator serves the report; POST needs the console key", async () => {
  const app = await startTestApp();
  try {
    fs.mkdirSync(path.join(app.cfg.stateDir, "orchestrator"), { recursive: true });
    fs.writeFileSync(
      path.join(app.cfg.stateDir, "orchestrator", "approved.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), kind: "merge", text: "Merged hq-1", why: "green" }) + "\n",
    );
    const res = await app.request("GET", "/api/orchestrator");
    assert.equal(res.status, 200);
    assert.equal(res.json.approved[0].text, "Merged hq-1");
    assert.equal(res.json.eventsToday, null);
    assert.deepEqual(res.json.loaded, []);
    const nokey = await app.request("POST", "/api/orchestrator/load", { body: { id: "up-x" } });
    assert.equal(nokey.status, 403);
    const unknown = await app.request("POST", "/api/orchestrator/load", { body: { id: "up-x" }, headers: { "x-console-key": app.key } });
    assert.equal(unknown.status, 404);
  } finally {
    await app.close();
  }
});

test("GET /api/state badge hides an ask only while the orchestrator is live", async () => {
  const ts = new Date().toISOString();
  const terminals = [{ id: "s-orch", kind: "interactive", status: "active", name: "orchestrator", last_seen: ts, pane_live: true }];
  const requests = [{ id: "r-1", status: "open", question: "q", ts, to: "orchestrator" }];
  for (const [rows, want] of [
    [terminals, 0],
    [[], 1],
  ]) {
    const app = await startTestApp({ sources: { ctlState: async () => ({ terminals: rows, requests, snoozed: [], phases: {}, tasks: {}, usage: {} }) } });
    try {
      const res = await app.request("GET", "/api/state");
      assert.equal(res.status, 200);
      assert.equal(res.json.requests.length, 1, "the ask is never dropped from the state");
      assert.equal(res.json.badges.now, want);
    } finally {
      await app.close();
    }
  }
});

test("deleting a loaded upload drops it from the loaded list", async () => {
  const rows = { "up-a": { name: "a.pdf", size: 10, keep: false }, "up-b": { name: "b.md", size: 20, keep: false } };
  const uploads = {
    ...fakeUploads(rows),
    handle: () => {},
    list: () => [],
    remove(id) {
      if (!rows[id]) return { ok: false, status: 404, error: "no such upload" };
      delete rows[id];
      return { ok: true };
    },
  };
  const loaded = new LoadedFiles(path.join(tmpDir(), "orchestrator-loaded.json"), () => NOW);
  const app = await startTestApp({ uploads, loaded });
  try {
    const h = { "x-console-key": app.key };
    assert.equal((await app.request("POST", "/api/orchestrator/load", { body: { id: "up-a" }, headers: h })).status, 200);
    assert.equal((await app.request("POST", "/api/orchestrator/load", { body: { id: "up-b" }, headers: h })).status, 200);
    assert.equal((await app.request("POST", "/api/uploads/up-a/delete", { body: {}, headers: h })).status, 200);
    assert.deepEqual(loaded.list().map((f) => f.id), ["up-b"]);
    const missing = await app.request("POST", "/api/uploads/up-zz/delete", { body: {}, headers: h });
    assert.equal(missing.status, 404);
    assert.deepEqual(loaded.list().map((f) => f.id), ["up-b"], "a failed delete leaves the list alone");
  } finally {
    await app.close();
  }
});
