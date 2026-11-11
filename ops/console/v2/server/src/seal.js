// Sealed approvals: bind a confirmation to the exact thing the human was shown.
//
// Why this exists (COMPILATION-v2 item 20). The console's approval flow for a
// destructive verb is plan-then-confirm: SessionRow runs `finish-check`, renders the gate
// output and a diffstat, and the operator clicks "Finish now", which posts
// `finish {confirm: true}`. Nothing tied that second call to the first. The panel can sit
// open on a phone for hours while the worker keeps committing, and the click would still
// merge, on the strength of a gate reading that had gone stale.
//
// WHAT THIS DOES AND DOES NOT CLAIM, stated plainly because the reshaped plan was blocked
// for overclaiming once already:
//
//   It does guarantee that a confirmation names one specific, server-produced gate
//   reading, that the reading is recent, and that it is spent exactly once. The revision
//   that reading described travels with it and is enforced at the merge, so a click
//   cannot land a commit the operator never saw.
//
//   It does NOT prove a human read anything: a script holding the console key can drive
//   the same two calls. That is the honest scope, not an oversight.
//
//   It does NOT re-verify the world at confirm time, and it does not need to. There are
//   three layers and each does exactly one job:
//
//     1. this module binds the CLICK to the READING the operator was shown;
//     2. `ctl.sh finish` re-runs finish-check at execution time and refuses unless it
//        still reports ok, which is the gate applied to current state;
//     3. `finish.sh --require-approval` re-reads the branch head immediately before
//        merging, checks it against the Review-Approve marker, and merges the PINNED
//        SHA rather than the branch name, so a ref that advances between the check and
//        the merge cannot change what lands.
//
//   Layer 3 is why binding the click to a revision is already covered: the reading is
//   JSON carrying `head`, so a new commit changes the digest here, and even if it did
//   not, the merge target is a sha that was verified microseconds earlier. Duplicating
//   any of that here would add a second half-implementation of a gate that already works.
//
// The signing key matters. Without it a client could compute the value for a state it
// merely predicted and skip the reading step entirely, which is exactly the "browser
// payload is display-only" property this is meant to have. It is generated per process
// and never leaves the server: a restart invalidating outstanding approvals is correct,
// because a restart also means the op records behind them are no longer in memory.

import crypto from "node:crypto";

const VERSION = "s1";
const DEFAULT_TTL_MS = 15 * 60 * 1000;

/** Stable stringify: key order must not change the result. */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

export class Seals {
  /**
   * @param {{signingKey?: Buffer|string, ttlMs?: number, now?: () => number, max?: number, hardMax?: number, log?: (m: string) => void}} [opts]
   */
  constructor(opts = {}) {
    this.signingKey = opts.signingKey || crypto.randomBytes(32);
    this.ttlMs = Number.isFinite(opts.ttlMs) ? Number(opts.ttlMs) : DEFAULT_TTL_MS;
    this.now = opts.now || (() => Date.now());
    this.max = Number.isFinite(opts.max) ? Number(opts.max) : 500;
    this.log = opts.log || (() => {});
    // A ceiling far above anything a human generates, used to refuse rather than to
    // evict. See redeem().
    this.hardMax = Number.isFinite(opts.hardMax) ? Number(opts.hardMax) : Math.max(20 * this.max, 10000);
    this.warned = false;
    /** @type {Map<string, number>} value -> the time it stops being worth remembering */
    this.spent = new Map();
  }

  /** @param {any} subject @param {number} issuedAt */
  sign(subject, issuedAt) {
    return crypto
      .createHmac("sha256", this.signingKey)
      .update(`${VERSION}\n${issuedAt}\n${canonical(subject)}`)
      .digest("hex")
      .slice(0, 32);
  }

  /**
   * Issue a seal over a subject. The subject is whatever identifies the exact thing the
   * operator is about to be shown; for finish that is the session, the op that produced
   * the gate, and a digest of the gate text itself.
   * @param {any} subject
   * @returns {string}
   */
  issue(subject) {
    const issuedAt = this.now();
    return `${VERSION}.${issuedAt}.${this.sign(subject, issuedAt)}`;
  }

