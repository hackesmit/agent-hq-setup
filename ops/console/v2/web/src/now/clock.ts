// Two hooks the Now tab needs everywhere: a ticking clock so "waiting 41 min" counts up
// without a state push, and a media query so the phone layout is a decision, not a guess.
//
// Both are SSR-safe: the render pass never touches window, only the effect does.

import { useEffect, useState } from "react";

export const TICK_MS = 5_000;

/** Milliseconds since the epoch, refreshed on an interval. */
export function useNowMs(intervalMs: number = TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const update = (): void => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/** The phone breakpoint from the design doc (section 3, "phone (<768)"). */
export const PHONE_QUERY = "(max-width: 767px)";

export function useIsPhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}
