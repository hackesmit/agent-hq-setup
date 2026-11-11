// Per-project token attribution, server side: usage.py's byProject rows through
// mapUsage, and the same rows landing on a ProjectSummary as tokens30d/costUsd30d.
import test from "node:test";
import assert from "node:assert/strict";
import { Collectors } from "../src/collectors.js";
import { mapUsage } from "../src/map.js";
import { registerProjectCollectors, summarize } from "../src/projects/collectors.js";
import { Registry, normalizeProject } from "../src/projects/registry.js";

const CFG = { hqRoot: "/home/owner/hq", rigsDir: "/home/owner/hq/rigs" };
const NOW = Date.parse("2026-09-06T12:00:00.000Z");
const FACTS = { live: [], closed: [], commits: [], error: null };
const project = (over = {}) =>
  normalizeProject({ id: "gym-tracker", kind: "rig", path: "/home/owner/hq/rigs/gym-tracker", ...over }, CFG);

// Shape copied from usage.py --json on this box (2026-09-06), trimmed to two
// rows. cacheWrite1hTokens is part of the producer's row and deliberately not
// projected onto UsageSummary: the TTL split is a pricing input, and costUsd
// already carries its effect.
const RAW = {
  today: { output: 10, input: 5, sessions: 1, models: { "claude-opus-5": 10 } },
  week: { output: 20 },
  byProjectDays: 30,
  byProject: [
    {
      project: "hq",
      inputTokens: 588065,
      outputTokens: 24506343,
      cacheReadTokens: 7361306761,
      cacheWriteTokens: 205295476,
      cacheWrite1hTokens: 113535601,
      costUsd: 8019.9349,
      sessions: 295,
      tokens: 7591696645,
      unpricedModels: [],
    },
    {
      project: "gym-tracker",
      inputTokens: 780,
      outputTokens: 268768,
      cacheReadTokens: 71798871,
      cacheWriteTokens: 694856,
      cacheWrite1hTokens: 480240,
      costUsd: 96.8927,
      sessions: 3,
      tokens: 72763275,
      unpricedModels: [],
    },
  ],
};

test("mapUsage carries byProject through, coerced and bounded", () => {
  const u = mapUsage(RAW, {});
  assert.equal(u.byProjectDays, 30);
  assert.equal(u.byProject.length, 2);
  assert.deepEqual(u.byProject[1], {
    project: "gym-tracker",
    inputTokens: 780,
    outputTokens: 268768,
    cacheReadTokens: 71798871,
    cacheWriteTokens: 694856,
    costUsd: 96.8927,
    sessions: 3,
  });
  // the day/week contract is untouched
  assert.equal(u.tokensToday, 15);
  assert.equal(u.sessionsToday, 1);
});

test("a usage document with no byProject is an empty list, never a throw", () => {
  const u = mapUsage({ today: {}, week: {} }, {});
  assert.deepEqual(u.byProject, []);
  assert.equal(u.byProjectDays, 30);
  assert.deepEqual(mapUsage(undefined, undefined).byProject, []);
});

test("junk rows are dropped rather than rendered", () => {
  const u = mapUsage(
    { byProject: [{ project: "", costUsd: 5 }, null, "nope", { project: "hq", costUsd: "1.5", sessions: "2" }] },
    {},
  );
  assert.equal(u.byProject.length, 1);
  assert.equal(u.byProject[0].project, "hq");
  assert.equal(u.byProject[0].costUsd, 1.5);
  assert.equal(u.byProject[0].sessions, 2);
  assert.equal(u.byProject[0].inputTokens, 0);
});

test("byProject is capped so one runaway document cannot flood the state", () => {
  const rows = Array.from({ length: 90 }, (_, i) => ({ project: `p-${i}`, costUsd: 1 }));
  assert.equal(mapUsage({ byProject: rows }, {}).byProject.length, 40);
});

test("summarize reports the project's own 30 day tokens and cost", () => {
  const usage = (id) => ({ hq: { tokens: 7591696645, costUsd: 8019.9349 } }[id] || { tokens: 0, costUsd: 0 });
  const hq = summarize(project({ id: "hq", path: "/home/owner/hq" }), FACTS, { nowMs: NOW, cfg: CFG, usage });
  assert.equal(hq.tokens30d, 7591696645);
  assert.equal(hq.costUsd30d, 8019.9349);
});

test("a project the usage slice never saw costs zero, not null", () => {
  const usage = () => ({ tokens: 0, costUsd: 0 });
  const s = summarize(project(), FACTS, { nowMs: NOW, cfg: CFG, usage });
  assert.equal(s.tokens30d, 0);
  assert.equal(s.costUsd30d, 0);
});

test("no usage slice at all reads null, so the tile can say nobody counted", () => {
  const s = summarize(project(), FACTS, { nowMs: NOW, cfg: CFG });
  assert.equal(s.tokens30d, null);
  assert.equal(s.costUsd30d, null);
});

/** Nothing spawns; every bd and git-log call is answered from memory. */
function fakeWrapper() {
  return {
    argv: (verb, args = []) => ({ cmd: "bash", args: [verb, ...args] }),
    async call(verb) {
      return { code: 0, stdout: verb === "git-log" ? "" : "[]", stderr: "" };
    },
  };
}

async function rowsWith(usageCollector) {
  const reg = new Collectors({});
  reg.register("requests", 5, async () => []);
  reg.register("ready", 60, async () => []);
  reg.register("usage", 60, usageCollector);
  registerProjectCollectors({
    collectors: reg,
    wrapper: fakeWrapper(),
    cfg: CFG,
    registry: new Registry(CFG),
    now: () => NOW,
  });
  return reg.get("projects");
}

test("the projects collector reads the usage slice and files each row under its project", async () => {
  const rows = await rowsWith(async () => mapUsage(RAW, {}));
  const hq = rows.find((r) => r.id === "hq");
  const gym = rows.find((r) => r.id === "gym-tracker");
  const chesski = rows.find((r) => r.id === "chesski");
  assert.equal(hq.costUsd30d, 8019.9349);
  assert.equal(hq.tokens30d, 588065 + 24506343 + 7361306761 + 205295476);
  assert.equal(gym.costUsd30d, 96.8927);
  // a real project the usage slice simply did not see spent nothing, which is
  // a measurement, not a gap
  assert.equal(chesski.tokens30d, 0);
  assert.equal(chesski.costUsd30d, 0);
});

test("a dead usage collector leaves every card null rather than claiming zero spend", async () => {
  const rows = await rowsWith(async () => {
    throw new Error("usage.py exited 1");
  });
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.equal(r.tokens30d, null, r.id);
    assert.equal(r.costUsd30d, null, r.id);
  }
});
