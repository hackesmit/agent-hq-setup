// Sealed approvals (COMPILATION-v2 item 20). The properties under test are the four this
// is allowed to claim: it names one specific gate reading, the reading is recent, it is
// spent once, and a client cannot mint one without having been shown that reading.
import test from "node:test";
import assert from "node:assert/strict";
import { Seals, finishSubject, headOf } from "../src/seal.js";

/** A clock the test drives, so expiry is asserted rather than waited for. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const subj = (output = "gate passed") => finishSubject({ session: "s-1", opId: "op-1", output });

test("a seal issued for a subject redeems for that subject", () => {
  const s = new Seals();
  const seal = s.issue(subj());
  assert.deepEqual(s.redeem(seal, subj()), { ok: true });
});

test("one character of different gate text invalidates the approval", () => {
  // This is the whole point: the operator approved a reading, not a session id.
  const s = new Seals();
  const seal = s.issue(subj("gate passed, 3 files"));
  const out = s.redeem(seal, subj("gate passed, 4 files"));
  assert.equal(out.ok, false);
  assert.match(out.reason, /not what this would do now/);
});

test("a seal is bound to its session and to the op that produced the reading", () => {
  const s = new Seals();
  const seal = s.issue(finishSubject({ session: "s-1", opId: "op-1", output: "x" }));
  assert.equal(s.redeem(seal, finishSubject({ session: "s-2", opId: "op-1", output: "x" })).ok, false);
  assert.equal(s.redeem(seal, finishSubject({ session: "s-1", opId: "op-2", output: "x" })).ok, false);
});

test("an approval is spent exactly once", () => {
  const s = new Seals();
  const seal = s.issue(subj());
  assert.equal(s.redeem(seal, subj()).ok, true);
  const again = s.redeem(seal, subj());
  assert.equal(again.ok, false);
  assert.match(again.reason, /already used once/);
});

test("an approval expires, and says how stale it was", () => {
  const c = clock();
  const s = new Seals({ now: c.now, ttlMs: 15 * 60 * 1000 });
  const seal = s.issue(subj());
  c.advance(14 * 60 * 1000);
  assert.equal(s.redeem(seal, subj()).ok, true, "still good just inside the window");

  const s2 = new Seals({ now: c.now, ttlMs: 15 * 60 * 1000 });
  const seal2 = s2.issue(subj());
  c.advance(16 * 60 * 1000);
  const out = s2.redeem(seal2, subj());
  assert.equal(out.ok, false);
  assert.match(out.reason, /16 minutes old/);
});

test("a client cannot mint an approval without the server's signing key", () => {
  // The forger knows the subject exactly and can compute any digest it likes; what it
  // does not have is the per-process key, which is the display-only property.
  const server = new Seals();
  const attacker = new Seals();
  const forged = attacker.issue(subj());
  const out = server.redeem(forged, subj());
  assert.equal(out.ok, false);
  assert.match(out.reason, /not what this would do now/);
});

test("malformed input is refused without throwing", () => {
  const s = new Seals();
  for (const bad of [null, undefined, "", 42, {}, [], "nope", "s1.notanumber.abc", "s0.1.abc", "s1.1", "s1.1.a.b"]) {
    const out = s.redeem(/** @type {any} */ (bad), subj());
    assert.equal(out.ok, false, `${JSON.stringify(bad)} should be refused`);
    assert.equal(typeof out.reason, "string");
    assert.ok(out.reason.length > 0);
  }
});

test("an approval dated in the future is refused", () => {
  const c = clock();
  const s = new Seals({ now: c.now });
  const seal = s.issue(subj());
  c.advance(-5 * 60 * 1000);
  const out = s.redeem(seal, subj());
  assert.equal(out.ok, false);
  assert.match(out.reason, /future/);
});

test("capacity pressure never makes a spent approval redeemable again", () => {
  // lucy round 1 found the opposite behaviour here: evicting the oldest entry at
  // capacity dropped an approval that was spent but still inside its TTL, so replaying
  // it passed. Correctness wins over the memory bound; the bound is a warning now.
  const c = clock();
  const warnings = [];
  const s = new Seals({ now: c.now, max: 3, ttlMs: 60_000, log: (m) => warnings.push(m) });
  const first = finishSubject({ session: "s-0", opId: "op", output: "x" });
  const firstSeal = s.issue(first);
  assert.equal(s.redeem(firstSeal, first).ok, true);
  for (let i = 1; i < 20; i += 1) {
    const subject = finishSubject({ session: `s-${i}`, opId: "op", output: "x" });
    s.redeem(s.issue(subject), subject);
  }
  const replay = s.redeem(firstSeal, first);
  assert.equal(replay.ok, false, "the first approval must still be remembered as spent");
  assert.match(replay.reason, /already used once/);
  assert.ok(warnings.length > 0, "exceeding the expected size is reported rather than hidden");
  c.advance(61_000);
  s.prune();
  assert.equal(s.spent.size, 0, "everything past its ttl is forgotten");
});

