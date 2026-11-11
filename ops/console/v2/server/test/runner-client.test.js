// The server's half of the runner link: the reconnecting client, the term.*
// bridge onto the real WsLayer, and the session flags the collector merges.
//
// The runner in these tests is a real unix socket server speaking the wire
// protocol (runner/PROTOCOL.md), so framing, ids and events are exercised for
// real; only the daemon behind it is fake.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { WsLayer, createTokens } from "../src/ws.js";
import { RunnerClient, attachTermHandlers, sessionsFromRunner } from "../src/runner-client.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The term handlers refuse a sid no session source can account for (a cache miss
// used to be read as "not the meta session", which let an attach to the uncaged
// terminal skip the passkey). These tests are about framing and references, not
// about the gate, so they declare the sessions they drive rather than leaving the
// handler with nothing to resolve against.
const KNOWN = (sid) => ({ id: sid, kind: sid === "worker1" ? "worker" : "interactive", attachable: true, writable: sid !== "worker1" });


/** A runner that answers the protocol and can push events. */
function fakeRunner(socketPath, opts = {}) {
  const requests = [];
  const sockets = new Set();
  const handlers = opts.handlers || {};
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    let buf = "";
    sock.on("error", () => {});
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        requests.push(msg);
        const custom = handlers[msg.op];
        let reply;
        if (custom) reply = custom(msg);
        else if (msg.op === "hello")
          reply =
            Number(msg.protocol) === (opts.protocol || 1)
              ? { ok: true, protocol: opts.protocol || 1, release: "runner-sha", state: "serving", sessions: opts.sessions || [] }
              : { ok: false, error: "protocol", detail: `runner speaks ${opts.protocol || 1}` };
        else if (msg.op === "attach") reply = { ok: true, replay: "replayed output", writable: msg.sid !== "worker1", cols: 80, rows: 24 };
        else if (msg.op === "list") reply = { ok: true, sessions: opts.sessions || [] };
        else reply = { ok: true };
        if (reply) sock.write(JSON.stringify({ id: msg.id, ...reply }) + "\n");
      }
    });
  });
  return {
    requests,
    listen: () => new Promise((r) => server.listen(socketPath, r)),
    emit(obj) {
      for (const s of sockets) s.write(JSON.stringify(obj) + "\n");
    },
    dropClients() {
      for (const s of sockets) s.destroy();
    },
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(r);
      }),
    lastOf: (op) => [...requests].reverse().find((m) => m.op === op),
  };
}

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-runner-client-"));
  return { dir, sock: path.join(dir, "runner.sock"), clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Stands in for a browser's WebSocket, with the fields WsLayer touches. */
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
  }
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
  last(t) {
    return [...this.sent].reverse().find((m) => m.t === t);
  }
}

function wsLayer() {
  const cfg = { protocol: 1, owner: "owner@example.com" };
  return new WsLayer({
    cfg,
    auth: {},
    tokens: createTokens({}),
    getHello: async () => ({ release: "dev", protocol: 1, owner: cfg.owner, state: null }),
    log: () => {},
  });
}

test("the client handshakes and exposes release, state and sessions", async () => {
  const t = tmp();
  const runner = fakeRunner(t.sock, { sessions: [{ sid: "s1", kind: "worker", alive: true }] });
  await runner.listen();
  const client = new RunnerClient({ socketPath: t.sock, log: () => {} });
  const ready = new Promise((r) => client.once("ready", r));
  client.start();
  const info = await ready;
  assert.equal(info.release, "runner-sha");
  assert.equal(info.state, "serving");
  assert.equal(client.connected, true);
  assert.deepEqual(runner.lastOf("hello").protocol, 1);
  client.stop();
  await runner.close();
  t.clean();
});

test("a request that fails comes back as a coded error, not a hang", async () => {
  const t = tmp();
  const runner = fakeRunner(t.sock, {
    handlers: { input: (m) => ({ ok: false, error: "read-only", sid: m.sid }) },
  });
  await runner.listen();
  const client = new RunnerClient({ socketPath: t.sock, log: () => {} });
  const ready = new Promise((r) => client.once("ready", r));
  client.start();
  await ready;
  await assert.rejects(() => client.request("input", { sid: "s1", data: "x" }), (e) => e.code === "read-only");
  client.stop();
  await runner.close();
  t.clean();
});

