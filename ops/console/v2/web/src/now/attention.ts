// Terminal attention: working, idle, or needs you (the owner, 2026-10-20, mockup A plus the
// sessions-list dot).
//
// The terminal itself says it wants him (and since 2026-10-20 there is no Needs-you
// panel at all: a question lives on the asking terminal's card):
//
//   waiting, question    the session has an open request (state "waiting")
//   needs you, done      a worker is finishable, or a turn ended after the owner last
//                        looked at this terminal
//   working              a turn is running (hook-turn-state.sh said so)
//   idle                 everything else that is alive, including a finished turn he has
//                        already looked at
//
// "Looked at" is per device: clicking or typing in the pane, or having its pop-out tab
// in front. What is stored is the turnAt he saw, so both sides of the compare are the
// box's clock. That is what turns a "done" back into "idle" once he has seen it.

import type React from "react";
import { useCallback, useEffect, useState } from "react";
import type { Session } from "@shared/api";

export type Attention = "question" | "done" | "working" | "idle";

const KEY = "hq.console.term-seen";
const EVENT = "hq:term-seen";
/** Bounds the stored map: the newest marks win, older sessions are long gone. */
const MAX_SEEN = 200;
const WORKING_STALE_MS = 30 * 60 * 1000;

export function attentionOf(session: Session, seenAt: string | null, now: number = Date.now()): Attention | null {
  if (session.state === "closed" || session.state === "snoozed" || session.state === "draining") return null;
  if (session.state === "waiting") return "question";
  if (session.state === "finishable") return "done";
  if (session.turn === "working" || session.turn === "background") {
    // A background turn ended with a job still running: it reads as working, not done.
    // The hook refreshes a working mark every 5 minutes; one silent for 30 means the
    // turn died without a Stop (Esc, a killed process), so it is idle, not working.
    const at = session.turnAt ? Date.parse(session.turnAt) : Number.NaN;
    return Number.isFinite(at) && now - at > WORKING_STALE_MS ? "idle" : "working";
  }
  if (session.turn === "idle" && session.turnAt) {
    const ended = Date.parse(session.turnAt);
    const seen = seenAt ? Date.parse(seenAt) : Number.NaN;
    if (Number.isFinite(ended) && !(Number.isFinite(seen) && seen >= ended)) return "done";
  }
  return "idle";
}

// The terminal cue (the owner, 2026-11-03: "a red colored border when their task is finished
// and they can be terminated. But if they start a new task it change until that is done").
// Unlike attention it does not care whether the owner has looked: it says what the terminal
// IS, from the same data, so the card border and the favicon agree.
//
//   null       closed, snoozed or draining: killed, gone or asleep, no cue
//   question   an open ctl ask (state "waiting"); amber, never red
//   finished   a worker is finishable, or the last turn ended and the process is idle
//              (turn idle with a time; ctl writes idle only when liveness.py confirms
//              no work is left): idle at its prompt, killable. Red border.
//   working    a turn is running (UserPromptSubmit or a tool call wrote turn working);
//              a new prompt on a finished terminal lands here, which clears the red.
//              Also a turn that ended with work still outstanding (turn "background":
//              ctl's liveness check found Claude Code busy/shell or a non-MCP child
//              process, e.g. a background Bash, Monitor or Agent, or could not check):
//              killing it would lose the job, so it is never finished.
//   idle       everything else, and every unknown: no turn data yet, a working mark
//              silent for 30 minutes (the turn died without a Stop), a background mark
//              older than 30 minutes, an idle mark with no time. Accuracy beats eagerness: unknown is never red.
//
// The meta terminal (Capri) is never finished: it is the owner's own, not one to kill.
export type TermCue = "question" | "finished" | "working" | "idle";

export function cueOf(session: Session, now: number = Date.now()): TermCue | null {
  if (session.state === "closed" || session.state === "snoozed" || session.state === "draining") return null;
  if (session.state === "waiting") return "question";
  if (session.kind !== "meta" && session.state === "finishable") return "finished";
  if (session.turn === "working" || session.turn === "background") {
    const at = session.turnAt ? Date.parse(session.turnAt) : Number.NaN;
    return Number.isFinite(at) && now - at <= WORKING_STALE_MS ? "working" : "idle";
  }
  if (session.kind !== "meta" && session.turn === "idle" && session.turnAt && Number.isFinite(Date.parse(session.turnAt))) {
    return "finished";
  }
  return "idle";
}

export function needsYou(attention: Attention | null): boolean {
  return attention === "question" || attention === "done";
}

