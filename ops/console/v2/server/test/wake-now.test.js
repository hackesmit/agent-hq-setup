// Wake now on the Now page (hq-4npjr.5): a snoozed registry worker wakes through the
// wrapper's wake verb (wake.sh), a console terminal still wakes through the runner, and
// a session that is not asleep is refused.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTestApp } from "./helpers.js";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function withApp(terminals, runnerSessions, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv-wake-"));
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

const WRAPPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "runner", "spawn-as-owner.sh");

test("a snoozed worker wakes through the wrapper's wake verb", async () => {
  const terminals = [{ id: "s-zz12", kind: "worker", status: "snoozed", wake_at: Math.floor(Date.now() / 1000) + 3600, started: "2026-11-04T00:00:00Z" }];
  await withApp(terminals, [], async ({ app, post, calls, runnerOps }) => {
    const r = await post("/api/session/s-zz12/wake");
    assert.equal(r.status, 202, JSON.stringify(r.json));
    await app.ops.pending;
    assert.ok(calls.some((a) => a.slice(1).join(" ") === "wake s-zz12"), JSON.stringify(calls));
    assert.equal(runnerOps.filter((m) => m.op === "term.wake").length, 0);
  });
});

test("wake on a session that is not asleep is refused", async () => {
  const terminals = [{ id: "s-up12", kind: "worker", status: "active", started: "2026-11-04T00:00:00Z", last_seen: new Date().toISOString(), pane_live: true }];
  await withApp(terminals, [], async ({ post, calls }) => {
    const r = await post("/api/session/s-up12/wake");
    assert.equal(r.status, 400);
    assert.ok(!calls.some((a) => a.includes("wake")), JSON.stringify(calls));
  });
});

test("the wrapper's wake verb takes exactly one session id and runs wake.sh with it", () => {
  const hq = fs.mkdtempSync(path.join(os.tmpdir(), "rv-wakehq-"));
  fs.mkdirSync(path.join(hq, "ops", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(hq, "ops", "scripts", "wake.sh"), 'echo "woke:$*"\n');
  const run = (...args) => spawnSync("bash", [WRAPPER, "wake", ...args], { env: { ...process.env, HQ_ROOT: hq }, encoding: "utf8" });
  try {
    const ok = run("s-zz12");
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), "woke:s-zz12");
    for (const bad of [[], ["s-1", "extra"], ["--all"], ["s-1;rm -rf /"], ["../x"]]) {
      const r = run(...bad);
      assert.equal(r.status, 2, `${JSON.stringify(bad)}: ${r.stdout}${r.stderr}`);
      assert.doesNotMatch(r.stdout, /woke/);
    }
  } finally {
    fs.rmSync(hq, { recursive: true, force: true });
  }
});
