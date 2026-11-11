// The trust boundary: nothing in the server may spawn a process except
// ops/console/v2/runner/spawn-as-owner.sh, sudo'd to owner in production.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { Wrapper } from "../src/wrapper.js";
import { buildVerbs } from "../src/actions.js";
import { defaultSources } from "../src/collectors.js";
import { devConfig, tmpDir } from "./helpers.js";

const prod = (over = {}) => loadConfig({ env: { CONSOLE_HOST: "hqbox.example.ts.net", ...over }, argv: [] });

test("production sudos to owner through the release's wrapper", () => {
  const cfg = prod();
  assert.equal(cfg.wrapperSudo, true);
  assert.equal(cfg.wrapperPath, "/var/lib/hqconsole/releases/current/runner/spawn-as-owner.sh");
  assert.equal(cfg.consoleStateDir, "/var/lib/hqconsole/state");
  const { cmd, args } = new Wrapper(cfg).argv("ctl", ["state"]);
  assert.equal(cmd, "sudo");
  assert.deepEqual(args, [
    "-n",
    "-u",
    "owner",
    "/var/lib/hqconsole/releases/current/runner/spawn-as-owner.sh",
    "ctl",
    "state",
  ]);
});

test("dev runs the repo wrapper directly, state under the repo", () => {
  const cfg = devConfig({ stateDir: undefined, env: { CONSOLE_STATE_DIR: "" }, hqRoot: "/home/owner/hq" });
  assert.equal(cfg.wrapperSudo, false);
  assert.equal(cfg.wrapperPath, "/home/owner/hq/ops/console/v2/runner/spawn-as-owner.sh");
  assert.equal(cfg.consoleStateDir, "/home/owner/hq/state/console-v2");
  const { cmd, args } = new Wrapper(cfg).argv("hw", ["--state", "/tmp/x"]);
  assert.equal(cmd, "bash");
  assert.deepEqual(args, ["/home/owner/hq/ops/console/v2/runner/spawn-as-owner.sh", "hw", "--state", "/tmp/x"]);
});

test("CONSOLE_WRAPPER and CONSOLE_WRAPPER_SUDO override both halves", () => {
  const cfg = prod({ CONSOLE_WRAPPER: "/opt/hq/wrap.sh", CONSOLE_WRAPPER_SUDO: "0" });
  const { cmd, args } = new Wrapper(cfg).argv("probe");
  assert.equal(cmd, "bash");
  assert.deepEqual(args, ["/opt/hq/wrap.sh", "probe"]);
  const sudoed = new Wrapper(prod({ CONSOLE_DEV_NOAUTH: "1", CONSOLE_WRAPPER_SUDO: "1" })).argv("probe");
  assert.equal(sudoed.cmd, "sudo");
});

test("every collector source goes through the wrapper, with the right verbs", async () => {
  const calls = [];
  const cfg = devConfig({ stateDir: tmpDir() });
  const w = new Wrapper(cfg, {
    runner: async (cmd, args) => {
      calls.push(args.slice(1));
      return { code: 0, stdout: "{}", stderr: "" };
    },
  });
  const src = defaultSources(cfg, w);
  await src.ctlState();
  await src.hw("/tmp/s");
  await src.usage("/tmp/s");
  await src.readyBeads({ id: "hq", path: "." }).catch(() => {});
  await src.readyBeads({ id: "chesski", path: "rigs/chesski" }).catch(() => {});
  assert.deepEqual(calls[0], ["ctl", "state"]);
  assert.deepEqual(calls[1], ["hw", "--state", "/tmp/s"]);
  assert.deepEqual(calls[2], ["usage", "--state", "/tmp/s"]);
  assert.deepEqual(calls[3], ["bd", "ready", "--json"]);
  assert.deepEqual(calls[4], ["bd-rig", "chesski", "ready", "--json"]);
});

