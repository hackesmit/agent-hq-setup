// Facet: the Capri presence indicator.
//
// Two vessels, one organism. On the rail the crystal collapses to its
// silhouette, a faceted lozenge whose breath is its width; expanded it is the
// full twelve-vertex crystal, tumbling on two axes. Both read the same ear
// state, so they always agree.
//
// The phases come from the ear (state/console/ear-state.json, pushed as a
// console slice). The thinking phase has two forms and the difference matters:
// with no progress figure it shows an ember circulating inside the wireframe,
// which says "contained work of unknown length" and claims nothing; with a
// figure it fills with grains to a level that stays horizontal in the world
// while the crystal tumbles around it. The fill is rate limited, so a task that
// jumps from nothing to nearly done is watched pouring rather than teleporting.
// It never runs backward except on a real restart. See facet.ts for the physics
// and the honesty rules.
import { useEffect, useRef, useState } from "react";
import type { EarPhase, EarState } from "@shared/api";
import { postJson } from "../data/client";
import { useConsoleSlice } from "../data/store";
import { stepLevel } from "./facet";
import {
  BASECOL, drawCrystal, drawRail, drawStatic, envFor, newState,
  type FacetState, type IO, type Phase, type Spk,
} from "./facetDraw";

const LABEL: Record<EarPhase, string> = {
  offline: "voice offline",
  muted: "asleep",
  idle: "Capri, listening for you",
  wake: "yes?",
  listening: "listening",
  thinking: "thinking",
  speaking: "speaking",
};

/** Map the ear's speaker verdict onto the package's vocabulary. */
function spkOf(speaker: string | undefined): Spk {
  if (speaker === "unknown") return "str";      // a stranger: it hardens
  if (speaker === "enrolling") return "enr";
  return "you";
}

export function CapriIndicator({ compact = false, form = "rail" }:
  { compact?: boolean; form?: "rail" | "crystal" }) {
  const ear = useConsoleSlice((s) => s?.ear ?? null) as
    (EarState & { progress?: number | null; speaker?: string }) | null;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const st = useRef<FacetState>(newState());
  const anim = useRef({ fill: 0, doneK: 1, lastTarget: null as number | null, lastChange: 0, last: 0 });
  const live = useRef({ ph: "offline" as Phase, spk: "you" as Spk, prog: null as number | null });

  const phase = (ear?.state ?? "offline") as Phase;
  const speaker = ear?.speaker;
  const progress = ear?.progress ?? null;
  live.current = { ph: phase, spk: spkOf(speaker), prog: progress };

  // a wake is an event: kick the spring so the crystal spikes and rings once
  useEffect(() => {
    if (phase === "wake") {
      st.current.bv += 3.2;
      st.current.wring = performance.now() / 1000;
    }
  }, [phase]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let raf = 0;
    let stopped = false;

    const frame = (nowMs: number) => {
      if (stopped) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const box = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(box.width * dpr));
      const h = Math.max(1, Math.round(box.height * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, box.width, box.height);

      const { ph, spk, prog } = live.current;

      if (reduce) {
        // the designed static forms, not a frozen frame. The loop must stay
        // alive: returning without scheduling the next frame froze the
        // indicator on whatever phase it mounted with, so a dead ear kept
        // showing "idle" forever under prefers-reduced-motion.
        drawStatic(ctx, box.width, box.height, ph);
        raf = requestAnimationFrame(frame);
        return;
      }

      const a = anim.current;
      const t = nowMs / 1000;
      const dt = a.last ? Math.min(0.064, t - a.last) : 0.016;
      a.last = t;

      // the fill pours toward its target and never teleports
      if (prog !== a.lastTarget) { a.lastTarget = prog; a.lastChange = t; }
      const restarting = prog !== null && prog < a.fill - 0.02;
      const before = a.fill;
      a.fill = ph === "thinking" ? stepLevel(a.fill, prog, dt * 1000, restarting) : 0;
      if (before < 1 && a.fill >= 0.999) a.doneK = 0;
      if (a.doneK < 1) a.doneK = Math.min(1, a.doneK + dt / 0.6);

      const io: IO = {
        t, dt, ph,
        env: envFor(ph, t),
        hard: spk === "str" ? 1 : 0,
        col: spk === "str" ? "#6f7d8c" : BASECOL[ph],
        prog, fill: a.fill, doneK: a.doneK,
        stall: ph === "thinking" && prog !== null && t - a.lastChange > 4,
        enr: Math.min(5, Math.floor(((t / 1.7) % 6))),
        spk, glow: true,
      };

      if (form === "crystal") drawCrystal(ctx, box.width, box.height, st.current, io);
      else drawRail(ctx, box.width, box.height, st.current, io);

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { stopped = true; cancelAnimationFrame(raf); };
  }, [form]);

  const label = LABEL[phase] ?? LABEL.offline;
  const heard = phase === "thinking" || phase === "speaking" ? ear?.text ?? null : null;
  const pct = phase === "thinking" && progress !== null ? `, ${Math.round(progress * 100)} percent` : "";

  // "capri, go to sleep" released the microphone; this is the one way back
  // besides the local mute script. The stamp is inert, so a double click or a
  // click with the ear already awake does nothing.
  const [waking, setWaking] = useState(false);
  const wake = () => {
    setWaking(true);
    postJson("/api/ear-wake", {}).catch(() => {}).finally(() => setWaking(false));
  };

  return (
    <div
      // Stacked whenever the label is on, because at 212px the rail leaves about a
      // hundred pixels beside the lozenge and the label needs more than that.
      className={compact ? "hq-facet" : "hq-facet hq-facet--stack"}
      data-phase={phase}
      data-speaker={speaker ?? "yours"}
      title={heard ? `heard: ${heard}` : label}
      role="status"
      aria-label={`capri: ${label}${pct}`}
    >
      <canvas
        ref={canvasRef}
        className={form === "crystal" ? "hq-facet-crystal" : "hq-facet-rail"}
        aria-hidden="true"
      />
      {compact ? null : (
        <small className="hq-facet-label">
          {label}
          {heard ? <span className="hq-facet-text"> · {heard}</span> : null}
          {phase === "muted" ? (
            <button
              type="button"
              className="hq-facet-wake"
              disabled={waking}
              onClick={wake}
            >
              wake
            </button>
          ) : null}
        </small>
      )}
    </div>
  );
}
