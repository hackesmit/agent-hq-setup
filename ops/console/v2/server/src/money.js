// The manual money ledger (bead hq-9fri, design 4.5, lucy-amended contract).
//
// An append-only JSONL in the console's OWN state tree (hqconsole-writable, no
// wrapper): two record variants, entry and tombstone. Server-generated ids;
// the client sends an idempotency key `op` and a replayed key returns the
// original outcome instead of writing twice; writes are serialized in-process
// and appended as one fsync'd line; recovery drops only a torn final line.
// Money surface: integer cents only, strict bounds, currencies never combined.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CURRENCIES = new Set(["MXN", "USD"]);
const ID_RE = /^m-[0-9a-f]{12}$/;
const OP_RE = /^[A-Za-z0-9._-]{1,64}$/;
const CATEGORY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
// A client, a vendor and a project all use the same shape as a category: a short
// lowercase slug. They are separate FIELDS rather than one tagging free-for-all
// because they answer different questions, and mixing them would make "who paid
// me" and "what did I pay for" the same column.
const SLUG_RE = CATEGORY_RE;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * A calendar date that actually exists, checked by round trip.
 *
 * The regex alone is not enough: it matches 2026-02-30, which Date.parse happily
 * normalises to the 2nd of March, so the stored start date and every due date
 * computed from it would disagree. And the value must be matched BEFORE any
 * slicing, or "2026-01-01garbage" is silently accepted as a date.
 */
function realDate(value) {
  const v = String(value);
  if (!DATE_RE.test(v)) return null;
  const [y, m, d] = v.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) return null;
  return v;
}
// How often a commitment repeats. Anything not on this list is refused rather
// than guessed at, because a wrong cadence silently misstates the run rate.
export const CADENCES = Object.freeze({
  weekly: { perYear: 52 },
  monthly: { perYear: 12 },
  quarterly: { perYear: 4 },
  yearly: { perYear: 1 },
});
const MAX_ABS_CENTS = 1_000_000_000; // ten million pesos/dollars is a typo, not a ledger line
const VISIBLE_CAP = 500;

export class MoneyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** An optional slug field: absent and empty both mean "not set", never "". */
function optSlug(value, what) {
  if (value === undefined || value === null || value === "") return null;
  const v = String(value);
  if (!SLUG_RE.test(v)) throw new Error(`bad ${what}`);
  return v;
}

/** Add n months to a UTC yyyy-mm-dd, clamping the day so 31 Jan plus one month
 *  is the last day of February rather than rolling into March. */
