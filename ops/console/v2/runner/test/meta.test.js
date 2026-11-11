// Capri (proposal 19) runner side: capabilities, the spawn gate, the idle/cap/detach
// stops, the close reconciliation and the start sweep. No real PTY, no real systemd:
// a fake factory drives output/exit and a scripted wrapper answers the meta verbs, so
// every rule is asserted deterministically with an injected clock.
import test from "node:test";
import assert from "node:assert/strict";
import { Manager, newSid } from "../src/manager.js";
import { Capabilities, diffSnapshots } from "../src/meta.js";
import { loadRunnerConfig } from "../src/config.js";
import { fakeFactory } from "./helpers.js";

function cfg(over = {}) {
  const base = loadRunnerConfig({
    HQ_ROOT: "/home/owner/hq",
    RUNNER_WRAPPER: "/w/spawn.sh",
    RUNNER_WRAPPER_SUDO: "1",
    RUNNER_META_ENABLED: "1",
    RUNNER_META_DIR: "/var/lib/hqconsole/meta",
    RUNNER_META_IDLE_MS: "1000",
    RUNNER_META_CAP_MS: "5000",
    RUNNER_META_DETACH_GRACE_MS: "200",
    RUNNER_STATE_DIR: "/tmp/hq-meta-test-state-" + process.pid,
    RUNNER_TERM_DIR: "/tmp/hq-meta-test-term-" + process.pid,
  });
  return Object.freeze({ ...base, ...over });
}

/** A wrapper whose meta verbs return scripted JSON; records every call. */
function scriptWrapper(script = {}) {
  const calls = [];
  const okSnap = { ok: true, sid: "x", units: { files: {}, units: {}, systemctl: true }, crontab: { available: true, lines: [] }, at: { available: true, lines: [] }, files: {}, present: [], known: { units: true, crontab: true, at: true, files: true } };
  return {
    calls,
    // used by MetaSession.start(): shape the argv but never actually exec
    argvFor: (verb, args) => ({ cmd: "node", args: ["-e", "0", verb, ...args] }),
    call: async (verb, args = []) => {
      calls.push({ verb, args });
      const s = script[verb];
      const val = typeof s === "function" ? s(args, calls) : s;
      if (val && val.throw) throw new Error(val.throw);
      const payload =
        val !== undefined
          ? val
          : verb === "meta-check"
            ? { ok: true, reasons: [] }
            : verb === "meta-snapshot"
              ? { ...okSnap, after: args[1] === "after" }
              : verb === "meta-scopes"
                ? { scopes: [], ok: true }
                : verb === "meta-integrity"
                  ? { canaries: { ok: true, tail: [] }, cage: { clean: true, files: [] } }
                  : verb === "meta-stop"
                    ? { unit: `hq-meta-${args[0]}.scope`, stopped: true }
                    : { ok: true };
      return { code: 0, stdout: JSON.stringify(payload) + "\n", stderr: "" };
    },
  };
}

