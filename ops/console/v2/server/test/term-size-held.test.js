// Review of the size fix (2026-10-20): a size event that lands in the same
// read as a pane's attach reply is held and delivered after term.open.
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
  last(t) { return [...this.sent].reverse().find((m) => m.t === t); }
}
test("a size event in the same read as this pane's attach reply reaches the pane", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv-size-"));
  const sockPath = path.join(dir, "r.sock");
  const server = net.createServer((sock) => {
    let buf = ""; sock.on("error", () => {});
    sock.on("data", (c) => {
      buf += c; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (msg.op === "hello") sock.write(JSON.stringify({ id: msg.id, ok: true, protocol: 1, release: "x", state: "serving", sessions: [] }) + "\n");
        else if (msg.op === "attach")
          // Pane A's attach is answered at 104x25; in the same chunk, view B's resize to 109 lands.
          sock.write(JSON.stringify({ id: msg.id, ok: true, replay: "", writable: true, cols: 104, rows: 25 }) + "\n" +
                     JSON.stringify({ event: "size", sid: "s1", cols: 109, rows: 25 }) + "\n");
        else sock.write(JSON.stringify({ id: msg.id, ok: true }) + "\n");
      }
    });
  });
  await new Promise((r) => server.listen(sockPath, r));
  const client = new RunnerClient({ socketPath: sockPath, log: () => {} });
  const ready = new Promise((r) => client.once("ready", r)); client.start(); await ready;
  const cfg = { protocol: 1, owner: "o@example.com" };
  const ws = new WsLayer({ cfg, auth: {}, tokens: createTokens({}), getHello: async () => ({ release: "dev", protocol: 1, owner: cfg.owner, state: null }), log: () => {} });
  const bridge = attachTermHandlers({ ws, runner: client, sessions: (sid) => ({ id: sid, kind: "interactive", attachable: true, writable: true }), log: () => {} });
  const a = new FakeSocket();
  ws.onMessage(a, JSON.stringify({ t: "term.attach", sid: "s1", cols: 104, rows: 25 }));
  await wait(60);
  const open = a.last("term.open"); const size = a.last("term.size");
  const final = size ? [size.cols, size.rows] : [open.cols, open.rows];
  bridge.stop(); client.stop(); server.close(); fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(final, [109, 25], "pane A must end at the PTY's real size");
});