export function addMonths(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * The next date a commitment falls due, at or after `from`.
 *
 * Walks the schedule rather than dividing, so month lengths and the clamp above
 * are respected, and a commitment that started years ago does not need its whole
 * history materialised. Returns null once the commitment has ended.
 */
export function nextDue(commitment, fromIso) {
  const from = String(fromIso).slice(0, 10);
  const cadence = CADENCES[commitment.cadence];
  if (!cadence) return null;
  const stepMonths = commitment.cadence === "weekly" ? 0 : 12 / cadence.perYear;
  let due = commitment.startsOn;
  if (commitment.cadence === "weekly") {
    // Weeks are not months: step in days, and jump most of the distance in one
    // go so a very old weekly commitment does not cost thousands of iterations.
    const start = Date.parse(`${commitment.startsOn}T00:00:00Z`);
    const target = Date.parse(`${from}T00:00:00Z`);
    const week = 7 * 86400000;
    const skipped = target > start ? Math.floor((target - start) / week) : 0;
    due = new Date(start + skipped * week).toISOString().slice(0, 10);
    while (due < from) due = new Date(Date.parse(`${due}T00:00:00Z`) + week).toISOString().slice(0, 10);
  } else {
    let k = due < from ? Math.max(0, Math.floor(monthsBetween(due, from) / stepMonths) * stepMonths) : 0;
    due = addMonths(commitment.startsOn, k);
    // Step the multiplier from the anchor, never from a clamped date: Jan 31 + 3
    // months clamps to Apr 30, and Apr 30 + 3 would drift to Jul 30 while the
    // anchor says Jul 31, which auto-post then booked twice.
    while (due < from) {
      k += stepMonths;
      due = addMonths(commitment.startsOn, k);
    }
  }
  if (commitment.endsOn && due > commitment.endsOn) return null;
  return due;
}

function dayAfter(iso) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

function monthsBetween(a, b) {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}

/** What a commitment costs per month, in whole cents, whatever its cadence. */
export function monthlyCents(commitment) {
  const cadence = CADENCES[commitment.cadence];
  if (!cadence) return 0;
  return Math.round((commitment.amountCents * cadence.perYear) / 12);
}

/** Validate one on-disk record against the SAME rules as a fresh write (lucy
 * red-team: a hand-edited or partially-written line must never be trusted just
 * because it parsed). Returns a clean record or throws. */
function validateRecord(rec) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) throw new Error("not an object");
  if (rec.t === "entry") {
    if (!ID_RE.test(rec.id)) throw new Error("bad entry id");
    if (!OP_RE.test(rec.op)) throw new Error("bad op");
    if (typeof rec.ts !== "string" || Number.isNaN(Date.parse(rec.ts))) throw new Error("bad ts");
    if (!Number.isInteger(rec.amountCents) || rec.amountCents === 0 || Math.abs(rec.amountCents) > MAX_ABS_CENTS)
      throw new Error("bad amountCents");
    if (!CURRENCIES.has(rec.currency)) throw new Error("bad currency");
    if (typeof rec.category !== "string" || !CATEGORY_RE.test(rec.category)) throw new Error("bad category");
    if (rec.note != null && typeof rec.note !== "string") throw new Error("bad note");
    // Added after the first version shipped, so they are OPTIONAL by construction:
    // every entry written before they existed must still load, which is why absent
    // is a valid value rather than a validation failure.
    const client = optSlug(rec.client, "client");
    const vendor = optSlug(rec.vendor, "vendor");
    const project = optSlug(rec.project, "project");
    return {
      t: "entry", id: rec.id, op: rec.op, ts: rec.ts,
      amountCents: rec.amountCents, currency: rec.currency, category: rec.category,
      note: String(rec.note || "").slice(0, 500),
      client, vendor, project,
    };
  }
  if (rec.t === "commitment") {
    // A scheduled repeating payment: a subscription, a tool, or a retainer coming
    // the other way. It is NOT a ledger entry. It records an intention, so it never
    // counts as money that has actually moved; it drives the run rate and the
    // what-is-due view, and the entry that eventually settles it is written
    // separately. Conflating the two is how a forecast ends up in a total.
    if (!ID_RE.test(rec.id)) throw new Error("bad commitment id");
    if (!OP_RE.test(rec.op)) throw new Error("bad op");
    if (typeof rec.ts !== "string" || Number.isNaN(Date.parse(rec.ts))) throw new Error("bad ts");
    if (!Number.isInteger(rec.amountCents) || rec.amountCents === 0 || Math.abs(rec.amountCents) > MAX_ABS_CENTS)
      throw new Error("bad amountCents");
    if (!CURRENCIES.has(rec.currency)) throw new Error("bad currency");
    if (!CATEGORY_RE.test(String(rec.category || ""))) throw new Error("bad category");
    if (!Object.prototype.hasOwnProperty.call(CADENCES, String(rec.cadence))) throw new Error("bad cadence");
    if (!realDate(rec.startsOn)) throw new Error("bad startsOn");
    if (rec.endsOn != null && !realDate(rec.endsOn)) throw new Error("bad endsOn");
    if (rec.endsOn != null && String(rec.endsOn) < String(rec.startsOn)) throw new Error("endsOn precedes startsOn");
    return {
      t: "commitment", id: rec.id, op: rec.op, ts: rec.ts,
      label: String(rec.label || "").slice(0, 120),
      amountCents: rec.amountCents, currency: rec.currency, category: rec.category,
      cadence: String(rec.cadence), startsOn: String(rec.startsOn),
      endsOn: rec.endsOn == null ? null : String(rec.endsOn),
      client: optSlug(rec.client, "client"),
      vendor: optSlug(rec.vendor, "vendor"),
      project: optSlug(rec.project, "project"),
    };
  }
  if (rec.t === "commitment-tombstone") {
    if (!ID_RE.test(rec.id)) throw new Error("bad tombstone id");
    if (!OP_RE.test(rec.op)) throw new Error("bad op");
    if (typeof rec.ts !== "string" || Number.isNaN(Date.parse(rec.ts))) throw new Error("bad ts");
    if (!ID_RE.test(rec.target)) throw new Error("bad target");
    return { t: "commitment-tombstone", id: rec.id, op: rec.op, ts: rec.ts, target: rec.target };
  }
  if (rec.t === "tombstone") {
    if (!ID_RE.test(rec.id)) throw new Error("bad tombstone id");
    if (!OP_RE.test(rec.op)) throw new Error("bad op");
    if (typeof rec.ts !== "string" || Number.isNaN(Date.parse(rec.ts))) throw new Error("bad ts");
    if (!ID_RE.test(rec.target)) throw new Error("bad target");
    return { t: "tombstone", id: rec.id, op: rec.op, ts: rec.ts, target: rec.target };
  }
  throw new Error("unknown record variant");
}

