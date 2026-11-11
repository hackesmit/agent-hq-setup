// The standby plate: what the console looks like from across the room when nothing
// needs you, and what it does the moment something does.
//
// It is read-only by construction. There is exactly one control, Wake, and the first
// pointer or key event anywhere is captured to dismiss the plate rather than passed
// through, so a blind touch on a sleeping screen can never land on Kill or Finish
// underneath. The rules for coming up and going away live in standby.ts.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConsoleState } from "@shared/api";
import { Button } from "../ui/primitives";
import { useIsPhone } from "../now/clock";
import { clockLabel, drift, mayEnter, mustExit, standbyView, STORAGE_KEY } from "./standby";

/** The preference, per device. */
export function useStandbyEnabled(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === "on";
    } catch {
      return false;
    }
  });
  const set = useCallback((next: boolean) => {
    setOn(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
    } catch {
      /* a browser that refuses storage still gets the session-local setting */
    }
  }, []);
  return [on, set];
}

export function Standby({
  state,
  connected,
  enabled,
  idleMs,
}: {
  state: ConsoleState | null;
  connected: boolean;
  enabled: boolean;
  /** How long untouched before the plate comes up, from settings. */
  idleMs: number;
}) {
  const phone = useIsPhone();
  const [showing, setShowing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lastInput = useRef(Date.now());
  const openRequests = (state?.requests ?? []).filter((r) => r.state === "open").length;

  // Any real input resets the idle clock. Listening on the capture phase means a click
  // that dismisses the plate is seen here first and never reaches the page behind it.
  useEffect(() => {
    const bump = (e: Event) => {
      lastInput.current = Date.now();
      if (!showing) return;
      // the first input while the plate is up is spent waking, and goes no further
      e.preventDefault();
      e.stopPropagation();
      setShowing(false);
    };
    const events: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "wheel", "touchstart"];
    for (const name of events) window.addEventListener(name, bump, { capture: true });
    return () => {
      for (const name of events) window.removeEventListener(name, bump, { capture: true } as EventListenerOptions);
    };
  }, [showing]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (mustExit(openRequests)) {
        setShowing(false);
        return;
      }
      setShowing(mayEnter({ enabled, phone, idleMs: t - lastInput.current, openRequests, threshold: idleMs }));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [enabled, phone, openRequests, idleMs]);

  if (!showing) return null;

  const view = standbyView(state, connected, now);
  const offset = drift(now);
  const alarm = view.question && (view.question.severity === "P0" || view.question.severity === "P1");

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col justify-center bg-bg"
      role="dialog"
      aria-label="Standby"
      style={alarm ? { boxShadow: "inset 0 0 0 2px var(--p0)" } : undefined}
    >
      {/* A drop here is almost always a deploy restart, back within a second or two
          (hq-aukwy): say so, not "offline". */}
      <span className={`absolute right-5 top-4 text-[12px] ${view.connected ? "text-ok" : "text-warn"}`}>
        {view.connected ? "live" : "reconnecting"}
      </span>

      {view.question ? (
        <div className="flex flex-col items-center gap-7 px-[8vw] text-center">
          <p className="m-0 text-[clamp(20px,3vw,38px)] leading-snug text-ink text-pretty">{view.question.text}</p>
          <p className="m-0 text-[clamp(13px,1.4vw,18px)] text-mute">
            {[view.question.rig ?? "hq", view.question.severity, `asked ${view.question.ageLabel}`, view.question.session ? `${view.question.session} is blocked` : null]
              .filter(Boolean)
              .join("  -  ")}
          </p>
          <Button size="md" variant="primary" className="min-h-12 px-14 text-[16px]" onClick={() => setShowing(false)}>
            Wake
          </Button>
        </div>
      ) : (
        <div className="px-[6vw]" style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}>
          <div className="text-[clamp(56px,11vw,150px)] font-medium leading-none tracking-tight text-ink tabular-nums">
            {clockLabel(now)}
          </div>
          <div className="mt-6 flex flex-col gap-2 text-[clamp(14px,2vw,26px)] text-mute">
            <span>
              {view.live} live{view.waiting > 0 ? `, ${view.waiting} waiting` : ""}
            </span>
            {view.machine ? <span>{view.machine}</span> : null}
            {view.tokensToday ? <span>{view.tokensToday}</span> : null}
            {!view.connected ? (
              <span className="text-bad">the link is down, so this is a picture, not the shop</span>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
