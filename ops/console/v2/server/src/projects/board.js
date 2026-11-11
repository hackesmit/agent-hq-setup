// Board: every project on one page, as a checklist. The card grid (collectors.js
// summarize) says how far along a project is; this says WHAT is done and what
// comes next, phrased as items rather than counts, so the owner can read the state
// of twelve projects without opening twelve pages.
//
// No new bd calls: it folds the same ProjectFacts snapshot the projects slice
// already fetched, plus the ready slice, so it refreshes on the same cadence
// and costs nothing extra on the box.

// Same order as the card grid (collectors.js ATTENTION_RANK), restated here so
// this module does not import its own importer.
const ATTENTION_RANK = { "needs-you": 0, blocked: 1, late: 2, ok: 3, quiet: 4 };

/** A project with no epic in motion shows what closed in this window as done. */
export const DONE_WINDOW_DAYS = 14;
/** Checklist rows per side (done / todo) before the card says "and n more". */
export const CHECKLIST_MAX = 12;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * bd names children by dotting the epic id (hq-cczm.5 belongs to hq-cczm), and
 * `bd list --json` does not always carry a parent column, so the id is the
 * parent of record when the row has none.
 * @param {{id: string, parent: string|null}} bead
 */
export function parentOf(bead) {
  if (bead.parent) return bead.parent;
  const dot = bead.id.lastIndexOf(".");
  return dot > 0 ? bead.id.slice(0, dot) : null;
}

/** @param {import("../../../shared/api.js").Bead} b */
function item(b) {
  return {
    id: b.id,
    title: b.title,
    status: b.status,
    priority: b.priority,
    kind: b.type,
    closedAt: b.closedAt || null,
  };
}

/** The card's four counts, from the facts alone. */
export function countsOf(live, closed, nowMs) {
  const counts = { open: 0, inProgress: 0, blocked: 0, closed7d: 0 };
  for (const b of live) {
    if (b.status === "open" || b.status === "deferred") counts.open += 1;
    else if (b.status === "in_progress") counts.inProgress += 1;
    else if (b.status === "blocked") counts.blocked += 1;
  }
  const weekAgo = nowMs - 7 * DAY_MS;
  for (const b of closed) if (b.closedAt && Date.parse(b.closedAt) >= weekAgo) counts.closed7d += 1;
  return counts;
}

const STATUS_RANK = { in_progress: 0, blocked: 1, open: 2, deferred: 3, closed: 4 };