test("requests before the handshake and while down fail fast", async () => {
  const t = tmp();
  const client = new RunnerClient({ socketPath: t.sock, log: () => {}, backoffMs: [10] });
  await assert.rejects(() => client.request("list"), (e) => e.code === "runner not connected");
  client.start();
  await wait(30);
  await assert.rejects(() => client.request("list"), (e) => e.code === "runner not connected");
  client.stop();
  t.clean();
});

test("the client reconnects after the runner restarts", async () => {
  const t = tmp();
  const first = fakeRunner(t.sock);
  await first.listen();
  const client = new RunnerClient({ socketPath: t.sock, log: () => {}, backoffMs: [10, 10] });
  let readies = 0;
  client.on("ready", () => (readies += 1));
  client.start();
  await wait(60);
  assert.equal(client.connected, true);

  // the runner drains and exits; socket activation brings the next one up
  await first.close();
  await wait(40);
  assert.equal(client.connected, false, "the link is honestly reported as down");

  const second = fakeRunner(t.sock, { sessions: [{ sid: "s9", kind: "interactive", alive: true, writable: true }] });
  await second.listen();
  await wait(200);
  assert.equal(client.connected, true, "and comes back on its own");
  assert.ok(readies >= 2);
  const list = await client.list();
  assert.equal(list[0].sid, "s9");
  client.stop();
  await second.close();
  t.clean();
});

test("a protocol mismatch is reported once and backs off, it does not spin", async () => {
  const t = tmp();
  const runner = fakeRunner(t.sock, { protocol: 7 });
  await runner.listen();
  const client = new RunnerClient({ socketPath: t.sock, log: () => {}, backoffMs: [5], mismatchDelayMs: 5000 });
  const mismatch = new Promise((r) => client.once("mismatch", r));
  client.start();
  await mismatch;
  await wait(80);
  assert.equal(client.connected, false);
  assert.equal(client.updatePending, true);
  assert.equal(runner.requests.filter((r) => r.op === "hello").length, 1, "one attempt, then a long wait");
  client.stop();
  await runner.close();
  t.clean();
});

test("term.attach opens the terminal and streams data and exit to that client only", async () => {
  const t = tmp();
  const runner = fakeRunner(t.sock);
  await runner.listen();
  const client = new RunnerClient({ socketPath: t.sock, log: () => {} });
  const ready = new Promise((r) => client.once("ready", r));
  client.start();
  await ready;

  const ws = wsLayer();
  const bridge = attachTermHandlers({ ws, runner: client, sessions: KNOWN, log: () => {} });
  const a = new FakeSocket();
  const b = new FakeSocket();

  ws.onMessage(a, JSON.stringify({ t: "term.attach", sid: "s1", cols: 100, rows: 30 }));
  await wait(40);
  const open = a.last("term.open");
  assert.equal(open.sid, "s1");
  assert.equal(open.replay, "replayed output");
  assert.equal(open.writable, true);
  assert.deepEqual([runner.lastOf("attach").cols, runner.lastOf("attach").rows], [100, 30]);

  runner.emit({ event: "data", sid: "s1", data: "hello\n" });
  await wait(30);
  assert.equal(a.last("term.data").data, "hello\n");
  assert.equal(b.sent.length, 0, "a client that did not attach sees nothing");

  runner.emit({ event: "size", sid: "s1", cols: 109, rows: 25 });
  await wait(30);
  assert.deepEqual([a.last("term.size").cols, a.last("term.size").rows], [109, 25], "another viewer's resize reaches this pane");
  assert.equal(b.sent.length, 0, "and not a socket that is not attached");

  runner.emit({ event: "exit", sid: "s1", code: 3 });
  await wait(30);
  assert.equal(a.last("term.exit").code, 3);

  bridge.stop();
  client.stop();
  await runner.close();
  t.clean();
});

