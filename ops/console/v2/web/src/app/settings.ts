// Console settings: the knobs that belong to a SCREEN rather than to the box.
//
// Standby, densities, whether the sigils are drawn: these are properties of the display
// you are looking at, not of the workshop, so they live in this browser rather than on
// hqbox. A setting that must follow the owner between devices (the read marker, the notes)
// is server side instead, and does not belong here.
//
// One typed record with one place to add a knob, so the next setting is a line rather
// than a new mechanism.

export interface Settings {
  /** Dim to the watch face when nothing needs you. */
  standby: boolean;
  /** How long the console must be untouched first. */
  standbyIdleMin: number;
  /** Draw the per-project mark beside project names. */
  sigils: boolean;
  /** Show the "since you left" ribbon at all. */
  awayRibbon: boolean;
  /** Play the sound cues. Off is a hard mute: even P0 is silent. */
  sound: boolean;
  /** Local hour quiet hours begin. Equal to `quietTo` means no quiet hours. */
  quietFrom: number;
  /** Local hour quiet hours end. Wraps midnight when below `quietFrom`. */
  quietTo: number;
}

export const DEFAULTS: Settings = {
  standby: false,
  standbyIdleMin: 4,
  sigils: true,
  awayRibbon: true,
  sound: true,
  quietFrom: 22,
  quietTo: 8,
};

export const IDLE_MIN = 1;
export const IDLE_MAX = 120;

const KEY = "hq.console.settings";
/** The pre-settings standby flag, so a screen that already had it on keeps it. */
const LEGACY_STANDBY_KEY = "hq.console.standby";

/** An hour-of-day knob. Anything unreadable falls back rather than disabling the window. */
function clampHour(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return ((n % 24) + 24) % 24;
}

function clampIdle(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULTS.standbyIdleMin;
  return Math.min(IDLE_MAX, Math.max(IDLE_MIN, n));
}

/** Read what is stored, keeping every unknown or malformed field at its default. */
export function parseSettings(raw: string | null, legacyStandby?: string | null): Settings {
  const out: Settings = { ...DEFAULTS };
  if (legacyStandby === "on") out.standby = true;
  if (!raw) return out;
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return out;
  const rec = j as Record<string, unknown>;
  if (typeof rec.standby === "boolean") out.standby = rec.standby;
  if (typeof rec.sigils === "boolean") out.sigils = rec.sigils;
  if (typeof rec.awayRibbon === "boolean") out.awayRibbon = rec.awayRibbon;
  if (rec.standbyIdleMin !== undefined) out.standbyIdleMin = clampIdle(rec.standbyIdleMin);
  if (typeof rec.sound === "boolean") out.sound = rec.sound;
  if (rec.quietFrom !== undefined) out.quietFrom = clampHour(rec.quietFrom, DEFAULTS.quietFrom);
  if (rec.quietTo !== undefined) out.quietTo = clampHour(rec.quietTo, DEFAULTS.quietTo);
  return out;
}

export function loadSettings(): Settings {
  try {
    return parseSettings(window.localStorage.getItem(KEY), window.localStorage.getItem(LEGACY_STANDBY_KEY));
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(next: Settings): Settings {
  const clean: Settings = {
    ...next,
    standbyIdleMin: clampIdle(next.standbyIdleMin),
    quietFrom: clampHour(next.quietFrom, DEFAULTS.quietFrom),
    quietTo: clampHour(next.quietTo, DEFAULTS.quietTo),
  };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(clean));
  } catch {
    /* a browser that refuses storage still gets the setting for this session */
  }
  return clean;
}

/** Minutes to milliseconds, for the idle check. */
export function idleMs(settings: Settings): number {
  return clampIdle(settings.standbyIdleMin) * 60_000;
}

/** The subset the cue engine needs, so it does not depend on the whole settings record. */
export function cueSettings(settings: Settings): { sound: boolean; quietFrom: number; quietTo: number } {
  return { sound: settings.sound, quietFrom: settings.quietFrom, quietTo: settings.quietTo };
}
