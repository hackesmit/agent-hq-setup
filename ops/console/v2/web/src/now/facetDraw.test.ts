import { describe, expect, it } from "vitest";
import {
  BASECOL, ICO, drawCrystal, drawRail, drawStatic, envFor, lzY, newState,
  type IO, type Phase,
} from "./facetDraw";

/** A canvas context that records what was drawn, so a frame can be compared. */
function recorder() {
  const ops: string[] = [];
  const r = (n: string) => (...a: unknown[]) =>
    ops.push(n + "(" + a.map((v) => (typeof v === "number" ? v.toFixed(2) : String(v))).join(",") + ")");
  const ctx = {
    ops,
    fillRect: r("fillRect"), strokeRect: r("strokeRect"), clearRect: r("clearRect"),
    beginPath: r("beginPath"), closePath: r("closePath"), moveTo: r("moveTo"),
    lineTo: r("lineTo"), arc: r("arc"), fill: r("fill"), stroke: r("stroke"),
    save: r("save"), restore: r("restore"), clip: r("clip"),
    setLineDash: r("setLineDash"), setTransform: r("setTransform"),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1,
    shadowColor: "", shadowBlur: 0, font: "", textAlign: "",
  };
  return ctx as unknown as CanvasRenderingContext2D & { ops: string[] };
}

function io(ph: Phase, t: number, over: Partial<IO> = {}): IO {
  return {
    t, dt: 0.016, ph, env: envFor(ph, t), hard: 0, col: BASECOL[ph],
    prog: null, fill: 0, doneK: 1, stall: false, enr: 0, spk: "you", glow: true,
    ...over,
  };
}

/** Draw n frames and return each frame's recorded output. */
function frames(ph: Phase, times: number[], over: Partial<IO> = {}) {
  const st = newState();
  return times.map((t) => {
    const ctx = recorder();
    drawRail(ctx, 64, 16, st, io(ph, t, over));
    return ctx.ops.join("|");
  });
}

describe("the crystal is the shape the package specifies", () => {
  it("is twelve vertices and thirty edges", () => {
    expect(ICO.v).toHaveLength(12);
    expect(ICO.e).toHaveLength(30);
    expect(ICO.grains).toHaveLength(150);
  });

  it("has a flat-topped lozenge that tapers to nothing at the points", () => {
    expect(lzY(0)).toBe(6);
    expect(lzY(9)).toBe(6);
    expect(lzY(20)).toBe(0);
    expect(lzY(15)).toBeGreaterThan(0);
    expect(lzY(15)).toBeLessThan(6);
  });
});

describe("it actually moves", () => {
  // This is the regression that matters. The first implementation drew a
  // stroked outline whose only motion was a 5 percent width breath, which at
  // sixteen pixels is about three pixels over four seconds: it read as a static
  // image. These tests fail if the rail ever goes still again.

  it("idle changes from frame to frame", () => {
    const [a, b, c] = frames("idle", [0, 0.6, 1.4]);
    expect(a).not.toEqual(b);
    expect(b).not.toEqual(c);
  });

  it("idle keeps changing across a whole breath cycle", () => {
    const seen = new Set(frames("idle", [0, 1.1, 2.2, 3.3, 4.4]));
    expect(seen.size).toBe(5);
  });

  it("listening moves, and moves differently from idle", () => {
    const [a, b] = frames("listening", [0.3, 0.9]);
    expect(a).not.toEqual(b);
    expect(frames("listening", [0.5])[0]).not.toEqual(frames("idle", [0.5])[0]);
  });

  it("speaking moves", () => {
    const [a, b] = frames("speaking", [0.2, 0.5]);
    expect(a).not.toEqual(b);
  });

  it("thinking moves even with no progress figure, because the ember circulates", () => {
    const [a, b] = frames("thinking", [0.2, 0.9]);
    expect(a).not.toEqual(b);
  });

  it("the crystal moves too", () => {
    const st = newState();
    const shot = (t: number) => {
      const ctx = recorder();
      drawCrystal(ctx, 200, 160, st, io("idle", t));
      return ctx.ops.join("|");
    };
    expect(shot(0)).not.toEqual(shot(0.8));
  });
});

describe("it is deliberately still where stillness is the meaning", () => {
  it("offline does not move: a dead ear must not look alive", () => {
    const [a, b] = frames("offline", [0, 2.5]);
    expect(a).toEqual(b);
  });

  it("muted does not move either, and draws a different shape from offline", () => {
    const [a, b] = frames("muted", [0, 2.5]);
    expect(a).toEqual(b);
    expect(a).not.toEqual(frames("offline", [0])[0]);
  });

  it("a voice that is not the owner's stops it dead", () => {
    const [a, b] = frames("listening", [0.4, 1.9], { hard: 1, env: 0 });
    expect(a).toEqual(b);
  });
});

describe("reduced motion gets designed statics, not a frozen frame", () => {
  it("draws something for every phase", () => {
    for (const ph of ["offline", "muted", "idle", "wake", "listening", "thinking", "speaking"] as Phase[]) {
      const ctx = recorder();
      drawStatic(ctx, 64, 16, ph);
      expect(ctx.ops.length, `${ph} drew nothing`).toBeGreaterThan(0);
    }
  });

  it("distinguishes the phases rather than drawing one shape", () => {
    const shot = (ph: Phase) => {
      const ctx = recorder();
      drawStatic(ctx, 64, 16, ph);
      return ctx.ops.join("|");
    };
    const all = ["offline", "muted", "idle", "listening", "thinking"].map((p) => shot(p as Phase));
    expect(new Set(all).size).toBe(5);
  });
});

describe("the fill", () => {
  it("draws more of the lozenge as progress rises", () => {
    const st = newState();
    const width = (fill: number) => {
      const ctx = recorder();
      drawRail(ctx, 64, 16, st, io("thinking", 1, { prog: fill, fill }));
      return (ctx.ops.join("|").match(/fillRect/g) || []).length;
    };
    expect(width(0.8)).toBeGreaterThan(width(0.2));
  });
});
