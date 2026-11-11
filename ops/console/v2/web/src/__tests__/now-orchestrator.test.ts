// Orchestrator panels on Now (hq-4npjr.5). The hold rule must fail closed exactly like
// the server's (server/test/orchestrator.test.js): every way the orchestrator can be
// missing brings the ask back to the owner.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mockState } from "../data/mock";
import { NowTab } from "../tabs/NowTab";
import type { Alert, ProjectSummary, Request, Session } from "@shared/api";
import {
  findOrchestrator,
  flowTabs,
  fmtSize,
  forYou,
  heldCount,
  liveOrchestrator,
  ORCH_HOLD_S,
  orchestratorHolds,
  p0Alerts,
  snoozedSessions,
  topCounts,
  visibleRequests,
} from "../now/orchestrator";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

function session(over: Partial<Session> = {}): Session {
  return {
    id: "s-1",
    kind: "worker",
    rig: "hq",
    bead: null,
    model: null,
    branch: null,
    worktree: null,
    state: "running",
    startedAt: ago(3600),
    lastActivityAt: null,
    phases: [],
    wakeAt: null,
    runner: "tmux",
    focusable: false,
    attachable: false,
    writable: false,
    name: null,
    task: null,
    turn: null,
    turnAt: null,
    ...over,
  } as Session;
}
const orch = (state: Session["state"] = "running") => session({ id: "s-orch", kind: "interactive", name: "orchestrator", state });

function request(over: Partial<Request> = {}): Request {
  return {
    id: "r-1",
    kind: "decide",
    severity: "P1",
    state: "open",
    rig: "hq",
    bead: null,
    session: "s-1",
    createdAt: ago(60),
    ageSeconds: 60,
    question: "q",
    command: null,
    link: null,
    why: null,
    answer: null,
    settledAt: null,
    snoozedUntil: null,
    meta: {},
    to: "orchestrator",
    ...over,
  };
}

describe("the hold rule", () => {
  it("holds a fresh ask while the orchestrator is live", () => {
    for (const state of ["running", "waiting", "idle"] as const) expect(orchestratorHolds(request(), [orch(state)], NOW)).toBe(true);
  });

  it("fails closed: missing, dead, asleep, ten minutes, forwarded, pre-routing or settled shows it", () => {
    expect(orchestratorHolds(request(), [], NOW)).toBe(false);
    expect(orchestratorHolds(request(), [orch("closed")], NOW)).toBe(false);
    expect(orchestratorHolds(request(), [orch("snoozed")], NOW)).toBe(false);
    expect(orchestratorHolds(request(), [orch("finishable")], NOW)).toBe(false);
    expect(orchestratorHolds(request({ createdAt: ago(ORCH_HOLD_S) }), [orch()], NOW)).toBe(false);
    expect(orchestratorHolds(request({ createdAt: "garbage" }), [orch()], NOW)).toBe(false);
    expect(orchestratorHolds(request({ to: "owner" }), [orch()], NOW)).toBe(false);
    expect(orchestratorHolds(request({ to: undefined }), [orch()], NOW)).toBe(false);
    expect(orchestratorHolds(request({ state: "answered" }), [orch()], NOW)).toBe(false);
  });

  it("never drops a request: visible plus held is everything", () => {
    const all = [request(), request({ id: "r-2", to: null }), request({ id: "r-3", createdAt: ago(700) })];
    const shown = visibleRequests(all, [orch()], NOW);
    expect(shown.map((r) => r.id)).toEqual(["r-2", "r-3"]);
    expect(shown.length + heldCount(all, [orch()], NOW)).toBe(all.length);
    expect(visibleRequests(all, [], NOW)).toHaveLength(3);
  });
});

