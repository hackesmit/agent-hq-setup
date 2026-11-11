// Tab badge model (design doc section 4, global chrome).
//
// The server owns badges and ships them on ConsoleState. deriveBadges recomputes the same
// numbers from the raw slices: it is the fallback when a state payload arrives without the
// field, and it is what the tests pin, so a server-side drift is visible rather than silent.

import type { ConsoleState, ReportsSummary, Severity } from "@shared/api";
import type { TabId } from "./routes";
import { attentionCount } from "../board/board";

export type BadgeTone = "p0" | "p1" | "neutral" | "none";

export interface TabBadge {
  count: number;
  tone: BadgeTone;
}

const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };

export function highestSeverity(severities: readonly Severity[]): Severity | null {
  let best: Severity | null = null;
  for (const severity of severities) {
    if (best === null || SEVERITY_RANK[severity] < SEVERITY_RANK[best]) best = severity;
  }
  return best;
}

export function badgeTone(count: number, severity: Severity | null): BadgeTone {
  if (count <= 0) return "none";
  if (severity === "P0") return "p0";
  if (severity === "P1") return "p1";
  return "neutral";
}

export function deriveBadges(state: ConsoleState | null): ConsoleState["badges"] {
  if (!state) return { now: 0, nowSeverity: null, projects: 0, stack: 0, machines: 0 };

  const open = (state.requests ?? []).filter((request) => request.state === "open");
  const nowSeverity = highestSeverity(open.map((request) => request.severity));

  // Projects badge counts what Now does not already show: work that is stuck or late.
  const projects = (state.projects ?? []).filter(
    (project) => project.attention === "blocked" || project.attention === "late",
  ).length;

  // Machines badge counts failing collectors (a failed collector is a failing service line).
  const machines = (state.collectors ?? []).filter((collector) => collector.error !== null).length;

  return {
    now: open.length,
    nowSeverity,
    projects,
    stack: state.badges?.stack ?? 0,
    machines,
  };
}

export function resolveBadges(state: ConsoleState | null): ConsoleState["badges"] {
  return state?.badges ?? deriveBadges(state);
}

/**
 * The waiting count on the top strip. The Needs-you panel and its tab badge are gone
 * (the owner, 2026-10-20), but the count is not: every open question, wherever its card
 * is, is counted here and shown on every tab. p0 marks a P0 among them.
 */
export function waitingStrip(state: ConsoleState | null): { count: number; p0: boolean } {
  const { now, nowSeverity } = resolveBadges(state);
  return { count: now, p0: now > 0 && nowSeverity === "P0" };
}

export function tabBadges(state: ConsoleState | null): Record<TabId, TabBadge> {
  const badges = resolveBadges(state);
  return {
    // No Needs-you badge (the owner, 2026-10-20): a question shows as a waiting mark on the
    // asking terminal's card, and the top strip counts what waits. The count stays on
    // resolveBadges for that strip.
    now: { count: 0, tone: "none" },
    // How many terminals are attachable, which is what the tab is for. Neutral
    // tone always: an open terminal is a state of work, never a thing demanding
    // attention, and a coloured badge here would compete with the ones that are.
    terminals: { count: (state?.sessions ?? []).filter((s) => s.attachable !== false && s.state !== "closed").length, tone: "none" },
    // Projects that are waiting on the owner or stuck: a glance, not an alarm.
    board: { count: attentionCount(state?.board?.projects ?? []), tone: "neutral" },
    projects: { count: badges.projects, tone: badgeTone(badges.projects, null) },
    stack: { count: badges.stack, tone: badgeTone(badges.stack, null) },
    machines: { count: badges.machines, tone: badgeTone(badges.machines, "P1") },
    money: { count: 0, tone: "none" },
    // Escalated incidents: each one is an error no fixer could close, so it needs the owner.
    errors: { count: state?.errors?.counts?.escalated ?? 0, tone: badgeTone(state?.errors?.counts?.escalated ?? 0, "P1") },
    reports: { count: 0, tone: "none" },
  };
}

export interface ReportsIndicator {
  /** The count on the icon, or null for no count (none unread, or nothing known yet). */
  label: string | null;
  /** The store could not be read: shown as a mark, never as zero (hq-o6wn.4 review). */
  unavailable: boolean;
  title: string;
}

export const REPORTS_CAP = 99;

/**
 * The unread reports icon in the top strip (hq-o6wn.6). Reads the summary, not
 * badges.reports: the server folds an unreadable store into a 0 there, and zero is the
 * one thing an unreadable store must not look like.
 */
export function reportsIndicator(summary: ReportsSummary | null | undefined): ReportsIndicator {
  if (!summary) return { label: null, unavailable: false, title: "Reports" };
  if (summary.unread === null || summary.total === null) {
    return { label: "!", unavailable: true, title: `Reports: the store could not be read${summary.error ? ` (${summary.error})` : ""}` };
  }
  const unread = Math.max(0, Math.floor(summary.unread));
  if (unread === 0) return { label: null, unavailable: false, title: "Reports: nothing unread" };
  return {
    label: unread > REPORTS_CAP ? `${REPORTS_CAP}+` : String(unread),
    unavailable: false,
    title: `Reports: ${unread} unread`,
  };
}
