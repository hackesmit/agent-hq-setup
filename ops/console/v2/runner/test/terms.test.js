// Persistent console terminals: the program lives in the hqterm tmux server,
// the PTY only holds a tmux client, and the store record is what lets a new
// runner re-attach (runner restart) or resume the pinned conversation (reboot).
// A fake wrapper stands in for spawn-as-owner.sh and keeps a set of live tmux
// sessions; the fake PTY factory stands in for node-pty.

import test from "node:test";
import assert from "node:assert/strict";
import { Manager } from "../src/manager.js";
import { cleanup, fakeFactory, testEnv } from "./helpers.js";

function fakeWrapper() {
  const live = new Set();
  const calls = [];
  const fake = {
    fg: "claude",
    live,
    calls,
    argvFor: (verb, args) => ({ cmd: verb, args }),
    ptyArgv: (spec) => ({ cmd: spec.argv[0], args: spec.argv.slice(1) }),
    async call(verb, args) {
      calls.push([verb, ...args]);
      if (verb === "term-new") {
        live.add(args[0]);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (verb === "term-has") return { code: live.has(args[0]) ? 0 : 1, stdout: "", stderr: "" };
      if (verb === "term-fg") return live.has(args[0]) ? { code: 0, stdout: `${fake.fg}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "no session" };
      if (verb === "term-kill") {
        live.delete(args[0]);
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "{}", stderr: "" };
    },
  };
  return fake;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function mk(env, wrapper, factory = fakeFactory()) {
  const cfg = { ...env.cfg, wrapperPath: "/fake/wrapper", persistTerms: true, termResumeMax: 3, termResumeWindowMs: 600000 };
  const m = new Manager({ cfg, factory, wrapper, log: () => {} }).init();
  return { m, factory };
}

const spawnReq = (env) => ({
  kind: "interactive",
  argv: ["claude", "--session-id", "u1", "seed"],
  resumeArgv: ["claude", "--resume", "u1"],
  persist: true,
  cwd: env.hq,
  cols: 100,
  rows: 30,
});

test("a persistent terminal starts in tmux and its PTY is a tmux client", async () => {
  const env = testEnv();
  const w = fakeWrapper();
  const { m, factory } = mk(env, w);
  const { sid } = await m.spawn(spawnReq(env));
  const nw = w.calls.find((c) => c[0] === "term-new");
  assert.equal(nw[1], `hqt-${sid}`);
  assert.ok(nw.includes(`HQ_CONSOLE_SID=${sid}`), "the stable sid rides into the tmux session env");
  assert.deepEqual(nw.slice(nw.indexOf("--") + 1), ["claude", "--session-id", "u1", "seed"]);
  assert.equal(factory.last().spec.file, "term-attach");
  assert.deepEqual(factory.last().spec.args, [`hqt-${sid}`]);
  assert.equal(m.list()[0].persistent, true);
  await m.shutdown();
  cleanup(env.dir);
});

test("a runner restart re-attaches under the same sid and emits no exit", async () => {
  const env = testEnv();
  const w = fakeWrapper();
  const a = mk(env, w);
  const exits = [];
  a.m.on("exit", (e) => exits.push(e));
  const { sid } = await a.m.spawn(spawnReq(env));
  await a.m.shutdown();
  a.factory.last().finish(1, "SIGHUP"); // the client dies with the old runner
  await wait(20);
  assert.equal(exits.length, 0, "a client killed by a stopping runner is not an exit");

  const b = mk(env, w);
  const rt = await b.m.restoreTerms();
  assert.deepEqual(rt.attached, [sid]);
  assert.equal(b.m.list()[0].sid, sid);
  assert.equal(b.m.list()[0].alive, true);
  assert.equal(w.calls.filter((c) => c[0] === "term-new").length, 1, "no second program was started");
  await b.m.shutdown();
  cleanup(env.dir);
});

test("after a reboot the pinned conversation is resumed, with a boot loop guard", async () => {
  const env = testEnv();
  const w = fakeWrapper();
  const a = mk(env, w);
  const { sid } = await a.m.spawn(spawnReq(env));
  await a.m.shutdown();
  for (let boot = 0; boot < 4; boot++) {
    w.live.clear(); // power loss: the tmux server is gone too
    const b = mk(env, w);
    const rt = await b.m.restoreTerms();
    if (boot < 3) {
      assert.deepEqual(rt.resumed, [sid], `boot ${boot} resumes`);
      const last = w.calls.filter((c) => c[0] === "term-new").pop();
      assert.deepEqual(last.slice(last.indexOf("--") + 1), ["claude", "--resume", "u1"]);
    } else {
      assert.deepEqual(rt.dropped, [sid], "the fourth boot inside the window gives up");
    }
    await b.m.shutdown();
  }
  cleanup(env.dir);
});

test("quitting the program is a real exit and forgets the terminal", async () => {
  const env = testEnv();
  const w = fakeWrapper();
  const { m, factory } = mk(env, w);
  const exits = [];
  m.on("exit", (e) => exits.push(e));
  const { sid } = await m.spawn(spawnReq(env));
  w.live.delete(`hqt-${sid}`); // claude exited, tmux session closed
  factory.last().finish(0);
  await wait(20);
  assert.equal(exits.length, 1);
  assert.equal(m.terms.size, 0);
  await m.shutdown();
  cleanup(env.dir);
});

test("killing the card ends the tmux session, not just the client", async () => {
  const env = testEnv();
  const w = fakeWrapper();
  const { m } = mk(env, w);
  const exits = [];
  m.on("exit", (e) => exits.push(e));
  const { sid } = await m.spawn(spawnReq(env));
  m.kill(sid);
  await wait(20);
  assert.ok(w.calls.some((c) => c[0] === "term-kill" && c[1] === `hqt-${sid}`));
  assert.equal(exits.length, 1);
  assert.equal(m.terms.size, 0);
  await m.shutdown();
  cleanup(env.dir);
});

test("a crashed client is re-attached while the runner serves", async () => {
  const env = testEnv();
  const w = fakeWrapper();
  const { m, factory } = mk(env, w);
  const { sid } = await m.spawn(spawnReq(env));
  const first = factory.last();
  first.finish(1);
  await wait(1200);
  assert.notEqual(factory.last(), first, "a new client was spawned");
  assert.equal(m.list().find((s) => s.sid === sid).alive, true);
  await m.shutdown();
  cleanup(env.dir);
});

test("persistent terminals never block a drain", async () => {
  const env = testEnv();
  const w = fakeWrapper();
  const { m } = mk(env, w);
  await m.spawn(spawnReq(env));
  let drained = false;
  m.on("drained", () => (drained = true));
  m.drain();
  await wait(10);
  assert.equal(drained, true);
  await m.shutdown();
  cleanup(env.dir);
});

test("snooze ends the program, keeps the record through a restart, and wakes the same conversation", async () => {
  const env = testEnv();
  const w = fakeWrapper();
  let clock = Date.parse("2026-10-20T06:00:00Z");
  const cfg = { ...env.cfg, wrapperPath: "/fake/wrapper", persistTerms: true, termResumeMax: 3, termResumeWindowMs: 600000 };
  const make = () => {
    const factory = fakeFactory();
    return { m: new Manager({ cfg, factory, wrapper: w, log: () => {}, now: () => clock }).init(), factory };
  };
  const a = make();
  const exits = [];
  a.m.on("exit", (e) => exits.push(e));
  const { sid } = await a.m.spawn(spawnReq(env));
  await assert.rejects(() => a.m.snoozeTerm(sid, "2026-10-20T05:00:00Z"), /bad wake time/);
  const r = await a.m.snoozeTerm(sid, "2026-10-20T09:00:00Z");
  assert.equal(r.wakeAt, "2026-10-20T09:00:00.000Z");
  assert.ok(!w.live.has(`hqt-${sid}`), "the program in tmux is ended");
  a.factory.last().finish(0, "SIGTERM"); // the client exits with it
  await wait(20);
  const row = a.m.list().find((x) => x.sid === sid);
  assert.equal(row.alive, false);
  assert.equal(row.attachable, false);
  assert.equal(row.snoozedUntil, "2026-10-20T09:00:00.000Z");

  // a runner restart before the wake time neither resumes nor drops it
  await a.m.shutdown();
  const b = make();
  const rt = await b.m.restoreTerms();
  assert.deepEqual([rt.attached, rt.resumed, rt.dropped], [[], [], []]);
  assert.deepEqual((await b.m.wakeTerms()).woke, [], "not due yet");
  clock = Date.parse("2026-10-20T09:00:01Z");
  assert.deepEqual((await b.m.wakeTerms()).woke, [sid]);
  const resumed = w.calls.filter((c) => c[0] === "term-new").pop();
  assert.deepEqual(resumed.slice(resumed.indexOf("--") + 1), ["claude", "--resume", "u1"], "the pinned conversation comes back");
  assert.ok(resumed.includes(`HQ_CONSOLE_SID=${sid}`), "under the same sid");
  const live = b.m.list().find((x) => x.sid === sid);
  assert.equal(live.alive, true);
  assert.equal(live.snoozedUntil, undefined);
  await b.m.shutdown();
  cleanup(env.dir);
});

test("wake now brings a snoozed terminal back early; unknown sids are refused", async () => {
  const env = testEnv();
  const w = fakeWrapper();
  const a = mk(env, w);
  const { sid } = await a.m.spawn(spawnReq(env));
  await a.m.snoozeTerm(sid, new Date(Date.now() + 3600000).toISOString());
  a.factory.last().finish(0, "SIGTERM");
  await wait(20);
  assert.deepEqual((await a.m.wakeTerms(sid)).woke, [sid]);
  await assert.rejects(() => a.m.wakeTerms("nope"), /no such session/);
  await assert.rejects(() => a.m.snoozeTerm("nope", new Date(Date.now() + 1000).toISOString()), /no such session/);
  await a.m.shutdown();
  cleanup(env.dir);
});

test("a snooze exit is flagged, kill ends a snoozed terminal for good, and a wake that keeps failing gives up", async () => {
  const env = testEnv();
  const w = fakeWrapper();
  const a = mk(env, w);
  const exits = [];
  a.m.on("exit", (e) => exits.push(e));
  const one = await a.m.spawn(spawnReq(env));
  await a.m.snoozeTerm(one.sid, new Date(Date.now() + 3600000).toISOString());
  a.factory.last().finish(0, "SIGTERM");
  await wait(20);
  assert.deepEqual(exits.map((e) => [e.sid, e.snoozed]), [[one.sid, true]], "the console can tell a snooze from an end");
  assert.deepEqual(a.m.kill(one.sid), {});
  assert.equal(a.m.list().some((x) => x.sid === one.sid), false, "killed while snoozed: gone");
  assert.equal(exits.at(-1).snoozed, undefined, "and this exit is a real end");
  assert.deepEqual((await a.m.wakeTerms()).woke, []);

  // a term-new that always fails: three tries, then the record is dropped
  const two = await a.m.spawn(spawnReq(env));
  await a.m.snoozeTerm(two.sid, new Date(Date.now() + 3600000).toISOString());
  a.factory.last().finish(0, "SIGTERM");
  await wait(20);
  const real = w.call;
  w.call = async (verb, args) => (verb === "term-new" ? { code: 1, stdout: "", stderr: "boom" } : real.call(w, verb, args));
  for (let i = 0; i < 3; i++) await assert.rejects(() => a.m.wakeTerms(two.sid));
  assert.equal(a.m.list().some((x) => x.sid === two.sid), false, "gave up after 3 failed wakes");
  w.call = real;

  // a term-kill that fails while the program lives: the snooze is refused
  const three = await a.m.spawn(spawnReq(env));
  w.call = async (verb, args) => (verb === "term-kill" ? { code: 1, stdout: "", stderr: "nope" } : real.call(w, verb, args));
  await assert.rejects(() => a.m.snoozeTerm(three.sid, new Date(Date.now() + 3600000).toISOString()), /snooze failed/);
  w.call = real;
  assert.equal(a.m.list().find((x) => x.sid === three.sid).alive, true, "still running, not shown as snoozed");
  await a.m.shutdown();
  cleanup(env.dir);
});

test("a kill that lands while a wake is starting the program ends that program too", async () => {
  const env = testEnv();
  const w = fakeWrapper();
  const a = mk(env, w);
  const { sid } = await a.m.spawn(spawnReq(env));
  await a.m.snoozeTerm(sid, new Date(Date.now() + 3600000).toISOString());
  a.factory.last().finish(0, "SIGTERM");
  await wait(20);
  const real = w.call;
  w.call = async (verb, args) => {
    if (verb === "term-new") await wait(40);
    return real.call(w, verb, args);
  };
  const waking = a.m.wakeTerms(sid).catch((e) => e);
  await wait(10);
  a.m.kill(sid);
  await waking;
  w.call = real;
  assert.equal(w.live.has(`hqt-${sid}`), false, "no program left running unseen");
  assert.equal(a.m.list().some((x) => x.sid === sid), false);
  await a.m.shutdown();
  cleanup(env.dir);
});

test("every viewer is told the program's size, and a same-size attach makes tmux repaint", async () => {
  const env = testEnv();
  const w = fakeWrapper();
  const { m, factory } = mk(env, w);
  const sizes = [];
  m.on("size", (e) => sizes.push([e.sid, e.cols, e.rows]));
  const { sid } = await m.spawn(spawnReq(env)); // 100x30
  const pty = factory.last();
  const seen = [];
  const resize = pty.resize.bind(pty);
  pty.resize = (c, r) => {
    seen.push([c, r]);
    resize(c, r);
  };

  await m.attach(sid, { cols: 104, rows: 25 });
  assert.deepEqual(sizes.at(-1), [sid, 104, 25], "a new size reaches every viewer");
  m.resize(sid, 109, 25);
  assert.deepEqual(sizes.at(-1), [sid, 109, 25]);

  seen.length = 0;
  const before = sizes.length;
  await m.attach(sid, { cols: 109, rows: 25 });
  assert.equal(sizes.length, before, "same size: no size event");
  assert.deepEqual(seen, [[109, 24]], "the one-row wiggle starts at once");
  await wait(100);
  assert.deepEqual(seen, [[109, 24], [109, 25]], "and puts the size back");
  assert.deepEqual(pty.size, { cols: 109, rows: 25 });
  await m.shutdown();
  cleanup(env.dir);
});

test("term.redraw wiggles a console terminal one row and back, once per wiggle", async () => {
  const env = testEnv();
  const w = fakeWrapper();
  const { m, factory } = mk(env, w);
  const { sid } = await m.spawn(spawnReq(env)); // 100x30
  const pty = factory.last();
  const seen = [];
  const resize = pty.resize.bind(pty);
  pty.resize = (c, r) => {
    seen.push([c, r]);
    resize(c, r);
  };
  const sizes = [];
  m.on("size", (e) => sizes.push(e));

  assert.deepEqual(m.redrawTerm(sid), { redrawn: true });
  assert.deepEqual(m.redrawTerm(sid), { redrawn: false }, "a wiggle under way is not doubled");
  assert.deepEqual(seen, [[100, 29]]);
  await wait(100);
  assert.deepEqual(seen, [[100, 29], [100, 30]], "and the size is put back");
  assert.deepEqual(pty.size, { cols: 100, rows: 30 });
  assert.equal(sizes.length, 0, "a redraw is not a size change for the viewers");
  assert.deepEqual(m.redrawTerm(sid), { redrawn: true }, "the next click redraws again");
  await wait(100);
  await m.shutdown();
  cleanup(env.dir);
});

test("term.redraw refuses anything that is not a console terminal", async () => {
  const env = testEnv();
  const w = fakeWrapper();
  const { m, factory } = mk(env, w);
  const plain = await m.spawn({ kind: "interactive", argv: ["bash"], cwd: env.hq, cols: 80, rows: 24 });
  const pty = factory.last();
  const seen = [];
  pty.resize = (c, r) => seen.push([c, r]);
  assert.throws(() => m.redrawTerm(plain.sid), (e) => e.code === "not a console terminal");
  assert.throws(() => m.redrawTerm("nope"), (e) => e.code === "no such session");
  assert.deepEqual(seen, [], "nothing was resized");
  await m.shutdown();
  cleanup(env.dir);
});

test("term.fg names the foreground program of a console terminal's pane, else null", async () => {
  const env = testEnv();
  const w = fakeWrapper();
  const { m } = mk(env, w);
  const { sid } = await m.spawn(spawnReq(env));
  assert.deepEqual(await m.termForeground(sid), { command: "claude" });
  assert.deepEqual(w.calls.at(-1), ["term-fg", `hqt-${sid}`]);
  w.fg = "bash";
  assert.deepEqual(await m.termForeground(sid), { command: "bash" });
  w.fg = "two words";
  assert.deepEqual(await m.termForeground(sid), { command: null }, "anything odd is unknown, never a guess");
  w.live.delete(`hqt-${sid}`);
  assert.deepEqual(await m.termForeground(sid), { command: null }, "tmux failing is unknown");
  await m.shutdown();
  cleanup(env.dir);
});

test("term.fg refuses anything that is not a console terminal", async () => {
  const env = testEnv();
  const w = fakeWrapper();
  const { m } = mk(env, w);
  const plain = await m.spawn({ kind: "interactive", argv: ["bash"], cwd: env.hq, cols: 80, rows: 24 });
  await assert.rejects(m.termForeground(plain.sid), (e) => e.code === "not a console terminal");
  await assert.rejects(m.termForeground("nope"), (e) => e.code === "not a console terminal");
  assert.ok(!w.calls.some((c) => c[0] === "term-fg"), "tmux was never asked");
  await m.shutdown();
  cleanup(env.dir);
});
