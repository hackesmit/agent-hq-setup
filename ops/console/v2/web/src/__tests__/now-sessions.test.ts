// Session ordering (bead hq-uyes): waiting on you first, then running, idle, finishable,
// snoozed, and inside a state the one that has been silent longest comes first.

import { describe, expect, it } from "vitest";
import type { ProjectSummary, Session, SessionState } from "@shared/api";
import {
  activityMs,
  compareSessions,
  isLive,
  knownRigs,
  phaseProgress,
  sessionLabel,
  sortSessions,
  STATE_RANK,
  terminalRigs,
} from "../now/sessions";

const BASE = Date.parse("2026-08-18T12:00:00.000Z");

function session(id: string, state: SessionState, minutesSilent = 1, over: Partial<Session> = {}): Session {
  return {
    id,
    kind: "worker",
    rig: "acme-dashboard",
    bead: "xd-207",
    model: "Opus 4.8",
    branch: null,
    worktree: null,
    state,
    startedAt: new Date(BASE - 60 * 60_000).toISOString(),
    lastActivityAt: new Date(BASE - minutesSilent * 60_000).toISOString(),
    phases: [],
    wakeAt: null,
    runner: "pty",
    attachable: true,
    focusable: true,
    writable: false,
    name: null,
    task: null,
    turn: null,
    turnAt: null,
    ...over,
  };
}

describe("sortSessions", () => {
  it("puts what is waiting on you first and what is asleep last", () => {
    const sorted = sortSessions([
      session("snoozed", "snoozed"),
      session("finishable", "finishable"),
      session("idle", "idle"),
      session("running", "running"),
      session("waiting", "waiting"),
      session("draining", "draining"),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual([
      "waiting",
      "running",
      "draining",
      "idle",
      "finishable",
      "snoozed",
    ]);
  });

  it("orders the oldest activity first inside a state", () => {
    const sorted = sortSessions([
      session("recent", "waiting", 2),
      session("stale", "waiting", 90),
      session("middle", "waiting", 30),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["stale", "middle", "recent"]);
  });

  it("breaks a full tie by id so the list does not jitter between pushes", () => {
    const a = session("a", "running", 5);
    const b = session("b", "running", 5);
    expect(compareSessions(a, b)).toBeLessThan(0);
    expect(sortSessions([b, a]).map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("does not mutate its input", () => {
    const input = [session("b", "idle"), session("a", "waiting")];
    const copy = [...input];
    sortSessions(input);
    expect(input).toEqual(copy);
  });

  it("falls back to startedAt when there is no activity stamp yet", () => {
    const fresh = session("fresh", "running", 0, { lastActivityAt: null });
    expect(activityMs(fresh)).toBe(Date.parse(fresh.startedAt));
  });

  it("sorts a session with unusable timestamps last rather than crashing", () => {
    const broken = session("broken", "running", 0, { lastActivityAt: "nope", startedAt: "nope" });
    const fine = session("fine", "running", 5);
    expect(sortSessions([broken, fine]).map((entry) => entry.id)).toEqual(["fine", "broken"]);
  });

  it("ranks every state in the contract", () => {
    const states: SessionState[] = [
      "running",
      "waiting",
      "idle",
      "finishable",
      "snoozed",
      "draining",
      "closed",
    ];
    for (const state of states) expect(typeof STATE_RANK[state]).toBe("number");
  });
});

describe("isLive", () => {
  it("counts everything but snoozed and closed", () => {
    expect(isLive(session("a", "running"))).toBe(true);
    expect(isLive(session("b", "waiting"))).toBe(true);
    expect(isLive(session("c", "finishable"))).toBe(true);
    expect(isLive(session("d", "snoozed"))).toBe(false);
    expect(isLive(session("e", "closed"))).toBe(false);
  });
});

describe("phaseProgress", () => {
  it("reports done, total, the current phase and the ratio", () => {
    const withPhases = session("a", "running", 1, {
      phases: [
        { name: "read", done: true },
        { name: "plan", done: true },
        { name: "tests", done: false },
        { name: "summary", done: false },
      ],
    });
    expect(phaseProgress(withPhases)).toEqual({ done: 2, total: 4, current: "tests", ratio: 0.5 });
  });

  it("handles a session with no phase list", () => {
    expect(phaseProgress(session("a", "idle"))).toEqual({ done: 0, total: 0, current: null, ratio: 0 });
  });
});

describe("labels and rigs", () => {
  it("prefers the operator's name, then the task, then the bead", () => {
    expect(sessionLabel(session("a", "running", 1, { name: "migration" }))).toBe("migration");
    expect(sessionLabel(session("a", "running", 1, { task: "wire the drain" }))).toBe("wire the drain");
    expect(sessionLabel(session("a", "running"))).toBe("xd-207");
    expect(sessionLabel(session("a", "running", 1, { bead: null }))).toBe("a");
  });

  it("collects rigs from several sources without duplicates", () => {
    expect(knownRigs(["chesski", null, "acme-dashboard"], ["chesski", "gym-tracker"])).toEqual([
      "chesski",
      "gym-tracker",
      "acme-dashboard",
    ]);
  });

  it("terminal picker drops an unspawnable project even when a ready bead or session names it", () => {
    const projects = [
      { id: "chesski", spawnable: true },
      { id: "acme-financial", spawnable: false },
    ];
    // ready beads and old sessions must not smuggle the blocked id back in
    expect(terminalRigs(projects, ["acme-financial", "gym-tracker"], ["acme-financial", "chesski"])).toEqual([
      "chesski",
      "gym-tracker",
    ]);
  });

  it("terminal picker keeps unknown ids and everything from an older server without the flag", () => {
    // a worktree the registry does not know stays offered
    expect(terminalRigs([{ id: "chesski", spawnable: true }], ["acme-dashboard-031f"], [])).toEqual([
      "chesski",
      "acme-dashboard-031f",
    ]);
    // spawnable undefined (older server): nothing is blocked
    expect(terminalRigs([{ id: "hq-mail" } as ProjectSummary], [], [])).toEqual(["hq-mail"]);
  });
});
