// Height of the orchestrator terminal box on Now (bead hq-4npjr.17). the owner found the
// fixed 340 px too short to read. The box opens at about 65% of the window, a drag on
// its bottom edge changes it within 240 px and 90% of the window, and the height is
// kept per browser.

export const ORCH_HEIGHT_KEY = "hq.now.orchHeight";
export const ORCH_MIN_PX = 240;
export const ORCH_MAX_FRACTION = 0.9;
export const ORCH_DEFAULT_FRACTION = 0.65;
/** Arrow keys on the handle move it this far. */
export const ORCH_KEY_STEP = 40;

export function clampHeight(px: number, viewport: number): number {
  const max = Math.max(ORCH_MIN_PX, Math.floor(viewport * ORCH_MAX_FRACTION));
  if (!Number.isFinite(px)) return Math.min(max, Math.max(ORCH_MIN_PX, Math.round(viewport * ORCH_DEFAULT_FRACTION)));
  return Math.min(max, Math.max(ORCH_MIN_PX, Math.round(px)));
}

export function defaultHeight(viewport: number): number {
  return clampHeight(viewport * ORCH_DEFAULT_FRACTION, viewport);
}

/** The stored height, or null when none is stored or it is not a number. */
export function readHeight(storage: Pick<Storage, "getItem"> | null): number | null {
  try {
    const raw = storage?.getItem(ORCH_HEIGHT_KEY);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function saveHeight(storage: Pick<Storage, "setItem"> | null, px: number): void {
  try {
    storage?.setItem(ORCH_HEIGHT_KEY, String(Math.round(px)));
  } catch {
    /* private mode: the height lasts this page only */
  }
}

/** The height after a drag that started at startY with the box at startPx. */
export function dragHeight(startPx: number, startY: number, y: number, viewport: number): number {
  return clampHeight(startPx + (y - startY), viewport);
}
