// Flow chart model (beads hq-c4pl0.2, hq-c4pl0.7): pure layout and the state-to-token
// map for FlowChart.tsx. The server (GET /api/projects/:id/flow) has already decided
// each node's state; this file only picks what is on screen, places it and finds the
// critical path.
//
// Placement (hq-c4pl0.7): dependency layers are ROWS read top to bottom, each row
// centred across the measured width and wrapped onto extra lines past MAX_PER_LINE.
// Nodes with no edge sit in one last row. At project level only work in flight is
// drawn (in progress, waiting, blocked); upcoming, deferred and done fold into counts
// the chart can unfold, because two hundred boxes say nothing at a glance.

import type { FlowEdge, FlowGraph, FlowNode, FlowState } from "@shared/api";

export const FLOW_STATES: readonly FlowState[] = ["done", "active", "waiting", "blocked", "upcoming", "deferred"];

export const STATE_LABEL: Record<FlowState, string> = {
  done: "done",
  active: "in progress",
  waiting: "waiting on you",
  blocked: "blocked",
  upcoming: "upcoming",
  deferred: "deferred",
};

/** Accent colour per state; tokens.css holds the values (WCAG AA 3:1 on panel2). */
export const STATE_TOKEN: Record<FlowState, string> = {
  done: "var(--flow-done)",
  active: "var(--flow-active)",
  waiting: "var(--flow-waiting)",
  blocked: "var(--flow-blocked)",
  upcoming: "var(--flow-upcoming)",
  deferred: "var(--flow-deferred)",
};

export const NODE_GAP = 24;
export const LAYER_GAP = 56;
/** gap between the wrapped lines of one layer: tighter than a layer, so they read as one row */
export const LINE_GAP = 16;
export const NODE_MIN_W = 150;
export const NODE_MAX_W = 240;
export const NODE_H = 58;
export const MAX_PER_LINE = 6;

/** States drawn by default at project level; the rest fold into toggled counts. */
export const PROJECT_SHOWN: readonly FlowState[] = ["waiting", "blocked", "active"];
export const FOLDABLE: readonly FlowState[] = ["upcoming", "deferred", "done"];

export interface PlacedNode extends FlowNode {
  /** dependency layer, or -1 for the row of unconnected nodes */
  layer: number;
  x: number;
  y: number;
}

export interface FlowLayout {
  nodes: PlacedNode[];
  edges: (FlowEdge & { critical: boolean })[];
  nodeW: number;
  width: number;
  height: number;
  critical: Set<string>;
}

const STATE_ORDER: Record<FlowState, number> = { waiting: 0, blocked: 1, active: 2, upcoming: 3, deferred: 4, done: 5 };

/** What needs a look first: waiting, blocked, active, then the rest; done last. */
export function byAttention(a: FlowNode, b: FlowNode): number {
  return STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.id.localeCompare(b.id, undefined, { numeric: true });
}

/**
 * The part of a graph that is on screen: nodes whose state is in `shown` (and any id in
 * `always`, such as a focused bead), plus any outside-project stub that links to one of
 * them, and the edges between those.
 */
