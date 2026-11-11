// What each console verb actually does to the world, declared in one place.
//
// Why this exists (COMPILATION-v2 item 18, reshaped). The original item was a
// "tainted-context tool gate" borrowed from Odysseus, which classifies every tool by
// effect and blocks the effectful ones once untrusted content has entered a run. That
// design assumes the system owns the model's tool registry and dispatch loop. HQ does
// not: its agents are Claude Code sessions whose built-in Bash, WebFetch and arbitrary
// MCP servers the console never sees, and whose hooks are stateless and, by invariant 7,
// not agent-editable. A gate blind to two of three ingress paths is not a gate, and
// cross-vendor review was right to call the original framing unimplementable here.
//
// What IS implementable, and is what this file does, is the half that lives where HQ has
// real authority: the console's own effectful operations. Every verb declares what it
// does and what it costs to be wrong about it, and the policy that follows from that
// declaration is applied server-side, in one place, rather than being remembered
// verb-by-verb at each call site.
//
// The load-bearing property is the CLOSURE test in effects.test.js: a verb with no entry
// here fails the suite. That is the difference between a convention and a mechanism.
// Adding an email send or a calendar write later is then a matter of declaring it, and
// the approval requirement follows automatically instead of being an act of memory.

/**
 * @typedef {"read" | "local" | "destructive" | "outward"} EffectClass
 *
 *   read        answers a question and writes nothing anywhere, not even to which
 *               pane the operator is looking at
 *   local       changes HQ's own bookkeeping: a bead, a label, a snooze
 *   destructive loses or rewrites work, or spends real resources, and is not a
 *               keystroke away from being undone
 *   outward     reaches past this box: merges that a daemon will push, automation that
 *               sends mail. Being wrong here is visible to somebody else.
 *
 * @typedef {"none" | "sealed"} ApprovalPolicy
 *   none    the click is the decision
 *   sealed  the request must carry an approval naming the exact reading it answers
 *           (see seal.js); the console refuses it otherwise
 *
 * @typedef {{effect: EffectClass, approval: ApprovalPolicy, why: string}} EffectSpec
 */

/**
 * The declaration. Keep the `why` honest and specific: it is the thing a future reader
 * weighs when deciding whether a policy is still right.
 *
 * A deliberate note on restraint. Only ONE verb is sealed today. It would be easy to
 * mark everything destructive as needing an approval, and it would be wrong: this is a
 * single-owner console, and gating a recoverable action behind a second step trains the
 * operator to click through the step, which costs more than it buys. `finish` earns it
 * by being the one verb that merges a branch a daemon then pushes, which for one rig is
 * a production deploy. `kill` and `service-restart` are loud and recoverable; `dispatch`
 * spends tokens but is already a deliberate act with a visible pane.
 *
 * @type {Record<string, EffectSpec>}
 */