test("the approved revision travels with the approval", () => {
  // NOT a digest comparison. lucy round 2 caught the earlier version of this test
  // modelling something production never does: it mutated a stored op record, when op
  // records are immutable, so re-digesting one at redemption compares it with itself
  // and can never detect a branch that moved. What actually binds the merge is the head
  // carried in the subject and handed to the executor, so that is what is asserted.
  const atA = JSON.stringify({ bead: "hq-1", ok: true, head: "a".repeat(40), reason: "approved" });
  const atB = JSON.stringify({ bead: "hq-1", ok: true, head: "b".repeat(40), reason: "approved" });
  assert.equal(finishSubject({ session: "t-1", opId: "op-1", output: atA }).head, "a".repeat(40));
  assert.notEqual(
    finishSubject({ session: "t-1", opId: "op-1", output: atA }).head,
    finishSubject({ session: "t-1", opId: "op-1", output: atB }).head,
  );
});

test("headOf reads a head only when there really is one", () => {
  assert.equal(headOf(JSON.stringify({ ok: true, head: "c".repeat(40) })), "c".repeat(40));
  // A session with no live worktree reports a refusal and no head at all.
  assert.equal(headOf(JSON.stringify({ bead: "hq-1", ok: false, reason: "no live session" })), "");
  // Anything malformed or unexpected degrades to "nothing I can pin", never to a guess.
  for (const bad of ["", "not json", "{}", JSON.stringify({ head: 42 }), JSON.stringify({ head: "short" }), JSON.stringify({ head: "A".repeat(40) })]) {
    assert.equal(headOf(bad), "", `${bad.slice(0, 30)} should yield no head`);
  }
});

test("an approval is refused at exactly its expiry, not one tick later", () => {
  // prune() forgets a spent seal once expiry <= now. If redemption still accepted that
  // same instant, a forgotten seal would be redeemable a second time (lucy round 2).
  const c = clock();
  const s = new Seals({ now: c.now, ttlMs: 1000 });
  const seal = s.issue(subj());
  c.advance(999);
  const fresh = new Seals({ now: c.now, ttlMs: 1000 });
  const sealB = fresh.issue(subj());
  assert.equal(fresh.redeem(sealB, subj()).ok, true, "just inside is still good");
  c.advance(1000);
  assert.equal(s.redeem(seal, subj()).ok, false, "exactly at expiry is refused");
});

test("an implausible number of live approvals refuses rather than forgetting one", () => {
  // The only two ways to bound the map are to forget (which makes a spent approval
  // replayable) and to refuse (which does not). Refusing is the fail-closed half.
  const c = clock();
  const s = new Seals({ now: c.now, ttlMs: 60_000, hardMax: 5 });
  const made = [];
  for (let i = 0; i < 5; i += 1) {
    const subject = finishSubject({ session: `s-${i}`, opId: "op", output: "x" });
    made.push([s.issue(subject), subject]);
    assert.equal(s.redeem(made[i][0], made[i][1]).ok, true);
  }
  const extra = finishSubject({ session: "s-over", opId: "op", output: "x" });
  const out = s.redeem(s.issue(extra), extra);
  assert.equal(out.ok, false);
  assert.match(out.reason, /something is looping/);
  // and nothing already spent quietly became usable again
  assert.equal(s.redeem(made[0][0], made[0][1]).ok, false);
});

test("key order in the subject does not change the result", () => {
  const s = new Seals();
  const seal = s.issue({ b: 2, a: 1, nested: { y: 2, x: 1 } });
  assert.equal(s.redeem(seal, { a: 1, nested: { x: 1, y: 2 }, b: 2 }).ok, true);
});

test("finishSubject digests the gate text rather than carrying it", () => {
  const long = "x".repeat(10000);
  const out = finishSubject({ session: "s-1", opId: "op-1", output: long });
  assert.equal(out.gate.length, 32);
  assert.ok(!JSON.stringify(out).includes(long), "the reading itself is not carried around");
  assert.notEqual(out.gate, finishSubject({ session: "s-1", opId: "op-1", output: long + "!" }).gate);
  // Missing output must not throw: an op can fail before it produces one.
  assert.equal(typeof finishSubject({ session: "s", opId: "o", output: undefined }).gate, "string");
});
