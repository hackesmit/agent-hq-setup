// Gantt geometry and the unlock-graph layering. Everything here is pure: the SVG
// component only turns these numbers into elements, so "did the bar land on the right
// day" is a unit test rather than a screenshot argument.
//
// Time is handled in UTC days on purpose. bd due dates arrive as date-only strings
// ("2026-09-12") which parse as UTC midnight; bucketing them in local time would drag a
// due date onto the previous column for anyone west of Greenwich.

import type { TimelineItem } from "@shared/api";

export const DAY_MS = 86_400_000;

export const ZOOMS = ["2w", "6w", "quarter"] as const;
export type Zoom = (typeof ZOOMS)[number];

export const ZOOM_LABELS: Record<Zoom, string> = { "2w": "2w", "6w": "6w", quarter: "Quarter" };
export const ZOOM_DAYS: Record<Zoom, number> = { "2w": 14, "6w": 42, quarter: 91 };
/** Column width per zoom. Wide enough to drop a bar on the right day at 2w. */
export const ZOOM_PX_PER_DAY: Record<Zoom, number> = { "2w": 46, "6w": 20, quarter: 11 };

export const ROW_H = 26;
export const HEADER_H = 24;
export const BAR_H = 14;
export const LANE_PAD = 6;

export function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** "2026-09-12" for a timestamp, in UTC. Used for due dates and calendar keys. */
export function isoDay(ms: number): string {
  return new Date(startOfUtcDay(ms)).toISOString().slice(0, 10);
}

export interface Scale {
  zoom: Zoom;
  startMs: number;
  endMs: number;
  days: number;
  pxPerDay: number;
  width: number;
  nowMs: number;
}

/**
 * Window for a zoom preset: today sits a fifth of the way in, so recent history stays
 * visible without hiding what is next. The window never moves with the data, which keeps
 * the today line in the same place when you switch projects.
 */
export function makeScale(zoom: Zoom, nowMs: number = Date.now()): Scale {
  const days = ZOOM_DAYS[zoom];
  const pxPerDay = ZOOM_PX_PER_DAY[zoom];
  const lead = Math.round(days * 0.2);
  const startMs = startOfUtcDay(nowMs) - lead * DAY_MS;
  return {
    zoom,
    startMs,
    endMs: startMs + days * DAY_MS,
    days,
    pxPerDay,
    width: days * pxPerDay,
    nowMs,
  };
}

export function xForMs(scale: Scale, ms: number): number {
  return ((ms - scale.startMs) / DAY_MS) * scale.pxPerDay;
}

export function msForX(scale: Scale, x: number): number {
  return scale.startMs + (x / scale.pxPerDay) * DAY_MS;
}

export function todayX(scale: Scale): number {
  return xForMs(scale, scale.nowMs);
}

export type BarTone = "done" | "projected" | "active" | "blocked" | "late";

/** Colour class of a bar. Late beats blocked: a late blocked bead is first a deadline problem. */
export function barTone(item: TimelineItem): BarTone {
  if (item.status === "closed") return "done";
  if (item.late) return "late";
  if (item.status === "blocked") return "blocked";
  if (item.status === "in_progress") return "active";
  return "projected";
}

export interface BarRect {
  x: number;
  width: number;
  clippedStart: boolean;
  clippedEnd: boolean;
}

const MIN_BAR_PX = 4;

/**
 * Bar geometry clipped to the window. Returns null when the item falls entirely outside,
 * so the caller can drop the row instead of drawing a zero-width sliver at an edge.
 */
export function barRect(item: TimelineItem, scale: Scale): BarRect | null {
  const start = Date.parse(item.start);
  const end = Date.parse(item.end);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  if (to < scale.startMs || from > scale.endMs) return null;
  const clippedStart = from < scale.startMs;
  const clippedEnd = to > scale.endMs;
  const x = xForMs(scale, Math.max(from, scale.startMs));
  const rawWidth = xForMs(scale, Math.min(to, scale.endMs)) - x;
  return {
    x: Math.round(x * 100) / 100,
    width: Math.round(Math.max(rawWidth, MIN_BAR_PX) * 100) / 100,
    clippedStart,
    clippedEnd,
  };
}

