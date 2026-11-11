// The Errors tab (bead hq-hsl2.3): incidents the mail poller opened, the live
// fixer pane for the ones still being worked, and a 24 hour volume strip per
// fingerprint.
//
// Where the data comes from. Incidents are one JSON file each under
// ~/hq/state/errors/incidents/<id>.json and the fingerprint counts live in
// ~/hq/state/mail.db. Both belong to owner, and this server runs as hqconsole,
// which never writes into ~/hq (design section 3). So reading AND resolving go
// through the wrapper verb `errors` (runner/errors-verbs.py, run as owner),
// exactly like every other collector. The helper hands back the files as raw
// text; parsing, tolerance and the shape the browser sees are decided here, so
// they are tested in one place (test/errors.test.js).
//
// Fixer panes. A fixer runs in a tmux window of the "hq-errors" session on
// owner's default tmux server. The helper resolves the incident's
// fixer.tmux_target to a pane id (%N); the browser then attaches that pane over
// the ordinary term.* WebSocket path, and hq-runner adopts it read-only the same
// way it adopts any spawn.sh pane. The term handlers only serve sids they can
// account for, so termRecord() below vouches for exactly the panes of incidents
// that are fixing right now. These panes never enter the sessions slice, which
// is why they do not show on the Terminals tab.

// "watching" (coordinator, 2026-10-19): recorded, no fixer launched yet (below a
// per-type threshold, or a no-spawn type such as a transient fetch failure).
export const STATUSES = ["escalated", "fixing", "watching", "fixed", "logged", "resolved"];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PANE_RE = /^%[0-9]+$/;
const BODY_MAX = 8000;

/** A bounded string, or null. */
function str(v, max = 500) {
  if (v === undefined || v === null) return null;
  if (typeof v === "object" || typeof v === "function") throw new TypeError("expected text, got an object");
  const s = String(v);
  return s.length ? s.slice(0, max) : null;
}

/** Epoch seconds from a float, an int, or an ISO string; null when it is
 *  neither or when it is outside what a Date can show (0 < ts < 1e11). */
const TS_MAX = 1e11;
function ts(v) {
  const ok = (n) => (Number.isFinite(n) && n > 0 && n < TS_MAX ? n : null);
  if (typeof v === "number") return ok(v);
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return ok(n);
    const d = Date.parse(v);
    if (Number.isFinite(d)) return ok(d / 1000);
  }
  return null;
}

function int(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);

function normFixer(v) {
  const f = obj(v);
  if (!f) return null;
  return {
    tmuxTarget: str(f.tmux_target, 200),
    tmuxSocket: str(f.tmux_socket, 64),
    promptPath: str(f.prompt_path, 400),
    logPath: str(f.log_path, 400),
    startedTs: ts(f.started_ts),
    endedTs: ts(f.ended_ts),
    rc: rcOf(f.rc),
    tmuxWindowId: str(f.tmux_window_id, 32),
  };
}

function rcOf(v) {
  return v === undefined || v === null || typeof v === "object" || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v));
}

/** policy may be a string or a small object from the mail side; shown as the watching reason. */
function policyText(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object") return str(v, 300);
  const o = obj(v);
  if (!o) return null;
  const pick = o.reason ?? o.why ?? o.name ?? o.kind ?? null;
  if (pick !== null && typeof pick !== "object") return str(pick, 300);
  try {
    return JSON.stringify(o).slice(0, 300);
  } catch {
    return null;
  }
}

/** True when any outbox item is still waiting to be mailed (done false). */
function mailPending(v) {
  if (!Array.isArray(v)) return false;
  return v.some((x) => obj(x) && x.done === false);
}

function normResult(v) {
  const r = obj(v);
  if (!r) return null;
  const marker = String(r.marker || "NONE").toUpperCase();
  return {
    marker: ["FIXED", "ESCALATE", "NONE"].includes(marker) ? marker : "NONE",
    summary: str(r.summary, 4000),
    receipt: str(r.receipt, 1000),
    rc: rcOf(r.rc),
  };
}

function normPane(v) {
  const p = obj(v);
  if (!p) return null;
  const id = PANE_RE.test(String(p.id || "")) ? String(p.id) : null;
  return {
    id,
    target: str(p.target, 200),
    socket: str(p.socket, 64),
    alive: Boolean(p.alive),
    attachable: Boolean(p.attachable) && id !== null,
    reason: str(p.reason, 200),
  };
}

