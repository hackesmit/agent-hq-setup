// term.redraw (2026-10-20): the pane's Redraw button and the click into an
// unfocused pane reach the runner as its term.redraw op, only from a connection
// that holds an attachment, and a refusal never puts the pane in an error state.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
const SRV = "../src/";
const { WsLayer, createTokens } = await import(SRV + "ws.js");
const { RunnerClient, attachTermHandlers } = await import(SRV + "runner-client.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeSocket extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.sent = []; }
  send(raw) { this.sent.push(JSON.parse(raw)); }
}

async function rig({ refuse = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv-redraw-"));
  const sockPath = path.join(dir, "r.sock");
  const ops = [];
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("error", () => {});
    sock.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        ops.push(msg);
        let reply = { id: msg.id, ok: true };
        if (msg.op === "hello") reply = { id: msg.id, ok: true, protocol: 1, release: "x", state: "serving", sessions: [] };
        else if (msg.op === "attach") reply = { id: msg.id, ok: true, replay: "", writable: true, cols: 80, rows: 24 };
        else if (msg.op === "term.redraw" && refuse) reply = { id: msg.id, ok: false, error: refuse };
        else if (msg.op === "term.redraw") reply = { id: msg.id, ok: true, redrawn: true };
        sock.write(JSON.stringify(reply) + "\n");
      }
    });
  });
  await new Promise((r) => server.listen(sockPath, r));
  const client = new RunnerClient({ socketPath: sockPath, log: () => {} });
  const ready = new Promise((r) => client.once("ready", r));
  client.start();
  await ready;
  const cfg = { protocol: 1, owner: "o@example.com" };
  const ws = new WsLayer({ cfg, auth: {}, tokens: createTokens({}), getHello: async () => ({ release: "dev", protocol: 1, owner: cfg.owner, state: null }), log: () => {} });
  const logs = [];
  const bridge = attachTermHandlers({
    ws,
    runner: client,
    sessions: (sid) => ({ id: sid, kind: "interactive", attachable: true, writable: true }),
    log: (l) => logs.push(l),
  });
  return {
    ws,
    ops,
    logs,
    done() {
      bridge.stop();
      client.stop();
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("an attached pane's term.redraw reaches the runner as term.redraw", async () => {
  const t = await rig();
  const a = new FakeSocket();
  await t.ws.onMessage(a, JSON.stringify({ t: "term.attach", sid: "s1", cols: 80, rows: 24 }));
  await t.ws.onMessage(a, JSON.stringify({ t: "term.redraw", sid: "s1" }));
  await wait(20);
  const redraws = t.ops.filter((m) => m.op === "term.redraw");
  t.done();
  assert.deepEqual(redraws.map((m) => m.sid), ["s1"]);
  assert.equal(a.sent.some((m) => m.t === "term.error"), false);
});

test("a connection that never attached cannot redraw, and is not told so", async () => {
  const t = await rig();
  const a = new FakeSocket();
  await t.ws.onMessage(a, JSON.stringify({ t: "term.redraw", sid: "s1" }));
  await wait(20);
  const redraws = t.ops.filter((m) => m.op === "term.redraw");
  t.done();
  assert.equal(redraws.length, 0);
  assert.deepEqual(a.sent, [], "no term.error: a redraw is a hint, not a state change");
});

test("a runner refusal (an adopted pane) never reaches the pane as an error", async () => {
  const t = await rig({ refuse: "not a console terminal" });
  const a = new FakeSocket();
  await t.ws.onMessage(a, JSON.stringify({ t: "term.attach", sid: "%7", cols: 80, rows: 24 }));
  await t.ws.onMessage(a, JSON.stringify({ t: "term.redraw", sid: "%7" }));
  await wait(20);
  const sentErr = a.sent.some((m) => m.t === "term.error");
  const logged = t.logs.some((l) => /redraw/.test(l));
  t.done();
  assert.equal(sentErr, false);
  assert.equal(logged, false, "an expected refusal is not log noise");
});
