import { describe, expect, it } from "vitest";
import type { UnderstudyReport } from "@shared/api";
import { backtestLine, fmtScore, gradedTrend, understudyHint, understudyTiles } from "../stack/understudy";

function report(partial?: Partial<UnderstudyReport>): UnderstudyReport {
  return {
    generatedAt: "2026-08-28T12:00:00Z",
    corpus: { total: 48, answered: 34, open: 9 },
    live: { stamped: 21, graded: 8, abstentions: 6, accuracy: 0.75, brier: 0.142, skill: 0.24 },
    backtest: { n: 34, coverage: 0.68, accuracy: 0.83, brier: 0.156, skill: 0.19 },
    history: [
      { ts: "2026-08-22T12:00:00Z", answered: 22, stamped: 9, graded: 2, accuracy: 0.5, brier: 0.21, skill: 0.02 },
      { ts: "2026-08-28T11:00:00Z", answered: 34, stamped: 21, graded: 8, accuracy: 0.75, brier: 0.142, skill: 0.24 },
    ],
    ...partial,
  };
}

describe("understudyTiles", () => {
  it("lays the six numbers out with the corpus first", () => {
    const tiles = understudyTiles(report());
    expect(tiles.map((t) => t.label)).toEqual(["corpus", "predicted", "graded", "accuracy", "brier", "skill"]);
    expect(tiles[0].value).toBe("34");
    expect(tiles[3].value).toBe("75%");
    expect(tiles[4].value).toBe("0.142");
  });

  it("shows dashes, never zeros, while nothing is graded", () => {
    const tiles = understudyTiles(
      report({ live: { stamped: 3, graded: 0, abstentions: 1, accuracy: null, brier: null, skill: null } }),
    );
    expect(tiles[3].value).toBe("-");
    expect(tiles[4].value).toBe("-");
    expect(tiles[5].value).toBe("-");
  });

  it("is empty with no report so the panel can say the collector has not run", () => {
    expect(understudyTiles(null)).toEqual([]);
  });
});

describe("understudyHint", () => {
  it("explains the waiting state and goes quiet once anything is graded", () => {
    expect(understudyHint(report({ live: { stamped: 2, graded: 0, abstentions: 0, accuracy: null, brier: null, skill: null } }))).toMatch(/scores once/);
    expect(understudyHint(report())).toBeNull();
    expect(understudyHint(null)).toBeNull();
  });
});

describe("gradedTrend and backtestLine", () => {
  it("pulls the graded counts oldest first for the sparkline", () => {
    expect(gradedTrend(report())).toEqual([2, 8]);
    expect(gradedTrend(null)).toEqual([]);
  });

  it("summarises the backtest in one line and hides it on an empty corpus", () => {
    expect(backtestLine(report())).toBe("backtest over 34 answered: coverage 68%, accuracy 83%, Brier 0.156");
    expect(backtestLine(report({ backtest: { n: 0, coverage: 0, accuracy: null, brier: null, skill: null } }))).toBeNull();
    expect(backtestLine(null)).toBeNull();
  });
});

describe("fmtScore", () => {
  it("keeps three decimals and dashes the unknown", () => {
    expect(fmtScore(0.1)).toBe("0.100");
    expect(fmtScore(null)).toBe("-");
    expect(fmtScore(Number.NaN)).toBe("-");
  });
});
