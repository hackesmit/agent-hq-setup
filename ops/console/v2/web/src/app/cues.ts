// Sound cues: the console's audible vocabulary.
//
// The console had no audio at all. It did already carry a typed event stream in exactly
// the right shape (ActivityEvent, Alert), so this layer is purely additive on the client:
// no server change, no protocol change. It watches snapshots go by, works out which
// events are NEW, and turns the interesting ones into one sound.
//
// Everything in this file is pure. The engine takes a `play` callback and a `now`
// function, so the whole policy (what fires, what is swallowed, what is quiet) is
// testable without WebAudio, a browser, or a clock. cuePlayer.ts owns the noise.
//
// Design: docs/superpowers/specs/2026-08-24-capri-voice-hermes-jira-gastown.md section 2.
// Bead: hq-4lxc.

import type { Alert, ActivityEvent, ConsoleState } from "@shared/api";

/**
 * The vocabulary. Six cues are driven by console state; three are driven by the Capri
 * ear (archive/jarvis-ear) and arrive through `fire()` rather than through a snapshot.
 */
export type CueName =
  | "URGENT"
  | "NEEDS_YOU"
  | "FAILED"
  | "DONE"
  | "ANSWERED"
  | "DISPATCHED"
  | "LISTENING"
  | "COMMITTED"
  | "CANCEL";

export interface CueSpec {
  /**
   * Higher wins when several cues want the same tick. Salience MUST track severity: if
   * DISPATCHED is as loud and as likely to be heard as NEEDS_YOU, both get ignored.
   */
  salience: number;
  /** Human label, used in Settings and in the test preview. */
  label: string;
  /** One line saying when it fires, shown next to the preview button. */
  when: string;
  /**
   * Plays during quiet hours. Only the P0 cue does: a P0 at 3am is precisely the thing
   * quiet hours must not swallow. The hard mute still silences everything.
   */
  piercesQuietHours?: boolean;
}

export const CUES: Record<CueName, CueSpec> = {
  URGENT: { salience: 100, label: "Urgent", when: "a P0 alert", piercesQuietHours: true },
  NEEDS_YOU: { salience: 90, label: "Question waiting", when: "a question arrives, or a P1 alert" },
  FAILED: { salience: 70, label: "Failed", when: "an error, or a failed operation" },
  DONE: { salience: 50, label: "Done", when: "a bead merged and closed" },
  ANSWERED: { salience: 30, label: "Answered", when: "an answer reached a waiting worker" },
  DISPATCHED: { salience: 10, label: "Dispatched", when: "a worker was spawned" },
  LISTENING: { salience: 80, label: "Listening", when: "Capri heard the wake word" },
  COMMITTED: { salience: 60, label: "Committed", when: "Capri captured what you said" },
  CANCEL: { salience: 40, label: "Cancelled", when: "Capri dropped what it heard" },
};

export const CUE_NAMES = Object.keys(CUES) as CueName[];

/** One cue type may not play again inside this window. A 12-commit merge rings once. */
export const COALESCE_MS = 3_000;
/** A P0 that is still unacknowledged rings a second time, once, after this long. */
export const URGENT_REPEAT_MS = 30_000;

export interface CueSettings {
  /** Master switch. Off means silence, including P0. */
  sound: boolean;
  /** Local hour (0 to 23) quiet hours begin. Equal to `quietTo` means no quiet hours. */
  quietFrom: number;
  /** Local hour (0 to 23) quiet hours end. Wraps midnight when `quietTo` < `quietFrom`. */
  quietTo: number;
}

export const CUE_DEFAULTS: CueSettings = { sound: true, quietFrom: 22, quietTo: 8 };

/** True when `hour` falls inside the quiet window, which may wrap past midnight. */
export function inQuietHours(hour: number, from: number, to: number): boolean {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  const a = ((Math.floor(from) % 24) + 24) % 24;
  const b = ((Math.floor(to) % 24) + 24) % 24;
  if (a === b) return false;
  return a < b ? h >= a && h < b : h >= a || h < b;
}

// ---------------------------------------------------------------------------
// Mapping state events onto cues
// ---------------------------------------------------------------------------

/** Which cue an activity row deserves, or null when it is not worth a sound. */
export function cueForActivity(event: ActivityEvent): CueName | null {
  switch (event.type) {
    case "ask":
      return "NEEDS_YOU";
    case "answer":
      return "ANSWERED";
    case "finish":
      return "DONE";
    case "dispatch":
      return "DISPATCHED";
    case "error":
      return "FAILED";
    case "op":
      // Operations are only worth a sound when they failed; a successful op is a click
      // the dispatch cue already covered.
      return event.sev ? "FAILED" : null;
    default:
      // commit, merge, snooze, capture: visible in the stream, not worth interrupting for.
      return null;
  }
}

/** Which cue an alert deserves. P2 alerts stay silent; they are for the retro. */
export function cueForAlert(alert: Alert): CueName | null {
  if (alert.severity === "P0") return "URGENT";
  if (alert.severity === "P1") return "NEEDS_YOU";
  return null;
}

