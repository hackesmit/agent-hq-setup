import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { FlowGraph, FlowNode, FlowState } from "@shared/api";
import {
  FLOW_STATES,
  LAYER_GAP,
  MAX_PER_LINE,
  NODE_GAP,
  NODE_H,
  PROJECT_SHOWN,
  STATE_TOKEN,
  byAttention,
  coreTitle,
  edgePath,
  flowCriticalPath,
  focusGraph,
  layoutFlow,
  lineFit,
  neighbours,
  stateCounts,
  wrapTitle,
} from "../projects/flow";

const node = (id: string, state: FlowState = "upcoming", kind: FlowNode["kind"] = "bead"): FlowNode => ({
  id,
  title: `title ${id}`,
  kind,
  status: state === "done" ? "closed" : "open",
  state,
  parent: null,
  childCount: 0,
  doneCount: 0,
});

const graph = (nodes: FlowNode[], edges: [string, string][]): FlowGraph => ({
  project: "p",
  epic: null,
  epicTitle: null,
  nodes,
  edges: edges.map(([from, to]) => ({ from, to })),
});

const W = 1200;

describe("flow layout", () => {
  it("stacks dependency layers as rows, top to bottom, with unconnected nodes last", () => {
    const g = graph(
      [node("a", "done"), node("b", "active"), node("c"), node("d"), node("z1", "waiting"), node("z2", "deferred")],
      [
        ["a", "b"],
        ["b", "c"],
        ["a", "c"],
        ["c", "d"],
      ],
    );
    const l = layoutFlow(g, W);
    const at = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
    expect([at.a!.layer, at.b!.layer, at.c!.layer, at.d!.layer]).toEqual([0, 1, 2, 3]);
    expect(at.b!.y - at.a!.y).toBe(NODE_H + LAYER_GAP);
    expect(at.z1!.layer).toBe(-1);
    expect(at.z1!.y).toBeGreaterThan(at.d!.y);
    expect(at.z1!.y).toBe(at.z2!.y);
    // waiting before deferred in the loose row
    expect(at.z1!.x).toBeLessThan(at.z2!.x);
    expect(l.height).toBe(at.z1!.y + NODE_H);
  });

  it("centres each row across the full width with at least the node gap between", () => {
    const l = layoutFlow(graph([node("a"), node("b"), node("c")], [["a", "b"], ["a", "c"]]), W);
    const row = l.nodes.filter((n) => n.layer === 1).sort((p, q) => p.x - q.x);
    expect(row).toHaveLength(2);
    expect(row[1]!.x - row[0]!.x - l.nodeW).toBeGreaterThanOrEqual(NODE_GAP);
    const left = row[0]!.x;
    const right = W - (row[1]!.x + l.nodeW);
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
    const top = l.nodes.find((n) => n.id === "a")!;
    expect(Math.abs(top.x + l.nodeW / 2 - W / 2)).toBeLessThanOrEqual(1);
  });

  it("wraps a layer wider than six onto a second line of the same layer", () => {
    const loose = Array.from({ length: 8 }, (_, i) => node(`n${i}`));
    const l = layoutFlow(graph(loose, []), 2400);
    const ys = [...new Set(l.nodes.map((n) => n.y))].sort((p, q) => p - q);
    expect(ys).toHaveLength(2);
    expect(l.nodes.filter((n) => n.y === ys[0])).toHaveLength(MAX_PER_LINE);
    expect(ys[1]! - ys[0]!).toBeLessThan(NODE_H + LAYER_GAP);
  });

  it("fits narrow widths without running past the right edge", () => {
    const loose = Array.from({ length: 5 }, (_, i) => node(`n${i}`));
    for (const width of [360, 700, 1500]) {
      const l = layoutFlow(graph(loose, []), width);
      for (const n of l.nodes) {
        expect(n.x, `${width}`).toBeGreaterThanOrEqual(0);
        expect(n.x + l.nodeW, `${width}`).toBeLessThanOrEqual(width);
      }
    }
    expect(lineFit(360).perLine).toBe(2);
    expect(lineFit(100).perLine).toBe(1);
    expect(lineFit(5000)).toMatchObject({ perLine: MAX_PER_LINE });
  });

  it("orders a row by what feeds it, so edges cross less", () => {
    const g = graph([node("p1"), node("p2"), node("k1"), node("k2")], [
      ["p1", "k1"],
      ["p2", "k2"],
    ]);
    const at = Object.fromEntries(layoutFlow(g, W).nodes.map((n) => [n.id, n.x]));
    expect(Math.sign(at.p1! - at.p2!)).toBe(Math.sign(at.k1! - at.k2!));
  });

  it("highlights the longest unfinished chain, skipping done nodes", () => {
    const g = graph(
      [node("a", "done"), node("b", "active"), node("c"), node("d"), node("x")],
      [
        ["a", "b"],
        ["b", "c"],
        ["c", "d"],
        ["a", "x"],
      ],
    );
    expect([...flowCriticalPath(g.nodes, g.edges)].sort()).toEqual(["b", "c", "d"]);
    const l = layoutFlow(g, W);
    expect(l.edges.filter((e) => e.critical).map((e) => `${e.from}>${e.to}`)).toEqual(["b>c", "c>d"]);
  });

  it("survives a dependency cycle", () => {
    const g = graph([node("a"), node("b"), node("c")], [
      ["a", "b"],
      ["b", "c"],
      ["c", "a"],
    ]);
    const l = layoutFlow(g, W);
    expect(l.nodes).toHaveLength(3);
    expect(flowCriticalPath(g.nodes, g.edges).size).toBeGreaterThan(0);
  });

  it("drops edges to nodes that are not in the graph", () => {
    const l = layoutFlow(graph([node("a")], [["a", "ghost"]]), W);
    expect(l.edges).toHaveLength(0);
    expect(l.nodes.map((n) => [n.id, n.layer])).toEqual([["a", -1]]);
  });

  it("draws edges as vertical curves from the bottom of one node to the top of the next", () => {
    expect(edgePath({ x: 0, y: 0 }, { x: 100, y: 200 }, 50)).toBe(`M25,${NODE_H} C25,${NODE_H + (200 - NODE_H) / 2} 125,${200 - (200 - NODE_H) / 2} 125,200`);
  });

  it("finds a node's blockers and unlocks for the hover highlight", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "x", to: "y" },
    ];
    const n = neighbours(edges, "b");
    expect([...n.nodes].sort()).toEqual(["a", "b", "c"]);
    expect([...n.edges].sort()).toEqual(["a>b", "b>c"]);
    expect(neighbours(edges, null).nodes.size).toBe(0);
  });

  it("orders by attention: waiting, blocked, active, upcoming, deferred, done", () => {
    const states: FlowState[] = ["done", "deferred", "upcoming", "active", "blocked", "waiting"];
    const sorted = states.map((s) => node(s, s)).sort(byAttention);
    expect(sorted.map((n) => n.state)).toEqual(["waiting", "blocked", "active", "upcoming", "deferred", "done"]);
  });

  it("counts states", () => {
    expect(stateCounts([node("a", "done"), node("b", "done"), node("c", "blocked")])).toEqual({
      done: 2,
      active: 0,
      waiting: 0,
      blocked: 1,
      upcoming: 0,
      deferred: 0,
    });
  });
});

