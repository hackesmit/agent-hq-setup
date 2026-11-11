// Review check (hq-je3fk.5): with the runner unreachable, Kill on a LIVE console
// terminal (registry kind console-term) must not report success through ctl,
// because ctl kill never touches a console-term pane and only marks the row done:
// the card disappears while the terminal's claude keeps running.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startTestApp } from "./helpers.js";

test("runner down: Kill on a live console terminal is not a silent ctl 'done'", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv-kill-down-"));
  const calls = [];
  const runner = async (cmd, args) => { calls.push(args); return { code: 0, stdout: "{}", stderr: "" }; };
  const terminals = [{ id: "smvlive0000001", kind: "console-term", status: "active", tmux_window: "", started: "2026-10-30T10:00:00Z", last_seen: new Date().toISOString() }];
  const t = await startTestApp({
    stateDir: dir,
    env: { CONSOLE_RUNNER_SOCKET: path.join(dir, "no-runner.sock") },
    runner,
    sources: { ctlState: async () => ({ terminals, requests: [], snoozed: [], phases: {}, tasks: {}, usage: {} }) },
  });
  try {
    await t.app.collectors.refresh("sessions");
    const r = await t.request("POST", "/api/session/smvlive0000001/kill", { body: {}, headers: { "x-console-key": t.key } });
    await t.app.ops.pending;
    const viaCtl = calls.some((a) => a.slice(1).join(" ") === "ctl kill smvlive0000001");
    assert.equal(viaCtl, false, `status ${r.status}: Kill was sent to ctl kill, which marks a live console terminal done without ending it`);
  } finally {
    t.app.runnerClient.stop();
    await t.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
