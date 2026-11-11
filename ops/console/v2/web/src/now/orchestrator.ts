// Rules for the orchestrator panels on Now (bead hq-4npjr.5, design
// docs/designs/2026-11-04-orchestrator.md section 4, mockup board F). Pure, so the
// tests pin them without a DOM.
//
// The one rule that matters: an ask is hidden from the owner only while the orchestrator
// can answer it. Every failure (no orchestrator, a dead one, a cap hit that leaves the
// ask untouched for ten minutes) shows it on the For you card, as before routing
// existed. The server mirrors this for the tab badge (server/src/map.js
// orchestratorHolds); keep the two in step.

import type { Alert, ProjectSummary, Request, Session } from "@shared/api";

/** Seconds the orchestrator may hold an ask before the owner sees it anyway (design 1). */
export const ORCH_HOLD_S = 600;
const LIVE: ReadonlySet<Session["state"]> = new Set(["running", "waiting", "idle"]);

const named = (s: Session) => (s.name ?? "").trim().toLowerCase() === "orchestrator";

/** The live orchestrator chat session: named "orchestrator" (ctl.sh name) and running. */
export function liveOrchestrator(sessions: readonly Session[]): Session | null {
  return sessions.find((s) => named(s) && LIVE.has(s.state)) ?? null;
}

/** The session to show on top: the live one, else an asleep one, else none. */
export function findOrchestrator(sessions: readonly Session[]): Session | null {
  return liveOrchestrator(sessions) ?? sessions.find((s) => named(s) && s.state !== "closed") ?? null;
}

export function orchestratorHolds(request: Request, sessions: readonly Session[], nowMs: number): boolean {
  if (request.to !== "orchestrator" || request.state !== "open") return false;
  const created = Date.parse(request.createdAt);
  if (!Number.isFinite(created) || nowMs - created >= ORCH_HOLD_S * 1000) return false;
  return liveOrchestrator(sessions) !== null;
}

/** Requests the owner can see at all: everything except what the orchestrator holds. */
export function visibleRequests(requests: readonly Request[], sessions: readonly Session[], nowMs: number): Request[] {
  return requests.filter((r) => !orchestratorHolds(r, sessions, nowMs));
}

const SEV: Record<string, number> = { P0: 0, P1: 1, P2: 2 };

/** The For you card: open asks the owner must decide, most severe then oldest first. */
export function forYou(requests: readonly Request[], sessions: readonly Session[], nowMs: number): Request[] {
  return visibleRequests(requests, sessions, nowMs)
    .filter((r) => r.state === "open")
    .sort((a, b) => (SEV[a.severity] ?? 2) - (SEV[b.severity] ?? 2) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** P0 alerts belong on For you too (design 4: only forwarded questions and P0 items). */
export function p0Alerts(alerts: readonly Alert[]): Alert[] {
  return alerts.filter((a) => a.severity === "P0");
}

/** Asks the orchestrator is working on right now (shown as a count, never the text). */
export function heldCount(requests: readonly Request[], sessions: readonly Session[], nowMs: number): number {
  return requests.filter((r) => orchestratorHolds(r, sessions, nowMs)).length;
}

/** Snoozed sessions, the soonest wake first; no wake time sorts last. */
export function snoozedSessions(sessions: readonly Session[]): Session[] {
  const at = (s: Session) => (s.wakeAt ? Date.parse(s.wakeAt) : Number.POSITIVE_INFINITY);
  return sessions.filter((s) => s.state === "snoozed").sort((a, b) => at(a) - at(b));
}

/** Which snoozed sessions the console can wake now. */
export function canWake(session: Session): boolean {
  return session.state === "snoozed";
}

export interface FlowTab {
  id: string;
  label: string;
  pct: number | null;
}

/**
 * One tab per project with work in flight (an active epic, or open or in-progress
 * beads), the busiest first. hq is always offered, since the orchestrator lives there.
 */
export function flowTabs(projects: readonly ProjectSummary[]): FlowTab[] {
  const busy = projects
    .filter((p) => p.status === "active" && (p.activeEpic !== null || p.counts.inProgress + p.counts.open > 0 || p.id === "hq"))
    .sort((a, b) => b.counts.inProgress - a.counts.inProgress || b.counts.open - a.counts.open || a.id.localeCompare(b.id));
  return busy.map((p) => ({
    id: p.id,
    label: p.name || p.id,
    pct: p.activeEpic && p.activeEpic.total > 0 ? Math.round((100 * p.activeEpic.done) / p.activeEpic.total) : null,
  }));
}

export interface TopCounts {
  live: number;
  asleep: number;
  forYou: number;
}

export function topCounts(sessions: readonly Session[], forYouCount: number): TopCounts {
  return {
    live: sessions.filter((s) => LIVE.has(s.state)).length,
    asleep: sessions.filter((s) => s.state === "snoozed").length,
    forYou: forYouCount,
  };
}

/** "3.2 KB" style size for the loaded-files list. */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** HH:MM local, for the approved log. */
export function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
