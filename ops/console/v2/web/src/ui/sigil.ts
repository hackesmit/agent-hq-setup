// Rig sigils: a deterministic glyph and hue for any project id.
//
// The console shows interleaved rows from a dozen projects and the number keeps growing
// (the registry is at eleven, the bunkers add more), so this is a pure function of the
// id rather than a table someone has to remember to extend: a new project gets its mark
// the first time it appears, with no registration step and nothing to keep in sync.
//
// Shape carries the identity and hue only reinforces it. That ordering is deliberate:
// hue alone fails for a colorblind reader, in high contrast, and in a printout, and the
// text label is always beside the mark anyway. The glyph is left-right symmetric because
// a symmetric mark reads as an emblem while a random one reads as noise.

/** Number of hues in the ramp. The tokens define --sigil-1 through --sigil-12. */
export const SIGIL_HUES = 12;

const GRID = 5;
const HALF = 3; // columns 0,1,2 are drawn and mirrored onto 3,4

/** FNV-1a, 32 bit. Small, fast, and stable across machines and releases. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A 32-bit xorshift so one hash yields a stable stream of bits for the grid. */
function nextBits(state: number): number {
  let x = state;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  return x;
}

export interface Sigil {
  /** 1-based index into the hue ramp, so it reads as var(--sigil-N). */
  hue: number;
  /** GRID*GRID booleans, row-major, already mirrored. */
  cells: boolean[];
  /** The id this was derived from, for the title and aria text. */
  id: string;
}

/**
 * The mark for a project id. Deterministic, and stable forever: changing this function
 * changes every mark in the console, so treat it as a format, not an implementation.
 */
export function sigilFor(id: string): Sigil {
  const clean = String(id || "").trim().toLowerCase();
  const h = hashId(clean || "unknown");
  const hue = (h % SIGIL_HUES) + 1;

  // Fill the left half plus the centre column from the bit stream, then mirror. A mark
  // that comes out nearly empty or nearly solid is re-rolled: both extremes are hard to
  // tell apart from each other, which is the one thing the glyph has to do.
  let state = h === 0 ? 0x9e3779b9 : h;
  let cells: boolean[] = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    cells = new Array(GRID * GRID).fill(false);
    let filled = 0;
    for (let col = 0; col < HALF; col++) {
      state = nextBits(state);
      for (let row = 0; row < GRID; row++) {
        const on = ((state >>> (row * 3 + col)) & 1) === 1;
        if (!on) continue;
        cells[row * GRID + col] = true;
        cells[row * GRID + (GRID - 1 - col)] = true;
        filled += col === HALF - 1 ? 1 : 2;
      }
    }
    if (filled >= 7 && filled <= 17) break;
  }
  return { hue, cells, id: clean };
}

/**
 * Whether marks are drawn at all. A display preference, set once by the Shell from
 * settings, read by the primitive: threading a prop through every row that happens to
 * name a project would be a worse trade than one module flag.
 */
let sigilsOn = true;
export function setSigilsEnabled(on: boolean): void {
  sigilsOn = on;
}
export function sigilsEnabled(): boolean {
  return sigilsOn;
}

/** The CSS variable that paints this sigil, resolved per design direction in tokens.css. */
export function sigilColor(sigil: Sigil): string {
  return `var(--sigil-${sigil.hue})`;
}

/**
 * How distinct two marks are, for the collision test: 2 when hue and shape both differ,
 * 1 when only one does, 0 when they are the same mark.
 */
export function sigilDistance(a: Sigil, b: Sigil): number {
  const sameHue = a.hue === b.hue;
  const sameShape = a.cells.every((v, i) => v === b.cells[i]);
  return (sameHue ? 0 : 1) + (sameShape ? 0 : 1);
}
