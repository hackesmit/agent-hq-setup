// The understudy slice (bead hq-ufx9.3): mapUnderstudy hardens the shadow
// loop's report, and the collector wires it in so every fetch is one live
// predict/grade tick wherever the console runs.

import test from "node:test";
import assert from "node:assert/strict";
import { Alerts } from "../src/alerts.js";
import { Collectors, registerAll } from "../src/collectors.js";
import { mapUnderstudy } from "../src/map.js";
import { devConfig, fakeSources, tmpDir } from "./helpers.js";

const REPORT = {
  generatedAt: "2026-08-28T10:00:00Z",
  tick: { stamped: 1, graded: 1 },
  corpus: { total: 40, answered: 31, open: 6, cancelled: 2, missing_answer: 1 },
  live: {
    stamped: 12,
    graded: 5,
    abstentions: 3,
    accuracy: 0.8,
    brier: 0.11,
    skill: 0.42,
    reliability: 0.02,
    resolution: 0.07,
    uncertainty: 0.16,
  },
  backtest: { n: 31, coverage: 0.71, accuracy: 0.86, brier: 0.13, skill: 0.35 },
  history: [
    { ts: "2026-08-27T10:00:00Z", answered: 30, stamped: 11, graded: 4, accuracy: 0.75, brier: 0.14, skill: 0.3 },
    { ts: "2026-08-28T10:00:00Z", answered: 31, stamped: 12, graded: 5, accuracy: 0.8, brier: 0.11, skill: 0.42 },
  ],
};

test("mapUnderstudy carries the numbers through", () => {
  const r = mapUnderstudy(REPORT);
  assert.equal(r.corpus.answered, 31);
  assert.equal(r.live.graded, 5);
  assert.equal(r.live.accuracy, 0.8);
  assert.equal(r.live.brier, 0.11);
  assert.equal(r.backtest.coverage, 0.71);
  assert.equal(r.history.length, 2);
  assert.equal(r.history[1].skill, 0.42);
});

test("nothing graded yet reads as waiting, not as a perfect score", () => {
  const r = mapUnderstudy({
    ...REPORT,
    live: { stamped: 2, graded: 0, abstentions: 1, accuracy: null, brier: 0.0, skill: 0.0 },
    backtest: { n: 0, coverage: 0.0, accuracy: null, brier: 0.0, skill: 0.0 },
  });
  assert.equal(r.live.brier, null);
  assert.equal(r.live.skill, null);
  assert.equal(r.live.accuracy, null);
  assert.equal(r.backtest.brier, null);
});

test("mapUnderstudy is defensive against a mangled report", () => {
  for (const junk of [null, "junk", 7, { live: "no", history: "no" }]) {
    const r = mapUnderstudy(junk);
    assert.equal(r.live.graded, 0);
    assert.equal(r.live.brier, null);
    assert.deepEqual(r.history, []);
    assert.ok(r.generatedAt);
  }
  // a history longer than the cap is trimmed from the old end
  const long = { history: Array.from({ length: 200 }, (_, i) => ({ ts: "2026-08-01T00:00:00Z", graded: i })) };
  const r = mapUnderstudy(long);
  assert.equal(r.history.length, 120);
  assert.equal(r.history[119].graded, 199);
});

test("the collector registers when the source exists and serves the slice", async () => {
  const cfg = devConfig({ stateDir: tmpDir() });
  const reg = new Collectors({});
  registerAll(reg, {
    cfg,
    alerts: new Alerts({ file: cfg.alertsFile, readOnly: true }),
    sources: { ...fakeSources(), understudyData: async () => REPORT },
  });
  const slice = await reg.get("understudy");
  assert.equal(slice.live.graded, 5);
  assert.equal(slice.corpus.answered, 31);
});

test("check mode leaves the ticking collector unregistered: a tick writes state", async () => {
  const cfg = devConfig({ stateDir: tmpDir() });
  const reg = new Collectors({});
  registerAll(reg, {
    cfg,
    alerts: new Alerts({ file: cfg.alertsFile, readOnly: true }),
    readOnly: true,
    sources: { ...fakeSources(), understudyData: async () => REPORT },
  });
  await assert.rejects(() => reg.get("understudy"));
});

test("no understudy source means no collector, not an error", async () => {
  const cfg = devConfig({ stateDir: tmpDir() });
  const reg = new Collectors({});
  registerAll(reg, {
    cfg,
    alerts: new Alerts({ file: cfg.alertsFile, readOnly: true }),
    sources: fakeSources(),
  });
  await assert.rejects(() => reg.get("understudy"));
});