function manager(over = {}, wrapper = scriptWrapper(), timers = {}) {
  const factory = fakeFactory();
  const m = new Manager({
    cfg: cfg(over.cfg),
    factory,
    wrapper,
    store: { load: () => ({ sessions: [], meta: over.meta || [] }), save: () => {} },
    log: () => {},
    now: timers.now || (() => 1_000_000),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  m.init();
  return { m, factory, wrapper };
}

// ---- capabilities ----------------------------------------------------------
test("a capability is single-use and expires", () => {
  let t = 0;
  const caps = new Capabilities({ ttlMs: 100, now: () => t });
  const { capability } = caps.mint();
  assert.equal(caps.spend(capability), true, "first spend works");
  assert.equal(caps.spend(capability), false, "second spend fails");
  const b = caps.mint().capability;
  t = 101;
  assert.equal(caps.spend(b), false, "expired capability is refused");
  assert.equal(caps.size, 0);
});

// ---- spawn gate ------------------------------------------------------------
test("spawn kind=meta is refused while the flag is off", async () => {
  const { m } = manager({ cfg: { metaEnabled: false } });
  await assert.rejects(() => m.spawn({ kind: "meta" }), /meta disabled/);
  assert.throws(() => m.mintMetaCapability(), /meta disabled/);
});

test("spawn kind=meta needs a fresh capability, spent exactly once", async () => {
  const { m } = manager();
  await assert.rejects(() => m.spawn({ kind: "meta", cols: 80, rows: 24 }), /meta capability required/);
  const { capability } = m.mintMetaCapability();
  const r = await m.spawn({ kind: "meta", capability, cols: 80, rows: 24 });
  assert.match(r.sid, /^s/);
  // the same capability cannot start a second session
  await assert.rejects(() => m.spawn({ kind: "meta", capability, cols: 80, rows: 24 }), /already live|capability required/);
});

test("only one meta session may be live; a second capability is refused", async () => {
  const { m } = manager();
  const c1 = m.mintMetaCapability();
  await m.spawn({ kind: "meta", capability: c1.capability, cols: 80, rows: 24 });
  assert.throws(() => m.mintMetaCapability(), /already live/);
});

test("two concurrent meta spawns cannot both start a session", async () => {
  // meta-check/snapshot await, opening a window between the liveMeta() check and the
  // session being tracked; the synchronous metaStarting lock must close it.
  const { m } = manager();
  const c1 = m.mintMetaCapability();
  // a second capability minted before the first spawn resolves would be refused by
  // mint (already starting is not yet live), so we drive two spawns with two caps by
  // minting the second directly on the caps map bypassing the live check.
  const c2cap = m.caps.mint().capability;
  const [r1, r2] = await Promise.allSettled([
    m.spawn({ kind: "meta", capability: c1.capability, cols: 80, rows: 24 }),
    m.spawn({ kind: "meta", capability: c2cap, cols: 80, rows: 24 }),
  ]);
  const ok = [r1, r2].filter((r) => r.status === "fulfilled");
  const bad = [r1, r2].filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1, "exactly one spawn started");
  assert.equal(bad.length, 1);
  assert.match(String(bad[0].reason), /already live|starting/);
  assert.equal(m.list().filter((x) => x.kind === "meta").length, 1);
});

test("a failing meta-check refuses the spawn with the reasons, and still spends the capability", async () => {
  const w = scriptWrapper({ "meta-check": { ok: false, reasons: ["meta settings writable by this user"] } });
  const { m } = manager({}, w);
  const { capability } = m.mintMetaCapability();
  await assert.rejects(() => m.spawn({ kind: "meta", capability, cols: 80, rows: 24 }), /writable by this user/);
  // capability spent: a retry with the same one is refused as capability, not check
  await assert.rejects(() => m.spawn({ kind: "meta", capability, cols: 80, rows: 24 }), /capability required/);
});

test("a snapshot that could not be written refuses the spawn", async () => {
  const w = scriptWrapper({ "meta-snapshot": { ok: false, error: "cannot write snapshot" } });
  const { m } = manager({}, w);
  const { capability } = m.mintMetaCapability();
  await assert.rejects(() => m.spawn({ kind: "meta", capability, cols: 80, rows: 24 }), /cannot write snapshot/);
});

test("the meta session is writable, has no disk log, and shows in status", async () => {
  const { m, factory } = manager();
  const { capability } = m.mintMetaCapability();
  const { sid } = await m.spawn({ kind: "meta", capability, cols: 80, rows: 24 });
  const rec = m.list().find((s) => s.sid === sid);
  assert.equal(rec.kind, "meta");
  assert.equal(rec.writable, true);
  assert.equal(rec.log, null);
  const st = m.metaStatus();
  assert.equal(st.enabled, true);
  assert.equal(st.live.sid, sid);
  // the fake pty exists and no *.log path was handed to it
  assert.equal(factory.last().spec.file, "node");
});

// ---- stops -----------------------------------------------------------------
function fakeTimers() {
  let seq = 1;
  const timers = new Map();
  let now = 1_000_000;
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const id = seq++;
      timers.set(id, { fn, at: now + ms });
      return { id, unref() {} };
    },
    clearTimer: (h) => h && timers.delete(h.id),
    advance: async (ms) => {
      now += ms;
      const due = [...timers.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at);
      for (const [id, t] of due) {
        timers.delete(id);
        await t.fn();
      }
    },
  };
}

