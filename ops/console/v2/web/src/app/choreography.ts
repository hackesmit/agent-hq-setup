// Choreography: who moves, when, and how much.
//
// This console is not driven by a user clicking. Agents finish, fail and ask at
// unpredictable times, often at once, so arrival choreography is the hard
// problem rather than any individual easing. These are the motion package's
// rules as code, kept pure so they can be tested without a DOM.
//
// Rule 1  a batch is ONE event with n bodies: reading order 45ms apart, the
//         whole batch beginning inside a single move, and one call for the lot.
//         A P0 preempts, landing alone with the call while everything else
//         holds a shift and follows fade-only. Past twenty items the console
//         stops itemising and presents a digest.
// Rule 2  repetition decays, per event type per surface: full, then quiet, then
//         a mark. The four hundredth arrival must not shout like the first.
// Rule 3  nothing vanishes. It resolves in place, holds long enough to read,
//         leaves the way it came, and is counted.

export type DecayLevel = "full" | "quiet" | "mark";

export interface ArrivalItem {
  id: string;
  /** P0 preempts the batch. Everything else is ordinary. */
  severity?: "P0" | "P1" | "P2" | null;
  /** Event type, for per-type decay ("ask", "finish", "commit"). */
  type?: string;
}

export interface Placed {
  id: string;
  /** ms after the batch starts. Zero for a preempting P0. */
  delayMs: number;
  decay: DecayLevel;
  /** Exactly one item in a batch carries the call. */
  call: boolean;
}

export interface BatchPlan {
  items: Placed[];
  /** Set when the batch was too large to itemise. */
  digest: { count: number; note: string } | null;
  /** What a screen reader is told, once, for the whole batch. */
  announce: string;
}

export const STAGGER_MS = 45;
export const MAX_ITEMISED = 20;
/** Past nine items the stagger compresses so the batch still lands in one move. */
export const COMPRESS_AFTER = 9;
export const MOVE_MS = 360;

/** Per-type, per-surface memory of when this kind of thing last arrived. */
export type DecayMemory = Map<string, number>;

/** An arrival within the window of the last of its type drops a level. */
export function decayFor(type: string, now: number, memory: DecayMemory,
                         windowMs = 5 * 60_000): DecayLevel {
  const last = memory.get(type);
  memory.set(type, now);
  if (last === undefined) return "full";
  const gap = now - last;
  if (gap > windowMs) return "full";
  if (gap > windowMs / 5) return "quiet";
  return "mark";
}

/**
 * Place a batch. The stagger compresses past nine items so that even a large
 * batch begins and ends inside one move: a list that takes three seconds to
 * finish arriving reads as a fault, not as choreography.
 */
export function planBatch(items: ArrivalItem[], now = 0,
                          memory: DecayMemory = new Map()): BatchPlan {
  if (items.length === 0) {
    return { items: [], digest: null, announce: "" };
  }

  const p0s = items.filter((i) => i.severity === "P0");
  const rest = items.filter((i) => i.severity !== "P0");

  // past twenty, stop itemising: a stampede is one fact, not twenty
  if (items.length > MAX_ITEMISED) {
    return {
      items: p0s.map((i) => ({ id: i.id, delayMs: 0, decay: "full" as DecayLevel, call: true })),
      digest: { count: items.length, note: `${items.length} events` },
      announce: p0s.length
        ? `${p0s.length} urgent, and ${items.length} events in total`
        : `${items.length} events`,
    };
  }

  const placed: Placed[] = [];

  // a P0 preempts: it lands alone, on the beat, carrying the batch's one call
  p0s.forEach((i) => {
    placed.push({ id: i.id, delayMs: 0, decay: "full", call: true });
  });

  // everything else holds one shift when a P0 took the stage, then follows.
  // It is fade-only in that case, so the P0 wins the eye without the rest
  // vanishing: the P0 borrows the batch's motion budget rather than silencing it.
  const offset = p0s.length ? 180 : 0;
  const span = Math.max(1, rest.length - 1);
  const step = rest.length > COMPRESS_AFTER
    ? Math.max(8, Math.floor((MOVE_MS - 60) / span))
    : STAGGER_MS;

  rest.forEach((item, idx) => {
    const decay = p0s.length
      ? "quiet"
      : decayFor(item.type ?? "generic", now, memory);
    placed.push({
      id: item.id,
      delayMs: offset + idx * step,
      // one call for the lot, and only if nothing more urgent already took it
      call: !p0s.length && idx === 0 && decay === "full",
      decay,
    });
  });

  const announce = p0s.length
    ? (rest.length ? `urgent, and ${rest.length} more` : "urgent")
    : `${rest.length} ${rest.length === 1 ? "item" : "items"}`;

  return { items: placed, digest: null, announce };
}

/** Rule 3: resolve in place, hold long enough to read, leave the way it came. */
export const DEPARTURE = {
  markMs: 180,     // shift: the card shows its resolution where it stands
  holdMs: 720,     // scene: still, long enough to read what happened
  leaveMs: 360,    // move: up and out, the arrival reversed
} as const;

export function departureTotalMs(): number {
  return DEPARTURE.markMs + DEPARTURE.holdMs + DEPARTURE.leaveMs;
}
