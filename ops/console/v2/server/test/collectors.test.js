import test from "node:test";
import assert from "node:assert/strict";
import { Alerts } from "../src/alerts.js";
import { Collectors, parseReadyText, registerAll } from "../src/collectors.js";
import { devConfig, fakeSources, tmpDir } from "./helpers.js";

test("a fresh value is served from cache until its ttl expires", async () => {
  let now = 0;
  let calls = 0;
  const reg = new Collectors({ now: () => now });
  reg.register("x", 10, async () => ++calls);
  assert.equal(await reg.get("x"), 1);
  now += 9000;
  assert.equal(await reg.get("x"), 1);
  now += 2000;
  assert.equal(await reg.get("x"), 2);
  assert.equal(calls, 2);
});

test("refreshes asked for during a run share ONE follow-up run, never one each", async () => {
  let calls = 0;
  const reg = new Collectors({});
  reg.register("x", 10, async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return calls;
  });
  await Promise.all([reg.refresh("x"), reg.refresh("x"), reg.refresh("x")]);
  // The first call runs; the two that arrived mid-run cannot trust that run's
  // result, so they share a single run after it. Two runs, not one, not three.
  assert.equal(calls, 2);
});

test("a refresh during a run sees the change that prompted it (money: the auto-post race)", async () => {
  // Models the real sequence: the money collector is mid-refresh (it has already
  // read the ledger) when a commitment lands and the route asks for a refresh.
  let ledger = "empty";
  let seenAtRead = null;
  let release;
  const gate = new Promise((r) => (release = r));
  const reg = new Collectors({});
  reg.register("money", 300, async () => {
    const snapshot = ledger; // the read happens at the START of the run
    await gate;
    seenAtRead = snapshot;
    return snapshot;
  });
  const first = reg.refresh("money");
  await new Promise((r) => setImmediate(r)); // let run A start and take its read
  ledger = "one commitment"; // the write lands while the first run is in flight
  const second = reg.refresh("money");
  release();
  await first;
  assert.equal(seenAtRead, "empty", "the first run really did read before the write");
  await second;
  assert.equal(reg.peek("money"), "one commitment", "the caller's refresh reflects its own write");
});

test("get() during a run with a queued follow-up waits for the follow-up, not the stale run (lucy)", async () => {
  let ledger = "empty";
  let release;
  const gate = new Promise((r) => (release = r));
  const reg = new Collectors({});
  let calls = 0;
  reg.register("money", 300, async () => {
    calls += 1;
    const snapshot = ledger;
    if (calls === 1) await gate;
    return snapshot;
  });
  const first = reg.refresh("money");
  await new Promise((r) => setImmediate(r)); // run A has taken its read
  ledger = "one commitment";
  const write = reg.refresh("money"); // queues the follow-up
  const read = reg.get("money"); // a reader arrives while A is still running
  release();
  await Promise.all([first, write]);
  assert.equal(await read, "one commitment", "the reader never sees data the write predates");
  assert.equal(calls, 2, "and the reader did not start a third run");
});

test("a collector that throws synchronously fails cleanly and runs again next time (lucy: no livelock)", async () => {
  let calls = 0;
  const reg = new Collectors({});
  reg.register("x", 10, () => {
    calls += 1;
    throw new Error("boom");
  });
  const first = await reg.refresh("x");
  assert.match(first.error, /boom/);
  // The slot must be clear again, or the second call waits on a settled
  // promise forever (old code) or chases its own queue (new code).
  const second = await reg.refresh("x");
  assert.match(second.error, /boom/);
  assert.equal(calls, 2);
  // And the same when the sync throw happens while a follow-up is queued.
  const [a, b] = await Promise.all([reg.refresh("x"), reg.refresh("x")]);
  assert.match(a.error, /boom/);
  assert.match(b.error, /boom/);
  assert.equal(calls, 4);
});

test("a run started in the settlement gap is joined, not stacked behind (lucy: exactly one follow-up)", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const reg = new Collectors({});
  reg.register("x", 10, async () => {
    calls += 1;
    if (calls === 1) await gate;
    return calls;
  });
  const first = reg.refresh("x");
  // A continuation registered BEFORE the queued follow-up: it runs first when
  // A settles and starts run B in the gap.
  const chained = first.then(() => reg.refresh("x"));
  const queued = reg.refresh("x"); // arrives during run A
  release();
  await Promise.all([first, chained, queued]);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 2, "run A, then one follow-up shared by both later callers");
});

test("get() joins a run already in flight instead of queueing another", async () => {
  let calls = 0;
  const reg = new Collectors({});
  reg.register("x", 10, async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return calls;
  });
  const [a, b, c] = await Promise.all([reg.get("x"), reg.get("x"), reg.get("x")]);
  assert.deepEqual([a, b, c], [1, 1, 1]);
  assert.equal(calls, 1);
});

test("a failure fills the error slot and keeps the last good data", async () => {
  let mode = "ok";
  const reg = new Collectors({});
  reg.register("x", 0, async () => {
    if (mode === "boom") throw new Error("ctl state produced no JSON");
    return { v: 1 };
  });
  await reg.refresh("x");
  mode = "boom";
  const r = await reg.refresh("x");
  assert.match(r.error, /no JSON/);
  assert.deepEqual(reg.peek("x"), { v: 1 });
  const st = reg.statuses().find((s) => s.name === "x");
  assert.match(st.error, /no JSON/);
  assert.equal(typeof st.durationMs, "number");
  mode = "ok";
  await reg.refresh("x");
  assert.equal(reg.statuses().find((s) => s.name === "x").error, null);
});

