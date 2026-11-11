// Standby: the rules for when the console may dim to a watch face, and what it says.
//
// Kept separate from the component because the entry rules are the whole safety story
// and they should be readable and testable on their own. The plate is strictly
// read-only: it never carries an action, and the first input anywhere is spent waking
// it, so a blind touch cannot land on a button underneath.
import type { ConsoleState } from "@shared/api";

/** Quiet for this long with nothing waiting, and the plate comes up. */
export const IDLE_MS = 4 * 60 * 1000;

/** Per device, not per box: which screen should dim is a property of the screen. */
export const STORAGE_KEY = "hq.console.standby";

export interface StandbyView {
  live: number;
  waiting: number;
  tokensToday: string | null;
  machine: string | null;
  /** The one open question worth showing, if any. */
  question: { text: string; rig: string | null; severity: string; ageLabel: string; session: string | null } | null;
  /** False when the link is down: the plate then says so rather than showing stale numbers. */
  connected: boolean;
}

/**
 * May the console dim right now?
 *
 * Never while something is waiting on the owner, because a dimmed screen is exactly when a
 * P0 must not be one more layer away. Never on a phone by default, where the screen
 * sleeps on its own and a full-bleed plate is just in the way.
 */
export function mayEnter(opts: {
  enabled: boolean;
  phone: boolean;
  idleMs: number;
  openRequests: number;
  /** The configured window; defaults to IDLE_MS when a caller has no setting. */
  threshold?: number;
}): boolean {
  if (!opts.enabled || opts.phone) return false;
  if (opts.openRequests > 0) return false;
  const threshold = typeof opts.threshold === "number" && opts.threshold > 0 ? opts.threshold : IDLE_MS;
  return opts.idleMs >= threshold;
}

/** Once up, a new request takes it straight back down: the plate is not a place to hide. */
export function mustExit(openRequests: number): boolean {
  return openRequests > 0;
}

function ageLabel(iso: string, now: number): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

/** What the plate shows. Everything here is already on the state; nothing is collected. */
export function standbyView(state: ConsoleState | null, connected: boolean, now: number): StandbyView {
  const sessions = state?.sessions ?? [];
  const live = sessions.filter((s) => s.state === "running" || s.state === "waiting").length;
  const waiting = sessions.filter((s) => s.state === "waiting").length;
  const open = (state?.requests ?? []).filter((r) => r.state === "open");
  const first = open[0] ?? null;
  const machine = state?.machine ?? null;
  const usage = state?.usage ?? null;

  return {
    live,
    waiting,
    tokensToday: usage && typeof usage.tokensToday === "number" ? `${Math.round(usage.tokensToday / 1000)}k tokens today` : null,
    machine:
      machine && typeof machine.cpuPct === "number"
        ? `hqbox ${machine.tempC !== null && machine.tempC !== undefined ? `${Math.round(machine.tempC)}C, ` : ""}${Math.round(machine.cpuPct)}% CPU`
        : null,
    question: first
      ? {
          text: first.question,
          rig: first.rig,
          severity: first.severity,
          ageLabel: ageLabel(first.createdAt, now),
          session: first.session,
        }
      : null,
    connected,
  };
}

/** hh:mm, the only thing on the plate that has to be legible from the doorway. */
export function clockLabel(now: number): string {
  const d = new Date(now);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * A slow drift so a plate left up for hours does not burn a fixed rectangle into a
 * panel. Returns whole pixels, cycling over an hour.
 */
export function drift(now: number): { x: number; y: number } {
  const t = (now / 60000) % 60;
  return { x: Math.round(Math.sin((t / 60) * Math.PI * 2) * 14), y: Math.round(Math.cos((t / 60) * Math.PI * 2) * 8) };
}
