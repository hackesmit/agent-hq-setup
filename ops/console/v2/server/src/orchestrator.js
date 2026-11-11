// Orchestrator panels on the Now page (bead hq-4npjr.5, design
// docs/designs/2026-11-04-orchestrator.md section 4, mockup board F).
//
// Three files, each written by someone else and validated again here:
//   state/orchestrator/approved.jsonl   the orchestrator's decision log, one JSON line per
//                                       decision: {ts, kind, text, why, bead?, rig?}
//   state/orchestrator/events.jsonl     the event queue the runner works (hq-4npjr.2); only
//                                       counted here, for "events today"
//   state/console/project-updates.json  {<rig>: {at, text}}, one line per project the
//                                       orchestrator writes after each merge or block
// and one this server owns:
//   <inbox>/orchestrator-loaded.json    files the owner dropped for the orchestrator to read on
//                                       its next wake. It sits in the inbox tree because the
//                                       server (hqconsole) can write there and owner can
//                                       read it; ~/hq/state is the other way round.
import fs from "node:fs";
import path from "node:path";

export const APPROVED_KINDS = Object.freeze(["merge", "review", "answer", "snooze", "wake", "dispatch", "forward", "fix", "block"]);
const TAIL_BYTES = 256 * 1024;
const TEXT = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n) : "");
const ID = (v) => (typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v) ? v : null);

/** The last TAIL_BYTES of a file as lines, dropping a partial first line. "" when absent. */
function tailLines(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Local midnight before `nowMs`, the start of "today" for the counters. */
export function startOfDay(nowMs) {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Newest-first decisions, at most `limit`, plus how many fall today. */
export function readApproved(stateDir, nowMs = Date.now(), limit = 30) {
  const lines = tailLines(path.join(stateDir, "orchestrator", "approved.jsonl")) || [];
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;
    const ts = TEXT(o.ts, 40);
    const at = Date.parse(ts);
    if (!Number.isFinite(at)) continue;
    const kind = APPROVED_KINDS.includes(o.kind) ? o.kind : null;
    const text = TEXT(o.text, 240);
    if (!kind || !text) continue;
    rows.push({ ts: new Date(at).toISOString(), at, kind, text, why: TEXT(o.why, 240) || null, bead: ID(o.bead), rig: ID(o.rig) });
  }
  rows.sort((a, b) => b.at - a.at);
  const since = startOfDay(nowMs);
  const today = rows.filter((r) => r.at >= since).length;
  return { rows: rows.slice(0, limit).map(({ at, ...r }) => r), today };
}

/** Events the runner received today, or null when there is no event file yet. */
export function countEventsToday(stateDir, nowMs = Date.now()) {
  const lines = tailLines(path.join(stateDir, "orchestrator", "events.jsonl"));
  if (lines === null) return null;
  const since = startOfDay(nowMs);
  let n = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const at = Date.parse(JSON.parse(line).ts);
      if (Number.isFinite(at) && at >= since) n += 1;
    } catch {
      /* a torn line is not an event */
    }
  }
  return n;
}

/** {<rig>: {at, text}} from the project update file; bad entries dropped. */
export function readProjectUpdates(stateDir) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(stateDir, "console", "project-updates.json"), "utf8"));
  } catch {
    return {};
  }
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [rig, v] of Object.entries(raw)) {
    if (!ID(rig) || !v || typeof v !== "object") continue;
    const at = Date.parse(TEXT(v.at, 40));
    const text = TEXT(v.text, 240);
    if (!Number.isFinite(at) || !text) continue;
    out[rig] = { at: new Date(at).toISOString(), text };
  }
  return out;
}

/**
 * The loaded-files list. Entries name committed uploads by id, so the path always
 * comes from the upload store, never from the browser.
 */
export class LoadedFiles {
  constructor(file, now = () => Date.now()) {
    this.file = file;
    this.now = now;
  }