describe("panels", () => {
  it("finds the live orchestrator before an asleep twin, and an asleep one when that is all", () => {
    const asleep = orch("snoozed");
    const awake = { ...orch(), id: "s-2" };
    expect(liveOrchestrator([asleep, awake])?.id).toBe("s-2");
    expect(findOrchestrator([asleep])?.id).toBe("s-orch");
    expect(findOrchestrator([orch("closed")])).toBeNull();
    expect(findOrchestrator([session()])).toBeNull();
  });

  it("For you: open and not held, most severe then oldest first", () => {
    const list = [
      request({ id: "a", to: null, severity: "P2", createdAt: ago(10) }),
      request({ id: "b", to: null, severity: "P0", createdAt: ago(5) }),
      request({ id: "c", to: null, severity: "P2", createdAt: ago(50) }),
      request({ id: "held" }),
      request({ id: "done", to: null, state: "answered" }),
    ];
    expect(forYou(list, [orch()], NOW).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("P0 alerts only", () => {
    const alerts = [{ id: "1", severity: "P0" }, { id: "2", severity: "P1" }] as Alert[];
    expect(p0Alerts(alerts).map((a) => a.id)).toEqual(["1"]);
  });

  it("snoozed sessions wake soonest first, no wake time last", () => {
    const rows = [
      session({ id: "late", state: "snoozed", wakeAt: ago(-7200) }),
      session({ id: "none", state: "snoozed", wakeAt: null }),
      session({ id: "soon", state: "snoozed", wakeAt: ago(-60) }),
      session({ id: "up", state: "running" }),
    ];
    expect(snoozedSessions(rows).map((s) => s.id)).toEqual(["soon", "late", "none"]);
  });

  it("flow tabs: active projects with work, busiest first, hq always offered", () => {
    const p = (id: string, inProgress: number, open: number, over: Partial<ProjectSummary> = {}) =>
      ({ id, name: id, status: "active", activeEpic: null, counts: { open, inProgress, blocked: 0, closed7d: 0 }, ...over }) as ProjectSummary;
    const tabs = flowTabs([
      p("quiet", 0, 0),
      p("hq", 0, 0),
      p("busy", 3, 1, { activeEpic: { id: "e", title: "E", done: 1, total: 4 } }),
      p("paused", 2, 2, { status: "paused" }),
      p("some", 1, 0),
    ]);
    expect(tabs.map((t) => t.id)).toEqual(["busy", "some", "hq"]);
    expect(tabs[0]?.pct).toBe(25);
  });

  it("top counts and sizes", () => {
    expect(topCounts([orch(), session({ state: "snoozed" }), session({ state: "closed" })], 2)).toEqual({ live: 1, asleep: 1, forYou: 2 });
    expect(fmtSize(512)).toBe("512 B");
    expect(fmtSize(2048)).toBe("2.0 KB");
    expect(fmtSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("the Now page (board F)", () => {
  // Rendered with the real clock, so the fixtures are relative to Date.now().
  const fresh = () => new Date(Date.now() - 30_000).toISOString();
  function render(sessions: Session[], requests: Request[]): string {
    const state = { ...mockState(), sessions, requests };
    return renderToStaticMarkup(createElement(NowTab, { state, focusRequest: null }));
  }
  const held = () => request({ id: "r-held", question: "HELD-QUESTION", createdAt: fresh() });
  const forwarded = () => request({ id: "r-fwd", question: "FORWARDED-QUESTION", to: "owner", createdAt: fresh() });

  it("opens with the board: strip, For you, approved, snoozed, loaded", () => {
    const html = render([orch()], []);
    for (const part of ["orchestrator-board", "orch-strip", "For you", "Orchestrator approved", "Snoozed terminals", "Loaded for the orchestrator"]) {
      expect(html).toContain(part);
    }
    expect(html).toContain("Nothing needs you.");
  });

  it("hides a held ask everywhere and shows a forwarded one", () => {
    const html = render([orch(), session({ id: "s-1" })], [held(), forwarded()]);
    expect(html).not.toContain("HELD-QUESTION");
    expect(html).toContain("FORWARDED-QUESTION");
  });

  it("fail-closed: with no orchestrator the held ask is the owner's again and the board says so", () => {
    const html = render([session({ id: "s-1" })], [held()]);
    expect(html).toContain("orch-missing");
    expect(html).toContain("HELD-QUESTION");
  });

  it("offers Start orchestrator only while none is found (hq-4npjr.11)", () => {
    expect(render([session({ id: "s-1" })], [])).toContain("orch-start");
    // a crashed or ended one is closed, so the button is back for a one-click restart
    expect(render([orch("closed")], [])).toContain("orch-start");
    expect(render([orch()], [])).not.toContain("orch-start");
  });
});
