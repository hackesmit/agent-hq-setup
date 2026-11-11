// Protocol round trip: a real daemon on a temp unix socket, a real client
// socket, a fake PTY underneath. Everything PROTOCOL.md promises is exercised
// here except the tmux verbs (tmux.test.js) and drain (drain.test.js).

import test from "node:test";
import assert from "node:assert/strict";
import { startRunner } from "../src/runner.js";
import { cleanup, connectClient, fakeFactory, testEnv, wait } from "./helpers.js";

async function boot(over = {}) {
  const env = testEnv(over);
  const factory = fakeFactory();
  const app = await startRunner({ cfg: env.cfg, factory, exitOnDrain: false, log: () => {} });
  const client = await connectClient(env.cfg.socketPath);
  return {
    ...env,
    factory,
    app,
    client,
    async done() {
      client.close();
      await app.stop();
      cleanup(env.dir);
    },
  };
}

test("hello returns protocol, release, state and the session list", async () => {
  const t = await boot();
  const r = await t.client.send("hello", { protocol: 1, release: "console-sha" });
  assert.equal(r.ok, true);
  assert.equal(r.protocol, 1);
  assert.equal(r.release, "testsha");
  assert.equal(r.state, "serving");
  assert.deepEqual(r.sessions, []);
  await t.done();
});

test("a protocol mismatch is refused, not guessed at", async () => {
  const t = await boot();
  const r = await t.client.send("hello", { protocol: 99 });
  assert.equal(r.ok, false);
  assert.equal(r.error, "protocol");
  await t.done();
});

test("spawn, list, attach with replay, resize, kill, exit event", async () => {
  const t = await boot();
  await t.client.send("hello", { protocol: 1 });

  const sp = await t.client.send("spawn", {
    kind: "worker",
    argv: ["fakejob", "--bead", "hq-njiu"],
    cwd: t.hq,
    cols: 100,
    rows: 30,
    rig: "acme-dashboard",
    bead: "hq-njiu",
  });
  assert.equal(sp.ok, true);
  assert.match(sp.sid, /^s[a-z0-9]+$/);

  const pty = t.factory.last();
  assert.equal(pty.spec.cols, 100);
  pty.say("hello from the job\n");

  const listed = await t.client.send("list");
  assert.equal(listed.sessions.length, 1);
  const rec = listed.sessions[0];
  assert.equal(rec.kind, "worker");
  assert.equal(rec.argv0, "fakejob");
  assert.equal(rec.rig, "acme-dashboard");
  assert.equal(rec.bead, "hq-njiu");
  assert.equal(rec.alive, true);
  assert.equal(rec.writable, false);

  const at = await t.client.send("attach", { sid: sp.sid, cols: 80, rows: 24 });
  assert.equal(at.ok, true);
  assert.equal(at.replay, "hello from the job\n");
  assert.equal(at.writable, false);
  assert.equal(at.cols, 80);
  assert.equal(pty.size.cols, 80, "attach resizes the pty to the browser's geometry");

  // data events reach an attached client and only an attached client
  pty.say("more output\n");
  const ev = await t.client.waitFor((e) => e.event === "data");
  assert.equal(ev.sid, sp.sid);
  assert.equal(ev.data, "more output\n");

  const rs = await t.client.send("resize", { sid: sp.sid, cols: 120, rows: 40 });
  assert.equal(rs.ok, true);
  assert.equal(pty.size.rows, 40);

  // A minimized pane measures as a few cells; that must not reach the program.
  const tiny = await t.client.send("resize", { sid: sp.sid, cols: 2, rows: 3 });
  assert.equal(tiny.ok, true);
  assert.equal(pty.size.cols, 120, "a hidden pane's 2-column measurement is ignored");
  assert.equal(pty.size.rows, 40);

  const k = await t.client.send("kill", { sid: sp.sid, signal: "SIGTERM" });
  assert.equal(k.ok, true);
  const exit = await t.client.waitFor((e) => e.event === "exit");
  assert.equal(exit.sid, sp.sid);
  assert.equal(exit.code, 0);
  assert.equal(exit.signal, "SIGTERM");

  await t.done();
});

test("events only reach the clients that attached", async () => {
  const t = await boot();
  const other = await connectClient(t.cfg.socketPath);
  const sp = await t.client.send("spawn", { kind: "interactive", argv: ["fakejob"], cwd: t.hq, cols: 80, rows: 24 });
  await t.client.send("attach", { sid: sp.sid, cols: 80, rows: 24 });
  t.factory.last().say("only for the attached one");
  await t.client.waitFor((e) => e.event === "data");
  await wait(30);
  assert.equal(other.events.length, 0);
  other.close();
  await t.done();
});

