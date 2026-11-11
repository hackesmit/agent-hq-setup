// Sticky notes: the console's own scratch surface (the owner, 2026-08-20).
//
// Notes are pinned anywhere on the screen, keep their place, and survive the tab, the
// browser and the box. They live in the console's OWN state tree (hqconsole-writable,
// no wrapper) as one small JSON document rather than a JSONL: a note is edited and
// moved constantly, so the interesting state is the CURRENT set, not the history of
// keystrokes. The whole file is rewritten atomically on every change, which is fine at
// this size and removes a whole class of torn-record problems.
//
// Position is stored as a FRACTION of the viewport, not pixels: the owner reads this
// console on a desktop, a laptop and a phone, and a note pinned at x=1840 would be off
// the screen on two of them. Fractions land in roughly the same visual place everywhere.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const NOTE_COLORS = ["amber", "green", "blue", "pink", "slate"];
const ID_RE = /^n-[0-9a-f]{12}$/;
const MAX_NOTES = 200;
const MAX_TEXT = 4000;

export class NotesError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function clamp01(v, fallback) {
  // null, undefined and "" mean "not given", so they take the fallback. Number(null)
  // is 0, which would silently pin the note to the top-left corner instead.
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** Validate an on-disk record with the same rules as a fresh write. */
function validate(rec) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  if (!ID_RE.test(rec.id)) return null;
  const text = typeof rec.text === "string" ? rec.text.slice(0, MAX_TEXT) : "";
  const color = NOTE_COLORS.includes(rec.color) ? rec.color : NOTE_COLORS[0];
  return {
    id: rec.id,
    text,
    color,
    x: clamp01(rec.x, 0.5),
    y: clamp01(rec.y, 0.3),
    w: Math.min(600, Math.max(140, Number(rec.w) || 220)),
    h: Math.min(600, Math.max(120, Number(rec.h) || 170)),
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : new Date().toISOString(),
    updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : new Date().toISOString(),
  };
}

export class Notes {
  /** @param {{file: string, readOnly?: boolean, log?: Function, now?: Function}} o */
  constructor(o) {
    this.file = o.file;
    this.readOnly = Boolean(o.readOnly);
    this.log = o.log || (() => {});
    this.now = o.now || (() => Date.now());
    /** @type {Map<string, any>} */
    this.notes = new Map();
    this.loaded = false;
  }

  load() {
    this.loaded = true;
    let raw;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return this;
    }
    try {
      const j = JSON.parse(raw);
      const list = Array.isArray(j && j.notes) ? j.notes : [];
      for (const rec of list) {
        const clean = validate(rec);
        // A note that cannot be validated is dropped rather than shown wrong: it is a
        // scratch note, and a garbled one on screen is worse than a missing one.
        if (clean) this.notes.set(clean.id, clean);
      }
    } catch (e) {
      this.log(`notes file unreadable, starting empty: ${String(e && e.message)}`);
    }
    return this;
  }

  save() {
    if (this.readOnly) return false;
    const body = JSON.stringify({ version: 1, notes: [...this.notes.values()] }, null, 1) + "\n";
    const tmp = `${this.file}.tmp.${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o750 });
      const fd = fs.openSync(tmp, "w", 0o640);
      try {
        fs.writeFileSync(fd, body);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
      return true;
    } catch (e) {
      this.log(`could not persist notes: ${String(e && e.message)}`);
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* nothing staged */
      }
      throw new NotesError("could not persist the note", 500);
    }
  }

  list() {
    return [...this.notes.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  create(body = {}) {
    if (this.readOnly) throw new NotesError("read-only", 503);
    if (this.notes.size >= MAX_NOTES) throw new NotesError(`too many notes (max ${MAX_NOTES})`, 409);
    const at = new Date(this.now()).toISOString();
    const note = validate({
      id: `n-${crypto.randomBytes(6).toString("hex")}`,
      text: typeof body.text === "string" ? body.text : "",
      color: body.color,
      x: body.x,
      y: body.y,
      w: body.w,
      h: body.h,
      createdAt: at,
      updatedAt: at,
    });
    if (!note) throw new NotesError("bad note");
    this.notes.set(note.id, note);
    this.save();
    return note;
  }

  /** Patch text, position, size or color. Last write wins: it is a sticky note. */
  update(id, body = {}) {
    if (this.readOnly) throw new NotesError("read-only", 503);
    const cur = this.notes.get(String(id));
    if (!cur) throw new NotesError("no such note", 404);
    const next = validate({
      ...cur,
      text: typeof body.text === "string" ? body.text : cur.text,
      color: body.color === undefined ? cur.color : body.color,
      x: body.x === undefined ? cur.x : body.x,
      y: body.y === undefined ? cur.y : body.y,
      w: body.w === undefined ? cur.w : body.w,
      h: body.h === undefined ? cur.h : body.h,
      updatedAt: new Date(this.now()).toISOString(),
    });
    if (!next) throw new NotesError("bad note");
    this.notes.set(next.id, next);
    this.save();
    return next;
  }

  remove(id) {
    if (this.readOnly) throw new NotesError("read-only", 503);
    const had = this.notes.delete(String(id));
    if (!had) throw new NotesError("no such note", 404);
    this.save();
    return { ok: true, id: String(id) };
  }
}
