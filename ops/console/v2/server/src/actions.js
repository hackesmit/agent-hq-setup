// Actions: every mutating endpoint, each one a shell-out to a ctl.sh verb with
// an argument array (execFile, never a shell string). Validation happens here
// AND again in ctl.sh; this layer's job is to make sure nothing unvalidated
// ever reaches a process boundary.
//
// Ops are async records exactly like v1: created queued, written to
// $STATE/ops/<id>.json, polled through GET /api/op/:id. A replayed op id
// returns the stored record instead of running the verb twice, so a browser
// retry after a lost response cannot dispatch a second worker.

import crypto from "node:crypto";
import fs from "node:fs";
import { redactText, sanitizeError } from "./redact.js";
import { finishSubject, headOf } from "./seal.js";
import { admit, approvalSatisfied, effectOf } from "./effects.js";
import path from "node:path";
import { run, tail } from "./exec.js";
import { MODELS, RIGS } from "./protocol.js";

const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
// How long a finished op record is kept. Long enough that any retry a client
// would actually make still lands as a replay; short enough that the store is
// not a permanent record of every verb the box has ever run.
const OP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const WHEN_RE = /^[ A-Za-z0-9:+-]{1,64}$/;

export class BadRequest extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

// Values from the browser become argv elements of owner-context CLIs. They are never
// shell-interpreted, but a leading dash would turn them into OPTIONS (bd create -h,
// snooze.sh --id --id ...), so no user-supplied positional may start with "-".
function noOption(s, what) {
  if (s.startsWith("-")) throw new BadRequest(`bad ${what}: must not start with -`);
  return s;
}
function id(v, what) {
  const s = String(v == null ? "" : v);
  if (!ID_RE.test(s)) throw new BadRequest(`bad ${what}`);
  return noOption(s, what);
}
function text(v, what, max) {
  const s = String(v == null ? "" : v);
  if (!s.trim()) throw new BadRequest(`empty ${what}`);
  if (s.length > max) throw new BadRequest(`${what} too long`);
  return noOption(s.trimStart(), what);
}
function when(v) {
  const s = String(v == null ? "" : v).slice(0, 64);
  if (!WHEN_RE.test(s)) throw new BadRequest("bad when");
  return noOption(s.trimStart(), "when");
}
function model(v) {
  const s = String(v == null ? "" : v);
  if (!MODELS.has(s)) throw new BadRequest("bad model");
  return s;
}
function knownRig(v) {
  const rig = id(v, "rig");
  if (!RIGS.some((r) => r.id === rig)) throw new BadRequest("unknown rig");
  return rig;
}
// Synthetic Needs-you cards (unconfirmed assumptions, id "truths-<project>-<entry>")
// have no ctl request behind them: settling one is a truths edit, and a ctl verb
// aimed at that namespace is refused here, before any op record or process exists.
function requestId(v) {
  const rid = id(v, "request id");
  if (rid.startsWith("truths-")) {
    throw new BadRequest("that card is a truths assumption: confirm or delete it in the project's Truths");
  }
  return rid;
}

