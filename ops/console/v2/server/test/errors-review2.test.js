// hq-hsl2.3 lucy round 2: one test per item.
//   1 no cap before status: >5000 newer history files cannot hide an older escalated incident
//   2 the id is the file name; an embedded id that disagrees is malformed (no resolve, no pane)
//   3 a deeply nested JSON file is one malformed entry, end to end through the helper
//   4 timestamps outside the Date range normalize to null
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildReport, normalizeIncident } from "../src/errors.js";
import { tmpDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.resolve(here, "..", "..", "runner", "errors-verbs.py");

function hq() {
  const root = tmpDir("hq-errors-r2-");
  const dir = path.join(root, "state", "errors", "incidents");
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}

function helper(root, args, env = {}) {
  const r = spawnSync("/usr/bin/python3", [HELPER, root, ...args], {
    encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: r.stdout && r.stdout.trim() ? JSON.parse(r.stdout) : null, err: r.stderr };
}

test("1: an escalated incident older than 5001 history files is still listed", () => {
  const { root, dir } = hq();
  const old = Date.now() / 1000 - 1e6;
  const esc = path.join(dir, "old-esc.json");
  fs.writeFileSync(esc, JSON.stringify({ status: "escalated", title: "oldest" }));
  fs.utimesSync(esc, old, old);
  for (let i = 0; i < 5001; i++) fs.writeFileSync(path.join(dir, `h${i}.json`), '{"status":"resolved"}');
  const r = helper(root, ["list"], { PATH: "/nonexistent" });
  assert.equal(r.code, 0, r.err);
  const rep = buildReport(r.out);
  assert.ok(rep.incidents.some((i) => i.id === "old-esc" && i.status === "escalated"));
  assert.equal(rep.omitted, 5001 - 300);
});

test("2: a.json claiming id b is malformed, cannot be resolved, and gets no pane", () => {
  const { root, dir } = hq();
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify({ id: "b", status: "fixing", title: "liar", fixer: { tmux_target: "hq-errors:b" } }));
  fs.writeFileSync(path.join(dir, "c.json"), JSON.stringify({ id: "c", status: "escalated", title: "honest" }));
  const r = helper(root, ["list"], { PATH: "/nonexistent" });
  const rep = buildReport(r.out);
  assert.deepEqual(rep.incidents.map((i) => i.id), ["c"]);
  assert.deepEqual(rep.malformed.map((m) => m.file), ["a.json"]);
  assert.deepEqual(Object.keys(r.out.panes), [], "no pane lookup for the lying file");
  assert.equal(helper(root, ["resolve", "a"], { HQ_ERRORS_LOCK_WAIT_S: "1" }).code, 5);
  assert.equal(helper(root, ["resolve", "b"], { HQ_ERRORS_LOCK_WAIT_S: "1" }).code, 4);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "a.json"), "utf8")).status, "fixing");
  assert.throws(() => normalizeIncident({ id: "b" }, "a.json", 0), /does not match/);
});

test("3: a deeply nested file is one malformed entry beside a valid escalated incident", () => {
  const { root, dir } = hq();
  fs.writeFileSync(path.join(dir, "deep.json"), "[".repeat(2000) + "0" + "]".repeat(2000));
  fs.writeFileSync(path.join(dir, "deepobj.json"), '{"status":"fixing","x":' + "[".repeat(2000) + "0" + "]".repeat(2000) + "}");
  fs.writeFileSync(path.join(dir, "ok.json"), JSON.stringify({ status: "escalated", title: "fine" }));
  const r = helper(root, ["list"], { PATH: "/nonexistent" });
  assert.equal(r.code, 0, r.err);
  const rep = buildReport(r.out);
  assert.ok(rep.incidents.some((i) => i.id === "ok" && i.status === "escalated"));
  assert.ok(rep.malformed.some((m) => m.file === "deep.json"));
  assert.equal(helper(root, ["resolve", "deep"], { HQ_ERRORS_LOCK_WAIT_S: "1" }).code, 5);
});

test("4: timestamps outside the Date range are null, sane ones survive", () => {
  const inc = normalizeIncident(
    { status: "fixing", opened_ts: 1e300, updated_ts: -1, last_repeat_ts: "1e300", condition_since: 1e11, fixer: { started_ts: 1e300 }, last_seen_ts: 1_700_000_000 },
    "t.json",
    Number.NaN,
  );
  assert.equal(inc.openedTs, null);
  assert.equal(inc.updatedTs, null);
  assert.equal(inc.lastRepeatTs, null);
  assert.equal(inc.conditionSinceTs, null);
  assert.equal(inc.fixer.startedTs, null);
  assert.equal(inc.lastSeenTs, 1_700_000_000);
});
