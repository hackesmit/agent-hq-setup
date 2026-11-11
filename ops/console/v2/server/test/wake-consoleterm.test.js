// Reviewer repro (hq-4npjr.5): a snoozed console terminal while the runner does not
// list it (runner down or restarted) must not be woken by wake.sh, which starts a
// fresh claude in the rig dir while the runner later resumes the real conversation.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startTestApp } from "./helpers.js";

test("snoozed console-term with no runner PTY is not woken through wake.sh", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv-ct-"));
  const calls = [];
  const runner = async (cmd, args) => { calls.push(args); return { code: 0, stdout: "{}", stderr: "" }; };
  const terminals = [{ id: "s-ct01", kind: "console-term", status: "snoozed", wake_at: Math.floor(Date.now() / 1000) + 3600, started: "2026-11-04T00:00:00Z", worktree: "/home/owner/hq/rigs/peel", rig: "peel" }];
  const t = await startTestApp({
    stateDir: dir,
    env: { CONSOLE_RUNNER_SOCKET: path.join(dir, "absent.sock") },
    runner,
    sources: { ctlState: async () => ({ terminals, requests: [], snoozed: [], phases: {}, tasks: {}, usage: {} }) },
  });
  try {
    await t.app.collectors.refresh("sessions");
    const r = await t.request("POST", "/api/session/s-ct01/wake", { body: {}, headers: { "x-console-key": t.key } });
    await t.app.ops.pending;
    const woke = calls.some((a) => a.slice(1).join(" ") === "wake s-ct01");
    assert.equal(woke, false, `status ${r.status}; wrapper calls ${JSON.stringify(calls)}`);
    assert.equal(r.status, 502, "runner down, as kill does");
  } finally {
    t.app.runnerClient.stop();
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Round 2 (note 3): the generic verb route POST /api/wake {session} gets the same gate.
async function genericWake(terminals, session) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv-gw-"));
  const calls = [];
  const runner = async (cmd, args) => { calls.push(args); return { code: 0, stdout: "{}", stderr: "" }; };
  const t = await startTestApp({
    stateDir: dir,
    env: { CONSOLE_RUNNER_SOCKET: path.join(dir, "absent.sock") },
    runner,
    sources: { ctlState: async () => ({ terminals, requests: [], snoozed: [], phases: {}, tasks: {}, usage: {} }) },
  });
  try {
    await t.app.collectors.refresh("sessions");
    const r = await t.request("POST", "/api/wake", { body: { session }, headers: { "x-console-key": t.key } });
    await t.app.ops.pending;
    return { status: r.status, woke: calls.some((a) => a.slice(1).join(" ") === `wake ${session}`) };
  } finally {
    t.app.runnerClient.stop();
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SOON = () => Math.floor(Date.now() / 1000) + 3600;

test("POST /api/wake on a snoozed console-term with no runner PTY fails, wake.sh never runs", async () => {
  const r = await genericWake([{ id: "s-ct02", kind: "console-term", status: "snoozed", wake_at: SOON(), started: "2026-11-04T00:00:00Z" }], "s-ct02");
  assert.equal(r.woke, false);
  assert.equal(r.status, 502);
});

test("POST /api/wake on a session that is not asleep is refused", async () => {
  const r = await genericWake([{ id: "s-up02", kind: "worker", status: "active", started: "2026-11-04T00:00:00Z" }], "s-up02");
  assert.equal(r.woke, false);
  assert.equal(r.status, 400);
});

test("POST /api/wake on a snoozed worker still runs wake.sh", async () => {
  const r = await genericWake([{ id: "s-zz02", kind: "worker", status: "snoozed", wake_at: SOON(), started: "2026-11-04T00:00:00Z" }], "s-zz02");
  assert.equal(r.woke, true);
  assert.equal(r.status, 202);
});