describe("flow focus", () => {
  const g = graph(
    [
      node("e1", "active", "epic"),
      node("e2", "upcoming", "epic"),
      node("e3", "done", "epic"),
      node("b1", "blocked"),
      node("b2", "waiting"),
      node("b3", "upcoming"),
      node("s1", "upcoming", "stub"),
      node("s2", "upcoming", "stub"),
    ],
    [
      ["e1", "e2"],
      ["s1", "b1"],
      ["s2", "b3"],
      ["e3", "e1"],
    ],
  );

  it("shows only work in flight by default, with stubs that link to it", () => {
    const f = focusGraph(g, new Set(PROJECT_SHOWN));
    expect(f.nodes.map((n) => n.id)).toEqual(["e1", "b1", "b2", "s1"]);
    expect(f.edges).toEqual([{ from: "s1", to: "b1" }]);
  });

  it("unfolds a state when its toggle is on", () => {
    const f = focusGraph(g, new Set([...PROJECT_SHOWN, "upcoming", "done"]));
    expect(f.nodes.map((n) => n.id)).toEqual(["e1", "e2", "e3", "b1", "b2", "b3", "s1", "s2"]);
    expect(f.edges).toHaveLength(4);
  });

  it("hides single in-progress beads at project level but keeps epics and focus", () => {
    const hidden = focusGraph(g, new Set(PROJECT_SHOWN), undefined, { hideActiveSingles: true });
    expect(hidden.nodes.filter((n) => n.kind === "bead" && n.state === "active")).toEqual([]);
    expect(hidden.nodes.some((n) => n.kind === "epic")).toBe(true);
    const active = g.nodes.find((n) => n.kind === "bead" && n.state === "active");
    if (active) {
      const kept = focusGraph(g, new Set(PROJECT_SHOWN), new Set([active.id]), { hideActiveSingles: true });
      expect(kept.nodes.map((n) => n.id)).toContain(active.id);
    }
  });

  it("keeps a focused bead on screen whatever its state", () => {
    const f = focusGraph(g, new Set(PROJECT_SHOWN), new Set(["b3"]));
    expect(f.nodes.map((n) => n.id)).toEqual(["e1", "b1", "b2", "b3", "s1", "s2"]);
  });
});