export interface DayTick {
  ms: number;
  x: number;
  label: string;
  major: boolean;
  weekend: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * One tick per day; only Mondays (and the first column) are labelled at 2w, and only
 * Mondays at coarser zooms, so the header never overprints itself.
 */
export function dayTicks(scale: Scale): DayTick[] {
  const ticks: DayTick[] = [];
  for (let day = 0; day < scale.days; day += 1) {
    const ms = scale.startMs + day * DAY_MS;
    const date = new Date(ms);
    const weekday = date.getUTCDay();
    const monday = weekday === 1;
    const major = monday || day === 0;
    ticks.push({
      ms,
      x: Math.round(day * scale.pxPerDay * 100) / 100,
      label: major ? `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}` : "",
      major,
      weekend: weekday === 0 || weekday === 6,
    });
  }
  return ticks;
}

export interface Row {
  item: TimelineItem;
  index: number;
  y: number;
  rect: BarRect | null;
  dueX: number | null;
  tone: BarTone;
}

/** Beads in projected order, then epics (milestones read as summary rows underneath). */
export function orderItems(items: readonly TimelineItem[]): TimelineItem[] {
  return [...items].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "epic" ? 1 : -1;
    const sa = Date.parse(a.start);
    const sb = Date.parse(b.start);
    if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sa - sb;
    return a.id.localeCompare(b.id);
  });
}

export function layoutRows(items: readonly TimelineItem[], scale: Scale): Row[] {
  return orderItems(items).map((item, index) => {
    const due = item.due ? Date.parse(item.due) : Number.NaN;
    const dueVisible = Number.isFinite(due) && due >= scale.startMs && due <= scale.endMs;
    return {
      item,
      index,
      y: HEADER_H + index * ROW_H + (ROW_H - BAR_H) / 2,
      rect: barRect(item, scale),
      dueX: dueVisible ? Math.round(xForMs(scale, due) * 100) / 100 : null,
      tone: barTone(item),
    };
  });
}

export function chartHeight(rowCount: number): number {
  return HEADER_H + rowCount * ROW_H + LANE_PAD;
}

export interface DepArrow {
  from: string;
  to: string;
  points: string;
  critical: boolean;
}

/**
 * Elbow arrows from a predecessor's end to a dependent's start. Only drawn when both bars
 * are on screen; a dangling arrow into the void is worse than no arrow.
 */