test("detach stops the stream for that client, the session lives on", async () => {
  const t = await boot();
  const sp = await t.client.send("spawn", { kind: "interactive", argv: ["fakejob"], cwd: t.hq, cols: 80, rows: 24 });
  await t.client.send("attach", { sid: sp.sid, cols: 80, rows: 24 });
  const d = await t.client.send("detach", { sid: sp.sid });
  assert.equal(d.ok, true);
  t.factory.last().say("nobody is listening");
  await wait(30);
  assert.equal(t.client.events.length, 0);
  const listed = await t.client.send("list");
  assert.equal(listed.sessions[0].alive, true);
  await t.done();
});

test("bad requests are refused with a code, not a crash", async () => {
  const t = await boot();
  const cases = [
    [{ op: "spawn", kind: "banana", argv: ["fakejob"], cwd: t.hq }, "bad kind"],
    [{ op: "spawn", kind: "worker", argv: [], cwd: t.hq }, "argv required"],
    [{ op: "spawn", kind: "worker", argv: ["rm"], cwd: t.hq }, "argv0 not allowed"],
    [{ op: "spawn", kind: "worker", argv: ["fakejob"], cwd: "/etc" }, "cwd outside hq"],
    [{ op: "attach", sid: "nope" }, "no such session"],
    [{ op: "input", sid: "nope", data: "x" }, "no such session"],
    [{ op: "kill", sid: "nope" }, "no such session"],
    [{ op: "wat" }, "unknown op"],
  ];
  for (const [req, err] of cases) {
    const r = await t.client.send(req.op, req);
    assert.equal(r.ok, false, `${req.op} should fail`);
    assert.equal(r.error, err);
  }
  await t.done();
});

test("meta is refused while the proposal 19 flag is off (the default)", async () => {
  const t = await boot();
  try {
    const r = await t.client.send("spawn", { kind: "meta", argv: ["claude"], cwd: t.hq, cols: 80, rows: 24 });
    assert.equal(r.ok, false);
    assert.match(r.error, /^meta disabled/);
    const c = await t.client.send("meta.capability");
    assert.equal(c.ok, false);
    assert.match(c.error, /^meta disabled/);
  } finally {
    await t.done();
  }
});

test("status reports state, count, release and protocol", async () => {
  const t = await boot();
  await t.client.send("spawn", { kind: "interactive", argv: ["fakejob"], cwd: t.hq, cols: 80, rows: 24 });
  const s = await t.client.send("status");
  assert.equal(s.state, "serving");
  assert.equal(s.sessions, 1);
  assert.equal(s.release, "testsha");
  assert.equal(s.protocol, 1);
  assert.equal(s.pty, "fake");
  await t.done();
});

test("a garbage frame closes the connection instead of poisoning the parser", async () => {
  const t = await boot();
  const closed = new Promise((r) => t.client.sock.on("close", r));
  t.client.raw("this is not json\n");
  await closed;
  await t.done();
});

test("the exited session is reaped after the retention window", async () => {
  const t = await boot();
  const sp = await t.client.send("spawn", { kind: "worker", argv: ["fakejob"], cwd: t.hq, cols: 80, rows: 24 });
  t.factory.last().finish(3, null);
  await wait(20);
  const during = await t.client.send("list");
  assert.equal(during.sessions[0].alive, false);
  assert.equal(during.sessions[0].exitCode, 3);
  await wait(120); // RUNNER_REAP_MS is 60 in the test env
  const after = await t.client.send("list");
  assert.deepEqual(after.sessions, []);
  await t.done();
});

test("term.redraw is a request op, and a non-terminal is refused over the wire", async () => {
  const { REQUEST_OPS } = await import("../src/protocol.js");
  assert.ok(REQUEST_OPS.includes("term.redraw"));
  const t = await boot();
  await t.client.send("hello", { protocol: 1 });
  const sp = await t.client.send("spawn", { kind: "worker", argv: ["fakejob"], cwd: t.hq, cols: 80, rows: 24 });
  const r = await t.client.send("term.redraw", { sid: sp.sid });
  assert.equal(r.ok, false);
  assert.equal(r.error, "not a console terminal");
  const none = await t.client.send("term.redraw", { sid: "nope" });
  assert.equal(none.error, "no such session");
  await t.done();
});

test("term.fg is a request op, and a non-terminal is refused over the wire", async () => {
  const { REQUEST_OPS } = await import("../src/protocol.js");
  assert.ok(REQUEST_OPS.includes("term.fg"));
  const t = await boot();
  await t.client.send("hello", { protocol: 1 });
  const sp = await t.client.send("spawn", { kind: "worker", argv: ["fakejob"], cwd: t.hq, cols: 80, rows: 24 });
  const r = await t.client.send("term.fg", { sid: sp.sid });
  assert.equal(r.ok, false);
  assert.equal(r.error, "not a console terminal");
  await t.done();
});