/** Open work first by what is moving, then by priority, then id for a stable list. */
export function todoOrder(a, b) {
  return (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || a.priority - b.priority || a.id.localeCompare(b.id);
}

/** Newest close first; a row with no close date sinks. */
export function doneOrder(a, b) {
  const am = a.closedAt ? Date.parse(a.closedAt) : -Infinity;
  const bm = b.closedAt ? Date.parse(b.closedAt) : -Infinity;
  return bm - am || a.id.localeCompare(b.id);
}

/**
 * The epic in motion, by the same rule the card uses (the epic of the first
 * in-progress bead, else of the next ready one), then a fallback the card does
 * not need: the open epic whose children closed most recently, so a project
 * between sessions still shows the phase it is in rather than nothing.
 */
export function pickEpic(all, live, nextId) {
  const epics = new Map(all.filter((b) => b.type === "epic").map((e) => [e.id, e]));
  if (epics.size === 0) return null;
  const epicOfBead = (id) => {
    const bead = all.find((b) => b.id === id);
    if (!bead) return null;
    const parent = parentOf(bead);
    return parent && epics.has(parent) ? epics.get(parent) : null;
  };
  const moving = live.filter((b) => b.status === "in_progress").sort((a, b) => a.priority - b.priority);
  for (const m of moving) {
    const e = epicOfBead(m.id);
    if (e) return e;
  }
  if (nextId) {
    const e = epicOfBead(nextId);
    if (e) return e;
  }
  // Fallback: an open epic that still has open work, the one whose children
  // closed most recently; an epic whose children are all closed is a phase
  // that ended, not one in motion, so it only wins when nothing else has work.
  let best = null;
  let bestKey = [-1, -Infinity];
  for (const e of epics.values()) {
    if (e.status === "closed") continue;
    const kids = all.filter((b) => parentOf(b) === e.id);
    if (kids.length === 0) continue;
    const hasWork = kids.some((k) => k.status !== "closed") ? 1 : 0;
    let ms = 0;
    for (const k of kids) {
      const t = k.closedAt ? Date.parse(k.closedAt) : 0;
      if (t > ms) ms = t;
    }
    if (hasWork > bestKey[0] || (hasWork === bestKey[0] && ms > bestKey[1])) {
      bestKey = [hasWork, ms];
      best = e;
    }
  }
  return best;
}

/**
 * Fold one project's facts into a board row.
 * @param {any} project registry entry (normalizeProject output)
 * @param {import("../../../shared/api.js").ProjectSummary|null} summary the card's numbers, when the projects slice has them
 * @param {{live: any[], closed: any[], commits: any[], error: string|null}} facts
 * @param {{nowMs: number, ready: any[]}} ctx
 * @returns {import("../../../shared/api.js").BoardProject}
 */
export function buildBoardRow(project, summary, facts, ctx) {
  const live = facts.live || [];
  const closed = facts.closed || [];
  const all = live.concat(closed);
  const readyRow = (ctx.ready || []).find((r) => r && r.rig === project.id) || null;
  const nowBead = live.filter((b) => b.status === "in_progress" && b.type !== "epic").sort((a, b) => a.priority - b.priority)[0] || null;
  const epic = pickEpic(all, live, readyRow ? String(readyRow.id) : null);

  let done;
  let todo;
  let scope;
  if (epic) {
    const kids = all.filter((b) => parentOf(b) === epic.id);
    done = kids.filter((k) => k.status === "closed");
    todo = kids.filter((k) => k.status !== "closed");
    scope = "epic";
  } else {
    const since = ctx.nowMs - DONE_WINDOW_DAYS * DAY_MS;
    done = closed.filter((b) => b.closedAt && Date.parse(b.closedAt) >= since);
    todo = live.filter((b) => b.type !== "epic");
    scope = "recent";
  }
  // A blocked bead is listed under Blocked, not counted again as something to
  // do: "To do 2" must not include the item that cannot be started.
  done = done.map(item).sort(doneOrder);
  todo = todo.filter((b) => b.status !== "blocked").map(item).sort(todoOrder);
  const blocked = live.filter((b) => b.status === "blocked").map(item).sort(todoOrder);
  const lastCommit = (facts.commits || [])[0] || null;

  // Next: what is moving now if anything is, else what bd says is ready.
  const next = nowBead
    ? { id: nowBead.id, title: nowBead.title, status: "in_progress" }
    : readyRow
      ? { id: String(readyRow.id), title: String(readyRow.title || ""), status: "ready" }
      : null;

  return {
    id: project.id,
    name: project.name,
    sphere: project.sphere ?? null,
    client: project.client ?? null,
    status: project.status,
    goal: project.goal ?? null,
    attention: summary ? summary.attention : blocked.length > 0 ? "blocked" : "quiet",
    completion: summary ? summary.completion : null,
    needsYou: summary ? summary.needsYou : 0,
    // With the projects slice down, count from the facts at hand rather than
    // show zeros beside a populated Blocked list.
    counts: summary ? summary.counts : countsOf(live, closed, ctx.nowMs),
    lastCommit: lastCommit ? { subject: lastCommit.subject, at: lastCommit.at } : null,
    epic: epic
      ? { id: epic.id, title: epic.title, done: done.length, total: done.length + todo.length }
      : null,
    scope,
    next,
    blocked,
    done: done.slice(0, CHECKLIST_MAX),
    todo: todo.slice(0, CHECKLIST_MAX),
    doneTotal: done.length,
    todoTotal: todo.length,
    error: facts.error || null,
  };
}

/**
 * Work before personal (the client's money is the morning's first question),
 * paused last whatever its sphere, then what wants attention, then name.
 */
export function sortBoard(rows) {
  const sphereRank = (r) => (r.status === "paused" || r.status === "done" ? 2 : r.sphere === "work" ? 0 : 1);
  return [...rows].sort(
    (a, b) =>
      sphereRank(a) - sphereRank(b) ||
      (ATTENTION_RANK[a.attention] ?? 9) - (ATTENTION_RANK[b.attention] ?? 9) ||
      b.needsYou - a.needsYou ||
      a.name.localeCompare(b.name),
  );
}