test("every action verb builds a wrapper invocation, never a direct ctl.sh call", () => {
  const cfg = devConfig({ stateDir: tmpDir() });
  const w = new Wrapper(cfg);
  const verbs = buildVerbs({ cfg, wrapper: w });
  const bodies = {
    answer: { rid: "r-1", text: "yes" },
    done: { rid: "r-1" },
    skip: { rid: "r-1", reason: "not now" },
    resolve: { rid: "r-1" },
    "req-snooze": { rid: "r-1", until: "tomorrow 9am" },
    "req-unsnooze": { rid: "r-1" },
    sink: { rid: "r-1" },
    dispatch: { bead: "hq-1", rig: "hq", model: "claude-opus-4-8" },
    "dispatch-batch": { rig: "hq", beads: ["hq-1", "hq-2"] },
    focus: { session: "t-1" },
    kill: { session: "t-1" },
    snooze: { session: "t-1", until: "tomorrow 9am" },
    name: { session: "t-1", name: "acme reconciliation" },
    "finish-check": { session: "t-1" },
    finish: { session: "t-1" },
    phase: { bead: "hq-1", phase: "plan" },
    capture: { rig: "chesski", title: "idea" },
  };
  for (const [verb, body] of Object.entries(bodies)) {
    const plan = verbs[verb](body);
    assert.equal(plan.cmd, "bash", `${verb} must run through the wrapper`);
    assert.equal(plan.args[0], cfg.wrapperPath, `${verb} must run the wrapper script`);
    assert.ok(
      ["ctl", "bd", "bd-rig", "snooze"].includes(plan.args[1]),
      `${verb} used an unexpected wrapper verb: ${plan.args[1]}`,
    );
    assert.ok(!plan.args.some((a) => a.includes("ops/console/ctl.sh")), `${verb} calls ctl.sh directly`);
  }
  assert.deepEqual(verbs.done({ rid: "r-1" }).args.slice(1), ["ctl", "answer", "r-1", "done"]);
  assert.deepEqual(verbs.skip({ rid: "r-1", reason: "not now" }).args.slice(1), [
    "ctl",
    "answer",
    "r-1",
    "skipped: not now",
  ]);
  assert.deepEqual(verbs.capture({ rig: "chesski", title: "idea" }).args.slice(1), [
    "bd-rig",
    "chesski",
    "create",
    "idea",
    "-p",
    "2",
    "-t",
    "task",
  ]);
});

test("the wrapper verbs the server uses all exist in spawn-as-owner.sh", () => {
  const script = fs.readFileSync(
    path.join("/home/owner/hq", "ops", "console", "v2", "runner", "spawn-as-owner.sh"),
    "utf8",
  );
  for (const verb of ["ctl)", "bd)", "bd-rig)", "hw)", "usage)", "snooze)", "probe)"]) {
    assert.ok(script.includes(verb), `wrapper is missing the ${verb} verb`);
  }
  const ctlVerbs = script.match(/^CTL_VERBS="([^"]+)"/m)[1].split(/\s+/);
  for (const v of [
    "state",
    "answer",
    "resolve",
    "req-snooze",
    "req-unsnooze",
    "sink",
    "dispatch",
    "dispatch-batch",
    "kill",
    "finish",
    "finish-check",
    "focus",
    "name",
    "phase",
  ]) {
    assert.ok(ctlVerbs.includes(v), `wrapper CTL_VERBS is missing ${v}`);
  }
});

test("the health file records sha, time and port for the activation script", async () => {
  const { startTestApp } = await import("./helpers.js");
  const t = await startTestApp();
  try {
    const rec = t.app.writeHealthFile(8787);
    assert.equal(rec.port, 8787);
    assert.equal(rec.sha, "dev");
    const onDisk = JSON.parse(fs.readFileSync(t.cfg.healthFile, "utf8"));
    assert.deepEqual(onDisk, rec);
    assert.ok(Date.parse(onDisk.at) > 0);
  } finally {
    await t.close();
  }
});