  list() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(raw && raw.files) ? raw.files.filter((f) => f && ID(f.id)) : [];
    } catch {
      return [];
    }
  }

  write(files) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ files }, null, 2)}\n`, { mode: 0o644 });
    fs.renameSync(tmp, this.file);
  }

  /** Add (or refresh) one upload entry; `keptBefore` remembers whether the owner had kept it. */
  add(entry, keptBefore) {
    const all = this.list();
    // A second load of the same upload sees keep=1 set by the first; the first
    // load's keptBefore is the truth, or unload would never clear the keep and the
    // file would escape the retention sweep (review round 1, note 2).
    const prior = all.find((f) => f.id === entry.id);
    if (prior) keptBefore = Boolean(prior.keptBefore);
    const files = all.filter((f) => f.id !== entry.id);
    files.unshift({
      id: entry.id,
      name: TEXT(entry.name, 200),
      path: entry.path,
      ref: entry.ref || null,
      size: Number(entry.size) || 0,
      at: new Date(this.now()).toISOString(),
      keptBefore: Boolean(keptBefore),
    });
    this.write(files);
    return files;
  }

  /** Remove one entry; returns the removed entry or null. */
  remove(id) {
    const files = this.list();
    const gone = files.find((f) => f.id === id) || null;
    if (gone) this.write(files.filter((f) => f.id !== id));
    return gone;
  }
}

/** GET /api/orchestrator */
export function orchestratorReport({ stateDir, loaded, nowMs = Date.now() }) {
  const approved = readApproved(stateDir, nowMs);
  return {
    approved: approved.rows,
    approvedToday: approved.today,
    eventsToday: countEventsToday(stateDir, nowMs),
    updates: readProjectUpdates(stateDir),
    loaded: loaded.list().map(({ id, name, size, at }) => ({ id, name, size, at })),
  };
}

/**
 * POST /api/orchestrator/load {id} and /unload {id}. `uploads` is the upload service
 * (setKeep returns the committed entry); a loaded file is kept so the retention sweep
 * cannot delete it while the orchestrator still needs it.
 */
export function loadRoute(url, body, { uploads, loaded }) {
  if (url !== "/api/orchestrator/load" && url !== "/api/orchestrator/unload") return null;
  const id = ID(body && body.id);
  if (!id) return { status: 400, body: { error: "id must be an upload id" } };
  if (url === "/api/orchestrator/load") {
    const row = uploads.store && uploads.store.get ? uploads.store.get(id) : null;
    const keptBefore = Boolean(row && row.keep);
    const r = uploads.setKeep(id, true);
    if (!r.ok) return { status: r.status || 404, body: { error: r.error || "no such upload" } };
    loaded.add(r.entry, keptBefore);
    return { status: 200, body: { ok: true, id } };
  }
  const gone = loaded.remove(id);
  if (!gone) return { status: 404, body: { error: "not loaded" } };
  // Only undo a keep this list set; a file the owner kept himself stays kept.
  if (!gone.keptBefore) uploads.setKeep(id, false);
  return { status: 200, body: { ok: true, id } };
}

// ---- the orchestrator chat terminal (bead hq-4npjr.11) ----------------------
//
// POST /api/session/new {role: "orchestrator"} starts the one terminal the owner talks
// to. Its model is the "decide" role in ops/config/orchestrator.json (Fable 5.2 since
// 2026-11-10), read at every start so a config change needs no deploy. The role seed
// stays in ops/templates/orchestrator.md: the terminal reads it there, so the file
// is the one source and a restarted orchestrator picks up the current text.

const MODEL_RE = /^claude-[a-z0-9][a-z0-9.-]{0,63}$/;

/** The decide-role model from ops/config/orchestrator.json, or null when unreadable. */
export function chatModel(hqRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(hqRoot, "ops", "config", "orchestrator.json"), "utf8"));
    const m = raw && raw.models && raw.models.decide;
    return typeof m === "string" && MODEL_RE.test(m) ? m : null;
  } catch {
    return null;
  }
}

/** The first prompt of the orchestrator chat terminal. */
export function orchestratorSeed(hqRoot) {
  const ctl = `${hqRoot}/ops/console/ctl.sh`;
  return (
    "You are the HQ orchestrator chat terminal the owner started from the console Now page; your session id is in the HQ_CONSOLE_SID env var. " +
    `First read ${hqRoot}/ops/templates/orchestrator.md: it is your role seed, and you are its Chat terminal form. ` +
    `The console already named your card orchestrator; if the card ever shows another name, run \`${ctl} name $(${ctl} whoami) orchestrator\`. Never rename it to anything else. ` +
    "Whenever you need the owner's input (a business, taste or unknowable call), ask it here in this terminal and wait for him: " +
    `first run \`${ctl} ask "<question>"\` without --wait (for a choice, spell out the numbered options inside the question and pass --kind decide); it prints a request id and marks your card as waiting. ` +
    "Then put the same question in your reply and end your turn. " +
    `When he answers here, run \`${ctl} answer <req-id> --here "<his answer>"\` to clear the waiting mark, then continue. ` +
    "An answer he sends from the card arrives typed into this terminal as \"[HQ console] the owner answered ...\"; it is already recorded, so just continue. " +
    "Then compile status from the ledger and the orchestrator files (state/orchestrator/), greet the owner in two lines, and await his word."
  );
}
