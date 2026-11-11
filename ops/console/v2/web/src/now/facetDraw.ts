// The Facet drawing, ported from the package's own implementation.
//
// This is deliberately a close port rather than a reinterpretation. The first
// attempt was written from the spec table and looked dead: a solid stroke whose
// only motion was a five percent width breath, which at sixteen pixels is about
// three pixels over four and a half seconds, so it read as a static image.
//
// The package's rail form is not a stroked outline at all. It is EIGHTEEN DOTS
// tracing the lozenge, each with its own alpha, so idle carries a shimmer
// travelling around the ring and speaking carries a wave chasing around it.
// That is what makes it legible at this size: the movement is in the dots, not
// in the silhouette.
//
// The voice envelope is synthesized here (envListen / envSpeak) exactly as the
// package does. There is no live audio level reaching the console, so a
// synthesized envelope is not a compromise: it is the design as delivered.

export type Phase = "offline" | "muted" | "idle" | "wake" | "listening" | "thinking" | "speaking";
export type Spk = "you" | "str" | "enr";

export const CT = {
  mute: "#7c7768", faint: "#4e4a42", ok: "#6ec988",
  amber: "#e7bd45", steel: "#6f7d8c", white: "#ffffff",
};
export const IDLE = "#769c76";
export const BASECOL: Record<Phase, string> = {
  offline: CT.faint, muted: CT.mute, idle: IDLE, wake: CT.ok,
  listening: CT.ok, thinking: CT.amber, speaking: CT.white,
};
const ENPH: Phase[] = ["wake", "listening", "thinking", "speaking"];

const hx = (c: string) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
export const mix = (a: string, b: string, k: number) => {
  const A = hx(a), B = hx(b);
  return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * k).toString(16).padStart(2, "0")).join("");
};
export const al = (c: string, a: number) =>
  c + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0");
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
/** Layered sines: never quite repeating, which is what reads as alive. */
export const n1 = (t: number) => Math.sin(t) * 0.55 + Math.sin(t * 2.13 + 1.7) * 0.3 + Math.sin(t * 4.7 + 0.4) * 0.15;

export const envListen = (t: number) => {
  const g = Math.max(0, Math.sin(t * 0.85) * 0.5 + 0.52);
  const s = Math.max(0, 0.62 + 0.3 * Math.sin(t * 6.9) + 0.22 * Math.sin(t * 11.3) + 0.12 * Math.sin(t * 2.2));
  return clamp(Math.pow(g, 1.5) * s * 1.25, 0, 1);
};
export const envSpeak = (t: number) => {
  const g = Math.max(0, Math.sin(t * 0.55 + 2) * 0.5 + 0.6);
  const s = 0.6 + 0.28 * Math.sin(t * 4.6) + 0.12 * Math.sin(t * 8.9);
  return clamp(Math.pow(g, 1.2) * s, 0, 1);
};
export function envFor(ph: Phase, t: number): number {
  if (ph === "listening") return envListen(t);
  if (ph === "speaking") return envSpeak(t);
  if (ph === "wake") return 0.9;
  return 0;
}
export const energyOf = (ph: Phase, env: number) =>
  ({ idle: 0.15, wake: 0.9, listening: 0.4 + env * 0.5, thinking: 1, speaking: 0.5 } as Record<string, number>)[ph] ?? 0;

const rX = (p: number[], a: number) => {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
};
const rY = (p: number[], a: number) => {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
};
const persp = (z: number) => 2.6 / (2.6 - z * 0.9);