describe("flow titles", () => {
  it("keeps the core of a title", () => {
    expect(coreTitle("(EPIC) Project flow charts: live dependency graph with status colors")).toBe("Project flow charts");
    expect(coreTitle("Redesign the flow chart: top-down, full width, simplified, modern")).toBe("Redesign the flow chart");
    // a one-word head is a category, not the task
    expect(coreTitle("Acquisition: pillow 13, for screenshots")).toBe("Acquisition: pillow 13, for screenshots");
    expect(coreTitle("Acquired rembg 2.0.86 (via pipx)")).toBe("Acquired rembg 2.0.86");
    expect(coreTitle("(EPIC)")).toBe("(EPIC)");
  });

  it("wraps to two lines on word boundaries, never cutting a word", () => {
    expect(wrapTitle("Serve a per-project flow graph", 20)).toEqual(["Serve a per-project", "flow graph"]);
    const long = wrapTitle("Fix the lodgeco-system session handoff so a dead pane revives cleanly", 20);
    expect(long).toHaveLength(2);
    expect(long[1]!.endsWith("...")).toBe(true);
    for (const line of long) expect(line.length).toBeLessThanOrEqual(20);
    const words = new Set("Fix the lodgeco-system session handoff so a dead pane revives cleanly".split(" "));
    for (const w of long.join(" ").replace("...", "").split(" ")) expect(words.has(w)).toBe(true);
    expect(wrapTitle("short", 20)).toEqual(["short"]);
    // a pixel measure: wide glyphs fit fewer words on a line
    const px = (t: string) => t.length * 10 + (t.match(/W/g)?.length ?? 0) * 10;
    expect(wrapTitle("WWW aa bb", 70, 2, px)).toEqual(["WWW", "aa bb"]);
    expect(wrapTitle("WWW aa bb cc", 70, 2, px)).toEqual(["WWW", "aa..."]);
  });
});

describe("flow state colours", () => {
  const css = readFileSync(new URL("../theme/tokens.css", import.meta.url), "utf8");
  const hex = (name: string) => css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1] ?? null;
  const lum = (h: string) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string) => {
    const [lo, hi] = [lum(a), lum(b)].sort((x, y) => x - y);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  it("every state has a token that clears 3:1 on the node fill and the panel", () => {
    const panel = hex("panel")!;
    const panel2 = hex("panel2")!;
    for (const s of FLOW_STATES) {
      expect(STATE_TOKEN[s]).toBe(`var(--flow-${s})`);
      const value = hex(`flow-${s}`);
      expect(value, s).not.toBeNull();
      expect(ratio(value!, panel2), s).toBeGreaterThanOrEqual(3);
      expect(ratio(value!, panel), s).toBeGreaterThanOrEqual(3);
    }
  });

  it("edges clear 3:1 on the panel; titles and legend text clear 4.5:1", () => {
    expect(ratio(hex("flow-edge")!, hex("panel")!)).toBeGreaterThanOrEqual(3);
    expect(ratio(hex("ink")!, hex("flow-node")!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex("flow-label")!, hex("panel")!)).toBeGreaterThanOrEqual(4.5);
  });
});
