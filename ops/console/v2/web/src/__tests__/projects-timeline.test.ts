import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@shared/api";
import {
  DAY_MS,
  ZOOM_DAYS,
  barRect,
  barTone,
  chartHeight,
  computeCriticalPath,
  criticalIds,
  dayTicks,
  depArrows,
  dueFromX,
  isoDay,
  layerGraph,
  layoutRows,
  makeScale,
  msForX,
  orderItems,
  todayX,
  tooltipFor,
  xForMs,
} from "../projects/timeline";

const NOW = Date.parse("2026-08-18T12:00:00.000Z");

function item(over: Partial<TimelineItem> & { id: string }): TimelineItem {
  return {
    title: over.id,
    kind: "bead",
    status: "open",
    start: "2026-08-16T00:00:00.000Z",
    end: "2026-08-18T00:00:00.000Z",
    projected: true,
    due: null,
    late: false,
    deps: [],
    critical: false,
    parent: null,
    ...over,
  };
}

describe("scale", () => {
  it("opens the window three days before today at the 2w preset", () => {
    const scale = makeScale("2w", NOW);
    expect(isoDay(scale.startMs)).toBe("2026-08-15");
    expect(isoDay(scale.endMs)).toBe("2026-08-29");
    expect(scale.days).toBe(ZOOM_DAYS["2w"]);
    expect(scale.width).toBe(14 * 46);
  });

  it("keeps today at the same fraction of every preset", () => {
    for (const zoom of ["2w", "6w", "quarter"] as const) {
      const scale = makeScale(zoom, NOW);
      const fraction = todayX(scale) / scale.width;
      expect(fraction).toBeGreaterThan(0.19);
      expect(fraction).toBeLessThan(0.26);
    }
  });

  it("maps time to pixels and back", () => {
    const scale = makeScale("2w", NOW);
    expect(xForMs(scale, scale.startMs)).toBe(0);
    expect(xForMs(scale, scale.startMs + 3 * DAY_MS)).toBe(138);
    expect(msForX(scale, 138)).toBe(scale.startMs + 3 * DAY_MS);
  });
});

describe("bars", () => {
  const scale = makeScale("2w", NOW);

  it("places a bar on its day columns", () => {
    const rect = barRect(item({ id: "a", start: "2026-08-16T00:00:00.000Z", end: "2026-08-18T00:00:00.000Z" }), scale)!;
    expect(rect).toEqual({ x: 46, width: 92, clippedStart: false, clippedEnd: false });
  });

  it("clips to the window and says so", () => {
    const rect = barRect(item({ id: "a", start: "2026-08-01T00:00:00.000Z", end: "2026-08-16T00:00:00.000Z" }), scale)!;
    expect(rect.x).toBe(0);
    expect(rect.width).toBe(46);
    expect(rect.clippedStart).toBe(true);
    expect(rect.clippedEnd).toBe(false);
  });

  it("drops an item that falls entirely outside the window", () => {
    expect(barRect(item({ id: "a", start: "2026-10-01T00:00:00.000Z", end: "2026-10-05T00:00:00.000Z" }), scale)).toBeNull();
    expect(barRect(item({ id: "b", start: "2026-07-01T00:00:00.000Z", end: "2026-07-05T00:00:00.000Z" }), scale)).toBeNull();
  });

  it("keeps a zero-length bar visible", () => {
    const rect = barRect(item({ id: "a", start: "2026-08-17T00:00:00.000Z", end: "2026-08-17T00:00:00.000Z" }), scale)!;
    expect(rect.width).toBe(4);
  });

  it("returns null rather than NaN geometry for an unparseable date", () => {
    expect(barRect(item({ id: "a", start: "whenever", end: "later" }), scale)).toBeNull();
  });

  it("colors by state, with late ahead of blocked", () => {
    expect(barTone(item({ id: "a", status: "closed" }))).toBe("done");
    expect(barTone(item({ id: "b", status: "blocked" }))).toBe("blocked");
    expect(barTone(item({ id: "c", status: "blocked", late: true }))).toBe("late");
    expect(barTone(item({ id: "d", status: "in_progress" }))).toBe("active");
    expect(barTone(item({ id: "e", status: "open" }))).toBe("projected");
  });
});

