// What an incoming full state may replace. A server that just restarted
// compiles its first state cold: a collector that failed its first run
// contributes an empty placeholder (its row in state.collectors has
// updatedAt null and an error), and a compile that failed outright arrives
// as state null. Applying either verbatim is what made the whole console
// appear to wipe itself after a deploy, so a full state can only ever
// upgrade what the page is showing: placeholders and null keep the data
// already on screen. The next successful collector run broadcasts its slice
// and overwrites the held value the normal way.

import type { ConsoleState } from "@shared/api";

/**
 * Slices whose value in this state is a placeholder, not an observation:
 * their collector has never succeeded on this server process. Collector
 * names equal ConsoleState keys.
 */
export function placeholderSlices(state: ConsoleState): string[] {
  return (state.collectors ?? [])
    .filter((c) => c.updatedAt === null && c.error)
    .map((c) => c.name);
}

/**
 * A full state that was compiled BEFORE the one already showing. A slow poll
 * can resolve after the socket has delivered a fresher hello; applying it
 * would flash the board backwards. Slice broadcasts do not advance
 * generatedAt, so this only orders full states against full states, which is
 * exactly the race that exists.
 */
export function isStaleFullState(current: ConsoleState | null, incoming: ConsoleState): boolean {
  if (!current?.generatedAt || !incoming.generatedAt) return false;
  const a = Date.parse(current.generatedAt);
  const b = Date.parse(incoming.generatedAt);
  return Number.isFinite(a) && Number.isFinite(b) && b < a;
}

/**
 * The state the page should show after a full state arrives (hello or poll).
 * A null `incoming` keeps the current state wholesale; placeholder slices
 * keep their current value. Returns null only when there is nothing to show
 * at all: no current state and no incoming.
 */
export function mergeState(current: ConsoleState | null, incoming: ConsoleState | null): ConsoleState | null {
  if (!incoming) return current;
  if (!current) return incoming;
  const failed = placeholderSlices(incoming);
  if (failed.length === 0) return incoming;
  const merged: Record<string, unknown> = { ...incoming };
  const held = current as unknown as Record<string, unknown>;
  for (const name of failed) {
    if (name in held) merged[name] = held[name];
  }
  return merged as unknown as ConsoleState;
}