export function focusGraph(
  graph: FlowGraph,
  shown: ReadonlySet<FlowState>,
  always?: ReadonlySet<string>,
  opts?: { hideActiveSingles?: boolean },
): FlowGraph {
  // Project level (the owner 2026-11-04): a single bead that is only in progress folds into
  // the legend count; epics, and beads that are waiting or blocked, stay on screen.
  const hidden = (n: FlowNode) => !!opts?.hideActiveSingles && n.kind === "bead" && n.state === "active";
  const core = new Set(
    graph.nodes
      .filter((n) => always?.has(n.id) || (n.kind !== "stub" && shown.has(n.state) && !hidden(n)))
      .map((n) => n.id),
  );
  const keep = new Set(core);
  for (const e of graph.edges) {
    if (core.has(e.from)) keep.add(e.to);
    if (core.has(e.to)) keep.add(e.from);
  }
  const nodes = graph.nodes.filter((n) => core.has(n.id) || (n.kind === "stub" && keep.has(n.id)));
  const ids = new Set(nodes.map((n) => n.id));
  return { ...graph, nodes, edges: graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}

/** Longest chain of unfinished nodes, by node count. Cycle-safe. */
export function flowCriticalPath(nodes: readonly FlowNode[], edges: readonly FlowEdge[]): Set<string> {
  const open = new Set(nodes.filter((n) => n.state !== "done").map((n) => n.id));
  const preds = new Map<string, string[]>();
  for (const e of edges) {
    if (!open.has(e.from) || !open.has(e.to)) continue;
    preds.set(e.to, [...(preds.get(e.to) ?? []), e.from]);
  }
  const best = new Map<string, { len: number; prev: string | null }>();
  const visiting = new Set<string>();
  const walk = (id: string): { len: number; prev: string | null } => {
    const hit = best.get(id);
    if (hit) return hit;
    if (visiting.has(id)) return { len: 0, prev: null };
    visiting.add(id);
    let out = { len: 1, prev: null as string | null };
    for (const p of [...(preds.get(id) ?? [])].sort()) {
      const r = walk(p);
      if (r.len + 1 > out.len) out = { len: r.len + 1, prev: p };
    }
    visiting.delete(id);
    best.set(id, out);
    return out;
  };
  let tip: string | null = null;
  for (const id of [...open].sort()) {
    if (!tip || walk(id).len > walk(tip).len) tip = id;
  }
  const path = new Set<string>();
  // a single node is not a path worth highlighting
  if (!tip || walk(tip).len < 2) return path;
  let cur: string | null = tip;
  while (cur && !path.has(cur)) {
    path.add(cur);
    cur = best.get(cur)?.prev ?? null;
  }
  return path;
}

/** How many nodes fit on one line of `width`, and how wide each is. */
export function lineFit(width: number): { perLine: number; nodeW: number } {
  const w = Math.max(width, NODE_MIN_W);
  const perLine = Math.max(1, Math.min(MAX_PER_LINE, Math.floor((w + NODE_GAP) / (NODE_MIN_W + NODE_GAP))));
  const nodeW = Math.floor(Math.min(NODE_MAX_W, (w - (perLine - 1) * NODE_GAP) / perLine));
  return { perLine, nodeW };
}

/**
 * Top-down layout across `width` px. A linked node sits one layer below its deepest
 * predecessor; inside a layer, nodes follow the mean slot of what feeds them (fewer
 * crossings), then attention order. Unconnected nodes form the last row.
 */
export function layoutFlow(graph: FlowGraph, width: number): FlowLayout {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const linked = new Set<string>();
  const preds = new Map<string, string[]>();
  for (const e of edges) {
    linked.add(e.from);
    linked.add(e.to);
    preds.set(e.to, [...(preds.get(e.to) ?? []), e.from]);
  }

  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const layerOf = (id: string): number => {
    const hit = depth.get(id);
    if (hit !== undefined) return hit;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let d = 0;
    for (const p of preds.get(id) ?? []) d = Math.max(d, layerOf(p) + 1);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };

  const rows = new Map<number, FlowNode[]>();
  for (const n of graph.nodes) {
    const layer = linked.has(n.id) ? layerOf(n.id) : -1;
    rows.set(layer, [...(rows.get(layer) ?? []), n]);
  }
  const order = [...rows.keys()].filter((k) => k >= 0).sort((a, b) => a - b);
  if (rows.has(-1)) order.push(-1);

  const { perLine, nodeW } = lineFit(width);
  const slot = new Map<string, number>();
  const placed: PlacedNode[] = [];
  let y = 0;
  for (const layer of order) {
    const pull = (n: FlowNode) => {
      const ps = (preds.get(n.id) ?? []).map((p) => slot.get(p)).filter((v): v is number => v !== undefined);
      return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Number.POSITIVE_INFINITY;
    };
    const members = [...rows.get(layer)!].sort((a, b) => {
      const pa = pull(a);
      const pb = pull(b);
      return pa === pb ? byAttention(a, b) : pa - pb;
    });
    for (let start = 0; start < members.length; start += perLine) {
      const line = members.slice(start, start + perLine);
      const used = line.length * nodeW + (line.length - 1) * NODE_GAP;
      const x0 = Math.max(0, Math.round((width - used) / 2));
      line.forEach((n, i) => {
        slot.set(n.id, (start + i) / Math.max(1, members.length - 1));
        placed.push({ ...n, layer, x: x0 + i * (nodeW + NODE_GAP), y });
      });
      y += NODE_H + LINE_GAP;
    }
    y += LAYER_GAP - LINE_GAP;
  }
  const critical = flowCriticalPath(graph.nodes, edges);
  return {
    nodes: placed,
    edges: edges.map((e) => ({ ...e, critical: critical.has(e.from) && critical.has(e.to) })),
    nodeW,
    width: Math.max(width, nodeW),
    height: placed.length ? y - LAYER_GAP : 0,
    critical,
  };
}

/** A smooth vertical curve from the bottom of `from` to the top of `to`. */
export function edgePath(from: { x: number; y: number }, to: { x: number; y: number }, nodeW: number): string {
  const x1 = from.x + nodeW / 2;
  const y1 = from.y + NODE_H;
  const x2 = to.x + nodeW / 2;
  const y2 = to.y;
  const bend = Math.max(24, Math.abs(y2 - y1) / 2);
  return `M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - bend} ${x2},${y2}`;
}

/** The blockers and the unlocks of one node, for the hover highlight. */
export function neighbours(edges: readonly FlowEdge[], id: string | null): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>();
  const keys = new Set<string>();
  if (!id) return { nodes, edges: keys };
  nodes.add(id);
  for (const e of edges) {
    if (e.from !== id && e.to !== id) continue;
    nodes.add(e.from);
    nodes.add(e.to);
    keys.add(edgeKey(e));
  }
  return { nodes, edges: keys };
}

