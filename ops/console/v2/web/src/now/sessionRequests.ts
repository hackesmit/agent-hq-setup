// Questions live on the terminal that asked them (the owner, 2026-10-20). There is no
// Needs-you panel any more: an agent asks in its own terminal and waits there, and
// that terminal's card carries the waiting mark, the question and an answer box.
//
// This splits the request list three ways:
//   bySession  open questions whose asking session is still on the card list
//   orphans    open questions with no live asker (no session bound, or the session
//              is gone): a short list at the foot of the Sessions card keeps them
//              answerable, so nothing filed before this change is stranded
//   snoozed    deferred questions, folded away until they wake
//   delivering answered questions whose answer has not reached the asking terminal
//              (the one typing attempt failed, and it is never retried, so it can
//              never be typed twice), kept on that terminal's card so a lost
//              delivery is visible instead of silent
//   undelivered the same, for an asker that is not on the card list (its session
//              ended or looks ended, or none was bound): listed at the foot of the
//              Sessions card, so no answer drops off the board (hq-zqqu.1 round 3)
//
// Pure on purpose, so the routing is tested without rendering anything.

import type { Request, Session } from "@shared/api";
import { isActionable, snoozedRequests, sortRequests } from "./lanes";
import { isLive } from "./sessions";

export interface RoutedRequests {
  bySession: Map<string, Request[]>;
  orphans: Request[];
  snoozed: Request[];
  delivering: Map<string, Request[]>;
  undelivered: Request[];
}

const DELIVERING: readonly Request["state"][] = ["answered", "revival_claimed"];

export function routeRequests(requests: readonly Request[], sessions: readonly Session[]): RoutedRequests {
  // A snoozed session still shows its card (under "snoozed"), so its question goes there.
  const shown = new Set(sessions.filter((s) => isLive(s) || s.state === "snoozed").map((s) => s.id));
  const bySession = new Map<string, Request[]>();
  const orphans: Request[] = [];
  for (const request of sortRequests(requests.filter(isActionable))) {
    const sid = request.session;
    if (sid && shown.has(sid)) {
      const list = bySession.get(sid) ?? [];
      list.push(request);
      bySession.set(sid, list);
    } else {
      orphans.push(request);
    }
  }
  const delivering = new Map<string, Request[]>();
  const undelivered: Request[] = [];
  for (const request of requests) {
    if (!DELIVERING.includes(request.state)) continue;
    const sid = request.session;
    if (!sid || !shown.has(sid)) {
      undelivered.push(request);
      continue;
    }
    const list = delivering.get(sid) ?? [];
    list.push(request);
    delivering.set(sid, list);
  }
  return { bySession, orphans, snoozed: snoozedRequests(requests), delivering, undelivered };
}

/**
 * Whether the Sessions panel is open after the layout changes. A wide screen always
 * shows it. Entering the phone layout folds it away, unless a question is already
 * waiting: then it stays open, because a waiting question is the first thing a small
 * screen must show (lucy, hq-zqqu.1 round 1). Only the layout change calls this, so a
 * fold the owner makes himself afterwards sticks.
 */
export function openAfterLayoutChange(collapsible: boolean, waiting: number): boolean {
  return !collapsible || waiting > 0;
}

/**
 * Whether a session card may offer Clear on an answer that has not reached its
 * terminal. A running headless worker picks an answer up on its next poll (ask
 * --wait) or revival, so clearing it there would cancel an answer it is about to
 * take; only an interactive terminal (or Capri), which has no poll, gets Clear on
 * its card. An answer whose session is gone is cleared from the foot list instead
 * (hq-zqqu.1 round 4).
 */
export function cardMayClear(session: Pick<Session, "kind">): boolean {
  return session.kind !== "worker";
}

/** Open questions in total: what the top strip counts as "waiting". */
export function waitingCount(requests: readonly Request[]): number {
  return requests.filter(isActionable).length;
}