/** Twelve vertices, thirty edges, and the interior grains, built once. */
export const ICO = (() => {
  const f = (1 + Math.sqrt(5)) / 2;
  const raw: number[][] = [];
  ([[0, 1, f], [0, 1, -f], [0, -1, f], [0, -1, -f], [1, f, 0], [1, -f, 0],
    [-1, f, 0], [-1, -f, 0], [f, 0, 1], [-f, 0, 1], [f, 0, -1], [-f, 0, -1]] as number[][])
    .forEach((p) => {
      const m = Math.hypot(p[0], p[1], p[2]);
      raw.push([p[0] / m, p[1] / m, p[2] / m]);
    });
  let dm = 9;
  for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) {
    const d = Math.hypot(raw[i][0] - raw[j][0], raw[i][1] - raw[j][1], raw[i][2] - raw[j][2]);
    if (d < dm) dm = d;
  }
  const e: number[][] = [];
  for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) {
    const d = Math.hypot(raw[i][0] - raw[j][0], raw[i][1] - raw[j][1], raw[i][2] - raw[j][2]);
    if (d < dm * 1.1) e.push([i, j]);
  }
  const grains: number[][] = [];
  let s = 7;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  while (grains.length < 150) {
    const x = rnd() * 2 - 1, y = rnd() * 2 - 1, z = rnd() * 2 - 1;
    if (x * x + y * y + z * z < 0.6) grains.push([x * 0.82, y * 0.82, z * 0.82]);
  }
  return { v: raw, e, grains };
})();

/** Mutable per-canvas animation state. */
export interface FacetState {
  S: Record<string, number>;
  bx: number; bv: number; bph: number; rx: number; ry: number;
  rings: { t0: number; w?: boolean }[];
  wring: number; dring: number;
  _pe?: number; _lo?: number;
}
export function newState(): FacetState {
  return { S: {}, bx: 0, bv: 0, bph: 0, rx: 0.4, ry: 0, rings: [], wring: 0, dring: 0 };
}

export interface IO {
  t: number; dt: number; ph: Phase; env: number; hard: number; col: string;
  prog: number | null; fill: number; doneK: number; stall: boolean;
  enr: number; spk: Spk; glow: boolean;
}

/** Exponential approach, so state changes ease rather than snap. */
const ap = (S: Record<string, number>, k: string, tg: number, rate: number, dt: number) => {
  const c = S[k] === undefined ? tg : S[k];
  const v = c + (tg - c) * Math.min(1, rate * dt);
  S[k] = v;
  return v;
};
const onsetOf = (st: FacetState, io: IO) => {
  const pe = st._pe === undefined ? 0 : st._pe;
  st._pe = io.env;
  const lo = st._lo === undefined ? -9 : st._lo;
  if (io.env > 0.5 && pe <= 0.5 && io.t - lo > 0.22) { st._lo = io.t; return true; }
  return false;
};