/**
 * One incident file's parsed JSON, shaped for the browser. Unknown fields are
 * dropped, missing optional ones become null, and a status outside the contract
 * is kept visible as "unknown" rather than guessed into a group.
 */
export function normalizeIncident(raw, file, mtime, pane) {
  const o = obj(raw);
  if (!o) return null;
  // The id is the FILE's name: it is what resolve and pane authorization use.
  // An embedded id that disagrees makes the record malformed, never a second id.
  const id = String(file || "").replace(/\.json$/, "");
  if (!ID_RE.test(id)) return null;
  if (o.id !== undefined && o.id !== id) throw new TypeError(`embedded id does not match the file name ${id}`);
  const rawStatus = (str(o.status, 40) || "").toLowerCase();
  const status = STATUSES.includes(rawStatus) ? rawStatus : "unknown";
  return {
    id,
    fp: str(o.fp, 200),
    project: str(o.project, 120),
    title: str(o.title, 300) || "(untitled)",
    host: str(o.host, 120),
    openedTs: ts(o.opened_ts) ?? (Number.isFinite(mtime) ? mtime : null),
    updatedTs: ts(o.updated_ts),
    status,
    rawStatus: status === "unknown" ? str(o.status, 40) : null,
    repeats: int(o.repeats),
    lastRepeatTs: ts(o.last_repeat_ts),
    mid: str(o.mid, 300),
    body: str(o.body, BODY_MAX),
    fixer: normFixer(o.fixer),
    result: normResult(o.result),
    bead: str(o.bead, 64),
    note: str(o.note, 2000),
    resolvedTs: ts(o.resolved_ts),
    // optional fields from the mail side (coordinator, review round 1)
    mailPending: mailPending(o.outbox),
    conditionSinceTs: ts(o.condition_since),
    lastSeenTs: ts(o.last_seen_ts),
    loopdeadAlertTs: ts(o.loopdead_alert_ts),
    policy: policyText(o.policy),
    pane: status === "fixing" ? normPane(pane) : null,
  };
}

function normVolume(v) {
  const o = obj(v);
  if (!o) return { source: "none", since: null, hours: 24, fps: [], error: null };
  const hours = int(o.hours) || 24;
  const fps = (Array.isArray(o.fps) ? o.fps : [])
    .map((r) => obj(r))
    .filter((r) => r && r.fp)
    .slice(0, 40)
    .map((r) => ({
      fp: String(r.fp).slice(0, 200),
      project: str(r.project, 120),
      title: str(r.title, 300),
      total: r.total === null || r.total === undefined ? null : int(r.total),
      buckets: Array.isArray(r.buckets) ? r.buckets.slice(0, hours).map(int) : null,
      lastTs: ts(r.last_ts),
      count: r.count === null || r.count === undefined ? null : int(r.count),
    }));
  const source = ["fp_events", "fps", "none"].includes(o.source) ? o.source : "none";
  return { source, since: ts(o.since), hours, fps, error: str(o.error, 300) };
}

/**
 * The helper's raw list output -> the `errors` slice.
 * Malformed files are reported, never fatal: one bad write must not blank the tab.
 */
export function buildReport(raw, now = Date.now()) {
  const r = obj(raw) || {};
  const panes = obj(r.panes) || {};
  const incidents = [];
  const malformed = [];
  for (const rec of Array.isArray(r.incidents) ? r.incidents : []) {
    const row = obj(rec);
    if (!row) continue;
    const file = String(row.file || "?").slice(0, 200);
    if (row.error) {
      malformed.push({ file, error: String(row.error).slice(0, 200) });
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(String(row.text ?? ""));
    } catch (e) {
      malformed.push({ file, error: `not JSON: ${String(e && e.message).slice(0, 120)}` });
      continue;
    }
    const mtime = Number(row.mtime);
    const idGuess = file.replace(/\.json$/, "");
    let inc;
    try {
      inc = normalizeIncident(parsed, file, mtime, panes[idGuess]);
    } catch (e) {
      // valid JSON with a field of the wrong type: this one file is malformed,
      // the rest of the report still renders
      malformed.push({ file, error: `bad field: ${String((e && e.message) || e).slice(0, 120)}` });
      continue;
    }
    if (!inc) {
      malformed.push({ file, error: "not an incident object" });
      continue;
    }
    incidents.push(inc);
  }
  incidents.sort((a, b) => (b.openedTs ?? 0) - (a.openedTs ?? 0));
  const counts = { escalated: 0, fixing: 0, watching: 0, fixed: 0, logged: 0, resolved: 0, unknown: 0 };
  for (const i of incidents) counts[i.status] += 1;
  return {
    generatedAt: new Date(now).toISOString(),
    dir: r.dir === "missing" ? "missing" : r.dir ? String(r.dir).slice(0, 200) : "ok",
    incidents,
    malformed,
    // history the helper's cap dropped (actionable incidents are never capped)
    omitted: int(r.omitted),
    counts,
    volume: normVolume(r.volume),
  };
}

