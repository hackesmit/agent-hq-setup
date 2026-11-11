import { describe, expect, it } from "vitest";
import { T1_MS, T2_MS, T3_MS, ageState, formatAge, tierClass, tierFor } from "./escalation";

const MIN = 60_000;

describe("the ladder", () => {
  it("climbs at thirty minutes, two hours and four hours", () => {
    expect(tierFor(0)).toBe("fresh");
    expect(tierFor(29 * MIN)).toBe("fresh");
    expect(tierFor(T1_MS)).toBe("t1");
    expect(tierFor(T2_MS)).toBe("t2");
    expect(tierFor(T3_MS)).toBe("t3");
    expect(tierFor(9 * 60 * MIN)).toBe("t3");
  });

  it("does not stamp a fresh question with a clock", () => {
    expect(ageState(5 * MIN).ageLabel).toBeNull();
  });

  it("shows what he owes from T1 onward", () => {
    expect(ageState(T1_MS).ageLabel).toBe("30m");
    expect(ageState(T2_MS + 10 * MIN).ageLabel).toBe("2h 10m");
    expect(formatAge(4 * 60 * MIN)).toBe("4h");
  });
});

describe("motion spends only at the thresholds", () => {
  it("stays silent while sitting inside a tier", () => {
    expect(ageState(T2_MS + MIN, "t2").ring).toBe(false);
    expect(ageState(3 * 60 * MIN, "t2").ring).toBe(false);
  });

  it("rings once on the crossing that matters", () => {
    expect(ageState(T2_MS, "t1").ring).toBe(true);
    expect(ageState(T3_MS, "t2").ring).toBe(true);
  });

  it("does not interrupt at T1: the age chip is state, not a claim", () => {
    expect(ageState(T1_MS, "fresh").ring).toBe(false);
  });

  it("rings three times only at the top of the ladder", () => {
    expect(ageState(T2_MS, "t1").rings).toBe(1);
    expect(ageState(T3_MS, "t2").rings).toBe(3);
  });

  it("goes assertive only when it is genuinely overdue", () => {
    expect(ageState(T2_MS).politeness).toBe("polite");
    expect(ageState(T3_MS).politeness).toBe("assertive");
  });

  it("never rings on a first render, only on a real crossing", () => {
    expect(ageState(T3_MS, null).ring).toBe(false);
  });
});

describe("the class it wears", () => {
  it("is nothing at all while fresh", () => {
    expect(tierClass("fresh")).toBe("");
    expect(tierClass("t3")).toContain("hq-aged--t3");
  });
});
