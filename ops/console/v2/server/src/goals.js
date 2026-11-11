// Money goals (the owner, 2026-10-06: "allow me to add goals into the money
// section"): targets the Money tab measures the ledger against. A goal is not
// money and never touches a total; it is a yardstick, and the web computes the
// progress from the ledger it already has.
//
// Its OWN file, goals.jsonl beside ledger.jsonl, on purpose. The ledger loader
// treats an unknown record variant as corruption and refuses every read and
// write until a human intervenes, which is right for the ledger. A new variant
// written INTO ledger.jsonl would therefore make the whole ledger unreadable to
// any earlier release this box rolls back to. Goals in their own file cost
// nothing if a release does not know them.
//
// Same discipline as the ledger otherwise: append-only JSONL, server ids, an
// idempotency key `op` whose replay returns the original outcome, writes
// serialized in-process and fsync'd one line at a time, a torn final line
// dropped on load, anything else wrong marked corrupt rather than guessed at.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CURRENCIES, MoneyError } from "./money.js";

const ID_RE = /^g-[0-9a-f]{12}$/;
const OP_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TARGET_CENTS = 1_000_000_000;
/** What a goal can be about. Anything else is refused, not stored. */
export const GOAL_KINDS = new Set(["in", "out", "net"]);

function realDate(value) {
  const v = String(value);
  if (!DATE_RE.test(v)) return null;
  const [y, m, d] = v.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null;
  return v;
}

function optSlug(value) {
  if (value === undefined || value === null || value === "") return null;
  const v = String(value);
  if (!SLUG_RE.test(v)) throw new MoneyError("client must be a short lowercase slug");
  return v;
}

function validateRecord(rec) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) throw new Error("not an object");
  if (!ID_RE.test(rec.id)) throw new Error("bad goal id");
  if (!OP_RE.test(rec.op)) throw new Error("bad op");
  if (typeof rec.ts !== "string" || Number.isNaN(Date.parse(rec.ts))) throw new Error("bad ts");
  if (rec.t === "goal") {
    if (!GOAL_KINDS.has(rec.kind)) throw new Error("bad kind");
    if (!Number.isInteger(rec.targetCents) || rec.targetCents <= 0 || rec.targetCents > MAX_TARGET_CENTS) throw new Error("bad targetCents");
    if (!CURRENCIES.has(rec.currency)) throw new Error("bad currency");
    if (rec.month != null && !MONTH_RE.test(String(rec.month))) throw new Error("bad month");
    if (rec.by != null && !realDate(rec.by)) throw new Error("bad by");
    const client = rec.client == null ? null : String(rec.client);
    if (client !== null && !SLUG_RE.test(client)) throw new Error("bad client");
    return {
      t: "goal", id: rec.id, op: rec.op, ts: rec.ts,
      label: String(rec.label || "").slice(0, 120),
      kind: rec.kind, targetCents: rec.targetCents, currency: rec.currency,
      month: rec.month == null ? null : String(rec.month),
      by: rec.by == null ? null : String(rec.by),
      client,
    };
  }
  if (rec.t === "goal-tombstone") {
    if (!ID_RE.test(rec.target)) throw new Error("bad target");
    return { t: "goal-tombstone", id: rec.id, op: rec.op, ts: rec.ts, target: rec.target };
  }
  throw new Error("unknown record variant");
}

export class Goals {
  /** @param {{dir: string, readOnly?: boolean, now?: () => number, log?: Function}} opts */
  constructor(opts) {
    this.file = path.join(opts.dir, "goals.jsonl");
    this.readOnly = Boolean(opts.readOnly);
    this.now = opts.now || (() => Date.now());
    this.log = opts.log || (() => {});
    /** @type {Map<string, any>} id -> goal record */
    this.goals = new Map();
    /** @type {Set<string>} ids removed */
    this.removed = new Set();
    /** @type {Map<string, any>} op key -> the result that op produced */
    this.byOp = new Map();
    this.chain = Promise.resolve();
    this.corrupt = null;
  }

  /** All-or-nothing load; a torn final line is dropped, anything else wrong marks the store corrupt. */
  load() {
    this.corrupt = null;
    let buf;
    try {
      buf = fs.readFileSync(this.file);
    } catch (e) {
      if (e && e.code === "ENOENT") return this;
      throw new MoneyError(`cannot read the goals file: ${String(e && e.message)}`, 500);
    }
    const goals = new Map();
    const removed = new Set();
    const byOp = new Map();
    const ids = new Set();
    let offset = 0;
    while (offset < buf.length) {
      let nl = buf.indexOf(0x0a, offset);
      const hasNewline = nl >= 0;
      if (nl < 0) nl = buf.length;
      const text = buf.subarray(offset, nl).toString("utf8");
      const lineStart = offset;
      offset = nl + 1;
      if (!text.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        if (!hasNewline) {
          this.log("money goals: truncating a torn final line (crash recovery)");
          if (!this.readOnly) this.truncateTo(lineStart);
          break;
        }
        this.corrupt = `goals corruption at byte ${lineStart}: not JSON; resolve by hand`;
        return this;
      }
      let rec;
      try {
        rec = validateRecord(parsed);
      } catch (e) {
        this.corrupt = `goals corruption at byte ${lineStart}: ${String(e && e.message)}; resolve by hand`;
        return this;
      }
      if (ids.has(rec.id) || byOp.has(rec.op)) {
        this.corrupt = `goals file has a duplicate id or op key at byte ${lineStart}; resolve by hand`;
        return this;
      }
      if (rec.t === "goal-tombstone" && (!goals.has(rec.target) || removed.has(rec.target))) {
        this.corrupt = `goals file has a dangling or duplicate removal at byte ${lineStart}; resolve by hand`;
        return this;
      }
      ids.add(rec.id);
      this.applyTo(goals, removed, byOp, rec);
    }
    this.goals = goals;
    this.removed = removed;
    this.byOp = byOp;
    return this;
  }

