import { describe, expect, it } from "vitest";
import type { PlanLimit, Session } from "@shared/api";
import { limitTone, planStale, resetsIn, terminalCounts } from "./WorkStrip";

const now = Date.parse("2026-10-20T05:00:00Z");
const limit = (over: Partial<PlanLimit>): PlanLimit => ({ kind: "session", label: "5 h", percent: 10, severity: "normal", resetsAt: null, active: true, ...over });

function session(over: Partial<Session>): Session {
  return {
    id: "s-1", kind: "interactive", rig: "hq", bead: null, model: null, branch: null,
    worktree: null, state: "running", startedAt: "2026-10-20T00:00:00Z", lastActivityAt: null,
    phases: [], wakeAt: null, runner: "pty", focusable: false, attachable: true, writable: true,
    name: null, task: null, turn: null, turnAt: null, ...over,
  };
}

describe("work strip", () => {
  it("says when a window resets", () => {
    expect(resetsIn("2026-10-20T08:30:00Z", now)).toBe("resets in 3 h 30 min");
    expect(resetsIn("2026-10-27T04:00:00Z", now)).toBe("resets in 6 d 23 h");
    expect(resetsIn("2026-10-20T04:00:00Z", now)).toBe("resets now");
    expect(resetsIn(null, now)).toBe("");
  });

  it("colours a window by how full it is", () => {
    expect(limitTone(limit({ percent: 4 }))).toBe("ok");
    expect(limitTone(limit({ percent: 75 }))).toBe("warn");
    expect(limitTone(limit({ percent: 95 }))).toBe("bad");
    expect(limitTone(limit({ percent: 10, severity: "warning" }))).toBe("warn");
  });

  it("flags stale or failed plan numbers", () => {
    expect(planStale("2026-10-20T04:58:00Z", null, now)).toBeNull();
    expect(planStale("2026-10-20T04:30:00Z", null, now)).toBe("numbers are 30 min old");
    expect(planStale("2026-10-20T04:58:00Z", "HTTPError: 401", now)).toMatch(/last read failed/);
    expect(planStale(null, null, now)).toBe("no plan reading yet");
  });

  it("counts terminals the same way the panes show them", () => {
    const counts = terminalCounts(
      [
        session({ id: "q", state: "waiting" }),
        session({ id: "w", turn: "working", turnAt: "2026-10-20T04:59:00Z" }),
        session({ id: "i" }),
        session({ id: "c", state: "closed" }),
      ],
      {},
      now,
    );
    expect(counts).toEqual({ needsYou: 1, working: 1, idle: 1 });
  });
});
