// The design direction.
//
// There is one, Teletype, chosen in round two on 2026-08-20. The three earlier
// directions were removed rather than left switchable, because an alternate nobody
// picks is a second palette to keep correct on every change and it had already
// drifted. The machinery stays: the attribute is still applied and still persisted,
// so adding a second direction later is a token block and a list entry rather than
// a re-wiring.

import { useCallback, useEffect, useState } from "react";

export const DESIGNS = ["teletype"] as const;
export type Design = (typeof DESIGNS)[number];

export const DESIGN_LABELS: Record<Design, string> = {
  teletype: "Teletype",
};

const STORAGE_KEY = "hq.console.design";
// Teletype won design round two (2026-08-20) and is what the console opens as.
export const DEFAULT_DESIGN: Design = "teletype";

function isDesign(value: string | null): value is Design {
  return value !== null && (DESIGNS as readonly string[]).includes(value);
}

export function readDesign(): Design {
  if (typeof window === "undefined") return DEFAULT_DESIGN;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isDesign(stored)) return stored;
  } catch {
    // private mode or blocked storage: fall through to the default
  }
  const attr = document.documentElement.getAttribute("data-design");
  return isDesign(attr) ? attr : DEFAULT_DESIGN;
}

export function applyDesign(design: Design): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-design", design);
  const themeColor = "#0c0c0b";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor);
  try {
    window.localStorage.setItem(STORAGE_KEY, design);
  } catch {
    // storage is optional
  }
}

export function useDesign(): [Design, (design: Design) => void] {
  const [design, setDesign] = useState<Design>(() => readDesign());

  useEffect(() => {
    applyDesign(design);
  }, [design]);

  const choose = useCallback((next: Design) => setDesign(next), []);
  return [design, choose];
}