test("idle past the limit stops the scope and reconciles", async () => {
  const tm = fakeTimers();
  const w = scriptWrapper();
  const { m, factory } = manager({}, w, tm);
  const reconciled = [];
  m.on("meta.reconcile", (e) => reconciled.push(e));
  const integrities = [];
  m.on("meta.integrity", (e) => integrities.push(e));
  const { capability } = m.mintMetaCapability();
  const { sid } = await m.spawn({ kind: "meta", capability, cols: 80, rows: 24 });
  await tm.advance(1001); // idle limit 1000
  // stopMeta SIGTERMs the fake pty; drive its exit so the close path runs
  factory.last().finish(0, "SIGTERM");
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(w.calls.some((c) => c.verb === "meta-stop" && c.args[0] === sid), "meta-stop called");
  assert.equal(reconciled.length, 1, "one reconcile event");
  assert.equal(reconciled[0].endedBy, "idle");
  assert.equal(integrities.length, 1);
  assert.equal(integrities[0].ok, true);
});

test("steady input keeps idle from firing; the 2 h cap still stops the session", async () => {
  const tm = fakeTimers();
  const { m, factory } = manager({}, scriptWrapper(), tm);
  const ended = [];
  m.on("meta.reconcile", (e) => ended.push(e.endedBy));
  const { capability } = m.mintMetaCapability();
  const { sid } = await m.spawn({ kind: "meta", capability, cols: 80, rows: 24 });
  // a keystroke every 400 ms keeps idle (limit 1000) from expiring, staying under
  // the 5000 ms cap; then one final jump crosses the cap with no input
  for (let elapsed = 0; elapsed < 4600; elapsed += 400) {
    await tm.advance(400);
    await m.input(sid, "l");
  }
  assert.equal(ended.length, 0, "steady input means no idle stop");
  await tm.advance(600); // now past the 5000 ms cap since start
  factory.last().finish(0, "SIGTERM");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ended, ["cap"]);
});

test("the last attacher detaching stops the scope after the grace, a re-attach cancels it", async () => {
  const tm = fakeTimers();
  const { m, factory } = manager({}, scriptWrapper(), tm);
  const ended = [];
  m.on("meta.reconcile", (e) => ended.push(e.endedBy));
  const { capability } = m.mintMetaCapability();
  const { sid } = await m.spawn({ kind: "meta", capability, cols: 80, rows: 24 });
  await m.attach(sid, { cols: 80, rows: 24 });
  await m.detach(sid);
  await m.attach(sid, { cols: 80, rows: 24 }); // re-attach within the grace
  await tm.advance(201);
  assert.equal(ended.length, 0, "re-attach cancelled the detach stop");
  await m.detach(sid);
  await tm.advance(201);
  factory.last().finish(0, "SIGTERM");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ended, ["detach"]);
});

// ---- reconciliation --------------------------------------------------------
test("close auto-reverts what the session added and reports what changed", async () => {
  const before = {
    units: { files: { "keep.service": "aaa" }, units: { "keep.service": "active/running" }, systemctl: true },
    crontab: { available: true, lines: ["0 * * * * old"] },
    at: { available: true, lines: [] },
    files: { ".bashrc": "b1" },
    present: [".bashrc"],
  };
  const after = {
    units: {
      files: { "keep.service": "aaa", "evil.service": "zzz" },
      units: { "keep.service": "active/running", "evil.service": "active/running", "hq-meta-SID.scope": "active/running" },
      systemctl: true,
    },
    crontab: { available: true, lines: ["0 * * * * old", "* * * * * evil"] },
    at: { available: true, lines: [] },
    files: { ".bashrc": "b2" },
    present: [".bashrc"],
  };
  const d = diffSnapshots(before, after, { ownScope: "hq-meta-SID.scope" });
  const kinds = d.autoRevert.map((x) => `${x.kind}:${x.name}`);
  assert.ok(kinds.includes("unit:evil.service"), JSON.stringify(kinds));
  assert.ok(kinds.includes("cron:* * * * * evil"));
  // evil.service is running: it also gets a stop; the scope itself is excluded
  assert.ok(kinds.includes("stop:evil.service"));
  assert.ok(!kinds.some((k) => k.includes("hq-meta-SID.scope")), "own scope excluded");
  // the changed .bashrc is a Revert/Keep card, not an auto-revert
  const changed = d.changed.find((c) => c.name === ".bashrc");
  assert.ok(changed, "bashrc change surfaced");
  assert.deepEqual(changed.revert, ["restore", "home/.bashrc"]);
});

