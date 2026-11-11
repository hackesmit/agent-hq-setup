// Kill always clears a card (hq-je3fk.5). A registry worker's Kill goes to ctl,
// never to the runner, which holds no such session; and a console PTY the
// runner has already lost is cleared through ctl instead of failing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startTestApp } from "./helpers.js";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function withApp(terminals, runnerSessions, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv-kill-"));
  const sock = path.join(dir, "runner.sock");
  const runnerOps = [];
  const srv = net.createServer((s) => {
    let buf = "";
    s.on("error", () => {});
    s.on("data", (c) => {
      buf += c; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        runnerOps.push(msg);
        let reply = { ok: true };
        if (msg.op === "hello") reply = { ok: true, protocol: 1, release: "r", state: "serving", sessions: [] };
        if (msg.op === "list") reply = { ok: true, sessions: runnerSessions };
        if (msg.op === "kill") reply = { ok: false, error: "no such session" };
        s.write(JSON.stringify({ id: msg.id, ...reply }) + "\n");
      }
    });
  });
  await new Promise((r) => srv.listen(sock, r));
  const calls = [];
  const runner = async (cmd, args) => { calls.push(args); return { code: 0, stdout: "{}", stderr: "" }; };
  const t = await startTestApp({
    stateDir: dir,
    env: { CONSOLE_RUNNER_SOCKET: sock },
    runner,
    sources: { ctlState: async () => ({ terminals, requests: [], snoozed: [], phases: {}, tasks: {}, usage: {} }) },
  });
  const post = (url) => t.request("POST", url, { body: {}, headers: { "x-console-key": t.key } });
  try {
    for (let i = 0; i < 50 && !t.app.runnerClient.connected; i++) await wait(20);
    await t.app.collectors.refresh("sessions");
    await fn({ app: t.app, post, calls, runnerOps });
  } finally {
    t.app.runnerClient.stop();
    await t.close();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a registry worker's Kill goes to ctl, not to the runner", async () => {
  const terminals = [{ id: "s-ab12", kind: "worker", status: "finishable", tmux_window: "%315", worktree: "/nope", started: "2026-10-30T10:00:00Z", last_seen: new Date().toISOString() }];
  await withApp(terminals, [], async ({ app, post, calls, runnerOps }) => {
    assert.ok(app.collectors.peek("sessions").some((x) => x.id === "s-ab12"), "fixture row is a card");
    const r = await post("/api/session/s-ab12/kill");
    assert.equal(r.status, 202, JSON.stringify(r.json));
    await app.ops.pending;
    assert.ok(calls.some((a) => a.slice(1).join(" ") === "ctl kill s-ab12"), JSON.stringify(calls));
    assert.equal(runnerOps.filter((m) => m.op === "kill").length, 0);
  });
});

test("Kill on a console terminal the runner already lost clears it through ctl", async () => {
  const runnerSessions = [{ sid: "c-gone1", kind: "interactive", alive: true, writable: true }];
  await withApp([], runnerSessions, async ({ app, post, calls, runnerOps }) => {
    const r = await post("/api/session/c-gone1/kill");
    assert.equal(r.status, 202, JSON.stringify(r.json));
    await app.ops.pending;
    assert.equal(runnerOps.filter((m) => m.op === "kill").length, 1);
    assert.ok(calls.some((a) => a.slice(1).join(" ") === "ctl kill c-gone1"), JSON.stringify(calls));
  });
});
