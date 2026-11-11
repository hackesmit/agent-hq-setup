// Session kinds and their two hard rules:
//   a worker never accepts a keystroke and its output IS written to disk;
//   an interactive session accepts keystrokes and its output is NEVER written
//   to disk (the stream echoes what was typed, so a pasted token would land in
//   the file: design section 3).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Manager } from "../src/manager.js";
import { Ring } from "../src/ring.js";
import { WrapperClient } from "../src/wrapper.js";
import { cleanup, fakeFactory, testEnv, wait } from "./helpers.js";

function mgr(over = {}) {
  const env = testEnv(over);
  const factory = fakeFactory();
  const wrapper = new WrapperClient(env.cfg);
  const m = new Manager({ cfg: env.cfg, factory, wrapper, log: () => {} }).init();
  return { ...env, factory, manager: m, done: () => cleanup(env.dir) };
}

test("a worker refuses input and logs to disk 0640", async () => {
  const t = mgr();
  const { sid } = await t.manager.spawn({ kind: "worker", argv: ["fakejob"], cwd: t.hq, cols: 80, rows: 24 });
  t.factory.last().say("worker output\n");
  await assert.rejects(() => t.manager.input(sid, "rm -rf /\r"), (e) => e.code === "read-only");
  const logFile = path.join(t.cfg.termDir, `${sid}.log`);
  assert.equal(fs.readFileSync(logFile, "utf8"), "worker output\n");
  assert.equal(fs.statSync(logFile).mode & 0o777, 0o640);
  assert.equal(t.factory.last().writes.length, 0);
  t.done();
});

test("log:false keeps even a worker off disk", async () => {
  const t = mgr();
  const { sid } = await t.manager.spawn({
    kind: "worker",
    argv: ["fakejob"],
    cwd: t.hq,
    cols: 80,
    rows: 24,
    log: false,
  });
  t.factory.last().say("secret");
  assert.equal(fs.existsSync(path.join(t.cfg.termDir, `${sid}.log`)), false);
  assert.equal((await t.manager.attach(sid, {})).replay, "secret");
  t.done();
});

test("an interactive session takes input and writes nothing to disk", async () => {
  const t = mgr();
  const { sid } = await t.manager.spawn({ kind: "interactive", argv: ["fakejob"], cwd: t.hq, cols: 80, rows: 24 });
  t.factory.last().say("$ ");
  await t.manager.input(sid, "ls\r");
  assert.deepEqual(t.factory.last().writes, ["ls\r"]);
  assert.deepEqual(fs.readdirSync(t.cfg.termDir), []);
  const a = await t.manager.attach(sid, {});
  assert.equal(a.writable, true);
  t.done();
});

test("input to an exited session is refused", async () => {
  const t = mgr();
  const { sid } = await t.manager.spawn({ kind: "interactive", argv: ["fakejob"], cwd: t.hq, cols: 80, rows: 24 });
  t.factory.last().finish(0);
  await assert.rejects(() => t.manager.input(sid, "x"), (e) => e.code === "no such session");
  t.done();
});

test("oversized input is refused before it reaches the pty", async () => {
  const t = mgr({ RUNNER_MAX_INPUT_BYTES: "16" });
  const { sid } = await t.manager.spawn({ kind: "interactive", argv: ["fakejob"], cwd: t.hq, cols: 80, rows: 24 });
  await assert.rejects(() => t.manager.input(sid, "x".repeat(17)), (e) => e.code === "input too large");
  assert.equal(t.factory.last().writes.length, 0);
  t.done();
});

test("multiple attachers share one session and both get the replay", async () => {
  const t = mgr();
  const { sid } = await t.manager.spawn({ kind: "interactive", argv: ["fakejob"], cwd: t.hq, cols: 80, rows: 24 });
  t.factory.last().say("line one\n");
  const a = await t.manager.attach(sid, { cols: 80, rows: 24 });
  const b = await t.manager.attach(sid, { cols: 80, rows: 24 });
  assert.equal(a.replay, "line one\n");
  assert.equal(b.replay, "line one\n");
  const seen = [];
  t.manager.on("data", (ev) => seen.push(ev));
  t.factory.last().say("line two\n");
  assert.equal(seen.length, 1, "the manager emits once; fan-out is the socket layer's job");
  t.done();
});

test("the replay buffer keeps the tail, not the head", () => {
  const r = new Ring(1024);
  for (let i = 0; i < 500; i++) r.push(`line ${i}\n`);
  const out = r.toString();
  assert.ok(Buffer.byteLength(out) <= 1024);
  assert.ok(out.endsWith("line 499\n"));
  assert.ok(!out.includes("line 0\n"));
});

test("a single oversized chunk is trimmed to the limit", () => {
  const r = new Ring(2048);
  r.push("x".repeat(5000));
  assert.equal(r.bytes, 2048);
  assert.equal(r.toString().length, 2048);
});

test("multi-byte output survives the ring", () => {
  const r = new Ring(1024);
  for (let i = 0; i < 200; i++) r.push("mañana ok\n");
  assert.ok(r.toString().endsWith("mañana ok\n"));
  assert.ok(!r.toString().includes("�"), "no chunk was split mid-sequence");
});

test("a session that exits is still attachable for its replay window", async () => {
  const t = mgr();
  const { sid } = await t.manager.spawn({ kind: "worker", argv: ["fakejob"], cwd: t.hq, cols: 80, rows: 24 });
  t.factory.last().say("final words\n");
  t.factory.last().finish(2);
  const a = await t.manager.attach(sid, {});
  assert.equal(a.replay, "final words\n");
  assert.equal(a.writable, false);
  assert.equal(a.alive, false);
  await wait(120);
  await assert.rejects(() => t.manager.attach(sid, {}), (e) => e.code === "no such session");
  t.done();
});

test("a pty that cannot be created fails the spawn, it does not kill the runner", async () => {
  const env = testEnv();
  const m = new Manager({
    cfg: env.cfg,
    factory: fakeFactory({ throws: "node-pty did not load" }),
    wrapper: new WrapperClient(env.cfg),
    log: () => {},
  }).init();
  await assert.rejects(
    () => m.spawn({ kind: "worker", argv: ["fakejob"], cwd: env.hq, cols: 80, rows: 24 }),
    (e) => e.code === "pty unavailable",
  );
  assert.equal(m.list().length, 0);
  cleanup(env.dir);
});

test("the wrapper builds the pty-spawn argv and filters the environment", () => {
  const env = testEnv({ RUNNER_WRAPPER: "/usr/local/lib/hq-console/spawn-as-owner.sh", RUNNER_WRAPPER_SUDO: "1" });
  const w = new WrapperClient(env.cfg);
  const { cmd, args } = w.ptyArgv({
    cwd: "/home/owner/hq/rigs/acme-dashboard",
    argv: ["claude", "-p", "do the thing"],
    env: { HQ_BEAD: "hq-njiu", PATH: "/evil/bin", LD_PRELOAD: "/evil.so" },
  });
  assert.equal(cmd, "sudo");
  assert.deepEqual(args, [
    "-n",
    "-u",
    "owner",
    "/usr/local/lib/hq-console/spawn-as-owner.sh",
    "pty-spawn",
    "/home/owner/hq/rigs/acme-dashboard",
    "--env",
    "HQ_BEAD=hq-njiu",
    "--",
    "claude",
    "-p",
    "do the thing",
  ]);
  cleanup(env.dir);
});