/** The expanded vessel: the crystal itself. */
export function drawCrystal(ctx: CanvasRenderingContext2D, w: number, h: number,
                            st: FacetState, io: IO) {
  const S = st.S;
  const { t, ph, hard, col } = io;
  const R = Math.min(w, h) * 0.31, cx = w / 2, cy = h / 2;
  const onset = onsetOf(st, io);
  const lock = ap(S, "lock", ph === "thinking" ? 1 : 0, 4, io.dt);
  const set = ap(S, "set", ph === "muted" ? 1 : 0, 2.2, io.dt);
  const dim = ap(S, "dim", ph === "offline" ? 1 : 0, 4, io.dt);

  st.bv += (-st.bx * 80 - st.bv * 7) * io.dt;
  st.bx += st.bv * io.dt;
  const energy = energyOf(ph, io.env);
  const frozen = ph === "muted" || ph === "offline";
  st.bph += frozen ? 0 : io.dt * 2 * Math.PI / 4.4;

  // asymmetric breath: sin(x - 0.45 sin x) rises faster than it falls
  let sc = R * (0.8 + 0.05 * Math.sin(st.bph - 0.45 * Math.sin(st.bph)) + st.bx * 0.35);
  if (ph === "speaking") sc *= 1 + io.env * 0.07 * Math.sin(t * 5.8);
  const stallK = io.stall ? 1 : 0;
  if (!frozen) {
    st.rx += io.dt * 0.16 * (0.4 + energy) * (1 - hard);
    st.ry += io.dt * (lock > 0.5 ? (io.prog === null ? 1.1 : 0.7 * (1 - stallK * 0.3))
      : 0.3 + 0.5 * energy) * (1 - hard);
  }
  const xf = (p: number[]) => rY(rX(p, st.rx), st.ry);
  const P = ICO.v.map((vv, i) => {
    let vd = 1;
    if (ph === "listening") vd = 1 + io.env * 0.15 * n1(t * 3 + i * 2.3);
    const p = xf([vv[0] * vd, vv[1] * vd, vv[2] * vd]);
    const y = p[1] * (1 - set * 0.9), z = p[2], pr = persp(z);
    return { x: cx + p[0] * sc * pr, y: cy + y * sc * pr + set * h * 0.24, z, d: (z + 1) / 2, pr };
  });

  const fillA = lock * (1 - set) * (1 - dim);
  if (fillA > 0.03) {
    if (io.prog === null) {
      const ea = t * 2.2;                       // the ember: work of unknown length
      for (let k = 0; k < 3; k++) {
        const a = ea - k * 0.3;
        const ep = xf([Math.cos(a) * 0.52, 0.18 * Math.sin(a * 1.7), Math.sin(a) * 0.52]);
        const pr = persp(ep[2]);
        ctx.fillStyle = al(CT.amber, fillA * (0.95 - k * 0.28));
        ctx.shadowColor = CT.amber; ctx.shadowBlur = io.glow ? 8 : 0;
        ctx.beginPath();
        ctx.arc(cx + ep[0] * sc * pr, cy + ep[1] * sc * pr, (3.2 - k) * pr, 0, 6.29);
        ctx.fill(); ctx.shadowBlur = 0;
      }
    } else {
      const lvl = lerp(0.85, -0.85, io.fill);   // the plane stays level in the world
      const gs: { x: number; y: number; z: number; d: number; pr: number; near: boolean }[] = [];
      ICO.grains.forEach((g, i) => {
        const p = xf(g);
        if (p[1] > lvl) {
          const near = Math.abs(p[1] - lvl) < 0.11;
          const jig = (near ? 1 : 0.3) * (1 + stallK * 1.5);
          const pr = persp(p[2]);
          gs.push({
            x: cx + (p[0] + n1(t * 2.1 + i) * 0.012 * jig) * sc * pr,
            y: cy + (p[1] + n1(t * 1.7 + i * 3) * 0.012 * jig) * sc * pr,
            z: p[2], d: (p[2] + 1) / 2, pr, near,
          });
        }
      });
      gs.sort((a, b) => a.z - b.z);
      gs.forEach((g) => {
        let cc = CT.amber, aa = fillA * (0.3 + 0.5 * g.d) * (g.near ? 1.6 : 1);
        if (io.doneK < 1) { cc = mix(CT.amber, CT.white, 1 - io.doneK); aa = fillA * (0.5 + 0.5 * g.d); }
        ctx.fillStyle = al(cc, clamp(aa, 0, 1));
        ctx.beginPath();
        ctx.arc(g.x, g.y, 1.5 * g.pr * (0.7 + 0.4 * g.d), 0, 6.29);
        ctx.fill();
      });
    }
  }

  if (dim > 0.5) ctx.setLineDash([3, 4]);
  ICO.e.forEach((e) => {
    const a = P[e[0]], b = P[e[1]], dd = (a.d + b.d) / 2;
    ctx.strokeStyle = al(col, (0.08 + 0.3 * dd) * (dim > 0.5 ? 0.5 : 1));
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  });
  ctx.setLineDash([]);

  ctx.shadowColor = col;
  P.map((q, i) => ({ q, i })).sort((a, b) => a.q.z - b.q.z).forEach(({ q, i }) => {
    let cc = col, aa = (0.3 + 0.6 * q.d) * (dim > 0.5 ? 0.5 : 1);
    if (io.spk === "enr" && ENPH.includes(ph)) {
      cc = CT.amber;
      aa = i < Math.ceil(io.enr * 2.4) ? Math.max(aa, 0.55 + 0.45 * q.d) : aa * 0.3;
    }
    ctx.shadowBlur = (io.glow && energy > 0.45 && dim < 0.5 && q.d > 0.65) ? 5 : 0;
    ctx.fillStyle = al(cc, clamp(aa, 0, 1));
    ctx.beginPath();
    ctx.arc(q.x, q.y, 2 * q.pr * (0.65 + 0.45 * q.d), 0, 6.29);
    ctx.fill();
  });
  ctx.shadowBlur = 0;

  if (onset && ph === "speaking") st.rings.push({ t0: t });
  if (st.wring) { st.rings.push({ t0: st.wring, w: true }); st.wring = 0; }
  if (io.doneK < 1 && !st.dring) { st.dring = 1; st.rings.push({ t0: t, w: true }); }
  if (io.doneK >= 1) st.dring = 0;
  st.rings = st.rings.filter((rg) => t - rg.t0 < 0.5);
  st.rings.forEach((rg) => {
    const k = (t - rg.t0) / 0.5;
    ctx.strokeStyle = al(io.doneK < 1 ? CT.white : col, (1 - k) * (rg.w ? 0.8 : 0.5));
    ctx.lineWidth = rg.w ? 1.6 : 1.1;
    ctx.beginPath(); ctx.arc(cx, cy, R * (1 + k * 1.3), 0, 6.29); ctx.stroke();
  });
}

