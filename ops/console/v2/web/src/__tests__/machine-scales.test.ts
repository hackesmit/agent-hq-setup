// The scales that turn a hardware figure into an answer. The thing under test is
// the judgement, not the arithmetic: a scale that marks the wrong place is worse
// than no scale, because it makes an opinion look measured.
import { describe, expect, it } from "vitest";
import { CPU, LOAD, MEM, TEMP, bandOf, fmtValue, positionOn, readingOf, trendOf } from "../machines/scales";

describe("temperature, the figure that means nothing on its own", () => {
  it("places the live reading where a person would expect it", () => {
    // The box was at 73 when this was written: warm, working, not a problem.
    expect(bandOf(73, TEMP)).toBe("ok");
    expect(bandOf(52, TEMP)).toBe("ok");
    expect(bandOf(82, TEMP)).toBe("warn");
    expect(bandOf(95, TEMP)).toBe("bad");
    // and the scale ends at the physical fact, not at a round number
    expect(TEMP.max).toBe(100);
  });

  it("uses the part of the scale that can actually happen", () => {
    // A running box is never near zero, so a scale from zero would spend a third
    // of itself on values that cannot occur.
    expect(TEMP.min).toBe(30);
    expect(positionOn(30, TEMP)).toBe(0);
    expect(positionOn(100, TEMP)).toBe(1);
    expect(positionOn(65, TEMP)).toBeCloseTo(0.5, 2);
  });

  it("clamps rather than running off the end", () => {
    expect(positionOn(120, TEMP)).toBe(1);
    expect(positionOn(-40, TEMP)).toBe(0);
  });
});

describe("load is normalised so the scale means the same on any box", () => {
  it("treats exactly saturated as the point worth noticing", () => {
    // 4.0 on 4 cores and 12.0 on 12 cores are the same situation
    expect(bandOf(4 / 4, LOAD)).toBe("warn");
    expect(bandOf(12 / 12, LOAD)).toBe("warn");
    // the live sample: 2.94 across 12 cores is a quarter loaded
    expect(bandOf(2.94 / 12, LOAD)).toBe("ok");
    expect(bandOf(2.0, LOAD)).toBe("bad");
  });
});

describe("cpu and memory", () => {
  it("is generous about cpu, because a busy box is doing its job", () => {
    expect(bandOf(70, CPU)).toBe("ok");
    expect(bandOf(85, CPU)).toBe("warn");
    expect(bandOf(99, CPU)).toBe("bad");
  });

  it("marks memory where a box starts trading rather than where it looks full", () => {
    expect(bandOf(38.1, MEM)).toBe("ok"); // the live reading
    expect(bandOf(70, MEM)).toBe("ok");
    expect(bandOf(88, MEM)).toBe("warn");
    expect(bandOf(97, MEM)).toBe("bad");
  });
});

describe("a missing reading is missing, never zero", () => {
  it("returns null for a box with no sensor", () => {
    expect(bandOf(null, TEMP)).toBe(null);
    expect(bandOf(undefined, TEMP)).toBe(null);
    expect(bandOf(Number.NaN, TEMP)).toBe(null);
    expect(positionOn(null, TEMP)).toBe(null);
    expect(readingOf(null, TEMP, "Temperature")).toBe("Temperature: no reading");
  });
});

describe("the judgement survives without colour", () => {
  it("says what it means in a sentence", () => {
    expect(readingOf(73, TEMP, "Temperature")).toBe("Temperature 73C, normal");
    expect(readingOf(84, TEMP, "Temperature")).toBe("Temperature 84C, above 80C, worth watching");
    expect(readingOf(93, TEMP, "Temperature")).toBe("Temperature 93C, past 90C, act on this");
  });
});

describe("trend", () => {
  it("says nothing until there is enough history to say it", () => {
    expect(trendOf([])).toBe(null);
    expect(trendOf([1, 2])).toBe(null);
    expect(trendOf([null, null, null, null])).toBe(null);
  });

  it("ignores noise and reports real movement", () => {
    expect(trendOf([50, 51, 49, 50, 51, 49, 50, 51])).toBe("steady");
    expect(trendOf([20, 22, 25, 30, 45, 55, 70, 80])).toBe("rising");
    expect(trendOf([80, 70, 60, 50, 30, 25, 20, 18])).toBe("falling");
  });

  it("reads through gaps where a sensor dropped out", () => {
    expect(trendOf([20, null, 25, null, 60, null, 80, 90])).toBe("rising");
  });
});

describe("the spoken figure matches the drawn one", () => {
  it("keeps the decimals on a ratio scale", () => {
    // Load lives between 0 and 2, so rounding it to a whole number turned a
    // quarter-loaded box into "Load 0, normal": a sentence saying nothing.
    expect(fmtValue(0.123, LOAD)).toBe("0.12");
    expect(readingOf(0.123, LOAD, "Load")).toBe("Load 0.12, normal");
    expect(readingOf(1.6, LOAD, "Load")).toBe("Load 1.60, past 1.5x, act on this");
  });

  it("still rounds the scales where a decimal would be noise", () => {
    expect(fmtValue(73.4, TEMP)).toBe("73");
    expect(fmtValue(38.1, MEM)).toBe("38");
    expect(readingOf(73.4, TEMP, "Temperature")).toBe("Temperature 73C, normal");
  });
});
