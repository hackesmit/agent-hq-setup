// The effect declaration and, more importantly, its closure (COMPILATION-v2 item 18).
//
// The test that matters here is the first one. Everything else in this file checks that
// the table says sensible things; the closure test is what turns the table from a
// convention someone might remember into a mechanism that fails the build when they do
// not. Adding a verb without declaring what it does breaks the suite, which is the only
// reason to believe the declaration will still be complete a year from now.
import test from "node:test";
import assert from "node:assert/strict";
import { EFFECTS, admit, approvalSatisfied, effectOf } from "../src/effects.js";
import { buildVerbs } from "../src/actions.js";
import { Wrapper } from "../src/wrapper.js";
import { devConfig, tmpDir } from "./helpers.js";

/** The live verb table, built the way the server builds it. */
function liveVerbs() {
  const cfg = devConfig({ stateDir: tmpDir() });
  return buildVerbs({ cfg, wrapper: new Wrapper(cfg) });
}

test("every verb the console can run has a declared effect, and nothing else does", () => {
  const verbs = Object.keys(liveVerbs()).sort();
  const declared = Object.keys(EFFECTS).sort();

  const undeclared = verbs.filter((v) => !declared.includes(v));
  assert.deepEqual(
    undeclared,
    [],
    `these verbs run but declare no effect, so the console cannot reason about what they do: ${undeclared.join(", ")}`,
  );

  // The other direction matters too: a stale entry for a verb that no longer exists is
  // a declaration nobody is checking, and it makes the table look more complete than it is.
  const orphaned = declared.filter((v) => !verbs.includes(v));
  assert.deepEqual(orphaned, [], `these are declared but no longer exist: ${orphaned.join(", ")}`);
});

test("an undeclared verb is refused rather than assumed harmless", () => {
  const out = admit("some-new-verb-nobody-classified");
  assert.equal(out.ok, false);
  assert.match(out.reason, /no declared effect/);
  assert.equal(effectOf("some-new-verb-nobody-classified"), null);
  // Prototype keys must not masquerade as declarations.
  assert.equal(effectOf("constructor"), null);
  assert.equal(effectOf("toString"), null);
  assert.equal(admit("hasOwnProperty").ok, false);
});

test("every declaration is well formed and says why", () => {
  for (const [verb, spec] of Object.entries(EFFECTS)) {
    assert.ok(["read", "local", "destructive", "outward"].includes(spec.effect), `${verb}: bad effect ${spec.effect}`);
    assert.ok(["none", "sealed"].includes(spec.approval), `${verb}: bad approval ${spec.approval}`);
    assert.equal(typeof spec.why, "string", `${verb}: why must be prose`);
    assert.ok(spec.why.length > 20, `${verb}: why is too thin to weigh later: ${spec.why}`);
  }
});

test("finish is the verb that reaches past this box, and the only sealed one", () => {
  // Restraint is the design decision under test. Sealing everything destructive would
  // train the operator to click through the extra step, which costs more than it buys on
  // a single-owner console. If a second verb ever earns a seal, this test should be
  // updated deliberately rather than drifting.
  const sealed = Object.entries(EFFECTS)
    .filter(([, s]) => s.approval === "sealed")
    .map(([v]) => v);
  assert.deepEqual(sealed, ["finish"]);
  assert.equal(EFFECTS.finish.effect, "outward");
});

test("a read never carries an approval requirement", () => {
  for (const [verb, spec] of Object.entries(EFFECTS)) {
    if (spec.effect === "read") assert.equal(spec.approval, "none", `${verb} reads but demands an approval`);
  }
});

test("the verbs that spawn or end work are classified for what they can reach", () => {
  // Named individually rather than by pattern: if one of these is ever reclassified,
  // the reader should have to argue with a test, not notice a silent change.
  // dispatch is OUTWARD, not merely destructive: what it starts is an agent session
  // carrying WebFetch, a shell and its MCP profile, so its reach leaves this box.
  for (const verb of ["dispatch", "dispatch-batch"]) {
    assert.equal(EFFECTS[verb].effect, "outward", `${verb} starts something that reaches the network`);
  }
  // snooze sits with kill: closing the pane discards whatever the session had not
  // written down, which is a loss even though the files survive.
  for (const verb of ["kill", "service-restart", "snooze"]) {
    assert.equal(EFFECTS[verb].effect, "destructive", `${verb} should be destructive`);
  }
});

