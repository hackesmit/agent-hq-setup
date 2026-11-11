// hq-zqqu.1 round 4: /api/req-clear takes only an owed answer off the board.
// An open question is refused with a 400 before any op is queued, and the ctl
// argv always carries --owed so ctl refuses it too if the slice has not seen it.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "./helpers.js";

function recordingRunner(calls) {
  return async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { code: 0, stdout: "ok\n", stderr: "" };
  };
}

const req = (id, status, extra = {}) => ({ id, question: "q?", status, session: "s-1", ts: "2026-10-20T00:00:00Z", ...extra });

test("req-clear refuses an open or snoozed question (400) and clears only an owed answer", async () => {
  const calls = [];
  const ctlState = async () => ({
    terminals: [],
    requests: [req("hq-open", "open"), req("hq-ans", "answered"), req("hq-rev", "revival_claimed"), req("hq-done", "delivered")],
    snoozed: [req("hq-snz", "open", { snooze_until: "2099-01-01T00:00:00Z" })],
    phases: {},
    tasks: {},
    usage: {},
  });
  const t = await startTestApp({ runner: recordingRunner(calls), sources: { ctlState } });
  try {
    const h = { "x-console-key": t.key };
    const s = await t.request("GET", "/api/state/requests", { headers: h });
    assert.equal(s.status, 200, s.text);
    for (const rid of ["hq-open", "hq-snz", "hq-done"]) {
      const r = await t.request("POST", "/api/req-clear", { headers: h, body: { rid } });
      assert.equal(r.status, 400, `${rid}: ${r.status} ${r.text}`);
    }
    assert.equal(calls.length, 0, "a refused clear must not start a process");
    for (const rid of ["hq-ans", "hq-rev"]) {
      const r = await t.request("POST", "/api/req-clear", { headers: h, body: { rid } });
      assert.equal(r.status, 202, `${rid}: ${r.text}`);
    }
    // an id the slice does not know yet still goes to ctl, which re-checks with --owed
    const r = await t.request("POST", "/api/req-clear", { headers: h, body: { rid: "hq-unseen" } });
    assert.equal(r.status, 202, r.text);
    await t.app.ops.pending;
    assert.equal(calls.length, 3);
    for (const c of calls) {
      const i = c.args.indexOf("clear");
      assert.ok(i >= 0, JSON.stringify(c.args));
      assert.equal(c.args[i + 2], "--owed", JSON.stringify(c.args));
    }
  } finally {
    await t.close();
  }
});
