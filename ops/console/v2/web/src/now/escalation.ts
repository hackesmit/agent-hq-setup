// Set-piece 2: a question ages.
//
// Urgency accumulates as STATE; motion spends only at the thresholds. This is
// the opposite of a loop, and deliberately so: a card that pulses for four
// hours is furniture by minute ten, and the thing it was trying to say stops
// being heard exactly when it starts to matter.
//
// So the card climbs a ladder of static escalations, and rings once at each
// step. Almost none of this is animation, which is why it still reads as urgent
// after an afternoon of being ignored.
//
//   fresh        amber border and dot. No age shown: a fresh question is not
//                yet a debt, and stamping one with a clock makes every question
//                look overdue.
//   T1  30 min   the age chip appears. State only, no motion, no sound. It now
//                says how long he has owed an answer.
//   T2  2 hours  the surface steps up, the chip turns amber, one ring and one
//                soft re-ask pip. Then still again.
//   T3  4 hours  promoted: red border, dot and chip, three rings, and the
//                announcement goes assertive.
//
// Under reduced motion this is identical, because the ladder is already static:
// the rings become a doubled border and the pips remain.

export type Tier = "fresh" | "t1" | "t2" | "t3";

export const T1_MS = 30 * 60_000;
export const T2_MS = 2 * 60 * 60_000;
export const T3_MS = 4 * 60 * 60_000;

export interface AgeState {
  tier: Tier;
  /** Shown from T1. Null while the question is still fresh. */
  ageLabel: string | null;
  /** True only on the tick the card crosses a threshold: motion spends here. */
  ring: boolean;
  /** How many rings that crossing is worth. */
  rings: number;
  /** Screen readers get told again, more insistently, at the top of the ladder. */
  politeness: "polite" | "assertive";
}

export function tierFor(ageMs: number): Tier {
  if (ageMs >= T3_MS) return "t3";
  if (ageMs >= T2_MS) return "t2";
  if (ageMs >= T1_MS) return "t1";
  return "fresh";
}

/** "34m", "2h 10m". Short enough for a chip, exact enough to feel owed. */
export function formatAge(ageMs: number): string {
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * @param lastTier the tier this card was last seen at, so a crossing rings once
 *                 rather than on every render.
 */
export function ageState(ageMs: number, lastTier: Tier | null = null): AgeState {
  const tier = tierFor(ageMs);
  const crossed = lastTier !== null && lastTier !== tier;
  return {
    tier,
    ageLabel: tier === "fresh" ? null : formatAge(ageMs),
    // T1 is state only: it says he owes an answer, it does not interrupt to say so
    ring: crossed && (tier === "t2" || tier === "t3"),
    rings: tier === "t3" ? 3 : 1,
    politeness: tier === "t3" ? "assertive" : "polite",
  };
}

/** The class the card wears at each rung. The look is CSS; this is the name. */
export function tierClass(tier: Tier): string {
  return tier === "fresh" ? "" : `hq-aged hq-aged--${tier}`;
}