export const EFFECTS = {
  // --- requests: answering the owner's own Needs-you cards -------------------------
  answer: { effect: "local", approval: "none", why: "writes an answer onto a request the operator opened" },
  done: { effect: "local", approval: "none", why: "marks a request handled without sending an answer back to its session" },
  skip: { effect: "local", approval: "none", why: "declines a request, recorded with a reason" },
  resolve: { effect: "local", approval: "none", why: "closes a request outright; the session that raised it is not told anything" },
  "req-snooze": { effect: "local", approval: "none", why: "defers a request to a later time, leaving it open but out of the way" },
  "req-clear": { effect: "local", approval: "none", why: "takes an answer that never reached a terminal off the Sessions card; the recorded answer stays on disk" },
  "req-unsnooze": { effect: "local", approval: "none", why: "brings a deferred request back into the Needs-you lane immediately" },
  sink: { effect: "local", approval: "none", why: "drops a request without answering it, which is the deliberate way to say no" },
  "ear-wake": { effect: "local", approval: "none", why: "stamps an inert timestamp the sleeping voice ear polls to start listening again; no text crosses and nothing executes" },

  // --- work: the ledger and the fleet -------------------------------------------
  capture: { effect: "local", approval: "none", why: "creates a bead; nothing runs as a result" },
  phase: { effect: "local", approval: "none", why: "ticks or unticks a phase checkbox on a bead, which only moves a progress bar" },
  name: { effect: "local", approval: "none", why: "relabels a session in the dashboard so panes read as work rather than ids" },
  dispatch: {
    effect: "outward",
    approval: "none",
    // Classified outward rather than destructive on review: what this starts is a Claude
    // Code session carrying WebFetch, a shell and whatever MCP servers its profile
    // declares, so its reach is not bounded by this box. Ungated all the same, because
    // it is already a deliberate act that produces a visible pane which can be killed;
    // a second click before every dispatch would be worn down to a reflex within a week.
    why: "starts an agent session that can reach the network and act on its own, and spends tokens doing it",
  },
  // wake.sh reopens a snoozed session now instead of at its timer: the same kind of
  // start as dispatch, of a session that was already dispatched (Now page, hq-4npjr.5).
  wake: {
    effect: "outward",
    approval: "none",
    why: "revives a snoozed agent session early, which then acts on its own and spends tokens",
  },
  "dispatch-batch": {
    effect: "outward",
    approval: "none",
    why: "same reach as dispatch, over several beads in sequence in one session",
  },
  focus: { effect: "local", approval: "none", why: "changes which tmux pane the operator is looking at, which is state even if it is only theirs" },
  kill: { effect: "destructive", approval: "none", why: "ends a session; its worktree and branch survive, so the work itself is recoverable" },
  snooze: {
    effect: "destructive",
    approval: "none",
    // Not bookkeeping: the pane closes, so whatever the session held in context and had
    // not written down is gone, and the revival starts from the files rather than from
    // where it left off. That is the same loss `kill` causes, on a timer.
    why: "closes the pane and schedules a revival, discarding any context the session had not written down",
  },

  // --- finishing: the one that reaches past the box ------------------------------
  "finish-check": { effect: "read", approval: "none", why: "reports whether a session may be finished; mints the approval finish requires" },
  finish: {
    effect: "outward",
    approval: "sealed",
    why: "merges a worker branch into a rig default that the sync daemon then pushes, which for acme is a production deploy",
  },

  // --- stack and machines --------------------------------------------------------
  "stack-keep": { effect: "local", approval: "none", why: "records a keep decision on a bead; executes nothing" },
  "stack-revert": {
    effect: "local",
    approval: "none",
    why: "records a revert decision on a bead; the revert command is shown to the operator, never run",
  },
  "service-restart": { effect: "destructive", approval: "none", why: "restarts a declared service; loud, and the allowlist is guard-protected" },
  "mail-switch": {
    effect: "outward",
    approval: "none",
    why: "turns mail automation on or off, which changes what leaves the box; strictly boolean and immediately visible",
  },
};

/** @param {string} verb @returns {EffectSpec | null} */
export function effectOf(verb) {
  return Object.prototype.hasOwnProperty.call(EFFECTS, verb) ? EFFECTS[verb] : null;
}

/**
 * Whether a verb may run at all, given what the console knows about it.
 *
 * An UNDECLARED verb is refused. That is the fail-high rule borrowed from Odysseus's
 * capability model and it is the whole point: a new effectful operation that nobody
 * classified must not default to "harmless". The closure test makes this unreachable in
 * practice, which is exactly where a safety net belongs.
 *
 * @param {string} verb
 * @returns {{ok: true, spec: EffectSpec} | {ok: false, reason: string}}
 */
export function admit(verb) {
  const spec = effectOf(verb);
  if (!spec) return { ok: false, reason: `${verb} has no declared effect, so it is refused` };
  return { ok: true, spec };
}

/**
 * Whether a built plan has satisfied the approval policy its verb declares.
 *
 * This is the half that was missing when this file was first written, and the review that
 * caught it was right that its absence made the table decorative: `admit()` checked only
 * that a declaration EXISTED, so moving a verb to `sealed` changed a string and nothing
 * else. Enforcement lived inside the finish verb, where nobody would think to look.
 *
 * A verb declared `sealed` must set `sealedOk` on the plan it returns, which it may only
 * do after actually redeeming an approval (or when the particular invocation is not the
 * effectful variant, as a dry finish is not). A verb that declares `sealed` and does not
 * set it is REFUSED rather than allowed: promoting a verb to sealed and forgetting to
 * implement the check should fail closed and loudly, not open and quietly.
 *
 * @param {EffectSpec} spec
 * @param {{sealedOk?: boolean}} plan
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function approvalSatisfied(spec, plan) {
  if (spec.approval !== "sealed") return { ok: true };
  if (plan && plan.sealedOk === true) return { ok: true };
  return { ok: false, reason: "this operation requires an approval and none was validated, so it is refused" };
}