/** The stable id a cue-worthy record is remembered by, so it fires exactly once. */
function activityKey(event: ActivityEvent): string {
  return `a:${event.id}`;
}
function alertKey(alert: Alert): string {
  return `x:${alert.id}`;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export interface CueEngineOptions {
  play: (cue: CueName) => void;
  now: () => number;
  settings?: CueSettings;
  /** Ids to treat as already seen. Used by tests; production primes from the first snapshot. */
  seen?: Iterable<string>;
}

/**
 * Watches snapshots and decides what to play.
 *
 * Two rules do most of the work:
 *
 *  1. The FIRST snapshot only primes the seen-set. A page refresh replays the whole
 *     activity list, and a browser that sang fifty times on load would be turned off
 *     within the hour.
 *  2. At most ONE cue per snapshot, the most salient. Two sounds at once is mush, and
 *     the quieter event is still sitting in the stream where it can be read.
 */
export class CueEngine {
  private readonly play: (cue: CueName) => void;
  private readonly now: () => number;
  private seen: Set<string>;
  private lastPlayed = new Map<CueName, number>();
  private primed = false;
  /** Alert id whose second ring is still pending, with the time it is due. */
  private urgentRepeat: { id: string; dueAt: number } | null = null;
  settings: CueSettings;

  constructor(opts: CueEngineOptions) {
    this.play = opts.play;
    this.now = opts.now;
    this.settings = { ...CUE_DEFAULTS, ...(opts.settings ?? {}) };
    this.seen = new Set(opts.seen ?? []);
    if (opts.seen) this.primed = true;
  }

  /** Whether this cue is allowed to make a sound right now. */
  private allowed(cue: CueName, at: number): boolean {
    if (!this.settings.sound) return false;
    const spec = CUES[cue];
    if (!spec.piercesQuietHours) {
      const hour = new Date(at).getHours();
      if (inQuietHours(hour, this.settings.quietFrom, this.settings.quietTo)) return false;
    }
    const last = this.lastPlayed.get(cue);
    if (last !== undefined && at - last < COALESCE_MS) return false;
    return true;
  }

  /**
   * Play one cue now, subject to mute, quiet hours and coalescing. This is the entry
   * point the Capri ear uses for LISTENING, COMMITTED and CANCEL.
   * Returns true when a sound was actually made.
   */
  fire(cue: CueName): boolean {
    const at = this.now();
    if (!this.allowed(cue, at)) return false;
    this.lastPlayed.set(cue, at);
    this.play(cue);
    return true;
  }

  /**
   * Feed a snapshot. Returns the cue that played, or null.
   *
   * A null state (offline, or before the first push) is ignored rather than treated as
   * an empty world, so a dropped socket does not un-see everything and then re-announce
   * it all on reconnect.
   */
  observe(state: ConsoleState | null): CueName | null {
    if (!state) return null;
    const at = this.now();

    const candidates: CueName[] = [];
    const mark = (key: string, cue: CueName | null) => {
      if (this.seen.has(key)) return;
      this.seen.add(key);
      if (cue && this.primed) candidates.push(cue);
    };

    for (const event of state.activity ?? []) mark(activityKey(event), cueForActivity(event));
    for (const alert of state.alerts ?? []) mark(alertKey(alert), cueForAlert(alert));

    this.trimSeen(state);
    const fired = this.primed ? this.playBest(candidates, at) : null;
    this.primed = true;

    this.scheduleUrgentRepeat(state, at, fired);
    return fired;
  }

  /**
   * A pending P0 repeat is armed when the alert first rings, disarmed the moment the
   * alert leaves the state (acknowledged or resolved), and fires once when due.
   */
  private scheduleUrgentRepeat(state: ConsoleState, at: number, fired: CueName | null): void {
    const live = (state.alerts ?? []).filter((a) => a.severity === "P0");
    if (fired === "URGENT") {
      const newest = live[live.length - 1];
      if (newest) this.urgentRepeat = { id: newest.id, dueAt: at + URGENT_REPEAT_MS };
      return;
    }
    const pending = this.urgentRepeat;
    if (!pending) return;
    if (!live.some((a) => a.id === pending.id)) {
      this.urgentRepeat = null;
      return;
    }
    if (at >= pending.dueAt) {
      this.urgentRepeat = null;
      // The repeat deliberately bypasses coalescing: 30 seconds is well past the window,
      // and a P0 nobody has touched has earned a second ring.
      if (this.settings.sound) {
        this.lastPlayed.set("URGENT", at);
        this.play("URGENT");
      }
    }
  }

  /** Whether a second P0 ring is still armed. Exposed for tests and for the tick. */
  urgentRepeatPending(): boolean {
    return this.urgentRepeat !== null;
  }

  /**
   * Called on a timer as well as on snapshots, so a P0 repeat lands on time even when
   * nothing else changed.
   */
  tick(state: ConsoleState | null): void {
    if (!state || !this.urgentRepeat) return;
    this.scheduleUrgentRepeat(state, this.now(), null);
  }

  private playBest(candidates: CueName[], at: number): CueName | null {
    let best: CueName | null = null;
    for (const cue of candidates) {
      if (!this.allowed(cue, at)) continue;
      if (best === null || CUES[cue].salience > CUES[best].salience) best = cue;
    }
    if (!best) return null;
    this.lastPlayed.set(best, at);
    this.play(best);
    return best;
  }

  /**
   * The seen-set must not grow without bound in a session that stays open for days.
   * Ids that are no longer anywhere in state can never fire again, so they are dropped.
   */
  private trimSeen(state: ConsoleState): void {
    const LIMIT = 4_000;
    if (this.seen.size <= LIMIT) return;
    const live = new Set<string>();
    for (const event of state.activity ?? []) live.add(activityKey(event));
    for (const alert of state.alerts ?? []) live.add(alertKey(alert));
    this.seen = live;
  }
}