test("input is refused for a worker and forwarded for an interactive session", async () => {
  const t = tmp();
  const runner = fakeRunner(t.sock);
  await runner.listen();
  const client = new RunnerClient({ socketPath: t.sock, log: () => {} });
  const ready = new Promise((r) => client.once("ready", r));
  client.start();
  await ready;

  const ws = wsLayer();
  const sessions = [
    { id: "worker1", kind: "worker", attachable: true, writable: false },
    { id: "inter1", kind: "interactive", attachable: true, writable: true },
  ];
  const typed = [];
  const bridge = attachTermHandlers({ ws, runner: client, sessions, log: () => {}, onInput: (sid, data) => typed.push([sid, data]) });
  const sock = new FakeSocket();

  ws.onMessage(sock, JSON.stringify({ t: "term.input", sid: "worker1", data: "rm -rf /\r" }));
  await wait(30);
  assert.equal(sock.last("term.error").error, "read-only");
  assert.equal(runner.lastOf("input"), undefined, "it never reaches the runner");

  // Writing needs an attachment held by this very connection: the rule that keeps
  // an authorized-but-unattached socket from typing into the uncaged terminal
  // applies to every session, so the interactive one is opened first.
  ws.onMessage(sock, JSON.stringify({ t: "term.attach", sid: "inter1", cols: 80, rows: 24 }));
  await wait(30);
  ws.onMessage(sock, JSON.stringify({ t: "term.input", sid: "inter1", data: "ls\r" }));
  await wait(30);
  assert.equal(runner.lastOf("input").data, "ls\r");
  // onInput (Capri's uncertain-lane reset, hq-ymxzt.14) sees only input the runner took.
  assert.deepEqual(typed, [["inter1", "ls\r"]]);

  ws.onMessage(sock, JSON.stringify({ t: "term.resize", sid: "inter1", cols: 120, rows: 40 }));
  await wait(30);
  assert.equal(runner.lastOf("resize").cols, 120);

  bridge.stop();
  client.stop();
  await runner.close();
  t.clean();
});

test("every browser attach returns exactly one reference, however it leaves", async () => {
  const t = tmp();
  const runner = fakeRunner(t.sock);
  await runner.listen();
  const client = new RunnerClient({ socketPath: t.sock, log: () => {} });
  const ready = new Promise((r) => client.once("ready", r));
  client.start();
  await ready;

  const ws = wsLayer();
  const bridge = attachTermHandlers({ ws, runner: client, sessions: KNOWN, log: () => {} });
  const a = new FakeSocket();
  const b = new FakeSocket();
  ws.onMessage(a, JSON.stringify({ t: "term.attach", sid: "s1", cols: 80, rows: 24 }));
  ws.onMessage(b, JSON.stringify({ t: "term.attach", sid: "s1", cols: 80, rows: 24 }));
  await wait(40);
  assert.equal(runner.requests.filter((r) => r.op === "attach").length, 2);

  ws.onMessage(a, JSON.stringify({ t: "term.detach", sid: "s1" }));
  await wait(30);
  assert.equal(runner.requests.filter((r) => r.op === "detach").length, 1);

  // a detach for a session this client never attached releases nothing
  ws.onMessage(a, JSON.stringify({ t: "term.detach", sid: "s1" }));
  await wait(30);
  assert.equal(runner.requests.filter((r) => r.op === "detach").length, 1);

  // the second client's socket just dies (browser closed)
  b.readyState = 3;
  b.emit("close");
  await wait(30);
  assert.equal(runner.requests.filter((r) => r.op === "detach").length, 2);
  assert.equal(runner.lastOf("detach").sid, "s1");

  // a re-attach by the same client is a refresh, not a second viewer
  ws.onMessage(a, JSON.stringify({ t: "term.attach", sid: "s1", cols: 80, rows: 24 }));
  await wait(40);
  ws.onMessage(a, JSON.stringify({ t: "term.attach", sid: "s1", cols: 80, rows: 24 }));
  await wait(40);
  assert.equal(runner.requests.filter((r) => r.op === "attach").length, 4);
  assert.equal(runner.requests.filter((r) => r.op === "detach").length, 3);

  bridge.stop();
  client.stop();
  await runner.close();
  t.clean();
});