test("close performs the auto-reverts through the wrapper and records the result", async () => {
  const snap = {
    ok: true,
    units: { files: {}, units: {}, systemctl: true },
    crontab: { available: true, lines: [] },
    at: { available: true, lines: [] },
    files: {},
    present: [],
    known: { units: true, crontab: true, at: true, files: true },
  };
  const w = scriptWrapper({
    "meta-snapshot": (args) => {
      if (args[1] === "after") {
        return {
          ...snap,
          after: true,
          crontab: { available: true, lines: ["* * * * * added-by-session"] },
        };
      }
      return { ...snap, after: false };
    },
  });
  const { m, factory } = manager({}, w);
  const { capability } = m.mintMetaCapability();
  const { sid } = await m.spawn({ kind: "meta", capability, cols: 80, rows: 24 });
  const events = [];
  m.on("meta.reconcile", (e) => events.push(e));
  factory.last().finish(0, null); // clean exit
  await new Promise((r) => setTimeout(r, 20));
  const revertCall = w.calls.find((c) => c.verb === "meta-revert");
  assert.ok(revertCall, "the added cron line was reverted");
  assert.equal(revertCall.args[1], "cron");
  assert.equal(events[0].autoReverted[0].kind, "cron");
  assert.equal(events[0].autoReverted[0].ok, true);
  const st = m.metaStatus();
  assert.equal(st.live, null);
  assert.equal(st.lastClose.sid, sid);
});

test("a scope that will not stop marks the close not-clean", async () => {
  const w = scriptWrapper({ "meta-stop": (args) => ({ unit: `hq-meta-${args[0]}.scope`, stopped: false, state: "active" }) });
  const { m, factory } = manager({}, w);
  const integrities = [];
  m.on("meta.integrity", (e) => integrities.push(e));
  const { capability } = m.mintMetaCapability();
  await m.spawn({ kind: "meta", capability, cols: 80, rows: 24 });
  factory.last().finish(0, null);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(integrities.length, 1);
  assert.equal(integrities[0].ok, false, "a live scope means the close is not clean");
  assert.equal(integrities[0].scopeGone, false);
});

test("close is idempotent: exit and a later reconcile do not double-run", async () => {
  const w = scriptWrapper();
  const { m, factory } = manager({}, w);
  const events = [];
  m.on("meta.reconcile", (e) => events.push(e));
  const { capability } = m.mintMetaCapability();
  const { sid } = await m.spawn({ kind: "meta", capability, cols: 80, rows: 24 });
  factory.last().finish(0, null); // triggers closeMeta via exit
  await new Promise((r) => setTimeout(r, 20));
  await m.reconcileUnclosed(); // must be a no-op for the already-closed record
  assert.equal(events.length, 1, "closeMeta ran exactly once");
  const revertCalls = w.calls.filter((c) => c.verb === "meta-integrity").length;
  assert.equal(revertCalls, 1, "integrity ran exactly once");
  void sid;
});

test("the start sweep stops lingering scopes and reconciles a record with no close event", async () => {
  const w = scriptWrapper({
    "meta-scopes": { scopes: ["hq-meta-old1.scope"], ok: true },
  });
  const priorRecord = {
    sid: "old0",
    startedAt: "2026-08-20T00:00:00.000Z",
    closedAt: null,
    snapshot: { units: { files: {}, units: {}, systemctl: true }, crontab: { available: true, lines: [] }, at: { available: true, lines: [] }, files: {}, present: [] },
  };
  const { m } = manager({ meta: [priorRecord] }, w);
  const sweep = await m.startSweep();
  assert.deepEqual(sweep.scopes, ["hq-meta-old1.scope"]);
  assert.ok(sweep.reconciled.includes("old0"), "the unclosed record was reconciled");
  assert.ok(w.calls.some((c) => c.verb === "meta-stop" && c.args[0] === "old1"), "lingering scope stopped");
  const rec = m.metaStatus().lastClose;
  assert.equal(rec.sid, "old0");
});