/** Parse the first JSON object out of a wrapper's stdout. */
function firstObject(stdout) {
  const s = String(stdout || "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    const line = s.split("\n").find((l) => l.trim().startsWith("{"));
    try {
      return line ? JSON.parse(line) : null;
    } catch {
      return null;
    }
  }
}

/** The production source: everything through the owner wrapper. */
export function wrapperSource(wrapper) {
  return {
    async list() {
      const r = await wrapper.call("errors", ["list"], { timeout: 20000 });
      if (r.code !== 0) throw new Error(`errors list exit ${r.code}: ${String(r.stderr || "").trim().slice(-160)}`);
      const j = firstObject(r.stdout);
      if (!j) throw new Error("errors list: no JSON payload");
      return j;
    },
    async resolve(id) {
      // the helper may wait up to 30 s for the mail automation's lock
      const r = await wrapper.call("errors", ["resolve", id], { timeout: 45000 });
      return { code: r.code, json: firstObject(r.stdout), stderr: String(r.stderr || "").trim().slice(-200) };
    },
  };
}

/** A source that answers "nothing yet": for tests built on fake collector sources. */
export function emptySource() {
  return {
    async list() {
      return { dir: "missing", incidents: [], panes: {}, volume: null };
    },
    async resolve() {
      return { code: 4, json: null, stderr: "no such incident" };
    },
  };
}

const RESOLVE_STATUS = { 0: 200, 2: 400, 4: 404, 5: 422, 6: 409, 8: 503 };

/**
 * Register the `errors` collector and return the route and term hooks.
 * @param {{collectors: any, wrapper?: any, source?: any, log?: Function, ttlS?: number}} o
 */
export function createErrors(o) {
  const collectors = o.collectors;
  const source = o.source || wrapperSource(o.wrapper);
  const log = o.log || (() => {});
  collectors.register("errors", o.ttlS || 10, async () => buildReport(await source.list()));

  function current() {
    const v = collectors.peek ? collectors.peek("errors") : null;
    return v && Array.isArray(v.incidents) ? v : null;
  }

  return {
    source,
    /**
     * The session record the term handlers need before they let a browser attach
     * a sid that is not in the sessions slice: only the pane of an incident that
     * is fixing now, and always read-only (the runner adopts tmux panes read-only
     * by default too; this refuses input before it gets that far).
     */
    termRecord(sid) {
      const s = String(sid || "");
      if (!PANE_RE.test(s)) return null;
      const rep = current();
      if (!rep) return null;
      const inc = rep.incidents.find((i) => i.status === "fixing" && i.pane && i.pane.attachable && i.pane.id === s);
      if (!inc) return null;
      return { id: s, kind: "tmux", runner: "tmux", attachable: true, writable: false, incident: inc.id };
    },
    /** Awaited variant for the handler's cache-miss path. */
    async termRecordFresh(sid) {
      try {
        await collectors.refresh("errors");
      } catch {
        /* a failed refresh leaves the cache as it was */
      }
      return this.termRecord(sid);
    },
    /**
     * POST routes. Returns true when the url was ours. The caller has already
     * done the Origin and CSRF checks every POST gets (the money routes' gate).
     */
    async route(url, body, send) {
      const m = url.match(/^\/api\/errors\/([^/]{1,128})\/resolve$/);
      if (!m) return false;
      let id = "";
      try {
        id = decodeURIComponent(m[1]);
      } catch {
        id = ""; // a bad %-escape is a bad id, not a server error
      }
      if (!ID_RE.test(id)) {
        send(400, { error: "bad incident id" });
        return true;
      }
      let r;
      try {
        r = await source.resolve(id);
      } catch (e) {
        log(`errors resolve ${id} failed: ${String(e && e.message)}`);
        send(502, { error: "resolve failed" });
        return true;
      }
      const status = RESOLVE_STATUS[r.code] || 502;
      collectors.refresh("errors").catch(() => {});
      if (status === 200 || status === 409) {
        send(status, r.json || { ok: true, id, status: "resolved" });
      } else {
        send(status, { error: r.stderr || `resolve exit ${r.code}` });
      }
      return true;
    },
  };
}
