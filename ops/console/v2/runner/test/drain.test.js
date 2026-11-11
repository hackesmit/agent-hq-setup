// The drain protocol is how the runner is replaced without hanging up a
// session: advertise draining, refuse new spawns, exit by itself at zero.

import test from "node:test";
import assert from "node:assert/strict";
import { startRunner } from "../src/runner.js";
import { cleanup, connectClient, fakeFactory, testEnv, wait } from "./helpers.js";

async function boot() {
  const env = testEnv();
  const factory = fakeFactory();
  const app = await startRunner({ cfg: env.cfg, factory, exitOnDrain: false, log: () => {} });
  const client = await connectClient(env.cfg.socketPath);
  return {
    ...env,
    factory,
    app,
    client,
    async done() {
      client.close();
      await app.stop();
      cleanup(env.dir);
    },
  };
}

test("draining refuses new spawns and keeps serving the live ones", async () => {
  const t = await boot();
  const sp = await t.client.send("spawn", { kind: "interactive", argv: ["fakejob"], cwd: t.hq, cols: 80, rows: 24 });
  const d = await t.client.send("drain");
  assert.equal(d.ok, true);
  assert.equal(d.state, "draining");
  assert.equal(d.sessions, 1);

  const refused = await t.client.send("spawn", { kind: "worker", argv: ["fakejob"], cwd: t.hq, cols: 80, rows: 24 });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "draining");

  // the session that is already running keeps working
  await t.client.send("attach", { sid: sp.sid, cols: 80, rows: 24 });
  await t.client.send("input", { sid: sp.sid, data: "still here\r" });
  assert.deepEqual(t.factory.last().writes, ["still here\r"]);
  const st = await t.client.send("status");
  assert.equal(st.state, "draining");
  await t.done();
});

test("the runner announces it is drained when the last session ends", async () => {
  const t = await boot();
  await t.client.send("spawn", { kind: "worker", argv: ["fakejob"], cwd: t.hq, cols: 80, rows: 24 });
  const drained = new Promise((r) => t.app.manager.once("drained", r));
  await t.client.send("drain");
  await wait(20);
  assert.equal(t.app.manager.state, "draining");
  t.factory.last().finish(0);
  await drained;
  assert.equal(t.app.manager.aliveCount, 0);
  await t.done();
});

test("draining with nothing running drains at once", async () => {
  const t = await boot();
  const drained = new Promise((r) => t.app.manager.once("drained", r));
  const d = await t.client.send("drain");
  assert.equal(d.sessions, 0);
  await drained;
  await t.done();
});

test("hello reports the draining state so the console can show it", async () => {
  const t = await boot();
  await t.client.send("spawn", { kind: "worker", argv: ["fakejob"], cwd: t.hq, cols: 80, rows: 24 });
  await t.client.send("drain");
  const fresh = await connectClient(t.cfg.socketPath);
  const h = await fresh.send("hello", { protocol: 1 });
  assert.equal(h.state, "draining");
  assert.equal(h.sessions.length, 1);
  fresh.close();
  await t.done();
});

// restart (hq-4npjr.20): drain now when nothing blocks, else keep serving and
// drain by itself when the last blocking session ends
test("restart with nothing blocking drains at once", async () => {
  const t = await boot();
  const drained = new Promise((r) => t.app.manager.once("drained", r));
  const r = await t.client.send("restart");
  assert.equal(r.ok, true);
  assert.equal(r.state, "draining");
  assert.equal(r.pending, false);
  await drained;
  await t.done();
});

test("restart with a live worker keeps serving, then drains when it ends", async () => {
  const t = await boot();
  await t.client.send("spawn", { kind: "worker", argv: ["fakejob"], cwd: t.hq, cols: 80, rows: 24 });
  const worker = t.factory.last();
  const r = await t.client.send("restart");
  assert.equal(r.state, "serving");
  assert.equal(r.pending, true);
  assert.equal(r.blocking, 1);
  const st = await t.client.send("status");
  assert.equal(st.restartPending, true);
  // unlike drain, new terminals still start while the restart waits
  const more = await t.client.send("spawn", { kind: "worker", argv: ["fakejob"], cwd: t.hq, cols: 80, rows: 24 });
  assert.equal(more.ok, true);
  const second = t.factory.last();
  const drained = new Promise((res) => t.app.manager.once("drained", res));
  let early = false;
  t.app.manager.once("drained", () => (early = true));
  worker.finish(0);
  await wait(20);
  assert.equal(early, false, "one blocking session left");
  second.finish(0);
  await drained;
  assert.equal(t.app.manager.state, "draining");
  await t.done();
});