test("newSid produces filename-safe ids", () => {
  for (let i = 0; i < 5; i++) assert.match(newSid(), /^s[a-z0-9]+$/);
});

// ---- the runner's own rule on driving Capri --------------------------------
test("the runner refuses input into the meta session from a connection that never attached", async () => {
  // The console gates the attach behind a passkey. The runner cannot see an
  // assertion, so it enforces the consequence instead: no attach on this
  // connection, no typing. That holds even if the console's gate is wrong,
  // which is the whole reason it is checked in two places.
  const { RunnerServer } = await import("../src/server.js");
  const { m } = manager();
  const { capability } = m.mintMetaCapability();
  const r = await m.spawn({ kind: "meta", capability, cols: 80, rows: 24 });
  assert.ok(m.isMeta(r.sid), "the manager knows this sid is the meta session");

  const srv = Object.create(RunnerServer.prototype);
  srv.manager = m;
  const stranger = { attached: new Map() };
  assert.throws(() => srv.requireAttachedForMeta(stranger, r.sid), /meta capability required/);

  // the connection that attached may drive it
  const holder = { attached: new Map([[r.sid, 1]]) };
  srv.requireAttachedForMeta(holder, r.sid);

  // and the rule fires ONLY for the meta session: anything else passes straight
  // through, so ordinary terminals keep behaving exactly as they did.
  assert.equal(m.isMeta("s-not-meta"), false);
  srv.requireAttachedForMeta(stranger, "s-not-meta");
});

test("a pre-existing unit that is running after the session is carded with a stop, never auto-stopped (lucy J8 rounds 1+2)", () => {
  const before = {
    units: { files: { "sleeper.service": "aaa", "busy.service": "bbb" }, units: { "sleeper.service": "inactive/dead", "busy.service": "active/running" }, systemctl: true },
    crontab: { available: true, lines: [] },
    at: { available: true, lines: [] },
    files: {},
    present: [],
  };
  const after = {
    units: {
      files: { "sleeper.service": "aaa", "busy.service": "bbb" },
      // the session ran `systemctl --user start sleeper.service`; busy was already running
      units: { "sleeper.service": "active/running", "busy.service": "active/running", "hq-meta-SID.scope": "active/running" },
      systemctl: true,
    },
    crontab: { available: true, lines: [] },
    at: { available: true, lines: [] },
    files: {},
    present: [],
  };
  const d = diffSnapshots(before, after, { ownScope: "hq-meta-SID.scope" });
  // two snapshots cannot tell a session start from a timer/socket start of the owner's
  // own unit, so nothing pre-existing is ever auto-stopped (lucy round 2)
  assert.ok(!d.autoRevert.some((x) => x.kind === "stop"), JSON.stringify(d.autoRevert));
  // but the card carries the one-click stop for the unit that was not running before
  const sleeper = d.changed.find((c) => c.kind === "unit" && c.name === "sleeper.service");
  assert.deepEqual(sleeper && sleeper.revert, ["stop", "sleeper.service"]);
  assert.ok(!d.changed.some((c) => c.name === "busy.service"), "unchanged state is not a card");
  // a unit that was activating at snapshot time counts as running: no stop hint
  const before2 = { ...before, units: { ...before.units, units: { ...before.units.units, "sleeper.service": "activating/start" } } };
  const d3 = diffSnapshots(before2, after, { ownScope: "hq-meta-SID.scope" });
  const sleeper3 = d3.changed.find((c) => c.kind === "unit" && c.name === "sleeper.service");
  assert.equal(sleeper3 && sleeper3.revert, null);
  // and the inverse (the session stopped something that was running) is a card only
  const d2 = diffSnapshots(after, before, { ownScope: "hq-meta-SID.scope" });
  assert.ok(!d2.autoRevert.some((x) => x.kind === "stop"), JSON.stringify(d2.autoRevert));
});

