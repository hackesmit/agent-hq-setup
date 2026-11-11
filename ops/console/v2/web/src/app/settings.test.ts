// Settings. These live in a browser and a browser's storage is whatever was last written
// there, including by an older version of this app or by hand. So the parser is the test:
// anything it cannot vouch for falls back to a default rather than reaching a feature.
import { describe, expect, it } from "vitest";
import { DEFAULTS, IDLE_MAX, IDLE_MIN, idleMs, parseSettings } from "./settings";
import { mayEnter } from "./standby";

describe("parseSettings", () => {
  it("returns the defaults for an empty store", () => {
    expect(parseSettings(null)).toEqual(DEFAULTS);
    expect(parseSettings("")).toEqual(DEFAULTS);
  });

  it("keeps a screen that already had standby on", () => {
    // the flag predates this dialog; a screen that opted in should not silently opt out
    expect(parseSettings(null, "on").standby).toBe(true);
    expect(parseSettings(null, "off").standby).toBe(false);
    // an explicit stored setting still wins over the legacy flag
    expect(parseSettings(JSON.stringify({ standby: false }), "on").standby).toBe(false);
  });

  it("survives garbage without losing the rest", () => {
    expect(parseSettings("{ not json")).toEqual(DEFAULTS);
    expect(parseSettings("[]")).toEqual(DEFAULTS);
    expect(parseSettings('"a string"')).toEqual(DEFAULTS);
    const mixed = parseSettings(JSON.stringify({ standby: "yes", sigils: false, standbyIdleMin: 15 }));
    // a non-boolean is not a boolean: the field falls back rather than coercing
    expect(mixed.standby).toBe(DEFAULTS.standby);
    expect(mixed.sigils).toBe(false);
    expect(mixed.standbyIdleMin).toBe(15);
  });

  it("clamps the idle window instead of accepting nonsense", () => {
    expect(parseSettings(JSON.stringify({ standbyIdleMin: 0 })).standbyIdleMin).toBe(IDLE_MIN);
    expect(parseSettings(JSON.stringify({ standbyIdleMin: -30 })).standbyIdleMin).toBe(IDLE_MIN);
    expect(parseSettings(JSON.stringify({ standbyIdleMin: 9999 })).standbyIdleMin).toBe(IDLE_MAX);
    expect(parseSettings(JSON.stringify({ standbyIdleMin: "twenty" })).standbyIdleMin).toBe(DEFAULTS.standbyIdleMin);
    expect(parseSettings(JSON.stringify({ standbyIdleMin: 12.6 })).standbyIdleMin).toBe(13);
  });

  it("ignores fields it does not know", () => {
    const s = parseSettings(JSON.stringify({ standby: true, somethingElse: 42 }));
    expect(s.standby).toBe(true);
    expect(Object.keys(s).sort()).toEqual(Object.keys(DEFAULTS).sort());
  });
});

describe("the idle window actually drives standby", () => {
  it("converts minutes to the threshold the rule uses", () => {
    expect(idleMs({ ...DEFAULTS, standbyIdleMin: 15 })).toBe(15 * 60_000);
    expect(idleMs({ ...DEFAULTS, standbyIdleMin: 0 })).toBe(IDLE_MIN * 60_000);
  });

  it("a longer window really does hold the plate back", () => {
    const base = { enabled: true, phone: false, openRequests: 0 };
    const twenty = idleMs({ ...DEFAULTS, standbyIdleMin: 20 });
    expect(mayEnter({ ...base, idleMs: 10 * 60_000, threshold: twenty })).toBe(false);
    expect(mayEnter({ ...base, idleMs: 20 * 60_000, threshold: twenty })).toBe(true);
  });

  it("a shorter window brings it up sooner", () => {
    const base = { enabled: true, phone: false, openRequests: 0 };
    const one = idleMs({ ...DEFAULTS, standbyIdleMin: 1 });
    expect(mayEnter({ ...base, idleMs: 61_000, threshold: one })).toBe(true);
  });

  it("still refuses while something is waiting, whatever the window says", () => {
    const one = idleMs({ ...DEFAULTS, standbyIdleMin: 1 });
    expect(mayEnter({ enabled: true, phone: false, openRequests: 1, idleMs: 60 * 60_000, threshold: one })).toBe(false);
  });
});