test("a sealed policy is enforced generically, not inside one verb", () => {
  // The failure this guards: moving a verb to "sealed" changes a string and nothing
  // else, because the only real check lives inside finish where nobody would look.
  const sealedSpec = { effect: "outward", approval: "sealed", why: "x" };
  assert.equal(approvalSatisfied(sealedSpec, { sealedOk: true }).ok, true);
  // A verb that declares sealed but never proves it validated one is REFUSED, so
  // promoting a verb and forgetting the check fails closed rather than open.
  for (const plan of [{}, { sealedOk: false }, { sealedOk: "yes" }, null]) {
    const out = approvalSatisfied(sealedSpec, plan);
    assert.equal(out.ok, false, `plan ${JSON.stringify(plan)} should not satisfy a sealed policy`);
    assert.match(out.reason, /requires an approval/);
  }
  // An unsealed policy needs nothing.
  assert.equal(approvalSatisfied({ effect: "local", approval: "none", why: "x" }, {}).ok, true);
});

test("the effect on a record is derived, never taken from the caller", async () => {
  // An effect that can be passed in is one that can be understated by whoever passes it.
  const { Ops, runVerb } = await import("../src/actions.js");
  const path = await import("node:path");
  const stateDir = tmpDir();
  const cfg = devConfig({ stateDir });
  const ops = new Ops({ dir: path.join(stateDir, "ops"), runner: async () => ({ code: 0, stdout: "", stderr: "" }) });
  const verbs = buildVerbs({ cfg, wrapper: new Wrapper(cfg) });
  const { rec } = runVerb({ ops, verbs, verb: "dispatch", body: { rig: "hq", bead: "hq-1", model: "claude-sonnet-5" } });
  assert.equal(rec.effect, "outward", "the record reports the declared reach");
  // Even a caller that lies is ignored: start() consults the declaration itself.
  const direct = ops.start({ verb: "kill", cmd: "bash", args: ["-c", "true"], effect: "read" });
  assert.equal(direct.rec.effect, "destructive", "a supplied effect must not override the declaration");
});

test("the declaration drives behaviour rather than describing it", async () => {
  // If flipping the table did not change what the code does, the table would be
  // documentation that drifts. finish reads its approval policy from EFFECTS, so this
  // asserts the wire is live rather than the comment being accurate.
  const { buildVerbs: build } = await import("../src/actions.js");
  const cfg = devConfig({ stateDir: tmpDir() });
  const verbs = build({ cfg, wrapper: new Wrapper(cfg) });
  // With the policy sealed (as declared), an unwired console refuses to confirm.
  assert.equal(EFFECTS.finish.approval, "sealed");
  assert.throws(() => verbs.finish({ session: "t-1", confirm: true }), /approvals are not configured|approved op/);
});

test("an operation records what it does, not only what it is called", async () => {
  const { Ops, runVerb } = await import("../src/actions.js");
  const path = await import("node:path");
  const stateDir = tmpDir();
  const cfg = devConfig({ stateDir });
  const ops = new Ops({ dir: path.join(stateDir, "ops"), runner: async () => ({ code: 0, stdout: "", stderr: "" }) });
  const verbs = buildVerbs({ cfg, wrapper: new Wrapper(cfg) });
  const { rec } = runVerb({ ops, verbs, verb: "kill", body: { session: "t-1" } });
  assert.equal(rec.effect, "destructive", "the op record carries its effect class");
  const moved = runVerb({ ops, verbs, verb: "focus", body: { session: "t-1" } });
  assert.equal(moved.rec.effect, "local", "focus writes operator state, so it is not a read");
});

test("runVerb refuses a verb that exists but was never classified", async () => {
  // The safety net for a verb added on a branch where the closure test was not run.
  const { runVerb, Ops } = await import("../src/actions.js");
  const path = await import("node:path");
  const stateDir = tmpDir();
  const ops = new Ops({ dir: path.join(stateDir, "ops"), runner: async () => ({ code: 0, stdout: "", stderr: "" }) });
  const rogue = { "not-declared": () => ({ cmd: "bash", args: ["-c", "true"], timeout: 1000 }) };
  assert.throws(() => runVerb({ ops, verbs: rogue, verb: "not-declared", body: {} }), /no declared effect/);
});

test("nothing starts an operation without passing through admission", async () => {
  // A source-level assertion, deliberately. The closure test proves every verb is
  // declared; this proves the declaration cannot be sidestepped by starting work from
  // somewhere that never consults it. If a second call site ever appears, the reader has
  // to come here and decide whether it should be admitted, rather than discovering later
  // that some operations were never classified.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const srcDir = path.join(here, "..", "src");
  const CALL = new RegExp("\\bops\\.start\\(");

  /** @param {string} dir @returns {string[]} */
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : e.name.endsWith(".js") ? [full] : [];
    });

  const callers = walk(srcDir).filter((f) => CALL.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(
    callers.map((f) => path.basename(f)),
    ["actions.js"],
    `an operation is started outside actions.js, so it skips admission: ${callers.join(", ")}`,
  );
});