/** The lozenge half-height at x: flat-topped, tapering from |x|=10 to |x|=20. */
export const lzY = (x: number) => {
  const ax = Math.abs(x);
  return ax < 10 ? 6 : Math.max(0, 6 * (1 - (ax - 10) / 10));
};

/** The rail vessel: the crystal's silhouette, drawn as eighteen dots. */
export function drawRail(ctx: CanvasRenderingContext2D, w: number, h: number,
                         st: FacetState, io: IO) {
  const { t, ph, hard, col } = io;
  const cx = w / 2, cy = h / 2;

  if (ph === "offline") {
    ctx.fillStyle = CT.faint;
    ([[12, 5], [27, 10], [42, 4], [53, 9]] as number[][])
      .forEach((p) => ctx.fillRect(p[0], p[1], 1.4, 1.4));
    return;
  }
  if (io.spk === "enr" && ENPH.includes(ph)) {
    for (let i = 0; i < 5; i++) {
      const x = 5 + i * 11.5, done = i < io.enr, act = i === io.enr && ph === "listening";
      ctx.fillStyle = done ? CT.amber : al(CT.amber, act ? 0.4 + 0.4 * Math.abs(Math.sin(t * 6)) : 0.15);
      ctx.fillRect(x, cy - 2.5, 9, 5);
    }
    return;
  }
  if (ph === "muted") {
    ctx.fillStyle = CT.mute;
    for (let i = 0; i < 12; i++) ctx.fillRect(8 + i * 4.2, cy + 4.5, 1.5, 1.5);
    return;
  }

  const frozenHard = hard > 0.5;
  st.bph += frozenHard ? 0 : io.dt * 2 * Math.PI / 4.4;
  let wS = 1 + 0.06 * Math.sin(st.bph) + (ph === "speaking" ? io.env * 0.12 : 0);
  st.bv += (-st.bx * 80 - st.bv * 7) * io.dt;
  st.bx += st.bv * io.dt;
  wS += st.bx * 0.3;
  const N = 18;

  if (ph === "thinking" && io.prog !== null) {
    const fw = io.fill * 40;
    for (let x = -20; x < -20 + fw; x += 2.6) {
      const yy = lzY(x) - 1;
      for (let y = -yy; y <= yy; y += 2.4) {
        const near = x > -20 + fw - 3;
        let cc = CT.amber;
        const aa = (near ? 0.95 : 0.55) + (io.stall && near ? 0.3 * Math.sin(t * 9) : 0);
        if (io.doneK < 1) cc = mix(CT.amber, CT.white, 1 - io.doneK);
        ctx.fillStyle = al(cc, clamp(aa, 0, 1));
        ctx.fillRect(cx + x * wS, cy + y, 1.5, 1.5);
      }
    }
  }

  for (let i = 0; i < N; i++) {
    const u = i / N * 6.28318;
    const x = 20 * Math.cos(u);
    const sgn = Math.sin(u) > 0 ? 1 : -1;
    const y = lzY(x) * sgn * Math.min(1, Math.abs(Math.sin(u)) * 1.4);
    let px = cx + x * wS, py = cy + y;
    if (ph === "listening") py += io.env * 2.2 * n1(t * 5 + i * 1.3);
    let cc = frozenHard ? CT.steel : col;
    // idle carries a shimmer travelling around the ring: this is the motion
    let aa = frozenHard ? 0.9 : 0.5 + 0.4 * Math.abs(Math.sin(u + t * (ph === "idle" ? 0.4 : 0)));
    if (ph === "speaking") aa = 0.3 + 0.6 * Math.max(0, Math.sin(u * 2 - t * 7));
    ctx.fillStyle = al(cc, clamp(aa, 0, 1));
    ctx.fillRect(px - 0.75, py - 0.75, 1.5, 1.5);
  }

  if (ph === "thinking" && !frozenHard) {
    const a = t * 1.4, xx = 20 * Math.cos(a);
    const px = cx + xx * wS;
    const py = cy + lzY(xx) * (Math.sin(a) > 0 ? 1 : -1) * Math.min(1, Math.abs(Math.sin(a)) * 1.4);
    ctx.fillStyle = CT.amber; ctx.shadowColor = CT.amber; ctx.shadowBlur = io.glow ? 4 : 0;
    ctx.beginPath(); ctx.arc(px, py, 1.7, 0, 6.29); ctx.fill(); ctx.shadowBlur = 0;
  }
  if (ph === "wake" && st.bx > 0.15) {
    ctx.strokeStyle = al(col, st.bx * 0.7);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, 10 + (1 - st.bx) * 16, 0, 6.29); ctx.stroke();
  }
}

