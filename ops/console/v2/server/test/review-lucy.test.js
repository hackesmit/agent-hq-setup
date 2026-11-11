// Fixes from the 2026-08-19 lucy (cross-vendor) review of the phase 1 batch.
// Each test here is the runnable form of a finding that was accepted.

import test from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "./helpers.js";

test("lucy 1: ctl verbs aimed at a synthetic truths- id are refused before any op exists", async () => {
  let spawned = 0;
  const t = await startTestApp({
    runner: async () => {
      spawned += 1;
      return { code: 0, stdout: "ok", stderr: "" };
    },
  });
  try {
    const cases = [
      ["/api/answer", { rid: "truths-demo-a1", text: "yes" }],
      ["/api/done", { rid: "truths-demo-a1" }],
      ["/api/skip", { rid: "truths-demo-a1", reason: "nope" }],
      ["/api/resolve", { rid: "truths-demo-a1" }],
      ["/api/req-snooze", { rid: "truths-demo-a1", until: "tomorrow 9am" }],
      ["/api/req-unsnooze", { rid: "truths-demo-a1" }],
      ["/api/sink", { rid: "truths-demo-a1" }],
    ];
    for (const [url, body] of cases) {
      const r = await t.request("POST", url, { body, headers: { "x-console-key": t.key } });
      assert.equal(r.status, 400, `${url} must refuse a truths- id, got ${r.status}: ${r.text}`);
      assert.match(r.json.error, /truths assumption/);
    }
    assert.equal(spawned, 0, "no process may run for a refused synthetic id");
    // and a real-looking rid still passes validation (the op may fail later, but the id is accepted)
    const ok = await t.request("POST", "/api/resolve", { body: { rid: "r-123" }, headers: { "x-console-key": t.key } });
    assert.equal(ok.status, 202, ok.text);
  } finally {
    await t.close();
  }
});
