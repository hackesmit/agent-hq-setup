// Gantt projection (design 4.2, bead hq-tf37).
//
// "Built entirely from bd fields that already exist. Done beads span created to
// closed. Open beads are a projection, labelled as such: epoch is now (or the
// bead's defer date), one worker lane per project by default, duration is the
// estimate (default 15 minutes when missing) placed in working hours, and
// predecessors must close before a bead starts; the critical path is the
// longest estimate-weighted dependency chain. Due dates render as an outline
// and a late state; a milestone is an epic with a due date."
//
// projectTimeline() is pure: beads in, TimelineItem[] out. No clock, no I/O, so
// the whole thing is unit-testable and the endpoint is a thin wrapper.

const MIN_MS = 60000;
const DAY_MS = 86400000;

export const DEFAULTS = {
  estimateDefaultMin: 15,
  workStartHour: 9,
  workEndHour: 18,
  lanes: 1,
};

/** Minutes east of UTC for the host, unless the caller pins one. */
function offsetFor(opts, nowMs) {
  if (Number.isFinite(opts.tzOffsetMinutes)) return Number(opts.tzOffsetMinutes);
  return -new Date(nowMs).getTimezoneOffset();
}

/** Local wall-clock milliseconds since that day's midnight. */
function localMs(ms, offMin) {
  const shifted = ms + offMin * MIN_MS;
  return ((shifted % DAY_MS) + DAY_MS) % DAY_MS;
}

function localMidnight(ms, offMin) {
  return ms - localMs(ms, offMin);
}

/**
 * The first working instant at or after `ms`.
 * Working hours are [workStartHour, workEndHour) in local time, every day.
 */
export function nextWorkingInstant(ms, cfg) {
  const off = cfg.offMin;
  const startMs = cfg.workStartHour * 3600000;
  const endMs = cfg.workEndHour * 3600000;
  const inDay = localMs(ms, off);
  const midnight = localMidnight(ms, off);
  if (inDay < startMs) return midnight + startMs;
  if (inDay >= endMs) return midnight + DAY_MS + startMs;
  return ms;
}

/**
 * Advance `startMs` by `minutes` of working time, skipping the closed hours.
 * A zero-length item still lands on a working instant.
 */
export function addWorkingMinutes(startMs, minutes, cfg) {
  const endOfDayMs = cfg.workEndHour * 3600000;
  let cursor = nextWorkingInstant(startMs, cfg);
  let left = Math.max(0, minutes) * MIN_MS;
  // guard against a degenerate config (start >= end) turning this into a loop
  const dayCapacity = Math.max(0, (cfg.workEndHour - cfg.workStartHour)) * 3600000;
  if (dayCapacity <= 0) return cursor + left;
  let guard = 0;
  while (left > 0 && guard++ < 4000) {
    const midnight = localMidnight(cursor, cfg.offMin);
    const room = midnight + endOfDayMs - cursor;
    if (left <= room) return cursor + left;
    left -= room;
    cursor = nextWorkingInstant(midnight + endOfDayMs, cfg);
  }
  return cursor + left;
}

/**
 * Dependency-first order. Kahn over the subgraph of the given beads; anything
 * left over (a cycle, or a dep on a bead outside this project) is appended in
 * a stable order so a bad edge never drops work off the chart.
 */
export function topoOrder(beads) {
  const byId = new Map(beads.map((b) => [b.id, b]));
  const indeg = new Map();
  const out = new Map();
  for (const b of beads) {
    indeg.set(b.id, 0);
    out.set(b.id, []);
  }
  for (const b of beads) {
    for (const d of b.deps) {
      if (!byId.has(d)) continue;
      indeg.set(b.id, indeg.get(b.id) + 1);
      out.get(d).push(b.id);
    }
  }
  const stable = (ids) =>
    ids.sort((x, y) => {
      const a = byId.get(x);
      const b = byId.get(y);
      return a.priority - b.priority || String(a.createdAt).localeCompare(String(b.createdAt)) || x.localeCompare(y);
    });
  const queue = stable([...indeg.keys()].filter((id) => indeg.get(id) === 0));
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(byId.get(id));
    for (const n of out.get(id)) {
      indeg.set(n, indeg.get(n) - 1);
      if (indeg.get(n) === 0) {
        queue.push(n);
        stable(queue);
      }
    }
  }
  if (order.length < beads.length) {
    const seen = new Set(order.map((b) => b.id));
    for (const id of stable(beads.map((b) => b.id).filter((id) => !seen.has(id)))) order.push(byId.get(id));
  }
  return order;
}

/**
 * Longest estimate-weighted dependency chain over the projected beads.
 * Returns the set of ids on that chain.
 */
export function criticalPath(beads, estimateOf) {
  const byId = new Map(beads.map((b) => [b.id, b]));
  const order = topoOrder(beads);
  /** @type {Map<string, {weight: number, prev: string|null}>} */
  const best = new Map();
  for (const b of order) {
    let weight = estimateOf(b);
    let prev = null;
    for (const d of b.deps) {
      if (!byId.has(d)) continue;
      const cand = best.get(d);
      if (!cand) continue;
      if (cand.weight + estimateOf(b) > weight) {
        weight = cand.weight + estimateOf(b);
        prev = d;
      }
    }
    best.set(b.id, { weight, prev });
  }
  let tip = null;
  for (const b of order) {
    const e = best.get(b.id);
    if (!tip || e.weight > best.get(tip).weight) tip = b.id;
  }
  const path = new Set();
  let cur = tip;
  let guard = 0;
  while (cur && guard++ < beads.length + 1) {
    path.add(cur);
    cur = best.get(cur).prev;
  }
  return path;
}