/** The designed static forms, for reduced motion. Not a frozen frame. */
export function drawStatic(ctx: CanvasRenderingContext2D, w: number, h: number, ph: Phase) {
  const col = BASECOL[ph], cx = w / 2, cy = h / 2;
  const outline = (ws: number, aa: number) => {
    for (let i = 0; i < 18; i++) {
      const u = i / 18 * 6.28318;
      const x = 20 * Math.cos(u);
      const y = lzY(x) * (Math.sin(u) > 0 ? 1 : -1) * Math.min(1, Math.abs(Math.sin(u)) * 1.4);
      ctx.fillStyle = al(col, aa);
      ctx.fillRect(cx + x * ws - 0.75, cy + y - 0.75, 1.5, 1.5);
    }
  };
  if (ph === "offline") {
    ctx.fillStyle = CT.faint;
    ([[12, 5], [27, 10], [42, 4], [53, 9]] as number[][]).forEach((p) => ctx.fillRect(p[0], p[1], 1.4, 1.4));
  } else if (ph === "muted") {
    ctx.fillStyle = CT.mute;
    for (let i = 0; i < 12; i++) ctx.fillRect(8 + i * 4.2, cy + 4.5, 1.5, 1.5);
  } else if (ph === "idle") { outline(1, 0.75); }
  else if (ph === "wake") {
    outline(1, 0.9);
    ctx.strokeStyle = al(col, 0.5); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, 13, 0, 6.29); ctx.stroke();
  } else if (ph === "listening") { outline(1, 0.9); outline(1.18, 0.35); }
  else if (ph === "thinking") {
    outline(1, 0.85);
    for (let x = -20; x < 0; x += 2.6) {
      const yy = lzY(x) - 1;
      for (let y = -yy; y <= yy; y += 2.4) {
        ctx.fillStyle = al(CT.amber, 0.6);
        ctx.fillRect(cx + x, cy + y, 1.5, 1.5);
      }
    }
  } else { outline(1, 0.9); outline(1.14, 0.4); }
}