export const ATTENTION_TEXT: Record<Attention, string> = {
  question: "waiting: question",
  done: "needs you: done",
  working: "working",
  idle: "idle",
};

type SeenMap = Record<string, string>;

function readSeen(): SeenMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SeenMap) : {};
  } catch {
    return {};
  }
}

/**
 * Records that the owner looked at a terminal. `at` is the box's own turnAt he saw, not the
 * browser clock: a phone running fast or slow would otherwise hide a later turn or keep
 * a seen one ringing. Safe to call often.
 */
export function markSeen(sid: string, at: string): void {
  if (typeof window === "undefined" || !sid || !at) return;
  const map = readSeen();
  map[sid] = at;
  const kept = Object.entries(map)
    .sort((a, b) => b[1].localeCompare(a[1]))
    .slice(0, MAX_SEEN);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // storage blocked: the mark lives for this event only, which is still correct
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { sid, at: map[sid] } }));
}

/** When the owner last looked at each terminal on this device; re-renders on a new mark. */
export function useTermSeen(): SeenMap {
  const [seen, setSeen] = useState<SeenMap>(() => readSeen());
  useEffect(() => {
    const update = (): void => setSeen(readSeen());
    window.addEventListener(EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return seen;
}

/** The attention of one session, with a callback that marks it seen. */
export function useAttention(session: Session): { attention: Attention | null; seen: () => void } {
  const seenMap = useTermSeen();
  const attention = attentionOf(session, seenMap[session.id] ?? null);
  const seen = useCallback(() => {
    if (attention === "done" && session.state !== "finishable" && session.turnAt) markSeen(session.id, session.turnAt);
  }, [attention, session.id, session.state, session.turnAt]);
  return { attention, seen };
}

// Grid order (the owner, 2026-10-20): the panes that need him move to the top left, so he
// answers questions as they come in. Needs you first, then working, then idle; inside a
// rank the order he opened them in stays.
const RANK: Record<Attention, number> = { question: 0, done: 0, working: 1, idle: 2 };

export function byAttention(sessions: Session[], seen: SeenMap, now: number = Date.now()): Session[] {
  const rank = (s: Session): number => {
    const attention = attentionOf(s, seen[s.id] ?? null, now);
    return attention ? RANK[attention] : 3;
  };
  return sessions
    .map((session, index) => ({ session, index, rank: rank(session) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.session);
}

/**
 * The panes in attention order, held still while the owner is working in the grid. Clicking
 * into a "done" pane marks it seen on pointer-down, which makes it idle; without the hold
 * it would jump away under his cursor. So the hold starts on pointer-down (capture, before
 * the pane's own handler) as well as on focus, and lands the new order only once focus has
 * really left the grid (on blur, or when a press ends with no focus inside). Switching to another window is not leaving: focus comes back.
 */
export function useAttentionOrder(panes: Session[]): {
  ordered: Session[];
  onPointerDownCapture: (event: React.PointerEvent<HTMLElement>) => void;
  onFocus: () => void;
  onBlur: (event: React.FocusEvent<HTMLElement>) => void;
} {
  const seen = useTermSeen();
  const [held, setHeld] = useState<string[] | null>(null);
  const live = byAttention(panes, seen);
  let ordered = live;
  if (held) {
    const at = (s: Session): number => {
      const i = held.indexOf(s.id);
      return i === -1 ? held.length : i;
    };
    ordered = [...panes].sort((a, b) => at(a) - at(b) || live.indexOf(a) - live.indexOf(b));
  }
  const ids = ordered.map((s) => s.id).join(" ");
  const hold = useCallback(() => setHeld((current) => current ?? ids.split(" ")), [ids]);
  // A press that ends with no focus in the grid releases the hold: a click on pane chrome,
  // a touch scroll (pointercancel, no pointerup) or a drag that ends outside the grid. The
  // listener is on window because those last two never reach the grid.
  const onPointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      hold();
      const grid = event.currentTarget;
      const release = (): void => {
        window.removeEventListener("pointerup", release, true);
        window.removeEventListener("pointercancel", release, true);
        window.setTimeout(() => {
          if (!grid.contains(document.activeElement)) setHeld(null);
        }, 0);
      };
      window.addEventListener("pointerup", release, true);
      window.addEventListener("pointercancel", release, true);
    },
    [hold],
  );
  const onBlur = useCallback((event: React.FocusEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    if (typeof document !== "undefined" && !document.hasFocus()) return;
    setHeld(null);
  }, []);
  return { ordered, onPointerDownCapture, onFocus: hold, onBlur };
}
