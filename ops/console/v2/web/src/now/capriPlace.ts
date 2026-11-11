// Where Capri's box sits and how big it is (hq-ymxzt.9). the owner drags the title bar
// to move it and the grip to resize it; the place is kept per browser. Offsets are
// from the right and bottom edges, so the box keeps its corner when the window resizes.

export interface CapriPlace {
  right: number;
  bottom: number;
  size: number;
}

export const CAPRI_MIN = 60;
export const CAPRI_MAX = 320;
export const CAPRI_DEFAULT_SIZE = 100;
const KEY = "hq.capri.place";
const EDGE = 4;

/** Keeps the size in range and the whole box inside a view of w by h. */
export function clampPlace(p: CapriPlace, w: number, h: number): CapriPlace {
  const size = Math.round(Math.min(CAPRI_MAX, Math.max(CAPRI_MIN, p.size)));
  // the box is size wide and about size + 12 tall (title bar)
  const right = Math.round(Math.min(Math.max(EDGE, w - size - EDGE), Math.max(EDGE, p.right)));
  const bottom = Math.round(Math.min(Math.max(EDGE, h - size - 12 - EDGE), Math.max(EDGE, p.bottom)));
  return { right, bottom, size };
}

export function parsePlace(raw: string | null): CapriPlace | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<CapriPlace>;
    if ([p.right, p.bottom, p.size].every((n) => typeof n === "number" && Number.isFinite(n))) return p as CapriPlace;
  } catch {
    // a broken entry means the default place
  }
  return null;
}

export function readPlace(): CapriPlace | null {
  try {
    return parsePlace(window.localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function savePlace(p: CapriPlace | null): void {
  try {
    if (p) window.localStorage.setItem(KEY, JSON.stringify(p));
    else window.localStorage.removeItem(KEY);
  } catch {
    // storage blocked: the place lasts until reload
  }
}
