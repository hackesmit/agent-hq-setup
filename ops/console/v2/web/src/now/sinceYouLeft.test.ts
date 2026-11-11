// Since You Left. The counts are the whole product: a ribbon that overstates or
// understates what happened is worse than no ribbon, because you stop reading it. These
// pin the rules that keep it honest.
import { describe, expect, it } from "vitest";
import type { ActivityEvent, ConsoleState, Request } from "@shared/api";
import { ACTIVITY_CAP, awayLabel, horizonIndex, MIN_AWAY_MS, newEvents, summarize } from "./sinceYouLeft";

const T0 = Date.parse("2026-08-20T23:14:00.000Z");
const NOW = T0 + 8 * 3600_000 + 12 * 60_000; // 8h 12m later

function ev(minsAfter: number, type: ActivityEvent["type"], rig = "acme-dashboard"): ActivityEvent {
  return {
    id: `${type}-${minsAfter}`,
    ts: new Date(T0 + minsAfter * 60_000).toISOString(),
    type,
    rig,
    session: null,
    bead: null,
    title: `${type} on ${rig}`,
    detail: null,
    sev: null,
  };
}

function req(minsAfter: number, state: Request["state"] = "open"): Request {
  return {
    id: `r-${minsAfter}`,
    kind: "decide",
    severity: "P1",
    state,
    rig: "chesski",
    bead: "ch-19",
    session: null,
    createdAt: new Date(T0 + minsAfter * 60_000).toISOString(),
    ageSeconds: 0,
    question: "bump depth?",
    command: null,
    link: null,
    why: null,
    answer: null,
    settledAt: null,
    snoozedUntil: null,
    meta: {},
  };
}

function stateOf(activity: ActivityEvent[], requests: Request[] = []): Pick<ConsoleState, "activity" | "requests"> {
  // newest first, as the server sends it
  return { activity: [...activity].sort((a, b) => b.ts.localeCompare(a.ts)), requests };
}

describe("summarize", () => {
  it("stays hidden when you were barely away", () => {
    const s = stateOf([ev(10, "commit"), ev(20, "merge")]);
    const short = summarize(s, new Date(NOW - 20 * 60_000).toISOString(), NOW);
    expect(short.show).toBe(false);
    expect(MIN_AWAY_MS).toBe(45 * 60 * 1000);
  });

  it("stays hidden when nothing happened, however long you were gone", () => {
    const summary = summarize(stateOf([]), new Date(T0).toISOString(), NOW);
    expect(summary.show).toBe(false);
    expect(summary.total).toBe(0);
  });

  it("stays hidden when the marker has never been set", () => {
    // a console that has never been marked read must not claim you missed everything
    const summary = summarize(stateOf([ev(10, "commit")]), null, NOW);
    expect(summary.show).toBe(false);
  });

  it("counts only what landed after the marker", () => {
    const s = stateOf([
      ev(-30, "commit"), // before you left: already read
      ev(10, "commit"),
      ev(20, "commit"),
      ev(30, "merge"),
      ev(40, "error"),
      ev(50, "dispatch"),
      ev(60, "finish"),
      ev(70, "ask"),
    ]);
    const summary = summarize(s, new Date(T0).toISOString(), NOW);
    expect(summary.show).toBe(true);
    expect(summary.counts.commits).toBe(2);
    expect(summary.counts.merges).toBe(1);
    expect(summary.counts.errors).toBe(1);
    expect(summary.counts.dispatches).toBe(1);
    expect(summary.counts.finishes).toBe(1);
    expect(summary.counts.asks).toBe(1);
    expect(summary.total).toBe(7);
  });

  it("separates asks raised from asks still open", () => {
    const s = stateOf(
      [ev(10, "ask"), ev(20, "ask"), ev(30, "ask")],
      [req(10, "open"), req(20, "answered"), req(30, "open"), req(-90, "open")],
    );
    const summary = summarize(s, new Date(T0).toISOString(), NOW);
    expect(summary.counts.asks).toBe(3);
    // the answered one does not count, and neither does the one that predates the marker
    expect(summary.counts.asksOpen).toBe(2);
  });

  it("says the counts are floors once the stream is capped", () => {
    const many = Array.from({ length: ACTIVITY_CAP }, (_, i) => ev(i + 1, "commit"));
    const summary = summarize(stateOf(many), new Date(T0).toISOString(), NOW);
    expect(summary.truncated).toBe(true);
  });

  it("reports the away duration in the head", () => {
    const summary = summarize(stateOf([ev(10, "commit")]), new Date(T0).toISOString(), NOW);
    expect(awayLabel(summary.awayMs)).toBe("8h 12m");
    expect(awayLabel(52 * 60_000)).toBe("52m");
    expect(awayLabel(3 * 3600_000)).toBe("3h");
  });
});

describe("horizonIndex", () => {
  it("finds where the read events start", () => {
    const rows = [ev(60, "commit"), ev(30, "merge"), ev(-10, "commit"), ev(-40, "ask")].sort((a, b) =>
      b.ts.localeCompare(a.ts),
    );
    expect(horizonIndex(rows, new Date(T0).toISOString())).toBe(2);
  });

  it("draws no rule when everything is new, or nothing is", () => {
    const allNew = [ev(60, "commit"), ev(30, "merge")];
    expect(horizonIndex(allNew, new Date(T0).toISOString())).toBe(-1);
    const allOld = [ev(-60, "commit"), ev(-30, "merge")];
    expect(horizonIndex(allOld, new Date(T0).toISOString())).toBe(-1);
    expect(horizonIndex(allNew, null)).toBe(-1);
  });
});

describe("newEvents", () => {
  it("is empty without a marker rather than claiming everything is unread", () => {
    expect(newEvents([ev(10, "commit")], null)).toHaveLength(0);
    expect(newEvents([ev(10, "commit")], "not a date")).toHaveLength(0);
  });
});
