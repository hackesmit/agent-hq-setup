// Turning a hardware figure into an answer.
//
// the owner, on the live console: "If I see 52 degrees, I might not know if that's
// good or bad. If I see it on a scale that has a temperature gradient, I can kind
// of see where we're at."
//
// That is the whole brief, and it is a real gap rather than a decorative one: a
// bare number requires the reader to already know the hardware. Every figure on
// the Machines tab should say where it sits between fine and not, so the position
// carries the meaning and the digits are only the detail.
//
// The thresholds below are deliberately conservative and deliberately explained.
// A scale that marks the wrong place is worse than no scale, because it makes a
// judgement look measured.

export type Band = "ok" | "warn" | "bad";

export interface Scale {
  /** Where the scale starts and ends, in the metric's own unit. */
  min: number;
  max: number;
  /** Above this is worth noticing; above `bad` is worth acting on. */
  warn: number;
  bad: number;
  unit: string;
  /** What the top of the scale means, for the label under it. */
  ceiling: string;
}

/**
 * CPU: a busy box is doing its job, so this is generous. Sustained high CPU on a
 * machine whose whole purpose is running agent sessions is expected, not alarming.
 */
export const CPU: Scale = { min: 0, max: 100, warn: 80, bad: 95, unit: "%", ceiling: "all cores busy" };

/**
 * Memory: the danger is not being full, it is being full enough to swap. 85 is
 * where a box this size starts trading, and 95 is where it starts thrashing.
 */
export const MEM: Scale = { min: 0, max: 100, warn: 85, bad: 95, unit: "%", ceiling: "no memory left" };

/**
 * Load, normalised by core count so the scale means the same on any machine:
 * 1.0 is exactly saturated, which is fine and sustainable. Past that, work is
 * queueing. The scale runs to 2 because beyond twice saturated the exact figure
 * stops mattering.
 */
export const LOAD: Scale = { min: 0, max: 2, warn: 1, bad: 1.5, unit: "x", ceiling: "twice saturated" };

/**
 * Temperature. The one figure where the number genuinely means nothing without
 * the scale, and the reason this module exists.
 *
 * An Intel mini PC throttles at around 100 degrees, so that is the ceiling and
 * it is a hard physical fact rather than a preference. 80 is where sustained
 * running shortens component life; 90 is close enough to throttling to act on.
 * The scale starts at 30 rather than 0 because a running box is never near 0 and
 * a scale mostly made of impossible values wastes the part that matters.
 */
export const TEMP: Scale = { min: 30, max: 100, warn: 80, bad: 90, unit: "C", ceiling: "thermal throttle" };

/** Which band a value falls in. */
export function bandOf(value: number | null | undefined, scale: Scale): Band | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (value >= scale.bad) return "bad";
  if (value >= scale.warn) return "warn";
  return "ok";
}

/** Where a value sits on its scale, 0 to 1, clamped to the ends. */
export function positionOn(value: number | null | undefined, scale: Scale): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const span = scale.max - scale.min;
  if (span <= 0) return null;
  return Math.min(1, Math.max(0, (value - scale.min) / span));
}

/** The same, for a threshold, so the mark and the needle share one geometry. */
export function markAt(threshold: number, scale: Scale): number {
  return positionOn(threshold, scale) ?? 0;
}

/**
 * The figure as the interface shows it.
 *
 * Rounding to a whole number is right for a percentage and for degrees and WRONG
 * for the load ratio, which lives between 0 and 2: a quarter-loaded box read
 * "Load 0, normal", which is a sentence that says nothing and looks broken. The
 * spoken figure and the drawn figure now come from the same function, so they
 * cannot drift apart again.
 */
export function fmtValue(value: number, scale: Scale): string {
  return scale.max <= 2 ? value.toFixed(2) : String(Math.round(value));
}

/**
 * A sentence for the figure, so the judgement survives for a screen reader and
 * for anyone who cannot separate the gradient's colours.
 */
export function readingOf(value: number | null | undefined, scale: Scale, label: string): string {
  const band = bandOf(value, scale);
  if (band === null) return `${label}: no reading`;
  const shown = `${fmtValue(value as number, scale)}${scale.unit === "x" ? "" : scale.unit}`;
  if (band === "bad") return `${label} ${shown}, past ${scale.bad}${scale.unit}, act on this`;
  if (band === "warn") return `${label} ${shown}, above ${scale.warn}${scale.unit}, worth watching`;
  return `${label} ${shown}, normal`;
}

/** Trend over the tail of a series: is it going somewhere, and how fast. */
export function trendOf(series: (number | null)[], tail = 20): "rising" | "falling" | "steady" | null {
  const usable = series.filter((n): n is number => n !== null && Number.isFinite(n));
  if (usable.length < 4) return null;
  const window = usable.slice(-tail);
  const half = Math.floor(window.length / 2);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const before = mean(window.slice(0, half));
  const after = mean(window.slice(half));
  const span = Math.abs(before) > 0 ? Math.abs(after - before) / Math.abs(before) : Math.abs(after - before);
  // Under a tenth of the level is noise on a box that is doing anything at all.
  if (span < 0.1) return "steady";
  return after > before ? "rising" : "falling";
}
