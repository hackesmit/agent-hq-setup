// A snoozed console terminal (review of the snooze fix, 2026-10-20): the sweep
// must not mark its registry row done, or its asks are swept after it wakes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.js";
import { devConfig, fakeSources } from "./helpers.js";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("a snoozed console terminal keeps a live registry row (else its asks are swept after wake)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv-snooze-"));
  const sock = path.join(dir, "runner.sock");
  const wakeAt = new Date(Date.now() + 3600e3).toISOString();
  const srv = net.createServer((s) => {
    let buf = "";
    s.on("error", () => {});
    s.on("data", (c) => {
      buf += c; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        let reply = { ok: true };
        if (msg.op === "hello") reply = { ok: true, protocol: 1, release: "r", state: "serving", sessions: [] };
        if (msg.op === "list") reply = { ok: true, sessions: [{ sid: "s1", kind: "interactive", runner: "pty", alive: false, attachable: false, writable: false, snoozedUntil: wakeAt }] };
        s.write(JSON.stringify({ id: msg.id, ...reply }) + "\n");
      }
    });
  });
  await new Promise((r) => srv.listen(sock, r));
  const calls = [];
  const wrapper = { async call(verb, args) { calls.push([verb, ...args]); return { code: 0, stdout: "{}", stderr: "" }; } };
  const cfg = devConfig({ stateDir: dir, env: { CONSOLE_RUNNER_SOCKET: sock } });
  const sources = fakeSources({ ctlState: async () => ({ terminals: [{ id: "s1", kind: "console-term", status: "active", started: "2026-10-20T05:00:00Z" }], requests: [], snoozed: [], phases: {}, tasks: {}, usage: {} }) });
  const app = createApp({ cfg, sources, wrapper, log: () => {} });
  try {
    for (let i = 0; i < 50 && !app.runnerClient.connected; i++) await wait(20);
    await app.collectors.refresh("sessions");
    const row = app.collectors.peek("sessions").find((x) => x.id === "s1");
    assert.equal(row && row.state, "snoozed");
    assert.equal(row && row.wakeAt, wakeAt);
    await wait(50);
    const done = calls.filter((c) => c[0] === "ctl" && c.includes("--done"));
    assert.deepEqual(done, [], "snoozed terminal must not be marked done in the registry: " + JSON.stringify(done));
  } finally {
    srv.close();
    if (app.close) await app.close().catch?.(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    setTimeout(() => process.exit(process.exitCode || 0), 100).unref?.();
  }
});
