// Standby. The plate itself is decoration; the entry rules are the feature, because a
// console that hides a P0 behind a screensaver is worse than one that never dims.
import { describe, expect, it } from "vitest";
import type { ConsoleState } from "@shared/api";
import { clockLabel, drift, IDLE_MS, mayEnter, mustExit, standbyView } from "./standby";

const base = { enabled: true, phone: false, idleMs: IDLE_MS, openRequests: 0 };

describe("mayEnter", () => {
  it("comes up only after the quiet period", () => {
    expect(mayEnter({ ...base, idleMs: IDLE_MS - 1 })).toBe(false);
    expect(mayEnter({ ...base, idleMs: IDLE_MS })).toBe(true);
  });

  it("never comes up while something is waiting on you", () => {
    expect(mayEnter({ ...base, openRequests: 1 })).toBe(false);
    expect(mayEnter({ ...base, idleMs: IDLE_MS * 100, openRequests: 1 })).toBe(false);
  });

  it("never comes up on a phone, where the screen sleeps by itself", () => {
    expect(mayEnter({ ...base, phone: true })).toBe(false);
  });

  it("stays off unless it was switched on", () => {
    expect(mayEnter({ ...base, enabled: false })).toBe(false);
  });
});

describe("mustExit", () => {
  it("takes the plate straight down when a request lands", () => {
    expect(mustExit(0)).toBe(false);
    expect(mustExit(1)).toBe(true);
  });
});

describe("standbyView", () => {
  const now = Date.parse("2026-08-20T23:41:00.000Z");
  function stateOf(over: Partial<ConsoleState> = {}): ConsoleState {
    return { sessions: [], requests: [], machine: null, usage: null, ...over } as unknown as ConsoleState;
  }

  it("counts live and waiting sessions", () => {
    const state = stateOf({
      sessions: [
        { state: "running" },
        { state: "waiting" },
        { state: "closed" },
        { state: "finishable" },
      ] as unknown as ConsoleState["sessions"],
    });
    const view = standbyView(state, true, now);
    expect(view.live).toBe(2);
    expect(view.waiting).toBe(1);
  });

  it("shows the open question, with what is blocked on it", () => {
    const state = stateOf({
      requests: [
        {
          id: "r-1",
          state: "open",
          severity: "P0",
          rig: "acme-dashboard",
          question: "keep the brand teal on charts?",
          createdAt: new Date(now - 3 * 60000).toISOString(),
          session: "js-4",
        },
      ] as unknown as ConsoleState["requests"],
    });
    const view = standbyView(state, true, now);
    expect(view.question?.text).toBe("keep the brand teal on charts?");
    expect(view.question?.severity).toBe("P0");
    expect(view.question?.ageLabel).toBe("3m ago");
    expect(view.question?.session).toBe("js-4");
  });

  it("carries the link state, so a stale plate can say it is stale", () => {
    expect(standbyView(stateOf(), false, now).connected).toBe(false);
    expect(standbyView(stateOf(), true, now).connected).toBe(true);
  });

  it("omits numbers it does not have rather than inventing zeroes", () => {
    const view = standbyView(stateOf(), true, now);
    expect(view.machine).toBeNull();
    expect(view.tokensToday).toBeNull();
  });

  it("formats the machine and token lines when they are there", () => {
    const state = stateOf({
      machine: { cpuPct: 22.4, tempC: 31.2 } as unknown as ConsoleState["machine"],
      usage: { tokensToday: 184_320 } as unknown as ConsoleState["usage"],
    });
    const view = standbyView(state, true, now);
    expect(view.machine).toBe("hqbox 31C, 22% CPU");
    expect(view.tokensToday).toBe("184k tokens today");
  });
});

describe("the plate itself", () => {
  it("shows a padded 24 hour clock", () => {
    expect(clockLabel(new Date(2026, 7, 20, 9, 5).getTime())).toBe("09:05");
    expect(clockLabel(new Date(2026, 7, 20, 23, 41).getTime())).toBe("23:41");
  });

  it("drifts by a few pixels so nothing burns in, and stays small", () => {
    const points = [0, 10, 20, 30, 40, 50].map((m) => drift(m * 60000));
    for (const p of points) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(14);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(8);
    }
    expect(new Set(points.map((p) => `${p.x},${p.y}`)).size).toBeGreaterThan(3);
  });
});
