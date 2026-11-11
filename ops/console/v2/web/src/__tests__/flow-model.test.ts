import { describe, expect, it } from "vitest";
import type { FlowReport } from "@shared/api";
import { flowHint, flowRows, fmtDur, fmtShare } from "../stack/flow";

function report(partial?: Partial<FlowReport>): FlowReport {
  const win = (closed: number, blocked: number | null = null) => ({
    closed, medianLeadS: closed ? 2500 : null, p90LeadS: closed ? 90000 : null,
    blockedShare: blocked, reopened: 0, reworkShare: closed ? 0 : null,
  });
  return {
    generatedAt: "2026-08-24T12:00:00Z",
    rigs: [
      {
        rig: "hq",
        windows: { 7: win(14, 0.1), 30: win(67, 0.09), 90: win(240, 0.14) },
        weekly: [
          { weekStart: "2026-07-20", medianLeadS: 5400, closed: 22 },
          { weekStart: "2026-07-27", medianLeadS: null, closed: 0 },
          { weekStart: "2026-08-03", medianLeadS: 2600, closed: 28 },
        ],
      },
      {
        rig: "chesski",
        windows: { 7: win(0), 30: win(0), 90: win(0) },
        weekly: [{ weekStart: "2026-07-20", medianLeadS: null, closed: 0 }],
      },
    ],
    ...partial,
  };
}

describe("fmtDur", () => {
  it("scales the unit to the span", () => {
    expect(fmtDur(42)).toBe("42s");
    expect(fmtDur(2497)).toBe("42m");
    expect(fmtDur(5.2 * 3600)).toBe("5.2h");
    expect(fmtDur(186215)).toBe("2.2d");
  });
  it("keeps null and nonsense as a dash", () => {
    expect(fmtDur(null)).toBe("-");
    expect(fmtDur(-5)).toBe("-");
  });
});

describe("fmtShare", () => {
  it("rounds where precision is noise, keeps a decimal where it matters", () => {
    expect(fmtShare(0.5)).toBe("50%");
    expect(fmtShare(0.09)).toBe("9.0%");
    expect(fmtShare(0)).toBe("0%");
    expect(fmtShare(null)).toBe("-");
  });
});

describe("flowRows", () => {
  it("is empty without a report", () => {
    expect(flowRows(null, "30")).toEqual([]);
  });

  it("puts busy rigs first and keeps idle ones", () => {
    const rows = flowRows(report(), "30");
    expect(rows.map((row) => row.rig)).toEqual(["hq", "chesski"]);
    expect(rows[0].closed).toBe(67);
    expect(rows[1].medianLead).toBe("-");
  });

  it("counts only weeks with closes toward the trend, and zero-fills the line", () => {
    const rows = flowRows(report(), "30");
    expect(rows[0].trendWeeks).toBe(2);
    expect(rows[0].trend).toEqual([5400, 0, 2600]);
  });
});

describe("flowHint", () => {
  it("stays quiet while blocked time is minor", () => {
    expect(flowHint(report(), "30")).toBeNull();
  });

  it("names the rig whose queue is waiting on the owner", () => {
    const r = report();
    r.rigs[0].windows["30"].blockedShare = 0.62;
    const hint = flowHint(r, "30");
    expect(hint).toContain("hq");
    expect(hint).toContain("62%");
    expect(hint).toContain("queue");
  });

  it("says nothing about rigs with no closes", () => {
    const r = report();
    r.rigs[1].windows["30"].blockedShare = 0.9; // idle rig, no closes
    expect(flowHint(r, "30")).toBeNull();
  });
});