  /**
   * Check a seal against the subject the caller believes it is confirming, and spend it.
   *
   * Order is deliberate: shape, then signature, then expiry, then spend. Checking expiry
   * before the signature would let a forged string with a stale timestamp produce a
   * different message than a forged string with a fresh one, which is a small oracle and
   * costs nothing to avoid.
   *
   * @param {unknown} seal
   * @param {any} subject
   * @returns {{ok: true} | {ok: false, reason: string}}
   */
  redeem(seal, subject) {
    if (typeof seal !== "string" || !seal) return { ok: false, reason: "no approval was presented" };
    const parts = seal.split(".");
    if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: "the approval is malformed" };
    const issuedAt = Number(parts[1]);
    if (!Number.isFinite(issuedAt)) return { ok: false, reason: "the approval is malformed" };
    const expect = this.sign(subject, issuedAt);
    // Constant-time, and length-checked first because timingSafeEqual throws on a length
    // mismatch rather than returning false.
    const a = Buffer.from(parts[2], "utf8");
    const b = Buffer.from(expect, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: "what you approved is not what this would do now; re-run the check and read it again" };
    }
    const age = this.now() - issuedAt;
    // `>=`, not `>`: prune() forgets a spent seal once expiry <= now, i.e. at age
    // ttlMs exactly. Accepting that same instant would let a forgotten seal be
    // redeemed a second time (lucy round 2). The two boundaries must agree.
    if (age >= this.ttlMs) {
      return { ok: false, reason: `that approval is ${Math.round(age / 60000)} minutes old; re-run the check and read it again` };
    }
    if (age < -60000) return { ok: false, reason: "that approval is dated in the future" };
    if (this.spent.has(seal)) return { ok: false, reason: "that approval was already used once" };
    this.prune();
    // Fail CLOSED at the ceiling. Forgetting an entry to make room would make it
    // replayable, so when the live set is implausibly large the answer is to stop
    // redeeming, not to stop remembering. Reaching this on a single-owner console
    // means something is looping, and the operator wants to know rather than to be
    // quietly served.
    if (this.spent.size >= this.hardMax) {
      return { ok: false, reason: "too many approvals are outstanding; something is looping, so this is refused until they expire" };
    }
    this.spent.set(seal, issuedAt + this.ttlMs);
    return { ok: true };
  }

  /**
   * Forget approvals that can no longer be redeemed anyway.
   *
   * Deliberately NOT a cap. An earlier version evicted the oldest entry once the map
   * reached `max`, which silently traded away the exact-once guarantee: the evicted
   * approval was spent but still inside its TTL, so presenting it again would have
   * passed (lucy round 1). The map is bounded by issuance rate times the TTL instead,
   * and `max` is a tripwire that reports rather than a limit that quietly loses state.
   * At a fifteen minute TTL, exceeding it means something is issuing approvals far
   * faster than a human could read them, which is worth saying out loud.
   */
  prune() {
    const now = this.now();
    for (const [k, expiry] of this.spent) if (expiry <= now) this.spent.delete(k);
    if (this.spent.size > this.max && !this.warned) {
      this.warned = true;
      this.log(`approval replay cache holds ${this.spent.size} live entries, above the expected ${this.max}`);
    }
  }
}

/**
 * The branch head named inside a gate reading, or "" when the reading has none (a session
 * with no live worktree reports a refusal and no head).
 *
 * This is parsed rather than assumed: the reading is JSON produced by `ctl.sh
 * finish-check`, and a malformed or changed shape must degrade to "no head I can pin"
 * rather than to a confident wrong answer.
 * @param {string} output
 * @returns {string}
 */
export function headOf(output) {
  try {
    const parsed = JSON.parse(String(output || ""));
    const head = parsed && typeof parsed.head === "string" ? parsed.head : "";
    return /^[0-9a-f]{40}$/.test(head) ? head : "";
  } catch {
    return "";
  }
}

/**
 * The subject for a finish approval.
 *
 * `gate` digests the reading the operator saw. `head` is the branch revision that reading
 * described, and it is the field that does real work at confirm time: the op record is
 * immutable, so re-digesting its text at redemption would compare the stored reading with
 * itself and could never detect anything (lucy round 2 found exactly that). The head is
 * carried so it can be handed to the executor, which refuses to merge a branch that has
 * moved off it.
 * @param {{session: string, opId: string, output: string}} arg
 */
export function finishSubject({ session, opId, output }) {
  const text = String(output == null ? "" : output);
  return {
    verb: "finish",
    session: String(session || ""),
    op: String(opId || ""),
    head: headOf(text),
    gate: crypto.createHash("sha256").update(text).digest("hex").slice(0, 32),
  };
}
