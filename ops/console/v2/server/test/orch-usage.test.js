// hq-4npjr.7: orch_usage.py's usage.json -> UsageSummary.orchestrator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapUsage, mapOrchUsage } from "../src/map.js";

const win = { calls: 2, inputTokens: 100, outputTokens: 40, costUsd: 0.3, models: [{ model: "claude-fable-5-1", calls: 2, inputTokens: 100, outputTokens: 40, costUsd: 0.3 }] };

test("mapOrchUsage carries the windows and share, coerced", () => {
  const o = mapOrchUsage({ today: win, week: win, shareOfHq: 0.31, threshold: 0.25, planWeeklyPct: 12, at: "2026-11-04T06:00:00Z" });
  assert.equal(o.week.models[0].model, "claude-fable-5-1");
  assert.equal(o.shareOfHq, 0.31);
  assert.equal(o.planWeeklyPct, 12);
});

test("mapOrchUsage: junk is null or zero, never NaN", () => {
  assert.equal(mapOrchUsage(null), null);
  assert.equal(mapOrchUsage([1]), null);
  const o = mapOrchUsage({ today: "x", week: { calls: "NaN", models: [{ model: "" }, 5] }, shareOfHq: "0.5", threshold: null });
  assert.equal(o.shareOfHq, null);
  assert.equal(o.today.calls, 0);
  assert.deepEqual(o.week.models, []);
});

test("mapUsage without a summary has orchestrator null", () => {
  assert.equal(mapUsage({}, {}).orchestrator, null);
  assert.equal(mapUsage({}, {}, { today: win, week: win, shareOfHq: 0.1, threshold: 0.25 }).orchestrator.shareOfHq, 0.1);
});