test("term.* without a runner says so, and non-term messages keep working", async () => {
  const t = tmp();
  const client = new RunnerClient({ socketPath: t.sock, log: () => {}, backoffMs: [10000] });
  const ws = wsLayer();
  const bridge = attachTermHandlers({ ws, runner: client, sessions: KNOWN, log: () => {} });
  const sock = new FakeSocket();

  ws.onMessage(sock, JSON.stringify({ t: "term.attach", sid: "s1", cols: 80, rows: 24 }));
  await wait(20);
  assert.equal(sock.last("term.error").error, "runner not connected");

  // the original WsLayer handler is untouched
  ws.clients.set(sock, { slices: null });
  ws.onMessage(sock, JSON.stringify({ t: "ping", ts: 42 }));
  assert.equal(sock.last("pong").ts, 42);
  ws.onMessage(sock, JSON.stringify({ t: "subscribe", slices: ["sessions"] }));
  assert.deepEqual([...ws.clients.get(sock).slices], ["sessions"]);

  bridge.stop();
  client.stop();
  t.clean();
});

test("a dropped runner tells every attached client instead of going quiet", async () => {
  const t = tmp();
  const runner = fakeRunner(t.sock);
  await runner.listen();
  const client = new RunnerClient({ socketPath: t.sock, log: () => {}, backoffMs: [10000] });
  const ready = new Promise((r) => client.once("ready", r));
  client.start();
  await ready;
  const ws = wsLayer();
  const bridge = attachTermHandlers({ ws, runner: client, sessions: KNOWN, log: () => {} });
  const sock = new FakeSocket();
  ws.onMessage(sock, JSON.stringify({ t: "term.attach", sid: "s1", cols: 80, rows: 24 }));
  await wait(40);
  runner.dropClients();
  await wait(40);
  assert.equal(sock.last("term.error").error, "runner not connected");
  bridge.stop();
  client.stop();
  await runner.close();
  t.clean();
});

test("sessionsFromRunner gives the collector attachable and writable, nothing it owns", () => {
  const rows = sessionsFromRunner([
    { sid: "s1", kind: "worker", alive: true, writable: false, rig: "acme-dashboard", bead: "xd-1", startedAt: "2026-08-18T00:00:00Z", log: "/var/lib/hqconsole/term/s1.log" },
    { sid: "s2", kind: "interactive", alive: true, writable: true },
    { sid: "%7", kind: "tmux", alive: true, writable: true },
    { sid: "s3", kind: "worker", alive: false, writable: false, exitCode: 2 },
    { kind: "worker" },
  ]);
  assert.equal(rows.length, 4, "an entry with no sid is dropped");
  assert.deepEqual(rows[0], {
    id: "s1",
    pane: null,
    runner: "pty",
    attachable: true,
    writable: false,
    alive: true,
    exitCode: null,
    kind: "worker",
    rig: "acme-dashboard",
    bead: "xd-1",
    startedAt: "2026-08-18T00:00:00Z",
    log: "/var/lib/hqconsole/term/s1.log",
    snoozedUntil: null,
  });
  assert.equal(rows[1].writable, true);
  assert.equal(rows[2].pane, "%7");
  assert.equal(rows[2].runner, "tmux");
  assert.equal(rows[2].kind, null, "the registry stays the source of truth for kind");
  assert.equal(rows[3].writable, false, "a dead session is never writable");
  assert.equal(rows[3].attachable, true, "but its replay is still worth opening");
  assert.equal(rows[3].exitCode, 2);
});

test("sessionsFromRunner carries a snoozed console terminal as not attachable", () => {
  const [snoozed, live, junk] = sessionsFromRunner([
    { sid: "s-a", kind: "interactive", alive: false, writable: false, snoozedUntil: "2026-10-20T09:00:00.000Z" },
    { sid: "s-b", kind: "interactive", alive: true, writable: true },
    { sid: "s-c", kind: "interactive", alive: false, snoozedUntil: "soon" },
  ]);
  assert.equal(snoozed.attachable, false);
  assert.equal(snoozed.snoozedUntil, "2026-10-20T09:00:00.000Z");
  assert.equal(live.attachable, true);
  assert.equal(live.snoozedUntil, null);
  assert.equal(junk.snoozedUntil, null, "a wake time that is not a date is dropped");
  assert.equal(junk.attachable, true);
});
