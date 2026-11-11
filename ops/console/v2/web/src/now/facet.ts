// Facet: the geometry and physics of the Capri presence crystal.
//
// Twelve vertices and thirty edges is an icosahedron, tumbling on two axes and
// breathing on a 4.4 second asymmetric cycle. It reads as alive because it is
// never quite repeating, not because anything about it is fast.
//
// Kept separate from the React component so the physics is testable without a
// canvas, and so the drawing code stays about drawing.
//
// Every constant here comes from the Facet package motion spec. Where a number
// looks arbitrary it is not: it is the spec's, and changing it is a design
// decision rather than a tuning knob.

export type Phase = "offline" | "muted" | "idle" | "wake" | "listening" | "thinking" | "speaking";
export type Speaker = "yours" | "unknown" | "enrolling";

const PHI = (1 + Math.sqrt(5)) / 2;

/** The twelve vertices, unit-normalised. */
export function icosahedron(): [number, number, number][] {
  const raw: [number, number, number][] = [];
  for (const s1 of [-1, 1]) {
    for (const s2 of [-1, 1]) {
      raw.push([0, s1 * 1, s2 * PHI]);
      raw.push([s1 * 1, s2 * PHI, 0]);
      raw.push([s1 * PHI, 0, s2 * 1]);
    }
  }
  const n = Math.hypot(1, PHI);
  return raw.map(([x, y, z]) => [x / n, y / n, z / n]);
}

/** The thirty edges: every vertex pair at the icosahedron's edge length. */
export function edges(verts: [number, number, number][]): [number, number][] {
  const out: [number, number][] = [];
  // edge length for a unit icosahedron, with room for float error
  const target = 2 / Math.hypot(1, PHI);
  for (let i = 0; i < verts.length; i++) {
    for (let j = i + 1; j < verts.length; j++) {
      const d = Math.hypot(
        verts[i][0] - verts[j][0],
        verts[i][1] - verts[j][1],
        verts[i][2] - verts[j][2],
      );
      if (Math.abs(d - target) < 1e-6) out.push([i, j]);
    }
  }
  return out;
}

/** Breath: plus or minus 5 percent scale on a 4.4s cycle, asymmetric so the
 * inhale and the exhale are not mirror images and the loop never reads as one. */
export function breath(tMs: number): number {
  const p = (tMs / 4400) % 1;
  // a longer fall than rise: 40 percent in, 60 percent out
  const shaped = p < 0.4
    ? Math.sin((p / 0.4) * Math.PI * 0.5)
    : Math.cos(((p - 0.4) / 0.6) * Math.PI * 0.5);
  return 1 + shaped * 0.05;
}

/** Tumble rates per phase: 0.16 rad/s on X always, 0.3 to 0.8 on Y by energy. */
export function spin(phase: Phase, speaker: Speaker): { x: number; y: number } {
  if (speaker === "unknown") return { x: 0, y: 0 };      // stillness itself
  if (phase === "offline" || phase === "muted") return { x: 0, y: 0 };
  const y = phase === "idle" ? 0.3
    : phase === "listening" ? 0.55
    : phase === "thinking" ? 0.8
    : phase === "speaking" ? 0.45
    : 0.7;
  return { x: 0.16, y };
}

/** An underdamped spring, for the wake spike: omega 9 rad/s, zeta 0.39. */
export function springSpike(sinceWakeMs: number): number {
  if (sinceWakeMs < 0) return 0;
  const t = sinceWakeMs / 1000;
  const w = 9, z = 0.39;
  const wd = w * Math.sqrt(1 - z * z);
  const env = Math.exp(-z * w * t);
  if (env < 0.002) return 0;
  return 0.35 * env * Math.cos(wd * t);
}

/** Speaking pulse: plus or minus 7 percent at about 0.9 Hz. */
export function speakPulse(tMs: number): number {
  return 1 + 0.07 * Math.sin((tMs / 1000) * 2 * Math.PI * 0.9);
}

/**
 * The fill level, rate limited. Jumps pour, they never teleport: a task that
 * reports 0 then 0.9 has to be watched filling, or the number is a lie told
 * quickly. Backward motion is refused except on an explicit restart, which
 * drains instead (honesty rule from the package).
 */
export const FILL_RATE = 0.25;      // per second

export function stepLevel(current: number, target: number | null, dtMs: number,
                          restarting = false): number {
  if (target === null) return current;
  const max = FILL_RATE * (dtMs / 1000);
  if (restarting) return Math.max(0, current - (dtMs / 300));   // drain in 300ms
  if (target < current) return current;                          // never runs backward
  return Math.min(target, current + max);
}

/** Deterministic interior grains, so the fill looks like a substance rather
 * than noise that reshuffles every frame. */
export function grains(count: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  let seed = 20260825;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  while (out.length < count) {
    const x = rnd() * 2 - 1, y = rnd() * 2 - 1, z = rnd() * 2 - 1;
    if (x * x + y * y + z * z <= 1) out.push([x, y, z]);
  }
  return out;
}

/** Rotate a point on Y then X. */
export function rotate(p: [number, number, number], ax: number, ay: number): [number, number, number] {
  const [x, y, z] = p;
  const cy = Math.cos(ay), sy = Math.sin(ay);
  const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
  const cx = Math.cos(ax), sx = Math.sin(ax);
  const y1 = y * cx - z1 * sx, z2 = y * sx + z1 * cx;
  return [x1, y1, z2];
}
