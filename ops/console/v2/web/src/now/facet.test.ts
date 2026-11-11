import { describe, expect, it } from "vitest";
import { breath, edges, grains, icosahedron, rotate, spin, springSpike, stepLevel } from "./facet";

describe("the crystal", () => {
  it("is twelve vertices and thirty edges, as the spec says", () => {
    const v = icosahedron();
    expect(v).toHaveLength(12);
    expect(edges(v)).toHaveLength(30);
  });

  it("has every vertex on the unit sphere", () => {
    for (const [x, y, z] of icosahedron()) {
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
    }
  });

  it("breathes within plus or minus five percent, and is not a mirror image", () => {
    const samples = Array.from({ length: 400 }, (_, i) => breath(i * 11));
    expect(Math.min(...samples)).toBeGreaterThan(0.94);
    expect(Math.max(...samples)).toBeLessThan(1.06);
    // asymmetric: the rise and the fall are different lengths, so the halves differ
    const rise = breath(4400 * 0.2), fall = breath(4400 * 0.8);
    expect(Math.abs(rise - fall)).toBeGreaterThan(0.01);
  });

  it("stops dead for a voice that is not the owner's", () => {
    expect(spin("listening", "unknown")).toEqual({ x: 0, y: 0 });
    expect(spin("listening", "yours").y).toBeGreaterThan(0);
  });

  it("does not tumble when it holds no microphone", () => {
    expect(spin("muted", "yours")).toEqual({ x: 0, y: 0 });
    expect(spin("offline", "yours")).toEqual({ x: 0, y: 0 });
  });

  it("spikes on wake and settles, rather than ringing forever", () => {
    expect(springSpike(0)).toBeCloseTo(0.35, 2);
    expect(Math.abs(springSpike(1200))).toBeLessThan(0.02);
    expect(springSpike(4000)).toBe(0);
  });
});

describe("the fill, which must not lie", () => {
  it("pours toward the target rather than teleporting", () => {
    // a jump from nothing to nearly full may not land in one frame
    const after = stepLevel(0, 0.9, 100);
    expect(after).toBeLessThan(0.05);
    expect(after).toBeGreaterThan(0);
  });

  it("reaches the target eventually, and stops there", () => {
    let v = 0;
    for (let i = 0; i < 200; i++) v = stepLevel(v, 0.5, 100);
    expect(v).toBeCloseTo(0.5, 6);
  });

  it("never runs backward on its own", () => {
    expect(stepLevel(0.8, 0.2, 100)).toBe(0.8);
  });

  it("drains only when the task actually restarted", () => {
    expect(stepLevel(0.8, 0.2, 100, true)).toBeLessThan(0.8);
  });

  it("holds still when progress is unknown, instead of inventing one", () => {
    expect(stepLevel(0.4, null, 1000)).toBe(0.4);
  });
});

describe("the grains", () => {
  it("are inside the sphere and identical every run", () => {
    const a = grains(150), b = grains(150);
    expect(a).toHaveLength(150);
    expect(a).toEqual(b);                        // deterministic: a substance, not noise
    for (const [x, y, z] of a) expect(Math.hypot(x, y, z)).toBeLessThanOrEqual(1);
  });
});

describe("rotation", () => {
  it("preserves length, so the crystal cannot drift or shear", () => {
    const p: [number, number, number] = [0.3, -0.5, 0.81];
    const r = rotate(p, 1.1, 2.2);
    expect(Math.hypot(...r)).toBeCloseTo(Math.hypot(...p), 10);
  });
});