describe("columns and rows", () => {
  const scale = makeScale("2w", NOW);

  it("emits one tick per day and labels the first column and every Monday", () => {
    const ticks = dayTicks(scale);
    expect(ticks).toHaveLength(14);
    expect(ticks[0]!.label).toBe("Aug 15");
    for (const tick of ticks) {
      const weekday = new Date(tick.ms).getUTCDay();
      expect(tick.major).toBe(weekday === 1 || tick.x === 0);
      expect(tick.weekend).toBe(weekday === 0 || weekday === 6);
      if (!tick.major) expect(tick.label).toBe("");
    }
  });

  it("orders beads by start and parks epics at the bottom", () => {
    const order = orderItems([
      item({ id: "epic", kind: "epic", start: "2026-08-01T00:00:00.000Z" }),
      item({ id: "late-bead", start: "2026-08-20T00:00:00.000Z" }),
      item({ id: "early-bead", start: "2026-08-16T00:00:00.000Z" }),
    ]).map((entry) => entry.id);
    expect(order).toEqual(["early-bead", "late-bead", "epic"]);
  });

  it("stacks rows and marks a visible due date", () => {
    const rows = layoutRows(
      [item({ id: "a", due: "2026-08-20" }), item({ id: "b", due: "2026-12-01" })],
      scale,
    );
    expect(rows[1]!.y - rows[0]!.y).toBe(26);
    expect(rows[0]!.dueX).toBe(xForMs(scale, Date.parse("2026-08-20")));
    expect(rows[1]!.dueX).toBeNull();
    expect(chartHeight(rows.length)).toBe(24 + 2 * 26 + 6);
  });

  it("draws a dependency arrow only when both bars are on screen", () => {
    const rows = layoutRows(
      [
        item({ id: "a", start: "2026-08-16T00:00:00.000Z", end: "2026-08-17T00:00:00.000Z" }),
        item({ id: "b", start: "2026-08-17T00:00:00.000Z", end: "2026-08-19T00:00:00.000Z", deps: ["a", "ghost"] }),
      ],
      scale,
    );
    const arrows = depArrows(rows);
    expect(arrows).toHaveLength(1);
    expect(arrows[0]).toMatchObject({ from: "a", to: "b", critical: false });
    expect(arrows[0]!.points.split(" ")).toHaveLength(4);
  });
});

describe("drag to set a due date", () => {
  const scale = makeScale("2w", NOW);

  it("snaps the pointer to the day column under it", () => {
    expect(dueFromX(scale, 0)).toBe("2026-08-15");
    expect(dueFromX(scale, 46 * 3 + 20)).toBe("2026-08-18");
  });

  it("clamps to the window rather than inventing a date off screen", () => {
    expect(dueFromX(scale, -500)).toBe("2026-08-15");
    expect(dueFromX(scale, 99_999)).toBe("2026-08-29");
  });
});

describe("tooltip", () => {
  it("says the dates, the projection, the due state and the deps", () => {
    const tip = tooltipFor(
      item({ id: "a", start: "2026-08-16T00:00:00.000Z", end: "2026-08-18T00:00:00.000Z", due: "2026-08-17", late: true, deps: ["b"], critical: true }),
    );
    expect(tip.lines[0]).toBe("2026-08-16 to 2026-08-18 (projected)");
    expect(tip.lines[1]).toBe("due 2026-08-17 (late)");
    expect(tip.lines[2]).toBe("after b");
    expect(tip.lines).toContain("on the critical path");
  });
});

describe("unlock graph", () => {
  const chain = [
    item({ id: "a" }),
    item({ id: "b", deps: ["a"] }),
    item({ id: "c", deps: ["b"] }),
    item({ id: "d", deps: ["a"] }),
    item({ id: "epic", kind: "epic" }),
  ];

  it("layers each bead one past its deepest predecessor and drops epics", () => {
    const dag = layerGraph(chain);
    expect(dag.nodes.map((node) => [node.id, node.layer])).toEqual([
      ["a", 0],
      ["b", 1],
      ["d", 1],
      ["c", 2],
    ]);
    expect(dag.layers).toBe(3);
    expect(dag.nodes.find((node) => node.id === "d")!.index).toBe(1);
  });

  it("ignores deps that point outside the set", () => {
    expect(layerGraph([item({ id: "a", deps: ["gone"] })]).nodes[0]!.layer).toBe(0);
  });

  it("survives a cycle instead of recursing forever", () => {
    const dag = layerGraph([item({ id: "a", deps: ["b"] }), item({ id: "b", deps: ["a"] })]);
    expect(dag.nodes).toHaveLength(2);
  });
});

describe("critical path", () => {
  it("takes the longest duration-weighted chain", () => {
    const path = computeCriticalPath([
      item({ id: "a", start: "2026-08-16T00:00:00.000Z", end: "2026-08-17T00:00:00.000Z" }),
      item({ id: "b", start: "2026-08-17T00:00:00.000Z", end: "2026-08-21T00:00:00.000Z", deps: ["a"] }),
      item({ id: "c", start: "2026-08-17T00:00:00.000Z", end: "2026-08-18T00:00:00.000Z", deps: ["a"] }),
    ]);
    expect(path).toEqual(["a", "b"]);
  });

  it("prefers the server's flags when it sets any", () => {
    const ids = criticalIds([item({ id: "a", critical: true }), item({ id: "b" })]);
    expect([...ids]).toEqual(["a"]);
  });

  it("computes the path when the server flags nothing", () => {
    const ids = criticalIds([item({ id: "a" }), item({ id: "b", deps: ["a"] })]);
    expect(ids.has("b")).toBe(true);
  });
});
