// `finish --confirm` must answer a specific gate reading (COMPILATION-v2 item 20).
//
// seal.test.js proves the approval primitive is sound. This proves the verb actually
// uses it, which is the part that would silently rot: every assertion here fails open
// into "merge without reading" if the wiring is removed.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Ops, buildVerbs, runVerb } from "../src/actions.js";
import { Seals } from "../src/seal.js";
import { Wrapper } from "../src/wrapper.js";
import { devConfig, tmpDir } from "./helpers.js";

/** A console just real enough to build verbs against, with ops backed by a temp dir. */
function harness() {
  const stateDir = tmpDir();
  const cfg = devConfig({ stateDir });
  const ops = new Ops({ dir: path.join(stateDir, "ops"), runner: async () => ({ code: 0, stdout: "", stderr: "" }) });
  const seals = new Seals();
  const verbs = buildVerbs({ cfg, wrapper: new Wrapper(cfg), seals, ops });
  return { cfg, ops, seals, verbs, stateDir };
}

/** Run a finish-check the way the route does, and settle it with the given gate text. */
function gateReading(h, session, output) {
  const plan = h.verbs["finish-check"]({ session });
  const rec = {
    id: `op-${Math.random().toString(16).slice(2, 10)}`,
    verb: "finish-check",
    state: "done",
    output,
    meta: { session },
  };
  plan.decorate(rec, { code: 0 });
  h.ops.write(rec);
  return rec;
}

test("a completed finish-check carries an approval; the dry finish does not need one", () => {
  const h = harness();
  const rec = gateReading(h, "t-1", "gate passed, 2 files");
  assert.equal(typeof rec.seal, "string");
  assert.ok(rec.seal.startsWith("s1."));
  // The dry plan is a read: it must stay one click, with nothing to approve.
  const dry = h.verbs.finish({ session: "t-1" });
  assert.ok(!dry.args.includes("--confirm"));
});

test("confirm without an approval is refused", () => {
  const h = harness();
  assert.throws(() => h.verbs.finish({ session: "t-1", confirm: true }), /approved op/i);
});

test("confirm with a valid approval builds the real finish", () => {
  const h = harness();
  const rec = gateReading(h, "t-1", "gate passed");
  const plan = h.verbs.finish({ session: "t-1", confirm: true, approvedOp: rec.id, seal: rec.seal });
  assert.ok(plan.args.includes("--confirm"), "the confirmed plan runs finish --confirm");
  assert.ok(plan.args.includes("t-1"));
});

test("an approval cannot be replayed", () => {
  const h = harness();
  const rec = gateReading(h, "t-1", "gate passed");
  const body = { session: "t-1", confirm: true, approvedOp: rec.id, seal: rec.seal };
  h.verbs.finish(body);
  assert.throws(() => h.verbs.finish({ ...body }), /already used once/);
});

test("an approval for one session cannot finish another", () => {
  const h = harness();
  const rec = gateReading(h, "t-1", "gate passed");
  assert.throws(
    () => h.verbs.finish({ session: "t-2", confirm: true, approvedOp: rec.id, seal: rec.seal }),
    /different session/,
  );
});

test("an approval stops being valid when the gate reading changes underneath it", () => {
  // The scenario this exists for: the panel is open on a phone, the worker commits
  // again, and the reading the operator actually read is no longer the current one.
  const h = harness();
  const rec = gateReading(h, "t-1", "gate passed, 2 files");
  const stale = rec.seal;
  rec.output = "gate passed, 5 files";
  h.ops.write(rec);
  assert.throws(
    () => h.verbs.finish({ session: "t-1", confirm: true, approvedOp: rec.id, seal: stale }),
    /not what this would do now/,
  );
});

test("an approval must name a finish-check, not some other op", () => {
  const h = harness();
  const rec = gateReading(h, "t-1", "gate passed");
  const decoy = { id: "op-decoy", verb: "focus", state: "done", output: "gate passed", meta: { session: "t-1" } };
  h.ops.write(decoy);
  assert.throws(
    () => h.verbs.finish({ session: "t-1", confirm: true, approvedOp: decoy.id, seal: rec.seal }),
    /does not name a finish check/,
  );
});

test("an unknown op id is refused rather than treated as absent approval", () => {
  const h = harness();
  assert.throws(
    () => h.verbs.finish({ session: "t-1", confirm: true, approvedOp: "op-nope", seal: "s1.1.aaaa" }),
    /does not name a finish check/,
  );
});

test("a console with no approval system refuses to confirm rather than degrading", () => {
  // The failure mode worth naming: a half-wired approval system that quietly becomes
  // no approval at all is worse than one that is plainly switched off.
  const stateDir = tmpDir();
  const cfg = devConfig({ stateDir });
  const verbs = buildVerbs({ cfg, wrapper: new Wrapper(cfg) });
  assert.throws(() => verbs.finish({ session: "t-1", confirm: true }), /approvals are not configured/);
  // The read-only path still works, so an unwired console can still show a gate.
  assert.ok(!verbs.finish({ session: "t-1" }).args.includes("--confirm"));
});

test("runVerb forwards decorate, so the approval survives the real code path", () => {
  const h = harness();
  const { rec } = runVerb({ ops: h.ops, verbs: h.verbs, verb: "finish-check", body: { session: "t-1" } });
  assert.equal(rec.verb, "finish-check");
  // decorate runs when the op settles; the runner resolves immediately here.
  return new Promise((resolve) => {
    setTimeout(() => {
      const settled = h.ops.read(rec.id);
      assert.equal(settled.state, "done");
      assert.equal(typeof settled.seal, "string", "a settled finish-check carries its approval");
      resolve(undefined);
    }, 20);
  });
});

test("a confirmed finish pins the revision the operator read about", () => {
  // The binding that actually stops a stale click landing an unseen commit: the head
  // from the approved reading is handed to the executor, which refuses a branch that
  // has moved off it. Without this the approval would only prove a check had happened.
  const h = harness();
  const head = "a".repeat(40);
  const rec = gateReading(h, "t-1", JSON.stringify({ bead: "hq-1", ok: true, head, reason: "approved" }));
  const plan = h.verbs.finish({ session: "t-1", confirm: true, approvedOp: rec.id, seal: rec.seal });
  const i = plan.args.indexOf("--expect-head");
  assert.ok(i > 0, `--expect-head missing from ${plan.args.join(" ")}`);
  assert.equal(plan.args[i + 1], head);
});

test("a reading with no head pins nothing rather than pinning something wrong", () => {
  // A session with no live worktree reports a refusal and no head. The gate refuses it
  // downstream anyway; what matters here is that we do not invent a value.
  const h = harness();
  const rec = gateReading(h, "t-1", JSON.stringify({ bead: "hq-1", ok: false, reason: "no live session" }));
  const plan = h.verbs.finish({ session: "t-1", confirm: true, approvedOp: rec.id, seal: rec.seal });
  assert.ok(!plan.args.includes("--expect-head"), plan.args.join(" "));
});
