// Snooze presets, shared by request cards and session rows.
//
// Everything is computed in the browser's local time, because "tonight" and "tomorrow
// 9:00" are the owner's hours, not UTC. The wire format is always an ISO instant.

export type SnoozePresetId = "1h" | "tonight" | "tomorrow";

/**
 * ISO instant at whole-second precision. Date.toISOString() emits milliseconds
 * ("2026-10-09T09:00:00.000Z"); the server and ctl.sh accept a when of
 * [ A-Za-z0-9:+-] only, so the dot was rejected as "bad when" and every snooze,
 * preset or custom, failed. GNU date parses the second-precision form.
 */
export function wireIso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface SnoozeChoice {
  id: SnoozePresetId;
  label: string;
  at: Date;
  iso: string;
}

export const TONIGHT_HOUR = 20;
export const MORNING_HOUR = 9;

/** Minimum distance to "tonight" before it rolls to the next evening. */
export const TONIGHT_MIN_LEAD_MS = 5 * 60_000;

function atLocalHour(from: Date, dayOffset: number, hour: number): Date {
  const at = new Date(from.getFullYear(), from.getMonth(), from.getDate() + dayOffset, hour, 0, 0, 0);
  return at;
}

/** now + one hour. */
export function inOneHour(now: Date): Date {
  return new Date(now.getTime() + 3_600_000);
}

/** The next 20:00 local. Rolls to tomorrow when tonight is already here or nearly here. */
export function tonight(now: Date): Date {
  const today = atLocalHour(now, 0, TONIGHT_HOUR);
  if (today.getTime() - now.getTime() >= TONIGHT_MIN_LEAD_MS) return today;
  return atLocalHour(now, 1, TONIGHT_HOUR);
}

/** Tomorrow at 09:00 local, always the next calendar day. */
export function tomorrowMorning(now: Date): Date {
  return atLocalHour(now, 1, MORNING_HOUR);
}

export function snoozePresets(now: Date = new Date()): SnoozeChoice[] {
  const choices: { id: SnoozePresetId; label: string; at: Date }[] = [
    { id: "1h", label: "1 h", at: inOneHour(now) },
    { id: "tonight", label: "tonight", at: tonight(now) },
    { id: "tomorrow", label: "tomorrow 9:00", at: tomorrowMorning(now) },
  ];
  return choices.map((choice) => ({ ...choice, iso: wireIso(choice.at) }));
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Value for an <input type="datetime-local">, in local time. */
export function toLocalInput(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * Parse a datetime-local value as local time. Returns null when the value is empty or
 * unparseable, so a custom snooze can never send an "Invalid Date" to the server.
 */
export function fromLocalInput(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    s ? Number(s) : 0,
    0,
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Custom snooze target as an ISO instant, or null when the input is unusable. */
export function customSnoozeIso(value: string): string | null {
  const date = fromLocalInput(value);
  return date ? wireIso(date) : null;
}

/** Default value for the custom picker: one hour out, rounded down to the minute. */
export function defaultCustomInput(now: Date = new Date()): string {
  const at = inOneHour(now);
  at.setSeconds(0, 0);
  return toLocalInput(at);
}