test("change detection only fires when the value actually changed", async () => {
  let value = { a: 1 };
  const seen = [];
  const reg = new Collectors({});
  reg.register("x", 0, async () => value);
  reg.onChange((name, data) => seen.push([name, data]));
  assert.equal((await reg.refresh("x")).changed, true);
  assert.equal((await reg.refresh("x")).changed, false);
  value = { a: 1 }; // equal content, different object identity
  assert.equal((await reg.refresh("x")).changed, false);
  value = { a: 2 };
  assert.equal((await reg.refresh("x")).changed, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[0][0], "x");
});

test("internal collectors are not reported as slices", async () => {
  const reg = new Collectors({});
  reg.register("_ctl", 5, async () => ({}), { internal: true });
  reg.register("sessions", 5, async () => []);
  await reg.refreshAll();
  assert.deepEqual(
    reg.statuses().map((s) => s.name),
    ["sessions"],
  );
});

test("a listener that throws does not break the refresh", async () => {
  const reg = new Collectors({});
  reg.register("x", 0, async () => 1);
  reg.onChange(() => {
    throw new Error("listener blew up");
  });
  const r = await reg.refresh("x");
  assert.equal(r.changed, true);
  assert.equal(r.error, null);
});

test("the phase 0 set maps ctl state into contract shapes", async () => {
  const cfg = devConfig({ stateDir: tmpDir() });
  const reg = new Collectors({});
  registerAll(reg, {
    cfg,
    alerts: new Alerts({ file: cfg.alertsFile, readOnly: true }),
    readOnly: true,
    sources: fakeSources({
      ctlState: async () => ({
        terminals: [{ id: "t-1", kind: "worker", rig: "chesski", bead: "ck-9", status: "active", started: "2026-08-18T10:00:00Z" }],
        requests: [{ id: "r-1", question: "run this", status: "open", ts: "2026-08-18T10:05:00Z", rig: "chesski", session: "t-1" }],
        snoozed: [],
        phases: { "ck-9": { phases: [{ name: "plan", done: true }] } },
        tasks: { chesski: { total: 2, beads: [{ id: "ck-9", status: "in_progress" }, { id: "ck-10", status: "open" }] } },
        usage: { pct: 6.1 },
      }),
      readyBeads: async (rig) => (rig.id === "chesski" ? [{ id: "ck-10", title: "next", priority: 1, labels: [] }] : []),
    }),
  });
  await reg.refreshAll();
  const sessions = reg.peek("sessions");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].state, "waiting"); // it has an open question
  assert.deepEqual(sessions[0].phases, [{ name: "plan", done: true }]);
  const ready = reg.peek("ready");
  assert.equal(ready[0].id, "ck-10");
  assert.equal(ready[0].rig, "chesski");
  const projects = reg.peek("projects");
  const ck = projects.find((p) => p.id === "chesski");
  assert.equal(ck.counts.inProgress, 1);
  assert.equal(ck.needsYou, 1);
  assert.equal(ck.attention, "needs-you");
  assert.equal(ck.nextUp.id, "ck-10");
  assert.equal(reg.peek("usage").planUsage.fiveHourPct, 6.1);
  assert.equal(reg.peek("machine").cores, 4);
});

test("one broken rig does not blank the ready list", async () => {
  const cfg = devConfig({ stateDir: tmpDir() });
  const reg = new Collectors({});
  registerAll(reg, {
    cfg,
    alerts: new Alerts({ file: cfg.alertsFile, readOnly: true }),
    readOnly: true,
    sources: fakeSources({
      readyBeads: async (rig) => {
        if (rig.id === "gym-tracker") throw new Error("bd: no such database");
        return rig.id === "hq" ? [{ id: "hq-1", title: "t", priority: 0, labels: [] }] : [];
      },
    }),
  });
  const r = await reg.refresh("ready");
  assert.equal(r.error, null);
  assert.equal(reg.peek("ready").length, 1);
});

test("bd text output is parsed when --json is unavailable", () => {
  const rows = parseReadyText("  hq-abc  P1  fix the thing\n  xd-12 2 another\nnot a bead line\n");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "hq-abc");
  assert.equal(rows[1].id, "xd-12");
});

test("an idle session with an open question shows as waiting (hq-zqqu.1)", async () => {
  const { mapSessions } = await import("../src/map.js");
  const now = Date.parse("2026-10-20T10:10:00Z");
  const ctl = {
    terminals: [
      { id: "t-idle", kind: "worker", status: "idle", started: "2026-10-20T10:00:00Z", last_seen: "2026-10-20T10:09:00Z" },
      { id: "t-quiet", kind: "worker", status: "idle", started: "2026-10-20T10:00:00Z", last_seen: "2026-10-20T10:09:00Z" },
      { id: "t-done", kind: "worker", status: "done", started: "2026-10-20T10:00:00Z" },
    ],
    requests: [
      { id: "r-1", question: "q", status: "open", session: "t-idle" },
      { id: "r-2", question: "q", status: "open", session: "t-done" },
    ],
  };
  const byId = Object.fromEntries(mapSessions(ctl, now).map((s) => [s.id, s.state]));
  assert.equal(byId["t-idle"], "waiting");
  assert.equal(byId["t-quiet"], "idle");
  assert.equal(byId["t-done"], "closed"); // a finished asker stays closed; its question is an orphan
});