  truncateTo(bytes) {
    try {
      const fd = fs.openSync(this.file, "r+");
      try {
        fs.ftruncateSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      this.corrupt = `cannot truncate a torn goals tail: ${String(e && e.message)}`;
    }
  }

  applyTo(goals, removed, byOp, rec) {
    if (rec.t === "goal") {
      goals.set(rec.id, rec);
      byOp.set(rec.op, { kind: "goal", goal: rec });
    } else {
      removed.add(rec.target);
      byOp.set(rec.op, { kind: "goal-tombstone", target: rec.target });
    }
  }

  guard() {
    if (this.corrupt) throw new MoneyError(this.corrupt, 503);
  }

  append(rec) {
    if (this.readOnly) throw new MoneyError("goals are read-only in check mode", 503);
    this.guard();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const line = Buffer.from(JSON.stringify(rec) + "\n", "utf8");
    let fd;
    try {
      fd = fs.openSync(this.file, "a");
    } catch (e) {
      throw new MoneyError(`cannot open the goals file: ${String(e && e.message)}`, 500);
    }
    try {
      // The whole line, however many calls it takes: a short write that is
      // never completed would be followed by the next record glued to it.
      let written = 0;
      while (written < line.length) written += fs.writeSync(fd, line, written, line.length - written);
      fs.fsyncSync(fd);
    } catch (e) {
      // Bytes may or may not be on disk now. A retry of the same op could
      // write it twice, which the loader would then call corruption, so the
      // store refuses everything until a reload has read what is really there.
      this.corrupt = `goals append failed mid-write (${String(e && e.message)}); restart to reload`;
      throw new MoneyError(this.corrupt, 503);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    this.applyTo(this.goals, this.removed, this.byOp, rec);
  }

  run(fn) {
    const p = this.chain.then(fn, fn);
    this.chain = p.then(
      () => {},
      () => {},
    );
    return p;
  }

  /** Add a goal. `month` null means every month (for in/out); `by` is a deadline for net. */
  add(body) {
    return this.run(() => {
      this.guard();
      const b = body && typeof body === "object" ? body : {};
      const op = String(b.op || "");
      if (!OP_RE.test(op)) throw new MoneyError("an idempotency key `op` is required");
      const replay = this.byOp.get(op);
      if (replay) {
        if (replay.kind !== "goal") throw new MoneyError("that op key was not a goal", 409);
        return { goal: this.decorate(replay.goal), replayed: true };
      }
      const kind = String(b.kind || "");
      if (!GOAL_KINDS.has(kind)) throw new MoneyError("kind must be in, out or net");
      const target = b.targetCents;
      if (!Number.isInteger(target) || target <= 0 || target > MAX_TARGET_CENTS) {
        throw new MoneyError("targetCents must be a positive integer within bounds");
      }
      const currency = String(b.currency || "");
      if (!CURRENCIES.has(currency)) throw new MoneyError("currency must be MXN or USD");
      let month = null;
      if (b.month != null && b.month !== "") {
        if (kind === "net") throw new MoneyError("a net goal has no month; give it a `by` date instead");
        if (!MONTH_RE.test(String(b.month))) throw new MoneyError("month must be yyyy-mm");
        month = String(b.month);
      }
      let by = null;
      if (b.by != null && b.by !== "") {
        if (kind !== "net") throw new MoneyError("only a net goal takes a `by` date");
        by = realDate(b.by);
        if (!by) throw new MoneyError("by must be a real yyyy-mm-dd date");
      }
      const client = optSlug(b.client);
      if (client !== null && kind === "net") throw new MoneyError("a net goal is for everything, not one client");
      const goal = {
        t: "goal",
        id: `g-${crypto.randomBytes(6).toString("hex")}`,
        op,
        ts: new Date(this.now()).toISOString(),
        label: String(b.label == null ? "" : b.label).slice(0, 120),
        kind,
        targetCents: target,
        currency,
        month,
        by,
        client,
      };
      this.append(goal);
      return { goal: this.decorate(goal), replayed: false };
    });
  }

  /** Remove a goal. The record stays on disk; it stops being shown. */
  remove(body) {
    return this.run(() => {
      this.guard();
      const b = body && typeof body === "object" ? body : {};
      const op = String(b.op || "");
      if (!OP_RE.test(op)) throw new MoneyError("an idempotency key `op` is required");
      const replay = this.byOp.get(op);
      if (replay) {
        if (replay.kind !== "goal-tombstone") throw new MoneyError("that op key was not a removal", 409);
        return { target: replay.target, replayed: true };
      }
      const target = String(b.target || "");
      if (!this.goals.has(target)) throw new MoneyError("no such goal", 404);
      if (this.removed.has(target)) throw new MoneyError("already removed", 409);
      this.append({
        t: "goal-tombstone",
        id: `g-${crypto.randomBytes(6).toString("hex")}`,
        op,
        ts: new Date(this.now()).toISOString(),
        target,
      });
      return { target, replayed: false };
    });
  }

  decorate(g) {
    return {
      id: g.id,
      label: g.label || "",
      kind: g.kind,
      targetCents: g.targetCents,
      currency: g.currency,
      month: g.month,
      by: g.by,
      client: g.client,
      createdAt: g.ts,
    };
  }

  /** Live goals, oldest first: the order they were set in is the order they are read in. */
  list() {
    this.guard();
    const out = [];
    for (const g of this.goals.values()) {
      if (this.removed.has(g.id)) continue;
      out.push(this.decorate(g));
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return out;
  }
}