test("a tmux pane scope new since the snapshot is carded, never auto-stopped (hq-4npjr.20)", () => {
  // 2026-11-04 21:08: a restart reconcile stopped the pane scopes of two console
  // terminals opened while a meta session was live, and both terminals ended
  const before = { units: { files: {}, units: {}, systemctl: true }, crontab: { available: true, lines: [] }, at: { available: true, lines: [] }, files: {}, present: [] };
  const pane = "tmux-spawn-4111035a-4253-44cb-8308-a3508773a7bb.scope";
  const after = {
    ...before,
    units: { files: {}, units: { [pane]: "active/running", "hq-term-tmux.scope": "active/running", "run-u7.service": "active/running" }, systemctl: true },
  };
  const d = diffSnapshots(before, after, { ownScope: "hq-meta-SID.scope" });
  const stops = d.autoRevert.filter((x) => x.kind === "stop").map((x) => x.name);
  assert.deepEqual(stops, ["run-u7.service"], "only the non-terminal unit is auto-stopped");
  for (const name of [pane, "hq-term-tmux.scope"]) {
    const card = d.changed.find((c) => c.name === name);
    assert.ok(card, `${name} is carded`);
    assert.equal(card.revert, null, `${name} has no one-click stop`);
  }
});

test("an auto-revert that did not take marks the close not-clean (lucy J8)", async () => {
  const snap = {
    ok: true,
    units: { files: {}, units: {}, systemctl: true },
    crontab: { available: true, lines: [] },
    at: { available: true, lines: [] },
    files: {},
    present: [],
    known: { units: true, crontab: true, at: true, files: true },
  };
  const w = scriptWrapper({
    "meta-snapshot": (args) =>
      args[1] === "after"
        ? { ...snap, after: true, units: { files: {}, units: { "escape.service": "active/running" }, systemctl: true } }
        : { ...snap, after: false },
    // the session deleted its snapshot.json, so the wrapper cannot bind the revert
    "meta-revert": () => ({ throw: "meta-revert: no readable snapshot for this sid" }),
  });
  const { m, factory } = manager({}, w);
  const integrities = [];
  const reconciles = [];
  m.on("meta.integrity", (e) => integrities.push(e));
  m.on("meta.reconcile", (e) => reconciles.push(e));
  const { capability } = m.mintMetaCapability();
  await m.spawn({ kind: "meta", capability, cols: 80, rows: 24 });
  factory.last().finish(0, null);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reconciles.length, 1);
  assert.equal(reconciles[0].autoReverted[0].ok, false);
  const revertErr = reconciles[0].errors.find((e) => e.startsWith("meta-revert stop escape.service"));
  assert.ok(revertErr, JSON.stringify(reconciles[0].errors));
  assert.equal(integrities.length, 1);
  assert.equal(integrities[0].ok, false, "residue the close could not revert is not a clean close");
  assert.ok(integrities[0].closeErrors.some((e) => e.startsWith("meta-revert")));
});

// ---- runner restart while a meta session lives (hq-4npjr.20) ----------------
// 2026-11-04: a meta session left open 12 h blocked every drain, so new runner
// code never went live. A pending restart closes it after metaRestartIdleMs of no
// input (and only then), and drains once its close has fully finished.

test("a pending restart closes an idle meta session, then drains after the close", async () => {
  const tm = fakeTimers();
  const w = scriptWrapper();
  const { m, factory } = manager({ cfg: { metaIdleMs: 0, metaCapMs: 0, metaRestartIdleMs: 5000 } }, w, tm);
  const order = [];
  m.on("meta.integrity", () => order.push("integrity"));
  m.on("drained", () => order.push("drained"));
  const { capability } = m.mintMetaCapability();
  const { sid } = await m.spawn({ kind: "meta", capability, cols: 80, rows: 24 });
  await tm.advance(3000);
  await m.input(sid, "x"); // the owner types: idle restarts from here
  const r = m.restart();
  assert.equal(r.pending, true);
  assert.equal(r.state, "serving", "the runner keeps serving while a restart waits");
  assert.equal(m.status().restartPending, true);
  await tm.advance(4000);
  assert.ok(!w.calls.some((c) => c.verb === "meta-stop"), "4 s idle is under the 5 s limit");
  await tm.advance(1001);
  assert.ok(w.calls.some((c) => c.verb === "meta-stop" && c.args[0] === sid), "idle past the limit stops it");
  factory.last().finish(0, "SIGTERM");
  await new Promise((res) => setTimeout(res, 30));
  assert.deepEqual(order, ["integrity", "drained"], "drained only after the close reconciled");
  assert.equal(m.state, "draining");
});