export class Ops {
  /** @param {{dir: string, readOnly?: boolean, now?: () => number, runner?: Function}} opts */
  constructor(opts) {
    this.dir = opts.dir;
    this.readOnly = Boolean(opts.readOnly);
    this.now = opts.now || (() => Date.now());
    this.run = opts.runner || run;
    /** @type {Map<string, any>} */
    this.mem = new Map();
    this.inflight = 0;
    if (!this.readOnly) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
      } catch {
        /* the first real write will report it */
      }
    }
  }

  file(opId) {
    return path.join(this.dir, `${opId}.json`);
  }

  read(opId) {
    if (this.mem.has(opId)) return this.mem.get(opId);
    try {
      const rec = JSON.parse(fs.readFileSync(this.file(opId), "utf8"));
      this.mem.set(opId, rec);
      return rec;
    } catch {
      return null;
    }
  }

  write(rec) {
    this.mem.set(rec.id, rec);
    if (this.readOnly) return;
    try {
      const tmp = `${this.file(rec.id)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rec, null, 1));
      fs.renameSync(tmp, this.file(rec.id));
    } catch (e) {
      // an op that cannot be persisted must not run: after a restart the replay
      // guard would have no record and a retry would execute the mutation twice
      throw new Error(`cannot persist op record: ${String(e && e.message)}`);
    }
  }

  newId() {
    return `op-${crypto.randomBytes(6).toString("hex")}`;
  }

  /**
   * Drop op records that are older than the replay window is worth.
   *
   * These records exist so that a retried mutation is recognised as a replay
   * rather than executed twice, which only matters for as long as a client might
   * plausibly retry. Without a sweep they were permanent: one JSON file and one
   * permanent Map entry per verb invocation, for the life of the box. A running
   * op is never swept, however old, because losing its record is exactly the case
   * the record exists to prevent.
   */
  prune(maxAgeMs = OP_RETENTION_MS) {
    const cutoff = this.now() - maxAgeMs;
    const old = (rec) => {
      if (!rec || rec.state === "running") return false;
      const at = Date.parse(rec.finishedAt || rec.startedAt || "");
      return Number.isFinite(at) && at <= cutoff;
    };
    let removed = 0;
    for (const [id, rec] of this.mem) {
      if (!old(rec)) continue;
      this.mem.delete(id);
      removed += 1;
    }
    // The directory is swept too, not just the map. Records are read lazily, so a
    // file that no request ever touched since the last restart is not in the map
    // at all -- sweeping only the map would leave the actual accumulation on disk
    // untouched, which is the half that grows without bound.
    if (this.readOnly) return removed;
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return removed;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.dir, name);
      let rec = null;
      try {
        rec = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        // Unreadable or half-written: judge it by mtime instead of guessing, and
        // leave a recent one alone in case a write is in flight.
        try {
          if (fs.statSync(file).mtimeMs > cutoff) continue;
        } catch {
          continue;
        }
      }
      if (rec && !old(rec)) continue;
      try {
        fs.unlinkSync(file);
        this.mem.delete(name.slice(0, -5));
        removed += 1;
      } catch {
        /* already gone */
      }
    }
    return removed;
  }

  /**
   * Start a verb. Returns the queued record at once; the process runs on.
   * @param {{opId?: string, verb: string, cmd: string, args: string[], timeout?: number, after?: Function, decorate?: Function}} spec
   */
  start(spec) {
    const opId = spec.opId || this.newId();
    if (!ID_RE.test(opId)) throw new BadRequest("bad op id");
    const existing = this.read(opId);
    if (existing) return { rec: existing, replayed: true };
    const rec = {
      id: opId,
      verb: spec.verb,
      // Derived, never taken from the caller: an effect that could be passed in is an
      // effect that could be understated by whoever passes it.
      effect: (effectOf(spec.verb) || {}).effect || null,
      state: "running",
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      output: null,
      error: null,
      meta: spec.meta || null,
    };
    try {
      this.write(rec);
    } catch (e) {
      rec.state = "failed";
      rec.error = sanitizeError(e);
      rec.finishedAt = new Date(this.now()).toISOString();
      this.mem.set(rec.id, rec);
      return { rec, replayed: false };
    }
    this.inflight += 1;
    const done = this.run(spec.cmd, spec.args, { timeout: spec.timeout || 120000 })
      .then((r) => {
        rec.state = r.code === 0 ? "done" : "failed";
        // Both halves are redacted, not just the error one. A command that SUCCEEDS can
        // still print a credential on stdout, and this record is durable and is served
        // to the browser, so "it worked" is not a reason to keep the bytes verbatim.
        rec.output = redactText(tail(r.stdout, ""));
        rec.error = r.code === 0 ? null : redactText(tail("", r.stderr || r.stdout)) || `exit ${r.code}`;
        rec.finishedAt = new Date(this.now()).toISOString();
        // `decorate` may add fields to the record and therefore runs BEFORE the write.
        // `after` below is for side effects and runs after it, where a mutation would
        // be lost.
        if (spec.decorate) {
          try {
            spec.decorate(rec, r);
          } catch {
            /* a record that could not be decorated is still a true record */
          }
        }
        this.write(rec);
        if (spec.after) {
          try {
            spec.after(rec, r);
          } catch {
            /* cleanup is best effort */
          }
        }
        return rec;
      })
      .catch((e) => {
        rec.state = "failed";
        rec.error = sanitizeError(e, { max: 500 });
        rec.finishedAt = new Date(this.now()).toISOString();
        this.write(rec);
        return rec;
      })
      .finally(() => {
        this.inflight -= 1;
      });
    this.pending = done;
    return { rec, replayed: false, done };
  }

  /** Reconcile ops wedged by a restart, exactly as v1 does. */
  reconcile() {
    if (this.readOnly) return 0;
    let n = 0;
    let files = [];
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      return 0;
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const p = path.join(this.dir, f);
        const rec = JSON.parse(fs.readFileSync(p, "utf8"));
        if (rec.state === "running" || rec.state === "queued") {
          rec.state = "failed";
          rec.error = "console server restarted mid-operation";
          rec.finishedAt = new Date(this.now()).toISOString();
          fs.writeFileSync(p, JSON.stringify(rec, null, 1));
          n += 1;
        }
      } catch {
        /* skip an unreadable record */
      }
    }
    return n;
  }
}

// Request states an answer is owed in: the only ones req-clear may take off the board.
const OWED_STATES = new Set(["answered", "revival_claimed"]);

/**
 * Build the verb table. Each entry validates its body and returns the wrapper
 * verb to run; nothing here interpolates a string into a command, and nothing
 * here spawns anything but ops/console/v2/runner/spawn-as-owner.sh.
 * @param {{cfg: any, wrapper: import("./wrapper.js").Wrapper, seals?: any, ops?: any, requestState?: (rid: string) => string | null}} opts
 */
export function buildVerbs(opts) {
  const cfg = opts.cfg;
  const w = opts.wrapper;
  // Optional so the verb table can be built for shape tests without a whole console.
  // The finish CONFIRM path refuses when they are missing rather than proceeding: a
  // half-wired approval system that silently degrades to no approval is worse than one
  // that is plainly switched off.
  const seals = opts.seals || null;
  const ops = opts.ops || null;
  // Optional: the current state of a request from the requests slice, or null when
  // unknown. Used to refuse req-clear on an open question before an op is queued.
  /** @type {((rid: string) => string | null) | null} */
  const requestState = typeof opts.requestState === "function" ? opts.requestState : null;
  /** @param {string[]} args */
  const ctl = (args) => w.argv("ctl", args);

  return {
    answer: (b) => {
      const rid = requestId(b.rid || b.id);
      const t = text(b.text, "answer", 8000);
      // The text is one argv element, so newlines and quotes are data, not
      // syntax, and no temp file has to be shared across the user boundary.
      return { ...ctl(["answer", rid, t]), timeout: 60000 };
    },
    done: (b) => ({ ...ctl(["answer", requestId(b.rid || b.id), "done"]), timeout: 60000 }),
    skip: (b) => {
      const rid = requestId(b.rid || b.id);
      const reason = String(b.reason || "").slice(0, 2000);
      // Design section 5: Skip records "skipped: <reason>" as the answer, so
      // the waiting worker continues instead of hanging on a dropped question.
      // (ctl.sh `resolve` takes no reason and leaves a live worker waiting.)
      return { ...ctl(["answer", rid, `skipped: ${reason || "no reason given"}`]), timeout: 60000 };
    },
    resolve: (b) => ({ ...ctl(["resolve", requestId(b.rid || b.id)]), timeout: 30000 }),
    // Takes an answered request whose answer never reached a terminal off the
    // board (ctl clear: cancelled + hidden). The answer file stays on disk.
    // Only an answer that is owed (answered or mid-revival) may be cleared: an open
    // question is refused here when the requests slice knows it (400), and ctl
    // clear --owed refuses it again in case the slice has not seen it yet, so a
    // direct POST cannot cancel a question the owner has not answered (hq-zqqu.1 round 4).
    "req-clear": (b) => {
      const rid = requestId(b.rid || b.id);
      const known = requestState ? requestState(rid) : null;
      if (known && !OWED_STATES.has(known)) {
        throw new BadRequest(`request ${rid} is ${known}; only an answer not yet in a terminal can be cleared`);
      }
      return { ...ctl(["clear", rid, "--owed"]), timeout: 30000 };
    },
    "req-snooze": (b) => ({
      ...ctl(["req-snooze", requestId(b.rid || b.id), when(b.until || b.when)]),
      timeout: 30000,
    }),
    "req-unsnooze": (b) => ({ ...ctl(["req-unsnooze", requestId(b.rid || b.id)]), timeout: 30000 }),
    // The wake button for a sleeping ear ("capri, go to sleep" releases the
    // microphone until this is pressed). Stamps an inert timestamp the ear
    // polls; no text crosses, no authority is granted.
    "ear-wake": () => ({ ...ctl(["ear-wake"]), timeout: 15000 }),
    sink: (b) => {
      const args = ["sink", requestId(b.rid || b.id)];
      if (b.top) args.push("--top");
      return { ...ctl(args), timeout: 30000 };
    },
    dispatch: (b) => {
      const bead = id(b.bead, "bead");
      const rig = knownRig(b.rig);
      const m = model(b.model);
      const args = ["dispatch", bead, "--rig", rig];
      if (m) args.push("--model", m);
      return { ...ctl(args), timeout: 120000 };
    },
    "dispatch-batch": (b) => {
      const rig = knownRig(b.rig);
      const m = model(b.model);
      const list = Array.isArray(b.beads) ? b.beads : String(b.beads || "").split(",");
      if (!list.length || list.length > 8) throw new BadRequest("1 to 8 beads per batch");
      const beads = list.map((x) => id(x, "bead")).join(",");
      const args = ["dispatch-batch", "--rig", rig, "--beads", beads];
      if (m) args.push("--model", m);
      return { ...ctl(args), timeout: 180000 };
    },
    focus: (b) => ({ ...ctl(["focus", id(b.session, "session")]), timeout: 30000 }),
    kill: (b) => ({ ...ctl(["kill", id(b.session, "session")]), timeout: 30000 }),
    snooze: (b) => ({
      ...w.argv("snooze", [when(b.until || b.when), "--id", id(b.session, "session"), "--reason", "console"]),
      timeout: 60000,
    }),
    // Now page "wake now" for a snoozed worker: wake.sh reopens it in its worktree
    // with its objectives. Console terminals wake through the runner instead (server.js).
    wake: (b) => ({ ...w.argv("wake", [id(b.session, "session")]), timeout: 60000 }),
    name: (b) => {
      const session = id(b.session, "session");
      const label = String(b.name || "").slice(0, 120).trim();
      if (label) noOption(label, "name");
      return { ...ctl(label ? ["name", session, label] : ["name", session, "--clear"]), timeout: 30000 };
    },
    "finish-check": (b) => {
      const session = id(b.session, "session");
      return {
        ...ctl(["finish-check", "--session", session]),
        timeout: 60000,
        // The reading the operator is about to be shown gets an approval stamped onto
        // it. `finish --confirm` will only accept a stamp naming THIS op and THIS text.
        decorate: (rec) => {
          if (!seals || rec.state !== "done") return;
          rec.seal = seals.issue(finishSubject({ session, opId: rec.id, output: rec.output || "" }));
        },
      };
    },
    finish: (b) => {
      const session = id(b.session, "session");
      // Without confirm this is the dry finish-plan, which is what the UI shows
      // before the approval gate; ctl.sh runs finish-check itself on confirm.
      // Strict boolean, for the same reason mail-switch is: the string "false"
      // is truthy, and this is the verb that merges a branch into a rig's
      // default and lets the sync daemon push it, which for acme is a
      // production deploy. A payload that does not clearly say yes means no.
      if (b.confirm !== undefined && typeof b.confirm !== "boolean") throw new BadRequest("`confirm` must be a boolean");
      const confirm = b.confirm === true;
      let approvedHead = "";
      const sealed = (effectOf("finish") || {}).approval === "sealed";
      if (confirm && sealed) {
        // The click has to name the gate reading it is answering. Without this the
        // panel can sit open on a phone while the worker keeps committing, and the
        // merge still goes through on a reading that has gone stale.
        if (!seals || !ops) throw new BadRequest("approvals are not configured on this server, so finish is refused", 500);
        const opId = id(b.approvedOp, "approved op");
        const rec = ops.read(opId);
        if (!rec || rec.verb !== "finish-check") throw new BadRequest("that approval does not name a finish check", 409);
        if (rec.meta && rec.meta.session && rec.meta.session !== session) {
          throw new BadRequest("that approval was for a different session", 409);
        }
        // Redeeming here spends the approval before the op is enqueued, so an enqueue
        // that then throws burns it and the operator has to re-read the gate. That is
        // the deliberate side of the trade: check-then-spend as two steps would let two
        // concurrent confirmations both pass the check before either spent, and a
        // double merge is worse than an extra click (lucy round 1).
        const verdict = seals.redeem(b.seal, finishSubject({ session, opId, output: rec.output || "" }));
        if (!verdict.ok) throw new BadRequest(verdict.reason, 409);
        // The revision the operator read about, handed to the executor so it can refuse
        // a branch that has moved. Re-digesting the stored reading here would prove
        // nothing: the op record is immutable, so it would only ever match itself.
        approvedHead = headOf(rec.output || "");
      }
      const args = confirm ? ["finish", session, "--confirm"] : ["finish", session];
      if (approvedHead) args.push("--expect-head", approvedHead);
      // Reaching here with confirm set means an approval was redeemed above; the dry
      // plan is a read and has nothing to approve.
      const sealedOk = true;
      return { ...ctl(args), timeout: confirm ? 300000 : 120000, sealedOk };
    },
    phase: (b) => {
      const bead = id(b.bead, "bead");
      const name = text(b.phase, "phase", 120);
      const verb = b.done === false ? "uncheck" : "check";
      return { ...ctl(["phase", verb, bead, name]), timeout: 30000 };
    },
    // Stack keep/revert (design 4.3): a decision files onto the acquisition
    // bead when one exists, otherwise a new stack-verdict bead. Nothing is
    // executed: on revert the UI shows the recorded revert command for the owner.
    "stack-keep": (b) => stackDecision(w, b, "keep"),
    "stack-revert": (b) => stackDecision(w, b, "revert"),
    // Machines (design 4.4): the wrapper re-reads the guard-protected
    // allowlist itself, so these only ever forward an id or a fixed word.
    "service-restart": (b) => ({ ...w.argv("service-restart", [id(b.service, "service")]), timeout: 30000 }),
    "mail-switch": (b) => {
      const sw = String(b.switch || "");
      if (sw !== "disabled" && sw !== "log-only") throw new BadRequest("bad switch");
      // Strict boolean: the string "false" is truthy, so a loose check would
      // disable mail on a payload that says not to (lucy red-team).
      if (typeof b.on !== "boolean") throw new BadRequest("`on` must be a boolean");
      return { ...w.argv("mail-switch", [sw, b.on ? "on" : "off"]), timeout: 15000 };
    },
    capture: (b) => {
      const rig = knownRig(b.rig);
      const title = text(b.title, "title", 300);
      const body = String(b.body || "").slice(0, 8000);
      const args = ["create", title, "-p", "2", "-t", "task"];
      if (body.trim()) args.push("-d", body);
      // hq beads go through `bd`, a rig's through `bd-rig <rig>`
      return rig === "hq"
        ? { ...w.argv("bd", args), timeout: 60000 }
        : { ...w.argv("bd-rig", [rig, ...args]), timeout: 60000 };
    },
  };
}

/** Shared body of stack-keep / stack-revert. */
function stackDecision(w, b, decision) {
  const item = text(b.item, "stack item", 120);
  const note = String(b.note || "").slice(0, 1000);
  const line = `console stack: ${decision.toUpperCase()} ${item}${note.trim() ? ` (${note.trim()})` : ""}`;
  if (b.bead) {
    return { ...w.argv("bd", ["comment", id(b.bead, "bead"), line]), timeout: 60000 };
  }
  const args = ["create", `${decision === "keep" ? "Keep" : "Revert"}: ${item}`, "-p", decision === "keep" ? "3" : "2", "-t", "task", "-l", "acquisition,stack-verdict"];
  if (note.trim()) args.push("-d", noOption(note.trim(), "note"));
  return { ...w.argv("bd", args), timeout: 60000 };
}

/**
 * Execute a verb as an op.
 * @param {{ops: Ops, verbs: any, verb: string, body: any}} spec
 */
export function runVerb(spec) {
  const build = spec.verbs[spec.verb];
  if (!build) throw new BadRequest("unknown verb", 404);
  // Fail high on anything nobody classified. The closure test in effects.test.js makes
  // this unreachable in practice, which is where a safety net belongs: it catches the
  // verb somebody adds on a branch where the test was not run.
  const gate = admit(spec.verb);
  if (!gate.ok) throw new BadRequest(gate.reason, 403);
  const plan = build(spec.body || {});
  // The declared policy is enforced HERE, generically, so that moving any verb to
  // `sealed` takes effect on its own rather than requiring somebody to also remember to
  // add a check inside that verb.
  const approved = approvalSatisfied(gate.spec, plan);
  if (!approved.ok) throw new BadRequest(approved.reason, 403);
  return spec.ops.start({
    opId: spec.body && spec.body.op ? String(spec.body.op) : undefined,
    verb: spec.verb,
    cmd: plan.cmd,
    args: plan.args,
    timeout: plan.timeout,
    decorate: plan.decorate,
    meta: opMeta(spec.body || {}),
  });
}

/**
 * Id-shaped context copied onto the op record for the activity stream. Only
 * values that pass ID_RE survive, so free text (answers, reasons, titles)
 * never lands in a record that outlives the request.
 */
export function opMeta(body) {
  const ok = (v) => typeof v === "string" && ID_RE.test(v) && !v.startsWith("-");
  const meta = {};
  for (const key of ["rig", "bead", "session"]) {
    if (ok(body[key])) meta[key] = body[key];
  }
  const rid = body.rid || (body.bead ? undefined : body.id);
  if (ok(rid)) meta.rid = rid;
  if (Array.isArray(body.beads)) {
    const beads = body.beads.filter(ok);
    if (beads.length) meta.beads = beads.slice(0, 8).join(",");
  }
  return Object.keys(meta).length ? meta : null;
}