export class Ledger {
  /** @param {{dir: string, readOnly?: boolean, now?: () => number, log?: Function}} opts */
  constructor(opts) {
    this.file = path.join(opts.dir, "ledger.jsonl");
    this.readOnly = Boolean(opts.readOnly);
    this.now = opts.now || (() => Date.now());
    this.log = opts.log || (() => {});
    /** @type {Map<string, any>} id -> entry record */
    this.entries = new Map();
    /** @type {Set<string>} ids tombstoned */
    this.deleted = new Set();
    /** @type {Map<string, any>} op key -> the result that op produced */
    this.byOp = new Map();
    /** @type {Map<string, any>} id -> commitment record (a schedule, not money moved) */
    this.commitments = new Map();
    /** @type {Set<string>} commitment ids cancelled */
    this.cancelled = new Set();
    this.chain = Promise.resolve();
    this.loaded = false;
    this.corrupt = null; // reason string when the on-disk file cannot be trusted
  }

  /**
   * Load all-or-nothing into fresh maps and commit only on a clean parse
   * (lucy red-team: a partial load that then stays writable loses newly
   * acknowledged appends on every restart). A torn FINAL line (an incomplete
   * write with no terminating newline) is truncated away before any write is
   * allowed; a broken MIDDLE line, or any record that fails the write-time
   * schema, marks the ledger corrupt and every mutation and read then fails
   * with 503 until it is repaired by hand.
   */
  load() {
    this.loaded = true;
    this.corrupt = null;
    let buf;
    try {
      buf = fs.readFileSync(this.file);
    } catch (e) {
      if (e && e.code === "ENOENT") return this;
      throw new MoneyError(`cannot read the ledger: ${String(e && e.message)}`, 500);
    }
    const entries = new Map();
    const deleted = new Set();
    const byOp = new Map();
    const commitments = new Map();
    const cancelled = new Set();
    const ids = new Set();
    let validBytes = 0; // byte length of the clean prefix (through the last good newline)
    let offset = 0;
    while (offset < buf.length) {
      let nl = buf.indexOf(0x0a, offset);
      const hasNewline = nl >= 0;
      if (nl < 0) nl = buf.length;
      const lineBuf = buf.subarray(offset, nl);
      const lineStart = offset;
      offset = nl + 1;
      const text = lineBuf.toString("utf8");
      if (!text.trim()) {
        if (hasNewline) validBytes = offset;
        continue;
      }
      // Parse and schema-validate are SEPARATE (lucy fix-verify): only a real
      // JSON.parse failure on an unterminated final line is a torn write; a
      // line that parses but fails the schema is corruption whether or not it
      // ends in a newline, and must never be silently truncated.
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        if (!hasNewline) {
          this.log("money: truncating a torn final ledger line (crash recovery)");
          if (!this.readOnly) this.truncateTo(lineStart);
          validBytes = lineStart;
          break;
        }
        this.corrupt = `ledger corruption at byte ${lineStart}: not JSON; resolve by hand`;
        return this;
      }
      let rec;
      try {
        rec = validateRecord(parsed);
      } catch (e) {
        this.corrupt = `ledger corruption at byte ${lineStart}: ${String(e && e.message)}; resolve by hand`;
        return this;
      }
      if (ids.has(rec.id) || (rec.op && byOp.has(rec.op))) {
        this.corrupt = `ledger has a duplicate id or op key at byte ${lineStart}; resolve by hand`;
        return this;
      }
      // A tombstone must reference an entry already seen and not already
      // deleted: remove() can never write a dangling, forward or double
      // tombstone, so one on disk is tampering (lucy fix-verify).
      if (rec.t === "tombstone" && (!entries.has(rec.target) || deleted.has(rec.target))) {
        this.corrupt = `ledger has a dangling or duplicate tombstone at byte ${lineStart}; resolve by hand`;
        return this;
      }
      // The same rule for a cancelled commitment: cancel() cannot write a
      // dangling, forward or double cancellation, so one on disk is tampering.
      if (rec.t === "commitment-tombstone" && (!commitments.has(rec.target) || cancelled.has(rec.target))) {
        this.corrupt = `ledger has a dangling or duplicate commitment cancellation at byte ${lineStart}; resolve by hand`;
        return this;
      }
      ids.add(rec.id);
      this.applyTo(entries, deleted, byOp, rec, commitments, cancelled);
      if (hasNewline) validBytes = offset;
    }
    void validBytes;
    // Clean parse: commit.
    this.entries = entries;
    this.deleted = deleted;
    this.byOp = byOp;
    this.commitments = commitments;
    this.cancelled = cancelled;
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
      // If the tail cannot be truncated, do NOT allow writes onto it.
      this.corrupt = `cannot truncate a torn ledger tail: ${String(e && e.message)}`;
    }
  }

  applyTo(entries, deleted, byOp, rec, commitments, cancelled) {
    if (rec.t === "entry") {
      entries.set(rec.id, rec);
      if (rec.op) byOp.set(rec.op, { kind: "entry", entry: rec });
    } else if (rec.t === "tombstone") {
      deleted.add(rec.target);
      if (rec.op) byOp.set(rec.op, { kind: "tombstone", target: rec.target });
    } else if (rec.t === "commitment") {
      if (commitments) commitments.set(rec.id, rec);
      if (rec.op) byOp.set(rec.op, { kind: "commitment", commitment: rec });
    } else if (rec.t === "commitment-tombstone") {
      if (cancelled) cancelled.add(rec.target);
      if (rec.op) byOp.set(rec.op, { kind: "commitment-tombstone", target: rec.target });
    }
  }

  apply(rec) {
    this.applyTo(this.entries, this.deleted, this.byOp, rec, this.commitments, this.cancelled);
  }

  guard() {
    if (this.corrupt) throw new MoneyError(this.corrupt, 503);
  }

  append(rec) {
    if (this.readOnly) throw new MoneyError("the ledger is read-only in check mode", 503);
    this.guard();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const fd = fs.openSync(this.file, "a");
    try {
      fs.writeSync(fd, JSON.stringify(rec) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.apply(rec);
  }

  /** Serialize mutations so two requests can never interleave an append. */
  run(fn) {
    const p = this.chain.then(fn, fn);
    this.chain = p.then(
      () => {},
      () => {},
    );
    return p;
  }

  add(body) {
    return this.run(() => {
      this.guard();
      const b = body && typeof body === "object" ? body : {};
      const op = String(b.op || "");
      if (!OP_RE.test(op)) throw new MoneyError("an idempotency key `op` is required");
      const replay = this.byOp.get(op);
      if (replay) {
        if (replay.kind !== "entry") throw new MoneyError("that op key was a delete", 409);
        return { entry: replay.entry, replayed: true };
      }
      const cents = b.amountCents;
      if (!Number.isInteger(cents) || cents === 0 || Math.abs(cents) > MAX_ABS_CENTS) {
        throw new MoneyError("amountCents must be a non-zero integer within bounds");
      }
      const currency = String(b.currency || "");
      if (!CURRENCIES.has(currency)) throw new MoneyError("currency must be MXN or USD");
      const category = String(b.category || "");
      if (!CATEGORY_RE.test(category)) throw new MoneyError("category must be a short lowercase slug");
      const note = String(b.note == null ? "" : b.note).slice(0, 500);
      let client, vendor, project;
      try {
        client = optSlug(b.client, "client");
        vendor = optSlug(b.vendor, "vendor");
        project = optSlug(b.project, "project");
      } catch (e) {
        throw new MoneyError(`${String(e && e.message)}: use a short lowercase slug`);
      }
      const entry = {
        t: "entry",
        id: `m-${crypto.randomBytes(6).toString("hex")}`,
        op,
        ts: new Date(this.now()).toISOString(),
        amountCents: cents,
        currency,
        category,
        note,
        client,
        vendor,
        project,
      };
      this.append(entry);
      return { entry, replayed: false };
    });
  }

  remove(body) {
    return this.run(() => {
      this.guard();
      const b = body && typeof body === "object" ? body : {};
      const op = String(b.op || "");
      if (!OP_RE.test(op)) throw new MoneyError("an idempotency key `op` is required");
      const replay = this.byOp.get(op);
      if (replay) {
        if (replay.kind !== "tombstone") throw new MoneyError("that op key was an entry", 409);
        return { target: replay.target, replayed: true };
      }
      const target = String(b.target || "");
      if (!this.entries.has(target)) throw new MoneyError("no such entry", 404);
      if (this.deleted.has(target)) throw new MoneyError("already deleted", 409);
      this.append({ t: "tombstone", id: `m-${crypto.randomBytes(6).toString("hex")}`, op, ts: new Date(this.now()).toISOString(), target });
      return { target, replayed: false };
    });
  }

  /** Visible entries, newest first, capped. */
  visible() {
    this.guard();
    const out = [];
    for (const e of this.entries.values()) {
      if (!this.deleted.has(e.id)) out.push(e);
    }
    out.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    return out.slice(0, VISIBLE_CAP).map((e) => ({
      id: e.id,
      ts: e.ts,
      amountCents: e.amountCents,
      currency: e.currency,
      category: e.category,
      note: e.note || "",
      client: e.client || null,
      vendor: e.vendor || null,
      project: e.project || null,
    }));
  }

  // ---- commitments: what repeats, and what it costs per month ----------------

  /** Add a scheduled repeating payment. Negative cents is money out. */
  addCommitment(body) {
    return this.run(() => {
      this.guard();
      const b = body && typeof body === "object" ? body : {};
      const op = String(b.op || "");
      if (!OP_RE.test(op)) throw new MoneyError("an idempotency key `op` is required");
      const replay = this.byOp.get(op);
      if (replay) {
        if (replay.kind !== "commitment") throw new MoneyError("that op key was not a commitment", 409);
        return { commitment: this.decorate(replay.commitment), replayed: true };
      }
      const cents = b.amountCents;
      if (!Number.isInteger(cents) || cents === 0 || Math.abs(cents) > MAX_ABS_CENTS) {
        throw new MoneyError("amountCents must be a non-zero integer within bounds");
      }
      const currency = String(b.currency || "");
      if (!CURRENCIES.has(currency)) throw new MoneyError("currency must be MXN or USD");
      const category = String(b.category || "");
      if (!CATEGORY_RE.test(category)) throw new MoneyError("category must be a short lowercase slug");
      const cadence = String(b.cadence || "");
      if (!Object.prototype.hasOwnProperty.call(CADENCES, cadence)) {
        throw new MoneyError(`cadence must be one of ${Object.keys(CADENCES).join(", ")}`);
      }
      const startsOn = realDate(b.startsOn);
      if (!startsOn) throw new MoneyError("startsOn must be a real yyyy-mm-dd date");
      const endsOn = b.endsOn == null || b.endsOn === "" ? null : realDate(b.endsOn);
      if (b.endsOn != null && b.endsOn !== "" && !endsOn) {
        throw new MoneyError("endsOn must be a real yyyy-mm-dd date, or left empty");
      }
      if (endsOn !== null && endsOn < startsOn) throw new MoneyError("endsOn cannot precede startsOn");
      let client, vendor, project;
      try {
        client = optSlug(b.client, "client");
        vendor = optSlug(b.vendor, "vendor");
        project = optSlug(b.project, "project");
      } catch (e) {
        throw new MoneyError(`${String(e && e.message)}: use a short lowercase slug`);
      }
      const commitment = {
        t: "commitment",
        id: `m-${crypto.randomBytes(6).toString("hex")}`,
        op,
        ts: new Date(this.now()).toISOString(),
        label: String(b.label == null ? "" : b.label).slice(0, 120),
        amountCents: cents,
        currency,
        category,
        cadence,
        startsOn,
        endsOn,
        client,
        vendor,
        project,
      };
      this.append(commitment);
      return { commitment: this.decorate(commitment), replayed: false };
    });
  }

  /** Cancel a commitment. The record stays on disk; it stops counting. */
  cancelCommitment(body) {
    return this.run(() => {
      this.guard();
      const b = body && typeof body === "object" ? body : {};
      const op = String(b.op || "");
      if (!OP_RE.test(op)) throw new MoneyError("an idempotency key `op` is required");
      const replay = this.byOp.get(op);
      if (replay) {
        if (replay.kind !== "commitment-tombstone") throw new MoneyError("that op key was not a cancellation", 409);
        return { target: replay.target, replayed: true };
      }
      const target = String(b.target || "");
      if (!this.commitments.has(target)) throw new MoneyError("no such commitment", 404);
      if (this.cancelled.has(target)) throw new MoneyError("already cancelled", 409);
      this.append({
        t: "commitment-tombstone",
        id: `m-${crypto.randomBytes(6).toString("hex")}`,
        op,
        ts: new Date(this.now()).toISOString(),
        target,
      });
      return { target, replayed: false };
    });
  }

  /**
   * Book every due occurrence of every live commitment as a real entry, once.
   *
   * the owner, 2026-09-30: a salary or subscription that is due counts as money
   * moved without him typing it in; an occurrence that did not happen is
   * deleted by hand. The op key `auto.<commitment>.<due date>` makes each
   * occurrence write at most once for good: byOp keeps an op after its entry is
   * tombstoned, so a deleted occurrence is never re-posted. The entry's ts is
   * the due date (noon UTC), not the write time, so a backfill lands in the
   * months it belongs to. A cancelled commitment posts nothing more; what it
   * already posted stays, and one cancelled before this existed never posts.
   * @returns {Promise<number>} entries written
   */
  postDue() {
    return this.run(() => {
      if (this.readOnly || this.corrupt) return 0;
      const today = this.today();
      let posted = 0;
      for (const c of this.commitments.values()) {
        if (this.cancelled.has(c.id)) continue;
        // ponytail: a cap so a mistyped decades-old start cannot write thousands
        // of lines in one pass; the rest posts on later passes, 400 at a time.
        let n = 0;
        for (let due = nextDue(c, c.startsOn); due && due <= today && n < 400; due = nextDue(c, dayAfter(due))) {
          const op = `auto.${c.id}.${due}`;
          if (this.byOp.has(op)) continue;
          this.append({
            t: "entry",
            id: `m-${crypto.randomBytes(6).toString("hex")}`,
            op,
            ts: `${due}T12:00:00.000Z`,
            amountCents: c.amountCents,
            currency: c.currency,
            category: c.category,
            note: `auto: ${c.label || c.category}`.slice(0, 500),
            client: c.client || null,
            vendor: c.vendor || null,
            project: c.project || null,
          });
          posted++;
          n++;
        }
      }
      if (posted) this.log(`money: auto-posted ${posted} due commitment entr${posted === 1 ? "y" : "ies"}`);
      return posted;
    });
  }

  /** A commitment plus the two things every view of it wants. */
  decorate(c, today = this.today()) {
    return {
      id: c.id,
      label: c.label || "",
      amountCents: c.amountCents,
      currency: c.currency,
      category: c.category,
      cadence: c.cadence,
      startsOn: c.startsOn,
      endsOn: c.endsOn,
      client: c.client || null,
      vendor: c.vendor || null,
      project: c.project || null,
      monthlyCents: monthlyCents(c),
      nextDueOn: nextDue(c, today),
    };
  }

  /** Today, once per call, so every view in one response agrees on the date. */
  today() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /**
   * Is this commitment still running? One definition, used by every view.
   *
   * Cancelled is not the only way to stop: a commitment past its endsOn has no
   * next date and is finished. Three views used to answer this question three
   * ways, so the run rate could exclude a record that the client rollup still
   * counted and the card still called live.
   */
  isLive(c, today) {
    if (this.cancelled.has(c.id)) return false;
    return nextDue(c, today) !== null;
  }

  /** Live commitments, soonest due first. Ended and cancelled ones are not live. */
  liveCommitments() {
    this.guard();
    const today = this.today();
    const out = [];
    for (const c of this.commitments.values()) {
      if (!this.isLive(c, today)) continue;
      out.push(this.decorate(c, today));
    }
    out.sort((a, b) => {
      if (a.nextDueOn && b.nextDueOn && a.nextDueOn !== b.nextDueOn) return a.nextDueOn < b.nextDueOn ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    return out;
  }

  /**
   * The committed monthly position, per currency and never across them.
   *
   * This is a FORECAST, built only from commitments. It deliberately does not
   * touch the entries: what actually moved and what is scheduled to move are
   * different questions, and adding them together is how a projection ends up
   * being reported as a balance.
   */
  runRate() {
    this.guard();
    const today = this.today();
    const acc = new Map();
    for (const c of this.commitments.values()) {
      if (!this.isLive(c, today)) continue;
      const row = acc.get(c.currency) || { currency: c.currency, inRaw: 0, outRaw: 0, count: 0 };
      // Accumulate the UNROUNDED annual figure and round once at the end. Rounding
      // each record first loses up to half a cent per commitment in the same
      // direction: twelve yearly items of one cent each would each round to zero
      // and report a portfolio that costs nothing.
      const perYear = c.amountCents * CADENCES[c.cadence].perYear;
      // Same sign convention as an entry: positive is a cost, negative is income.
      if (perYear > 0) row.outRaw += perYear;
      else row.inRaw += -perYear;
      row.count += 1;
      acc.set(c.currency, row);
    }
    return [...acc.values()]
      .map((row) => {
        const inCents = Math.round(row.inRaw / 12);
        const outCents = Math.round(row.outRaw / 12);
        return { currency: row.currency, inCents, outCents, netCents: inCents - outCents, count: row.count };
      })
      .sort((a, b) => a.currency.localeCompare(b.currency));
  }

  /**
   * What each client is worth, and what each client has cost in agent effort.
   *
   * The client-to-project mapping is not configured anywhere: it EMERGES from the
   * ledger. Tagging a payment with both a client and a project is what teaches the
   * console that the two belong together, so there is no second file to keep in
   * step with reality, and a client with no projects tagged simply reports none.
   *
   * @param {(project: string) => {tokens: number, sessions: number}} effortFor
   */
  clients(effortFor = null) {
    this.guard();
    const acc = new Map();
    const touch = (name) => {
      let row = acc.get(name);
      if (!row) {
        row = { client: name, currencies: new Map(), projects: new Set(), commitmentCount: 0 };
        acc.set(name, row);
      }
      return row;
    };
    const money = (row, currency) => {
      let c = row.currencies.get(currency);
      if (!c) {
        c = { currency, inCents: 0, outCents: 0, monthlyCents: 0 };
        row.currencies.set(currency, c);
      }
      return c;
    };

    for (const e of this.entries.values()) {
      if (this.deleted.has(e.id) || !e.client) continue;
      const row = touch(e.client);
      const c = money(row, e.currency);
      // positive is a cost against this client, negative is what they paid
      if (e.amountCents > 0) c.outCents += e.amountCents;
      else c.inCents += -e.amountCents;
      if (e.project) row.projects.add(e.project);
    }
    const today = this.today();
    for (const cm of this.commitments.values()) {
      // The SAME liveness rule the run rate uses, against the same captured date,
      // so two views of the same ledger can never disagree about what is running.
      if (!this.isLive(cm, today) || !cm.client) continue;
      const row = touch(cm.client);
      money(row, cm.currency).monthlyCents += monthlyCents(cm);
      if (cm.project) row.projects.add(cm.project);
      row.commitmentCount += 1;
    }

    return [...acc.values()]
      .map((row) => {
        const projects = [...row.projects].sort();
        // Effort is summed over the projects this client is tagged against. A
        // project shared by two clients is counted for both on purpose: the
        // console cannot know how to split it, and silently halving it would be
        // an invented number.
        let tokens = 0;
        let sessions = 0;
        if (effortFor) {
          for (const project of projects) {
            const e = effortFor(project) || { tokens: 0, sessions: 0 };
            tokens += Number(e.tokens) || 0;
            sessions += Number(e.sessions) || 0;
          }
        }
        return {
          client: row.client,
          projects,
          commitmentCount: row.commitmentCount,
          tokens,
          sessions,
          money: [...row.currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
        };
      })
      .sort((a, b) => a.client.localeCompare(b.client));
  }

  /**
   * What money actually moved, per currency, split by direction.
   *
   * SIGN CONVENTION, and it is the ledger's, not a new one: a POSITIVE amount is
   * money going out (a cost), a NEGATIVE amount is money coming in (revenue or a
   * refund). That reads backwards written down, but it is what every entry
   * already on disk means, and re-interpreting stored rows would silently invert
   * every historical figure. So the sign is left alone and the direction is
   * named here instead, where a reader can see it.
   */
  flows() {
    this.guard();
    const acc = new Map();
    for (const e of this.entries.values()) {
      if (this.deleted.has(e.id)) continue;
      const row = acc.get(e.currency) || { currency: e.currency, inCents: 0, outCents: 0, netCents: 0 };
      if (e.amountCents > 0) row.outCents += e.amountCents;
      else row.inCents += -e.amountCents;
      acc.set(e.currency, row);
    }
    for (const row of acc.values()) row.netCents = row.inCents - row.outCents;
    return [...acc.values()].sort((a, b) => a.currency.localeCompare(b.currency));
  }

  /** Per-currency, per-month sums over ALL visible entries (never combined). */
  totals() {
    this.guard();
    const acc = new Map();
    for (const e of this.entries.values()) {
      if (this.deleted.has(e.id)) continue;
      const month = String(e.ts || "").slice(0, 7);
      const key = `${month}|${e.currency}`;
      acc.set(key, (acc.get(key) || 0) + e.amountCents);
    }
    return [...acc.entries()]
      .map(([key, cents]) => {
        const [month, currency] = key.split("|");
        return { month, currency, cents };
      })
      .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : a.currency.localeCompare(b.currency)));
  }
}
