// The wipe guard: a restarted server's cold hello (or a poll racing its warmup)
// must never replace populated panels with empty placeholders or null.

import { describe, expect, it } from "vitest";
import type { ConsoleState } from "@shared/api";
import { isStaleFullState, mergeState, placeholderSlices } from "../data/hello";

function state(over: Partial<ConsoleState>): ConsoleState {
  return {
    generatedAt: "2026-08-27T00:00:00Z",
    sessions: [],
    ready: [],
    collectors: [],
    ...over,
  } as unknown as ConsoleState;
}

const SESSION = { id: "t-1" } as unknown as ConsoleState["sessions"][number];
const BEAD = { id: "hq-1" } as unknown as ConsoleState["ready"][number];

describe("placeholderSlices", () => {
  it("names only collectors that have never succeeded", () => {
    const s = state({
      collectors: [
        { name: "sessions", updatedAt: null, error: "bd timed out", ttlS: 5, durationMs: 0 },
        { name: "ready", updatedAt: "2026-08-27T00:00:00Z", error: "stale", ttlS: 5, durationMs: 1 },
        { name: "requests", updatedAt: null, error: null, ttlS: 5, durationMs: 0 },
      ] as unknown as ConsoleState["collectors"],
    });
    expect(placeholderSlices(s)).toEqual(["sessions"]);
  });
});

describe("mergeState", () => {
  it("null incoming keeps the current state wholesale", () => {
    const current = state({ sessions: [SESSION] });
    expect(mergeState(current, null)).toBe(current);
  });

  it("a cold server's placeholder slice keeps the populated value the page already shows", () => {
    const current = state({ sessions: [SESSION], ready: [BEAD] });
    const incoming = state({
      sessions: [],
      ready: [BEAD],
      collectors: [
        { name: "sessions", updatedAt: null, error: "cold", ttlS: 5, durationMs: 0 },
      ] as unknown as ConsoleState["collectors"],
    });
    const merged = mergeState(current, incoming);
    expect(merged?.sessions).toEqual([SESSION]);
    expect(merged?.ready).toEqual([BEAD]);
  });

  it("a slice that genuinely emptied (collector succeeded) is applied, not held", () => {
    const current = state({ sessions: [SESSION] });
    const incoming = state({
      sessions: [],
      collectors: [
        { name: "sessions", updatedAt: "2026-08-27T00:01:00Z", error: null, ttlS: 5, durationMs: 2 },
      ] as unknown as ConsoleState["collectors"],
    });
    expect(mergeState(current, incoming)?.sessions).toEqual([]);
  });

  it("with no current state, incoming is shown as-is and only a double null is nothing", () => {
    const incoming = state({ sessions: [] });
    expect(mergeState(null, incoming)).toBe(incoming);
    expect(mergeState(null, null)).toBeNull();
  });
});

describe("isStaleFullState", () => {
  it("rejects a full state compiled before the one showing, and nothing else", () => {
    const shown = state({ generatedAt: "2026-08-27T00:05:00Z" });
    expect(isStaleFullState(shown, state({ generatedAt: "2026-08-27T00:04:00Z" }))).toBe(true);
    expect(isStaleFullState(shown, state({ generatedAt: "2026-08-27T00:05:00Z" }))).toBe(false);
    expect(isStaleFullState(shown, state({ generatedAt: "2026-08-27T00:06:00Z" }))).toBe(false);
    expect(isStaleFullState(null, state({ generatedAt: "2026-08-27T00:04:00Z" }))).toBe(false);
  });
});
