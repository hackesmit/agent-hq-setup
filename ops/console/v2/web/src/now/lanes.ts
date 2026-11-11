// Needs-you lane grouping (design doc 4.1): three lanes, P0 first, oldest first inside a
// lane, because the oldest P0 is what has been blocking a worker the longest.
//
// Only `open` requests sit in a lane. Settled cards (answered, resolved, cancelled,
// delivered) leave the lanes at once and are shown faded for 2 minutes keyed on
// `settledAt`, so an accidental Skip is visible and undoable-by-asking before it vanishes.
// Snoozed cards come back on their own schedule and are listed apart until then.

import type { Request, RequestState, Severity } from "@shared/api";

export const LANE_ORDER: readonly Severity[] = ["P0", "P1", "P2"] as const;

export const LANE_LABELS: Record<Severity, string> = {
  P0: "P0, now",
  P1: "P1, next digest",
  P2: "P2, whenever",
};

export interface Lane {
  severity: Severity;
  label: string;
  items: Request[];
}

const LANE_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };

/** How long a settled card stays on screen, faded, before it disappears. */
export const FADE_MS = 2 * 60_000;

/** Opacity floor at the end of the fade window. */
export const FADE_FLOOR = 0.3;

export const SETTLED_STATES: readonly RequestState[] = [
  "answered",
  "resolved",
  "cancelled",
  "delivered",
] as const;

/** Cards that still want an answer. */
export function isActionable(request: Request): boolean {
  return request.state === "open";
}

/** Cards that got their answer (or were dismissed) and are on their way out. */
export function isSettled(request: Request): boolean {
  return SETTLED_STATES.includes(request.state);
}

/**
 * When the card settled, as a comparable number. `settledAt` is the contract field and is
 * what the fade is keyed on; a server that has not filled it yet falls back to the
 * creation time, which at worst hides the card sooner than 2 minutes rather than pinning
 * a stale card to the tab forever.
 */
export function settledMs(request: Request): number | null {
  const settled = request.settledAt ? Date.parse(request.settledAt) : Number.NaN;
  if (!Number.isNaN(settled)) return settled;
  const created = Date.parse(request.createdAt);
  return Number.isNaN(created) ? null : created;
}

/** True while a settled card is still inside its fade window. */
export function isFading(request: Request, now: number = Date.now(), windowMs: number = FADE_MS): boolean {
  if (!isSettled(request)) return false;
  const at = settledMs(request);
  if (at === null) return false;
  const elapsed = now - at;
  return elapsed >= 0 ? elapsed <= windowMs : true;
}

/** 1 right after settling, FADE_FLOOR at the end of the window. */
export function fadeOpacity(request: Request, now: number = Date.now(), windowMs: number = FADE_MS): number {
  const at = settledMs(request);
  if (at === null) return FADE_FLOOR;
  const ratio = Math.max(0, Math.min(1, (now - at) / windowMs));
  return Math.round((1 - ratio * (1 - FADE_FLOOR)) * 100) / 100;
}

/** Settled cards still inside the window, most recently settled first. */
export function fadingRequests(requests: readonly Request[], now: number = Date.now(), windowMs: number = FADE_MS): Request[] {
  return requests
    .filter((request) => isFading(request, now, windowMs))
    .sort((a, b) => (settledMs(b) ?? 0) - (settledMs(a) ?? 0));
}

function createdMs(request: Request): number {
  const parsed = Date.parse(request.createdAt);
  if (!Number.isNaN(parsed)) return parsed;
  // Fall back to the server-computed age when the timestamp is unusable.
  return Number.MAX_SAFE_INTEGER - request.ageSeconds * 1000;
}

/** Age in seconds that ticks locally instead of waiting for the next state push. */
export function liveAgeSeconds(request: Request, now: number = Date.now()): number {
  const created = Date.parse(request.createdAt);
  if (Number.isNaN(created)) return request.ageSeconds;
  return Math.max(0, (now - created) / 1000);
}

/** P0 first; oldest first within a lane; id as the last tie-break so order is stable. */
export function compareRequests(a: Request, b: Request): number {
  const bySeverity = LANE_RANK[a.severity] - LANE_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  const byAge = createdMs(a) - createdMs(b);
  if (byAge !== 0) return byAge;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortRequests(requests: readonly Request[]): Request[] {
  return [...requests].sort(compareRequests);
}

export function groupRequests(requests: readonly Request[]): Lane[] {
  const actionable = sortRequests(requests.filter(isActionable));
  return LANE_ORDER.map((severity) => ({
    severity,
    label: LANE_LABELS[severity],
    items: actionable.filter((request) => request.severity === severity),
  }));
}

/** The open cards in lane order, flattened: the order j/k walks. */
export function orderedOpen(requests: readonly Request[]): Request[] {
  return groupRequests(requests).flatMap((lane) => lane.items);
}

export function openCount(requests: readonly Request[]): number {
  return requests.filter(isActionable).length;
}

export function oldestOpenSeconds(requests: readonly Request[], now?: number): number {
  let oldest = 0;
  for (const request of requests) {
    if (!isActionable(request)) continue;
    const age = now === undefined ? request.ageSeconds : liveAgeSeconds(request, now);
    if (age > oldest) oldest = age;
  }
  return oldest;
}

function wakeMs(request: Request): number {
  const parsed = Date.parse(request.snoozedUntil ?? "");
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

/** Snoozed cards, next to wake first. */
export function snoozedRequests(requests: readonly Request[]): Request[] {
  return requests
    .filter((request) => request.state === "snoozed")
    .sort((a, b) => wakeMs(a) - wakeMs(b) || (a.id < b.id ? -1 : 1));
}

/** Only http(s) links are ever rendered, whatever the server sends. */
export function safeLink(link: string | null): string | null {
  if (!link) return null;
  const trimmed = link.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}
