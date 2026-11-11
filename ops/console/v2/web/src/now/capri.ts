// Capri (hq-ymxzt.2): the wake word heard on George arrives as {t: "capri", event}
// on the live socket. A wake puts the cursor in the orchestrator input (the meta
// terminal today) so Wispr Flow pastes there, and shows a listening state until
// done, or for 30 s at most. A page with no orchestrator input ignores the event.
// No text or audio ever reaches the page: the event is the whole message.
import { useSyncExternalStore } from "react";

export type CapriEvent = "wake" | "done";
export const CAPRI_LISTEN_MS = 30_000;
/** A keystroke on this page this recently means the owner is typing: a wake must not move his cursor. */
export const CAPRI_TYPING_MS = 3_000;

/** What the page knows about itself when a wake arrives. */
export interface CapriPage {
  visible: () => boolean;
  now: () => number;
}

const browserPage: CapriPage = {
  visible: () => typeof document === "undefined" || document.visibilityState === "visible",
  now: () => Date.now(),
};

/** Puts the cursor in one orchestrator input. */
export type CapriTarget = () => void;

export interface CapriTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const browserTimers: CapriTimers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (handle) => window.clearTimeout(handle as number),
};

export function createCapri(timers: CapriTimers = browserTimers, page: CapriPage = browserPage) {
  const targets: CapriTarget[] = [];
  let lastKey = -Infinity;
  const listeners = new Set<() => void>();
  const events = new Set<(event: CapriEvent) => void>();
  let listening = false;
  let timer: unknown = null;

  function set(next: boolean): void {
    if (timer !== null) {
      timers.clear(timer);
      timer = null;
    }
    if (next) timer = timers.set(() => set(false), CAPRI_LISTEN_MS);
    if (next === listening) return;
    listening = next;
    for (const fn of listeners) fn();
  }

  return {
    /** The latest mounted input wins: it is the one the owner opened last. */
    register(target: CapriTarget): () => void {
      targets.push(target);
      return () => {
        const i = targets.lastIndexOf(target);
        if (i >= 0) targets.splice(i, 1);
        if (targets.length === 0) set(false);
      };
    },
    /** Returns true when the page acted on the event. */
    receive(event: unknown): boolean {
      if (event === "wake" || event === "done") for (const fn of events) fn(event);
      if (event === "done") {
        const was = listening;
        set(false);
        return was;
      }
      if (event !== "wake") return false;
      const target = targets[targets.length - 1];
      if (!target) return false;
      // A hidden page or one the owner is typing in is no target: a false wake must
      // not pull his cursor (and Wispr Flow's paste) into the orchestrator.
      if (!page.visible() || page.now() - lastKey < CAPRI_TYPING_MS) return false;
      target();
      set(true);
      return true;
    },
    /** A keystroke anywhere on the page (the capture listener below calls this). */
    typed(): void {
      lastKey = page.now();
    },
    /** Every wake and done, whether or not this page has an input to focus. */
    onEvent(fn: (event: CapriEvent) => void): () => void {
      events.add(fn);
      return () => events.delete(fn);
    },
    /** Puts the cursor in the orchestrator input; false when this page has none. */
    focus(): boolean {
      const target = targets[targets.length - 1];
      if (!target) return false;
      target();
      return true;
    },
    listening: () => listening,
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export type Capri = ReturnType<typeof createCapri>;

export const capri = createCapri();
if (typeof window !== "undefined") window.addEventListener("keydown", () => capri.typed(), true);

// ---------- the corner's mood (hq-ymxzt.5) ----------
// Four states drive the corner avatar. A wake means listening, whether or not this
// page has an input; done means thinking; a new line of orchestrator output means
// speaking for 4 s after the last one. There is no speech event yet, so output is
// the honest proxy. Echo is not speech: output while listening (the dictation
// pasting) or right after a keystroke in the orchestrator pane does not count.
// Idle holds no timer at all.

export type CapriMood = "idle" | "listening" | "thinking" | "speaking";
export const CAPRI_SPEAK_MS = 4_000;
export const CAPRI_THINK_MS = 60_000;
/** Output this soon after done is the prompt being submitted, not an answer. */
export const CAPRI_THINK_MIN_MS = 1_000;
/** Output this soon after a keystroke is the echo of that keystroke. */
export const CAPRI_ECHO_MS = 400;

export function createCapriMood(
  source: Pick<Capri, "onEvent">,
  timers: CapriTimers = browserTimers,
  now: () => number = () => Date.now(),
) {
  const listeners = new Set<() => void>();
  let mood: CapriMood = "idle";
  let since = 0;
  let typedAt = -Infinity;
  let timer: unknown = null;

  function go(next: CapriMood, ms: number | null): void {
    if (timer !== null) {
      timers.clear(timer);
      timer = null;
    }
    if (ms !== null) timer = timers.set(() => go("idle", null), ms);
    since = now();
    if (next === mood) return;
    mood = next;
    for (const fn of listeners) fn();
  }

  source.onEvent((event) => {
    if (event === "wake") go("listening", CAPRI_LISTEN_MS);
    else if (mood === "listening") go("thinking", CAPRI_THINK_MS);
  });

  return {
    /** Output arrived on the orchestrator pane. */
    heard(data: string): void {
      if (!data.includes("\n")) return;
      if (mood === "listening") return;
      const t = now();
      if (t - typedAt < CAPRI_ECHO_MS) return;
      if (mood === "thinking" && t - since < CAPRI_THINK_MIN_MS) return;
      go("speaking", CAPRI_SPEAK_MS);
    },
    /** the owner typed into the orchestrator pane. */
    typed(): void {
      typedAt = now();
    },
    mood: () => mood,
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export const capriMood = createCapriMood(capri);

export function useCapriMood(): CapriMood {
  return useSyncExternalStore(capriMood.subscribe, capriMood.mood, () => "idle");
}

const STATE_LINES: Record<Exclude<CapriMood, "speaking">, string> = {
  idle: "Capri. Standing by.",
  listening: "Listening.",
  thinking: "Routing it.",
};

/** One short dry line per state (board G). Speaking says what waits on the owner. */
export function capriLine(mood: CapriMood, waiting: number): string {
  if (mood !== "speaking") return STATE_LINES[mood];
  if (waiting === 1) return "One question waiting. It is yours.";
  if (waiting > 1) return `${waiting} questions waiting. They are yours.`;
  return "Orchestrator answered. Nothing needs you.";
}

/** How far to raise the corner so it clears a focused input; 0 when they do not meet. */
export function capriLift(
  corner: { left: number; top: number; right: number; bottom: number },
  input: { left: number; top: number; right: number; bottom: number },
  gap = 12,
): number {
  const meets =
    input.left < corner.right + gap &&
    input.right > corner.left - gap &&
    input.top < corner.bottom + gap &&
    input.bottom > corner.top - gap;
  if (!meets) return 0;
  return Math.max(0, Math.ceil(corner.bottom - input.top + gap));
}

export function useCapriListening(): boolean {
  return useSyncExternalStore(capri.subscribe, capri.listening, () => false);
}
