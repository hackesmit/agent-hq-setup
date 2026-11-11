// Snooze presets (beads hq-tsom, hq-uyes). Everything is asserted in local time, because
// "tonight" and "tomorrow 9:00" are wall-clock promises: a preset that lands at 09:00 UTC
// would wake a session in the middle of the night.

import { describe, expect, it } from "vitest";
import {
  customSnoozeIso,
  defaultCustomInput,
  fromLocalInput,
  inOneHour,
  MORNING_HOUR,
  snoozePresets,
  toLocalInput,
  tonight,
  tomorrowMorning,
  TONIGHT_HOUR,
} from "../now/snooze";

function local(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe("presets", () => {
  it("offers exactly the three presets in order", () => {
    const presets = snoozePresets(local(2026, 8, 18, 10));
    expect(presets.map((preset) => preset.id)).toEqual(["1h", "tonight", "tomorrow"]);
    expect(presets.map((preset) => preset.label)).toEqual(["1 h", "tonight", "tomorrow 9:00"]);
    for (const preset of presets) expect(Number.isNaN(Date.parse(preset.iso))).toBe(false);
  });

  it("1 h is exactly one hour out", () => {
    const now = local(2026, 8, 18, 10, 17);
    expect(inOneHour(now).getTime() - now.getTime()).toBe(3_600_000);
  });

  it("tonight is 20:00 today when the day is still young", () => {
    const at = tonight(local(2026, 8, 18, 10));
    expect(at.getHours()).toBe(TONIGHT_HOUR);
    expect(at.getDate()).toBe(18);
  });

  it("tonight rolls to the next evening once 20:00 has passed", () => {
    const at = tonight(local(2026, 8, 18, 21, 30));
    expect(at.getHours()).toBe(TONIGHT_HOUR);
    expect(at.getDate()).toBe(19);
  });

  it("tonight rolls rather than landing in the next few minutes", () => {
    const at = tonight(local(2026, 8, 18, 19, 58));
    expect(at.getDate()).toBe(19);
  });

  it("tomorrow 9:00 is the next calendar day at 09:00 local, whatever the hour now", () => {
    for (const hour of [0, 8, 9, 13, 23]) {
      const at = tomorrowMorning(local(2026, 8, 18, hour));
      expect(at.getHours()).toBe(MORNING_HOUR);
      expect(at.getDate()).toBe(19);
      expect(at.getMinutes()).toBe(0);
    }
  });

  it("crosses a month boundary", () => {
    const at = tomorrowMorning(local(2026, 8, 31, 22));
    expect(at.getMonth()).toBe(8); // September, zero-based
    expect(at.getDate()).toBe(1);
  });

  it("presets are always in the future", () => {
    const now = local(2026, 8, 18, 19, 59);
    for (const preset of snoozePresets(now)) {
      expect(preset.at.getTime()).toBeGreaterThan(now.getTime());
    }
  });
});

describe("custom input", () => {
  it("round-trips a local datetime-local value", () => {
    const at = local(2026, 8, 18, 14, 5);
    expect(toLocalInput(at)).toBe("2026-08-18T14:05");
    expect(fromLocalInput("2026-08-18T14:05")?.getTime()).toBe(at.getTime());
  });

  it("reads a value with seconds", () => {
    expect(fromLocalInput("2026-08-18T14:05:30")?.getMinutes()).toBe(5);
  });

  it("rejects anything unparseable instead of sending an invalid date", () => {
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("tomorrow")).toBeNull();
    expect(fromLocalInput("2026-08-18")).toBeNull();
    expect(customSnoozeIso("nonsense")).toBeNull();
  });

  it("turns a good value into an ISO instant", () => {
    const iso = customSnoozeIso("2026-08-18T14:05");
    expect(iso).not.toBeNull();
    expect(new Date(iso!).getTime()).toBe(local(2026, 8, 18, 14, 5).getTime());
  });

  it("defaults the picker to one hour out, on the minute", () => {
    expect(defaultCustomInput(local(2026, 8, 18, 10, 30))).toBe("2026-08-18T11:30");
  });
});

// The server and ctl.sh accept a when of [ A-Za-z0-9:+-] only. A millisecond
// suffix (".000Z") was rejected as "bad when", which broke every snooze from the
// console, preset and custom alike.
describe("wire format", () => {
  const WHEN_RE = /^[ A-Za-z0-9:+-]{1,64}$/;

  it("presets carry a second-precision ISO instant the server accepts", () => {
    for (const preset of snoozePresets(new Date(2026, 9, 8, 7, 11, 23, 838))) {
      expect(preset.iso).not.toMatch(/\.\d{3}Z$/);
      expect(preset.iso).toMatch(WHEN_RE);
      expect(Date.parse(preset.iso)).toBe(preset.at.getTime() - preset.at.getMilliseconds());
    }
  });

  it("a custom day picked in the picker is accepted by the server", () => {
    const iso = customSnoozeIso("2026-10-09T09:00");
    expect(iso).not.toBeNull();
    expect(iso).toMatch(WHEN_RE);
    expect(iso).not.toMatch(/\.\d{3}Z$/);
  });
});