export function depArrows(rows: readonly Row[]): DepArrow[] {
  const byId = new Map(rows.map((row) => [row.item.id, row]));
  const arrows: DepArrow[] = [];
  for (const row of rows) {
    if (!row.rect) continue;
    for (const dep of row.item.deps) {
      const source = byId.get(dep);
      if (!source?.rect) continue;
      const x1 = source.rect.x + source.rect.width;
      const y1 = source.y + BAR_H / 2;
      const x2 = row.rect.x;
      const y2 = row.y + BAR_H / 2;
      const mid = x2 > x1 ? (x1 + x2) / 2 : x1 + 6;
      arrows.push({
        from: dep,
        to: row.item.id,
        points: [`${round2(x1)},${round2(y1)}`, `${round2(mid)},${round2(y1)}`, `${round2(mid)},${round2(y2)}`, `${round2(x2)},${round2(y2)}`].join(" "),
        critical: source.item.critical && row.item.critical,
      });
    }
  }
  return arrows;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Date a drag-to-here would set, snapped to the day column under the pointer. */
export function dueFromX(scale: Scale, x: number): string {
  const clamped = Math.max(0, Math.min(scale.width, x));
  return isoDay(msForX(scale, clamped));
}

export interface Tooltip {
  id: string;
  title: string;
  kind: TimelineItem["kind"];
  status: TimelineItem["status"];
  lines: string[];
}

export function tooltipFor(item: TimelineItem): Tooltip {
  const lines: string[] = [];
  const start = Date.parse(item.start);
  const end = Date.parse(item.end);
  if (Number.isFinite(start) && Number.isFinite(end)) {
    lines.push(`${isoDay(start)} to ${isoDay(end)}${item.projected ? " (projected)" : ""}`);
  }
  if (item.due) lines.push(`due ${item.due.slice(0, 10)}${item.late ? " (late)" : ""}`);
  if (item.deps.length > 0) lines.push(`after ${item.deps.join(", ")}`);
  if (item.parent) lines.push(`epic ${item.parent}`);
  if (item.critical) lines.push("on the critical path");
  return { id: item.id, title: item.title, kind: item.kind, status: item.status, lines };
}

// ---------- unlock graph ----------

export interface GraphNode {
  id: string;
  title: string;
  layer: number;
  index: number;
  critical: boolean;
  status: TimelineItem["status"];
}

export interface GraphEdge {
  from: string;
  to: string;
  critical: boolean;
}

export interface Dag {
  nodes: GraphNode[];
  edges: GraphEdge[];
  layers: number;
}

/**
 * Layered DAG: layer 0 is everything with no predecessor inside the set, and every other
 * node sits one past its deepest predecessor. Cycles cannot happen in bd deps, but a
 * corrupted set must not hang the tab, so the walk carries a visiting set and treats a
 * back edge as depth 0.
 */
export function layerGraph(items: readonly TimelineItem[]): Dag {
  const beads = items.filter((item) => item.kind !== "epic");
  const byId = new Map(beads.map((item) => [item.id, item]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();

  function layerOf(id: string): number {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const item = byId.get(id);
    let best = 0;
    for (const dep of item?.deps ?? []) {
      if (!byId.has(dep)) continue;
      best = Math.max(best, layerOf(dep) + 1);
    }
    visiting.delete(id);
    depth.set(id, best);
    return best;
  }

  const nodes: GraphNode[] = beads
    .map((item) => ({
      id: item.id,
      title: item.title,
      layer: layerOf(item.id),
      index: 0,
      critical: item.critical,
      status: item.status,
    }))
    .sort((a, b) => a.layer - b.layer || a.id.localeCompare(b.id));

  const perLayer = new Map<number, number>();
  for (const node of nodes) {
    const next = perLayer.get(node.layer) ?? 0;
    node.index = next;
    perLayer.set(node.layer, next + 1);
  }

  const edges: GraphEdge[] = [];
  for (const item of beads) {
    for (const dep of item.deps) {
      const source = byId.get(dep);
      if (!source) continue;
      edges.push({ from: dep, to: item.id, critical: source.critical && item.critical });
    }
  }

  return { nodes, edges, layers: perLayer.size };
}

/**
 * Fallback critical path, used when the server ships no `critical` flags: the longest
 * duration-weighted chain through the dep DAG. Same shape as the server's rule (design
 * 4.2), computed on what the client already has.
 */
export function computeCriticalPath(items: readonly TimelineItem[]): string[] {
  const beads = items.filter((item) => item.kind !== "epic");
  const byId = new Map(beads.map((item) => [item.id, item]));
  const best = new Map<string, { cost: number; path: string[] }>();
  const visiting = new Set<string>();

  function weight(item: TimelineItem): number {
    const start = Date.parse(item.start);
    const end = Date.parse(item.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 1;
    return Math.max(end - start, 1);
  }

  function walk(id: string): { cost: number; path: string[] } {
    const cached = best.get(id);
    if (cached) return cached;
    if (visiting.has(id)) return { cost: 0, path: [] };
    visiting.add(id);
    const item = byId.get(id);
    let winner: { cost: number; path: string[] } = { cost: 0, path: [] };
    for (const dep of item?.deps ?? []) {
      if (!byId.has(dep)) continue;
      const candidate = walk(dep);
      if (candidate.cost > winner.cost) winner = candidate;
    }
    visiting.delete(id);
    const result = item
      ? { cost: winner.cost + weight(item), path: [...winner.path, id] }
      : { cost: winner.cost, path: winner.path };
    best.set(id, result);
    return result;
  }

  let champion: { cost: number; path: string[] } = { cost: 0, path: [] };
  for (const item of beads) {
    const candidate = walk(item.id);
    if (candidate.cost > champion.cost) champion = candidate;
  }
  return champion.path;
}

/** Items with the server's critical flags, or the computed path when none are flagged. */
export function criticalIds(items: readonly TimelineItem[]): Set<string> {
  const flagged = items.filter((item) => item.critical).map((item) => item.id);
  return new Set(flagged.length > 0 ? flagged : computeCriticalPath(items));
}
