import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "@shared/api";
import {
  activityGeometry,
  activityLabel,
  activityTotal,
  daysUntil,
  filterCounts,
  filterProjects,
  matchesFilter,
  milestoneProgress,
  sortProjects,
} from "../projects/overview";

function project(over: Partial<ProjectSummary> & { id: string }): ProjectSummary {
  return {
    name: over.id,
    kind: "rig",
    status: "active",
    sphere: null,
    client: null,
    spawnable: true,
    completion: null,
    activeEpic: null,
    worth: null,
    earned: null,
    tokens30d: null,
    costUsd30d: null,
    startedAt: null,
    goal: null,
    targetDate: null,
    counts: { open: 0, inProgress: 0, blocked: 0, closed7d: 0 },
    activity30d: [],
    activitySource: "commits",
    activityTruncated: false,
    lastMergeAt: null,
    lastDeploy: null,
    needsYou: 0,
    nextUp: null,
    attention: "ok",
    ...over,
  };
}

describe("attention sort", () => {
  it("puts needs-you first, then blocked, late, ok, quiet", () => {
    const order = sortProjects([
      project({ id: "quiet", attention: "quiet" }),
      project({ id: "ok", attention: "ok" }),
      project({ id: "late", attention: "late" }),
      project({ id: "blocked", attention: "blocked" }),
      project({ id: "needs", attention: "needs-you" }),
    ]).map((entry) => entry.id);
    expect(order).toEqual(["needs", "blocked", "late", "ok", "quiet"]);
  });

  it("breaks a tie on needs-you count, then blocked count, then name", () => {
    const order = sortProjects([
      project({ id: "b", attention: "needs-you", needsYou: 1 }),
      project({ id: "a", attention: "needs-you", needsYou: 1 }),
      project({ id: "loud", attention: "needs-you", needsYou: 4 }),
      project({ id: "stuck", attention: "needs-you", needsYou: 1, counts: { open: 0, inProgress: 0, blocked: 3, closed7d: 0 } }),
    ]).map((entry) => entry.id);
    expect(order).toEqual(["loud", "stuck", "a", "b"]);
  });

  it("does not mutate its input", () => {
    const input = [project({ id: "z", attention: "quiet" }), project({ id: "a", attention: "needs-you" })];
    const copy = [...input];
    sortProjects(input);
    expect(input).toEqual(copy);
  });
});

describe("filters", () => {
  const projects = [
    project({ id: "rig-a", kind: "rig", sphere: "work" }),
    project({ id: "rig-b", kind: "rig", status: "paused", sphere: "work" }),
    project({ id: "mail", kind: "service", sphere: "personal" }),
    project({ id: "client", kind: "client" }),
  ];

  it("hides paused work everywhere except the paused chip", () => {
    expect(filterProjects(projects, "all").map((entry) => entry.id)).toEqual(["client", "mail", "rig-a"]);
    expect(filterProjects(projects, "rigs").map((entry) => entry.id)).toEqual(["rig-a"]);
    expect(filterProjects(projects, "non-code").map((entry) => entry.id)).toEqual(["client", "mail"]);
    expect(filterProjects(projects, "paused").map((entry) => entry.id)).toEqual(["rig-b"]);
  });

  it("splits work from personal by the registry's sphere", () => {
    expect(filterProjects(projects, "work").map((entry) => entry.id)).toEqual(["rig-a"]);
    expect(filterProjects(projects, "personal").map((entry) => entry.id)).toEqual(["mail"]);
  });

  it("shows an unclassified project only under all, never in a guessed bucket", () => {
    expect(matchesFilter(project({ id: "x" }), "work")).toBe(false);
    expect(matchesFilter(project({ id: "x" }), "personal")).toBe(false);
    expect(matchesFilter(project({ id: "x" }), "all")).toBe(true);
  });

  it("counts each chip", () => {
    expect(filterCounts(projects)).toEqual({ all: 3, work: 1, personal: 1, rigs: 1, "non-code": 2, paused: 1 });
  });

  it("keeps a paused non-rig out of the non-code list", () => {
    expect(matchesFilter(project({ id: "x", kind: "service", status: "paused" }), "non-code")).toBe(false);
  });

  it("keeps a paused work project out of the work list", () => {
    expect(matchesFilter(project({ id: "x", sphere: "work", status: "paused" }), "work")).toBe(false);
  });
});

