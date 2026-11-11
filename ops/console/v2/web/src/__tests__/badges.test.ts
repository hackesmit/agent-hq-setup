import { describe, expect, it } from "vitest";
import type { ConsoleState, Request } from "@shared/api";
import { badgeTone, deriveBadges, highestSeverity, reportsIndicator, resolveBadges, tabBadges, waitingStrip } from "../app/badges";

function request(id: string, severity: Request["severity"], state: Request["state"]): Request {
  return {
    id,
    kind: "decide",
    severity,
    state,
    rig: "acme-dashboard",
    bead: null,
    session: null,
    createdAt: "2026-08-18T09:00:00.000Z",
    ageSeconds: 60,
    question: "q",
    command: null,
    link: null,
    why: null,
    answer: null,
    settledAt: null,
    snoozedUntil: null,
    meta: {},
  };
}

function stateWith(partial: Partial<ConsoleState>): ConsoleState {
  return {
    generatedAt: "2026-08-18T09:00:00.000Z",
    version: { release: "test", protocol: 1 },
    owner: "owner",
    sessions: [],
    requests: [],
    ready: [],
    projects: [],
    machine: null,
    usage: null,
    alerts: [],
    activity: [],
    stack: null,
    flow: null,
    understudy: null,
    services: null,
    money: null,
    calendar: null,
    discovered: null,
    monitors: null,
    deploys: null,
    ear: null,
    board: null,
    collectors: [],
    badges: { now: 0, nowSeverity: null, projects: 0, stack: 0, machines: 0 },
    ...partial,
  };
}

describe("highestSeverity", () => {
  it("ranks P0 above P1 above P2", () => {
    expect(highestSeverity(["P2", "P1", "P0"])).toBe("P0");
    expect(highestSeverity(["P2", "P1"])).toBe("P1");
    expect(highestSeverity(["P2"])).toBe("P2");
    expect(highestSeverity([])).toBeNull();
  });
});

describe("badgeTone", () => {
  it("is red for P0, amber for P1, neutral otherwise", () => {
    expect(badgeTone(3, "P0")).toBe("p0");
    expect(badgeTone(3, "P1")).toBe("p1");
    expect(badgeTone(3, "P2")).toBe("neutral");
    expect(badgeTone(3, null)).toBe("neutral");
  });

  it("shows nothing at zero, whatever the severity", () => {
    expect(badgeTone(0, "P0")).toBe("none");
    expect(badgeTone(-1, "P0")).toBe("none");
  });
});

describe("deriveBadges", () => {
  it("counts only open requests and takes the highest severity", () => {
    const badges = deriveBadges(
      stateWith({
        requests: [
          request("r-1", "P2", "open"),
          request("r-2", "P0", "open"),
          request("r-3", "P0", "resolved"),
          request("r-4", "P1", "snoozed"),
        ],
      }),
    );
    expect(badges.now).toBe(2);
    expect(badges.nowSeverity).toBe("P0");
  });

  it("counts stuck projects and failing collectors", () => {
    const badges = deriveBadges(
      stateWith({
        projects: [
          { ...project("a"), attention: "blocked" },
          { ...project("b"), attention: "late" },
          { ...project("c"), attention: "needs-you" },
          { ...project("d"), attention: "ok" },
        ],
        collectors: [
          { name: "sessions", updatedAt: null, ttlS: 5, error: null, durationMs: 1 },
          { name: "jobs", updatedAt: null, ttlS: 5, error: "stale heartbeat", durationMs: 1 },
        ],
      }),
    );
    expect(badges.projects).toBe(2);
    expect(badges.machines).toBe(1);
  });

  it("is all zeros with no state", () => {
    expect(deriveBadges(null)).toEqual({ now: 0, nowSeverity: null, projects: 0, stack: 0, machines: 0 });
  });
});

describe("resolveBadges and tabBadges", () => {
  it("prefers what the server sent", () => {
    const state = stateWith({
      requests: [request("r-1", "P2", "open")],
      badges: { now: 9, nowSeverity: "P1", projects: 2, stack: 4, machines: 1 },
    });
    expect(resolveBadges(state).now).toBe(9);
    const badges = tabBadges(state);
    // the Now tab carries no Needs-you badge any more (hq-zqqu.1)
    expect(badges.now).toEqual({ count: 0, tone: "none" });
    expect(badges.machines).toEqual({ count: 1, tone: "p1" });
    expect(badges.money).toEqual({ count: 0, tone: "none" });
  });

  it("keeps the waiting count on the top strip although the tab badge is gone", () => {
    // with no server badges the count is derived from the open requests
    const derived = {
      ...stateWith({
        requests: [request("r-1", "P0", "open"), request("r-2", "P1", "open"), request("r-3", "P1", "answered")],
      }),
      badges: undefined,
    } as unknown as ConsoleState;
    expect(waitingStrip(derived)).toEqual({ count: 2, p0: true });
    expect(waitingStrip(stateWith({ badges: { now: 3, nowSeverity: "P1", projects: 0, stack: 0, machines: 0 } }))).toEqual({
      count: 3,
      p0: false,
    });
    expect(waitingStrip(null)).toEqual({ count: 0, p0: false });
  });
});

function project(id: string): ConsoleState["projects"][number] {
  return {
    id,
    name: id,
    kind: "rig",
    status: "active",
    sphere: null,
    client: null,
    spawnable: true,
    completion: null,
    activeEpic: null,
    worth: null,
    earned: null,
    tokens30d: null,
    costUsd30d: null,
    startedAt: null,
    goal: null,
    targetDate: null,
    counts: { open: 0, inProgress: 0, blocked: 0, closed7d: 0 },
    activity30d: [],
    activitySource: "commits",
    activityTruncated: false,
    lastMergeAt: null,
    lastDeploy: null,
    needsYou: 0,
    nextUp: null,
    attention: "ok",
  };
}

describe("reportsIndicator", () => {
  it("shows the unread count, capped at 99+", () => {
    expect(reportsIndicator({ total: 10, unread: 3 }).label).toBe("3");
    expect(reportsIndicator({ total: 500, unread: 99 }).label).toBe("99");
    expect(reportsIndicator({ total: 500, unread: 100 }).label).toBe("99+");
  });
  it("hides the count at zero and before the summary arrives", () => {
    expect(reportsIndicator({ total: 10, unread: 0 })).toEqual({ label: null, unavailable: false, title: "Reports: nothing unread" });
    expect(reportsIndicator(undefined).label).toBeNull();
    expect(reportsIndicator(null).unavailable).toBe(false);
  });
  it("marks an unreadable store instead of showing zero", () => {
    const ind = reportsIndicator({ total: null, unread: null, error: "read.json is unreadable" });
    expect(ind.unavailable).toBe(true);
    expect(ind.label).toBe("!");
    expect(ind.title).toContain("read.json is unreadable");
  });
});