export const edgeKey = (e: FlowEdge): string => `${e.from}>${e.to}`;

/** Count per state, for the legend. */
export function stateCounts(nodes: readonly FlowNode[]): Record<FlowState, number> {
  const out = { done: 0, active: 0, waiting: 0, blocked: 0, upcoming: 0, deferred: 0 };
  for (const n of nodes) out[n.state] += 1;
  return out;
}

/**
 * The core of a title for the node face: no "(EPIC)" tag, no trailing aside, and
 * when a full phrase precedes a colon, only that phrase. The full title stays in the
 * tooltip.
 */
export function coreTitle(title: string): string {
  let t = title.replace(/^\s*\((?:epic|EPIC)\)\s*/, "").trim();
  const colon = t.indexOf(": ");
  if (colon > 0 && t.slice(0, colon).trim().split(/\s+/).length >= 3) t = t.slice(0, colon);
  const aside = t.replace(/\s*\([^()]*\)\s*$/, "");
  if (aside.length >= 8) t = aside;
  return t.trim() || title.trim();
}

/**
 * Word-wrap to at most `lines` lines no wider than `max`, never cutting a word: when
 * it does not fit, the last whole word that fits is followed by an ellipsis. `measure`
 * gives a string's width; the default counts characters, the chart passes a canvas
 * measure so the budget is real pixels.
 */
export function wrapTitle(title: string, max: number, lines = 2, measure: (s: string) => number = (s) => s.length): string[] {
  const words = title.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (measure(next) <= max || !cur) {
      cur = next;
      continue;
    }
    out.push(cur);
    cur = w;
    if (out.length === lines) break;
  }
  if (out.length < lines) {
    out.push(cur);
    return out;
  }
  // overflow: trim the last line back to whole words that leave room for the ellipsis
  const last = out[lines - 1]!.split(" ");
  while (last.length > 1 && measure(`${last.join(" ")}...`) > max) last.pop();
  out[lines - 1] = `${last.join(" ")}...`;
  return out;
}