describe("activity chart", () => {
  it("draws one column per active day, scaled against the window's own peak", () => {
    const geometry = activityGeometry([0, 1, 2], 300, 36);
    expect(geometry.peak).toBe(2);
    // Three slots of 100; the zero day contributes no rect at all.
    expect(geometry.bars.map((b) => b.x)).toEqual([100, 200]);
    expect(geometry.bars.map((b) => b.height)).toEqual([18, 36]);
    expect(geometry.bars[0]!.y).toBe(18);
    expect(geometry.bars[1]!.y).toBe(0);
  });

  it("draws nothing for a day with nothing in it, so gaps look like gaps", () => {
    // The whole reason this stopped being a cumulative line: a running total cannot
    // fall, so a dead month and a finished one drew identically.
    expect(activityGeometry([0, 0, 0]).bars).toEqual([]);
    expect(activityGeometry([]).bars).toEqual([]);
  });

  it("gives a single-event day a visible bar rather than a sub-pixel sliver", () => {
    const geometry = activityGeometry([1, 0, 40], 300, 36);
    expect(geometry.bars[0]!.height).toBeGreaterThanOrEqual(1.5);
  });

  it("skips a bad sample IN PLACE, so the days after it keep their dates", () => {
    // Filtering the array first compacted it, and the last value drew at the third
    // slot instead of the fourth: one NaN silently redrew the month one day early.
    const geometry = activityGeometry([2, Number.NaN, -3, 4], 300, 36);
    expect(geometry.peak).toBe(4);
    expect(geometry.bars.map((b) => b.x)).toEqual([0, 225]);
    expect(geometry.bars.every((b) => Number.isFinite(b.height) && Number.isFinite(b.y))).toBe(true);
  });

  it("a window of only bad samples draws nothing rather than a row of full-height bars", () => {
    expect(activityGeometry([Number.NaN, -1]).bars).toEqual([]);
    expect(activityGeometry([Number.NaN, -1]).peak).toBe(0);
  });

  it("totals the window by summing days, which the old cumulative delta could not", () => {
    // burnupDelta was last-minus-first on a running total, so anything closed on the
    // oldest day in the window was silently missing from the caption.
    expect(activityTotal([3, 0, 1, 2])).toBe(6);
    expect(activityTotal([])).toBe(0);
  });

  it("names what it counted, and does not say '1 commits'", () => {
    expect(activityLabel(47, "commits")).toBe("47 commits in 30 days");
    expect(activityLabel(1, "commits")).toBe("1 commit in 30 days");
    expect(activityLabel(6, "beads")).toBe("6 beads closed in 30 days");
    expect(activityLabel(1, "beads")).toBe("1 bead closed in 30 days");
    expect(activityLabel(0, "commits")).toBe("0 commits in 30 days");
  });
});

describe("milestone progress", () => {
  const epics = [
    { id: "e1", title: "Checkout", due: "2026-09-12", children: 14, closed: 10 },
    { id: "e2", title: "Later", due: null, children: 8, closed: 0 },
  ];

  it("measures epics that carry a due date", () => {
    const progress = milestoneProgress(epics)!;
    expect(progress).toMatchObject({ pct: 71, closed: 10, total: 14 });
    expect(progress.lead?.id).toBe("e1");
  });

  it("falls back to all epics when none has a due date", () => {
    expect(milestoneProgress([{ id: "e2", title: "Later", due: null, children: 4, closed: 1 }])!.pct).toBe(25);
  });

  it("returns null when there is nothing to measure", () => {
    expect(milestoneProgress([])).toBeNull();
    expect(milestoneProgress([{ id: "e", title: "Empty", due: "2026-01-01", children: 0, closed: 0 }])).toBeNull();
  });
});

describe("daysUntil", () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z");

  it("counts forwards and backwards", () => {
    expect(daysUntil("2026-08-28T12:00:00.000Z", now)).toBe(10);
    expect(daysUntil("2026-08-08T12:00:00.000Z", now)).toBe(-10);
  });

  it("is null for a missing or unparseable date", () => {
    expect(daysUntil(null, now)).toBeNull();
    expect(daysUntil("soon", now)).toBeNull();
  });
});

describe("fmtEarned", () => {
  it("keeps cents, splits currencies, and never invents a dollar", async () => {
    const { fmtEarned } = await import("../projects/ProjectPage");
    expect(fmtEarned(null)).toBe("-");
    expect(fmtEarned({ mxnCents: 0, usdCents: 0 })).toBe("$0");
    expect(fmtEarned({ mxnCents: 50, usdCents: 0 })).toBe("$0.50 MXN");
    expect(fmtEarned({ mxnCents: 1234000, usdCents: 9900 })).toBe("$12,340 MXN + $99 USD");
  });
});

describe("fmtCostUsd", () => {
  it("shows the cents that matter and never rounds real spend to zero", async () => {
    const { fmtCostUsd } = await import("../projects/ProjectPage");
    expect(fmtCostUsd(null)).toBe("-");
    expect(fmtCostUsd(0)).toBe("$0");
    expect(fmtCostUsd(0.004)).toBe("<$0.01");
    expect(fmtCostUsd(0.54)).toBe("$0.54");
    expect(fmtCostUsd(93.5081)).toBe("$93.51");
    // past three figures the cents are noise, so the thousands separator earns the room
    expect(fmtCostUsd(7351.2911)).toBe("$7,351");
  });

  it("is a dash rather than NaN when the number never arrived", async () => {
    const { fmtCostUsd } = await import("../projects/ProjectPage");
    expect(fmtCostUsd(Number.NaN)).toBe("-");
  });
});