test("without a pending restart an idle meta session stays open (the owner 2026-10-09)", async () => {
  const tm = fakeTimers();
  const w = scriptWrapper();
  const { m } = manager({ cfg: { metaIdleMs: 0, metaCapMs: 0, metaRestartIdleMs: 5000 } }, w, tm);
  const { capability } = m.mintMetaCapability();
  await m.spawn({ kind: "meta", capability, cols: 80, rows: 24 });
  await tm.advance(60_000);
  assert.ok(!w.calls.some((c) => c.verb === "meta-stop"));
});

test("metaRestartIdleMs 0 never closes meta for a restart; the restart waits for the owner's close", async () => {
  const tm = fakeTimers();
  const w = scriptWrapper();
  const { m, factory } = manager({ cfg: { metaIdleMs: 0, metaCapMs: 0, metaRestartIdleMs: 0 } }, w, tm);
  let drained = false;
  m.on("drained", () => (drained = true));
  const { capability } = m.mintMetaCapability();
  await m.spawn({ kind: "meta", capability, cols: 80, rows: 24 });
  m.restart();
  await tm.advance(10 * 3600 * 1000);
  assert.ok(!w.calls.some((c) => c.verb === "meta-stop"));
  assert.equal(drained, false);
  factory.last().finish(0); // the owner closes Capri
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(drained, true);
});

test("an adopted tmux pane and a persistent term never block a restart; a worker does", () => {
  const { m } = manager();
  const alive = (sid, kind) => ({ session: { sid, kind, alive: true } });
  m.entries.set("%7", alive("%7", "tmux"));
  m.entries.set("smterm", alive("smterm", "interactive"));
  m.terms.set("smterm", {});
  assert.equal(m.blockingCount, 0);
  m.entries.set("smwork", alive("smwork", "worker"));
  assert.equal(m.blockingCount, 1);
});

test("the restart sweep of a meta session left open never stops a console terminal's pane (2026-11-04 replay)", async () => {
  // the incident: meta smw1v5m2454ab89 snapshotted at 08:37; the orchestrator
  // terminal opened at 19:13 got pane scope tmux-spawn-f55401e1...; the 21:08
  // restart reconciled the meta record and stopped that scope, ending the terminal
  const pane = "tmux-spawn-f55401e1-9ace-4c66-a40c-26e4d33ff53c.scope";
  const empty = { units: { files: {}, units: {}, systemctl: true }, crontab: { available: true, lines: [] }, at: { available: true, lines: [] }, files: {}, present: [] };
  const w = scriptWrapper({
    "meta-snapshot": (args) => ({ ok: true, ...empty, units: { files: {}, units: { [pane]: "active/running", "hq-term-tmux.scope": "active/running" }, systemctl: true }, after: args[1] === "after" }),
  });
  const rec = { sid: "smw1v5m2454ab89", startedAt: "2026-11-04T08:37:21.242Z", closedAt: null, snapshot: empty };
  const { m } = manager({ meta: [rec] }, w);
  const sweep = await m.startSweep();
  assert.ok(sweep.reconciled.includes("smw1v5m2454ab89"));
  const stops = w.calls.filter((c) => c.verb === "meta-revert" && c.args[1] === "stop");
  assert.deepEqual(stops, [], "no terminal scope is stopped");
  const close = m.metaStatus().lastClose;
  assert.ok(close.reconcile.changed.some((c) => c.name === pane && c.revert === null), "the pane is carded for the owner, with no stop");
});
