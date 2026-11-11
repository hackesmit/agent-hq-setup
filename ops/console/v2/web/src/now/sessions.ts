// Session ordering and derived bits, kept pure so the row component stays presentational.
//
// Order (design doc 4.1): whatever is waiting on the owner comes first, then what is running,
// then the quiet ones, then what is finished, then what is asleep. Inside a state the
// oldest activity comes first, because a session that has been silent longest is the one
// most likely to be stuck.

import type { ProjectSummary, Session, SessionState } from "@shared/api";

export const STATE_RANK: Record<SessionState, number> = {
  waiting: 0,
  running: 1,
  draining: 2,
  idle: 3,
  finishable: 4,
  snoozed: 5,
  closed: 6,
};

export const STATE_TEXT: Record<SessionState, string> = {
  running: "running",
  waiting: "waiting on you",
  idle: "idle",
  finishable: "finishable",
  snoozed: "snoozed",
  draining: "draining",
  closed: "closed",
};

export const STATE_DOT: Record<SessionState, string> = {
  running: "bg-ok",
  waiting: "bg-p1 hq-waiting-ring",
  idle: "bg-faint",
  finishable: "bg-accent",
  snoozed: "bg-p2",
  draining: "bg-warn",
  closed: "bg-faint",
};

export const LIVE_STATES: SessionState[] = ["running", "waiting", "idle", "finishable", "draining"];

export function isLive(session: Session): boolean {
  return LIVE_STATES.includes(session.state);
}

/** Last time the session did anything, as a comparable number. */
export function activityMs(session: Session): number {
  const stamp = session.lastActivityAt ?? session.startedAt;
  const parsed = Date.parse(stamp ?? "");
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

export function compareSessions(a: Session, b: Session): number {
  const byState = (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9);
  if (byState !== 0) return byState;
  const byAge = activityMs(a) - activityMs(b);
  if (byAge !== 0) return byAge;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortSessions(sessions: readonly Session[]): Session[] {
  return [...sessions].sort(compareSessions);
}

export interface PhaseProgress {
  done: number;
  total: number;
  current: string | null;
  ratio: number;
}

export function phaseProgress(session: Session): PhaseProgress {
  const total = session.phases.length;
  const done = session.phases.filter((phase) => phase.done).length;
  const current = session.phases.find((phase) => !phase.done)?.name ?? null;
  return { done, total, current, ratio: total === 0 ? 0 : done / total };
}

/** Label shown on the row: the operator's name if set, else the task, else the bead. */
export function sessionLabel(session: Session): string {
  return session.name ?? session.task ?? session.bead ?? session.id;
}

/** Rigs worth offering in a "new terminal" picker, in a stable order. */
export function knownRigs(...sources: readonly (readonly (string | null)[])[]): string[] {
  const seen = new Set<string>();
  for (const source of sources) {
    for (const rig of source) {
      if (rig) seen.add(rig);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * What the NEW-TERMINAL picker may offer. Stricter than the capture picker: a
 * bead can be filed against any project, but a terminal can only start in a
 * directory that exists on this box, and offering the rest produced spawns that
 * died on the cd with no visible error. A project the server marked
 * unspawnable stays out even when a ready bead or an old session names it (the
 * ready/session lists would otherwise smuggle it back in). Ids the registry
 * does not know (worktrees, sessions from before the registry) stay offered,
 * and an older server with no spawnable field yet blocks nothing.
 */
export function terminalRigs(
  projects: readonly Pick<ProjectSummary, "id" | "spawnable">[],
  ...rest: readonly (readonly (string | null)[])[]
): string[] {
  const blocked = new Set(projects.filter((p) => p.spawnable === false).map((p) => p.id));
  return knownRigs(
    projects.filter((p) => p.spawnable !== false).map((p) => p.id),
    ...rest,
  ).filter((id) => !blocked.has(id));
}
