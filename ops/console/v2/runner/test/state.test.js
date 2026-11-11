// The state file and the release pin.
//
// The state file is a record, not a resurrection mechanism: a PTY master is a
// descriptor of the runner process, so a session cannot outlive it. What must
// survive is the honest account of what ran and how it ended.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Manager } from "../src/manager.js";
import { WrapperClient } from "../src/wrapper.js";
import { Store, pinRelease, unpinRelease } from "../src/store.js";
import { cleanup, fakeFactory, testEnv } from "./helpers.js";

function mgr(env) {
  const factory = fakeFactory();
  return {
    factory,
    manager: new Manager({
      cfg: env.cfg,
      factory,
      wrapper: new WrapperClient(env.cfg),
      log: () => {},
    }).init(),
  };
}

test("sessions are persisted as they start and as they end", async () => {
  const env = testEnv();
  const t = mgr(env);
  const { sid } = await t.manager.spawn({
    kind: "worker",
    argv: ["fakejob", "run"],
    cwd: env.hq,
    cols: 80,
    rows: 24,
    bead: "hq-njiu",
  });
  const afterSpawn = JSON.parse(fs.readFileSync(env.cfg.stateFile, "utf8"));
  assert.equal(afterSpawn.version, 1);
  assert.equal(afterSpawn.release, "testsha");
  const live = afterSpawn.sessions.find((s) => s.sid === sid);
  assert.equal(live.alive, true);
  assert.equal(live.bead, "hq-njiu");
  assert.equal(live.log, path.join(env.cfg.termDir, `${sid}.log`));

  t.factory.last().finish(7);
  const afterExit = JSON.parse(fs.readFileSync(env.cfg.stateFile, "utf8"));
  const dead = afterExit.sessions.filter((s) => s.sid === sid);
  assert.ok(dead.length >= 1);
  assert.equal(dead[dead.length - 1].exitCode, 7);
  assert.equal(dead[dead.length - 1].alive, false);
  cleanup(env.dir);
});

test("a restart reports the previous runner's sessions as ended, never as live", async () => {
  const env = testEnv();
  const first = mgr(env);
  await first.manager.spawn({ kind: "interactive", argv: ["fakejob"], cwd: env.hq, cols: 80, rows: 24 });
  // no exit event: this is a crash or a SIGKILL, the harshest case
  const second = mgr(env);
  assert.deepEqual(second.manager.list(), [], "nothing is resurrected");
  const persisted = JSON.parse(fs.readFileSync(env.cfg.stateFile, "utf8"));
  assert.equal(persisted.sessions.length, 1);
  assert.equal(persisted.sessions[0].alive, false);
  assert.equal(persisted.sessions[0].endedBy, "runner restart");
  cleanup(env.dir);
});

test("a corrupt state file does not stop the daemon", () => {
  const env = testEnv();
  fs.mkdirSync(env.cfg.stateDir, { recursive: true });
  fs.writeFileSync(env.cfg.stateFile, "{ this is not json");
  const t = mgr(env);
  assert.deepEqual(t.manager.list(), []);
  cleanup(env.dir);
});

test("the store writes atomically and leaves no temp file behind", () => {
  const env = testEnv();
  const store = new Store({ file: env.cfg.stateFile });
  assert.equal(store.save({ release: "abc", sessions: [{ sid: "s1" }] }), true);
  assert.equal(JSON.parse(fs.readFileSync(env.cfg.stateFile, "utf8")).release, "abc");
  assert.deepEqual(
    fs.readdirSync(env.cfg.stateDir).filter((f) => f.includes(".tmp")),
    [],
  );
  assert.equal(fs.statSync(env.cfg.stateFile).mode & 0o777, 0o640);
  cleanup(env.dir);
});

test("the release pin keeps activation from pruning a release we are running", async () => {
  const env = testEnv();
  const t = mgr(env);
  const pins = () => fs.readFileSync(env.cfg.pinFile, "utf8").split("\n").filter(Boolean);
  assert.deepEqual(pins(), ["testsha"]);
  await t.manager.shutdown();
  assert.deepEqual(pins(), [], "a clean exit releases the pin");
  cleanup(env.dir);
});

test("pinning is idempotent and leaves other runners' pins alone", () => {
  const env = testEnv();
  const f = env.cfg.pinFile;
  pinRelease(f, "aaa");
  pinRelease(f, "bbb");
  pinRelease(f, "bbb");
  assert.deepEqual(fs.readFileSync(f, "utf8").split("\n").filter(Boolean), ["aaa", "bbb"]);
  unpinRelease(f, "aaa");
  assert.deepEqual(fs.readFileSync(f, "utf8").split("\n").filter(Boolean), ["bbb"]);
  assert.equal(pinRelease(f, "dev"), false, "a dev tree has no release to pin");
  cleanup(env.dir);
});