/**
 * @param {import("../../../shared/api.js").Bead[]} beads
 * @param {number|string|Date} now
 * @param {{estimateDefaultMin?: number, workStartHour?: number, workEndHour?: number,
 *          lanes?: number, tzOffsetMinutes?: number}} [opts]
 * @returns {import("../../../shared/api.js").TimelineItem[]}
 */
export function projectTimeline(beads, now, opts = {}) {
  const nowMs = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(String(now));
  const cfg = {
    estimateDefaultMin: opts.estimateDefaultMin || DEFAULTS.estimateDefaultMin,
    workStartHour: opts.workStartHour == null ? DEFAULTS.workStartHour : opts.workStartHour,
    workEndHour: opts.workEndHour == null ? DEFAULTS.workEndHour : opts.workEndHour,
    lanes: Math.max(1, opts.lanes || DEFAULTS.lanes),
    offMin: offsetFor(opts, nowMs),
  };
  const list = (Array.isArray(beads) ? beads : []).filter((b) => b && b.id);
  const estimateOf = (b) => (b.estimateMin && b.estimateMin > 0 ? b.estimateMin : cfg.estimateDefaultMin);

  const done = list.filter((b) => b.status === "closed");
  const live = list.filter((b) => b.status !== "closed");
  const epicIds = new Set(list.filter((b) => b.type === "epic").map((b) => b.id));

  /** @type {Map<string, {start: number, end: number}>} */
  const span = new Map();

  // Done beads are history, not a projection: created to closed.
  for (const b of done) {
    const start = b.createdAt ? Date.parse(b.createdAt) : b.closedAt ? Date.parse(b.closedAt) : nowMs;
    const end = b.closedAt ? Date.parse(b.closedAt) : start;
    span.set(b.id, { start: Math.min(start, end), end: Math.max(start, end) });
  }

  // Projection. One lane by default: a lane cursor per lane, each bead placed
  // on the lane that frees up first, after its deferral and its predecessors.
  const projectedBeads = live.filter((b) => !epicIds.has(b.id));
  const lanes = new Array(cfg.lanes).fill(nextWorkingInstant(nowMs, cfg));
  for (const b of topoOrder(projectedBeads)) {
    let earliest = nowMs;
    if (b.deferUntil) earliest = Math.max(earliest, Date.parse(b.deferUntil));
    for (const d of b.deps) {
      const s = span.get(d);
      if (s) earliest = Math.max(earliest, s.end);
    }
    let laneIdx = 0;
    for (let i = 1; i < lanes.length; i++) if (lanes[i] < lanes[laneIdx]) laneIdx = i;
    const start = nextWorkingInstant(Math.max(earliest, lanes[laneIdx]), cfg);
    const end = addWorkingMinutes(start, estimateOf(b), cfg);
    lanes[laneIdx] = end;
    span.set(b.id, { start, end });
  }

  const critical = criticalPath(projectedBeads, estimateOf);

  // Epics span their children; a childless epic falls back to its own bar.
  for (const e of list.filter((b) => epicIds.has(b.id))) {
    const kids = list.filter((b) => b.parent === e.id).map((b) => span.get(b.id)).filter(Boolean);
    if (kids.length) {
      span.set(e.id, {
        start: Math.min(...kids.map((k) => k.start)),
        end: Math.max(...kids.map((k) => k.end)),
      });
    } else if (!span.has(e.id)) {
      const start = nextWorkingInstant(e.deferUntil ? Math.max(nowMs, Date.parse(e.deferUntil)) : nowMs, cfg);
      span.set(e.id, { start, end: addWorkingMinutes(start, estimateOf(e), cfg) });
    }
  }

  /** @type {import("../../../shared/api.js").TimelineItem[]} */
  const items = [];
  for (const b of list) {
    const s = span.get(b.id);
    if (!s) continue;
    const projected = b.status !== "closed";
    const dueMs = b.due ? Date.parse(b.due) : null;
    let late = false;
    if (dueMs != null) {
      // closed: was it closed after its due date; open: does the projection
      // (or simply the clock, for an already overdue bead) land past it
      late = projected ? s.end > dueMs || nowMs > dueMs : s.end > dueMs;
    }
    items.push({
      id: b.id,
      title: b.title,
      kind: epicIds.has(b.id) ? "epic" : "bead",
      status: b.status,
      start: new Date(s.start).toISOString(),
      end: new Date(s.end).toISOString(),
      projected,
      due: b.due,
      late,
      deps: b.deps.slice(),
      critical: critical.has(b.id),
      parent: b.parent,
    });
  }
  items.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  // The plan reads at the idea level: epics and unparented beads. A bead
  // inside an epic still shaped its epic's bar above; drawing it too is what
  // turned the Plan card into a hundred rows of atoms. `atoms: true` keeps
  // the full drill-down for a caller that asks.
  if (!opts.atoms) return items.filter((i) => i.kind === "epic" || !i.parent || !epicIds.has(i.parent));
  return items;
}

/**
 * Milestone rollup: an epic with a due date, plus percent of children closed.
 * @param {import("../../../shared/api.js").Bead[]} beads
 */
export function milestones(beads) {
  const list = Array.isArray(beads) ? beads : [];
  return list
    .filter((b) => b.type === "epic")
    .map((e) => {
      const kids = list.filter((b) => b.parent === e.id);
      const closed = kids.filter((b) => b.status === "closed").length;
      return {
        id: e.id,
        title: e.title,
        due: e.due,
        children: kids.length,
        closed,
        pctClosed: kids.length ? Math.round((closed / kids.length) * 100) : 0,
      };
    });
}
