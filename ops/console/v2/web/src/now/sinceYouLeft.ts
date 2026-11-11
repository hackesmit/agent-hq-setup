// Since You Left: turning the stream into a diff.
//
// The console already records everything that happened overnight; it just has no idea
// what has and has not been read. One marker fixes that. This module is the pure part,
// so the counting rules are testable without a DOM: which events are new, how they add
// up, and when the ribbon should not appear at all.
import type { ActivityEvent, ConsoleState, Request } from "@shared/api";

/** Below this, you were not really away, and a ribbon would just be noise. */
export const MIN_AWAY_MS = 45 * 60 * 1000;

/** The server caps the stream; past that the counts are a floor, not a total. */
export const ACTIVITY_CAP = 200;

export interface AwaySummary {
  /** false when the ribbon should not render at all. */
  show: boolean;
  since: string | null;
  awayMs: number;
  /** true when the stream was truncated, so counts are "at least". */
  truncated: boolean;
  counts: {
    commits: number;
    merges: number;
    errors: number;
    asks: number;
    asksOpen: number;
    dispatches: number;
    finishes: number;
  };
  total: number;
}

const EMPTY: AwaySummary["counts"] = {
  commits: 0,
  merges: 0,
  errors: 0,
  asks: 0,
  asksOpen: 0,
  dispatches: 0,
  finishes: 0,
};

function ms(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/** Events newer than the marker, newest first (the stream is already sorted). */
export function newEvents(activity: ActivityEvent[], since: string | null): ActivityEvent[] {
  if (!since) return [];
  const cut = ms(since);
  if (!cut) return [];
  return activity.filter((e) => ms(e.ts) > cut);
}

/**
 * What happened while you were gone. `since` is the marker; `now` is passed in so the
 * away duration is testable. A null marker means the console has never been marked
 * read, which is not the same as "nothing happened": the ribbon stays hidden and the
 * first press sets the baseline.
 */
export function summarize(
  state: Pick<ConsoleState, "activity" | "requests"> | null,
  since: string | null,
  now: number,
): AwaySummary {
  const activity = state?.activity ?? [];
  const awayMs = since ? Math.max(0, now - ms(since)) : 0;
  const base: AwaySummary = {
    show: false,
    since,
    awayMs,
    truncated: activity.length >= ACTIVITY_CAP,
    counts: { ...EMPTY },
    total: 0,
  };
  if (!since || awayMs < MIN_AWAY_MS) return base;

  const fresh = newEvents(activity, since);
  const counts = { ...EMPTY };
  for (const e of fresh) {
    switch (e.type) {
      case "commit":
        counts.commits += 1;
        break;
      case "merge":
        counts.merges += 1;
        break;
      case "error":
        counts.errors += 1;
        break;
      case "ask":
        counts.asks += 1;
        break;
      case "dispatch":
        counts.dispatches += 1;
        break;
      case "finish":
        counts.finishes += 1;
        break;
      default:
        break;
    }
  }
  // Of the asks raised while away, how many are still sitting there. This comes from
  // the live request list rather than the stream, because an ask that was answered
  // while away is not something to walk back into.
  const openRequests: Request[] = (state?.requests ?? []).filter((r) => r.state === "open");
  counts.asksOpen = openRequests.filter((r) => ms(r.createdAt) > ms(since)).length;

  const total = counts.commits + counts.merges + counts.errors + counts.asks + counts.dispatches + counts.finishes;
  return { ...base, show: total > 0, counts, total };
}

/** "8h 12m", "52m". Short enough for a ribbon head. */
export function awayLabel(awayMs: number): string {
  const mins = Math.max(0, Math.round(awayMs / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** The clock time the marker was set, for "since 23:14". */
export function sinceLabel(since: string | null): string {
  if (!since) return "";
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * Where to draw the horizon rule in a rendered list: the index of the first event that
 * is NOT new, or -1 when every event is new or none is.
 */
export function horizonIndex(events: ActivityEvent[], since: string | null): number {
  if (!since) return -1;
  const cut = ms(since);
  if (!cut) return -1;
  const i = events.findIndex((e) => ms(e.ts) <= cut);
  return i <= 0 ? -1 : i;
}
