// The activity stream: merges, commits, dispatches, finishes, snoozes,
// asks/answers, captures and error reports in one filterable list (design
// section 4.1 item 2). Phase 1 folds the v1 Operations and Recent-changes
// panels into this slice; nothing else in the console shows raw op records.
//
// Every source is defensive: a rig without git, an unreadable op record or a
// missing ops directory each drop their own events, never the stream.

import fs from "node:fs";
import path from "node:path";

export const ACTIVITY_CAP = 200;
const OPS_SCAN = 120;
const TITLE_MAX = 200;

const VERB_TYPE = {
  dispatch: "dispatch",
  "dispatch-batch": "dispatch",
  finish: "finish",
  snooze: "snooze",
  "req-snooze": "snooze",
  answer: "answer",
  done: "answer",
  skip: "answer",
  resolve: "answer",
  capture: "capture",
};

const one = (s, max = TITLE_MAX) =>
  String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max);

/** Op records (actions.js) -> events. Failed ops surface as P2. */
export function activityFromOps(recs) {
  const out = [];
  for (const rec of Array.isArray(recs) ? recs : []) {
    if (!rec || !rec.id || !rec.verb) continue;
    const ts = rec.finishedAt || rec.startedAt;
    if (!ts) continue;
    const meta = rec.meta && typeof rec.meta === "object" ? rec.meta : {};
    const failed = rec.state === "failed";
    const subject = [meta.bead || meta.beads, meta.rig && `on ${meta.rig}`, meta.session && `session ${meta.session}`]
      .filter(Boolean)
      .join(" ");
    out.push({
      id: `op-${rec.id}`,
      ts,
      type: VERB_TYPE[rec.verb] || "op",
      rig: meta.rig || null,
      session: meta.session || null,
      bead: meta.bead || null,
      title: one(`${failed ? "failed: " : ""}${rec.verb}${subject ? " " + subject : ""}`),
      detail: failed ? one(rec.error, 300) || null : null,
      sev: failed ? "P2" : null,
    });
  }
  return out;
}

/**
 * One rig's `git-log` wrapper output -> events.
 * Lines are `%H<TAB>%ct<TAB>%an<TAB>%s`; the subject may contain further tabs.
 */
export function activityFromGit(rigId, stdout) {
  const out = [];
  for (const line of String(stdout || "").split("\n")) {
    if (!line.trim()) continue;
    const [sha, ct, author, ...rest] = line.split("\t");
    const seconds = Number(ct);
    if (!sha || !Number.isFinite(seconds)) continue;
    const subject = rest.join("\t");
    out.push({
      id: `git-${rigId}-${sha.slice(0, 12)}`,
      ts: new Date(seconds * 1000).toISOString(),
      type: /^merge\b/i.test(subject) ? "merge" : "commit",
      rig: rigId,
      session: null,
      bead: null,
      title: one(subject) || sha.slice(0, 12),
      detail: one(author, 80) || null,
      sev: null,
    });
  }
  return out;
}

/** Requests (map.js mapRequests) -> an ask event, plus an answer event once settled. */
export function activityFromRequests(requests) {
  const out = [];
  for (const r of Array.isArray(requests) ? requests : []) {
    if (!r || !r.id) continue;
    if (r.createdAt) {
      out.push({
        id: `ask-${r.id}`,
        ts: r.createdAt,
        type: "ask",
        rig: r.rig || null,
        session: r.session || null,
        bead: r.bead || null,
        title: one(r.question) || `${r.kind || "ask"} request`,
        detail: null,
        sev: r.severity || null,
      });
    }
    if (r.settledAt && (r.state === "answered" || r.state === "delivered" || r.state === "resolved")) {
      out.push({
        id: `answer-${r.id}`,
        ts: r.settledAt,
        type: "answer",
        rig: r.rig || null,
        session: r.session || null,
        bead: r.bead || null,
        title: r.state === "resolved" ? "resolved" : one(r.answer) || "answered",
        detail: one(r.question, 120) || null,
        sev: null,
      });
    }
  }
  return out;
}

/** Alerts -> error events. */
export function activityFromAlerts(alerts) {
  const out = [];
  for (const a of Array.isArray(alerts) ? alerts : []) {
    if (!a || !a.id || !a.createdAt) continue;
    out.push({
      id: `alert-${a.id}`,
      ts: a.createdAt,
      type: "error",
      rig: null,
      session: null,
      bead: null,
      title: one(a.title) || a.source || "alert",
      detail: one(a.detail, 300) || null,
      sev: a.severity || "P2",
    });
  }
  return out;
}

/** Flatten, dedupe by id (first wins), newest first, cap. */
export function mergeActivity(lists, cap = ACTIVITY_CAP) {
  const seen = new Set();
  const all = [];
  for (const list of lists) {
    for (const ev of Array.isArray(list) ? list : []) {
      if (!ev || !ev.id || !ev.ts || seen.has(ev.id)) continue;
      if (!Number.isFinite(Date.parse(ev.ts))) continue;
      seen.add(ev.id);
      all.push(ev);
    }
  }
  all.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts) || (a.id < b.id ? -1 : 1));
  return all.slice(0, cap);
}

/** The newest op records on disk, unreadable ones skipped. */
export function readOpsDir(dir, scan = OPS_SCAN) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const withTimes = [];
  for (const f of names) {
    try {
      withTimes.push({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs });
    } catch {
      /* raced with a writer */
    }
  }
  withTimes.sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const { f } of withTimes.slice(0, scan)) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
    } catch {
      /* half-written or junk */
    }
  }
  return out;
}
