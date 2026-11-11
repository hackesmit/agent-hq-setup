// Capri's corner (hq-ymxzt.5, board G): the owner's own frames, fixed bottom-right on
// every console page (never the pop-out terminal, which Shell renders without it).
// It loops the frames for the mood from capri.ts inside a square capri.exe window (hq-ymxzt.8) with a
// turning neon ring edge and a state glow, with scanlines, fades between moods, says one short line, and a click opens the
// orchestrator terminal. Capri owns its own palette (tokens.css). the owner prepares
// the frames himself (docs/capri-frames.md); nothing is drawn or cropped here, and
// with no frames the corner shows a small red dot, and a gear in the title bar opens Load
// images (CapriLoadPanel), where he drops his own files from his PC.
// Dragging the title bar moves the box, the grip at its top-left corner resizes it, and a
// double-click on the title bar puts it back; the place is kept per browser (capriPlace.ts).
//
// Cost when idle: none unless the idle clip has more than one frame. Under
// prefers-reduced-motion it holds the first frame, does not fade and stills every
// CSS animation (styles.css).
import { useEffect, useRef, useState } from "react";
import { navigate } from "../app/router";
import { tabPath } from "../app/routes";
import { capri, capriLift, capriLine, useCapriMood, type CapriMood } from "./capri";
import { capriClip, capriFrameAt, loadCapriFrames, onCapriFramesChanged, type CapriFrames } from "./capriFrames";
import { CapriLoadPanel } from "./CapriLoadPanel";
import { CAPRI_DEFAULT_SIZE, clampPlace, readPlace, savePlace, type CapriPlace } from "./capriPlace";

const LABEL: Record<CapriMood, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

function useReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia?.(query).matches === true);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = (): void => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

function isInput(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** Raises the corner while a focused input sits under or near it. Event driven, no polling. */
function useLift(ref: React.RefObject<HTMLElement | null>): number {
  const [lift, setLift] = useState(0);
  useEffect(() => {
    function measure(): void {
      const el = ref.current;
      const focused = document.activeElement;
      if (!el || !isInput(focused)) return setLift(0);
      // measure from the resting place, so a lifted corner does not chase itself
      const r = el.getBoundingClientRect();
      const current = Number(el.dataset.lift || 0);
      const rest = { left: r.left, right: r.right, top: r.top + current, bottom: r.bottom + current };
      setLift(capriLift(rest, focused.getBoundingClientRect()));
    }
    const later = (): void => void window.requestAnimationFrame(measure);
    document.addEventListener("focusin", later);
    document.addEventListener("focusout", later);
    window.addEventListener("resize", later);
    return () => {
      document.removeEventListener("focusin", later);
      document.removeEventListener("focusout", later);
      window.removeEventListener("resize", later);
    };
  }, [ref]);
  return lift;
}

/** The box's place: null is the default corner. A drag on the bar moves it, a drag on the grip resizes it. */
function usePlace(ref: React.RefObject<HTMLElement | null>) {
  const [place, setPlace] = useState<CapriPlace | null>(() => readPlace());
  const [, setView] = useState(0);
  useEffect(() => {
    const on = (): void => setView((v) => v + 1);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  function current(): CapriPlace {
    if (place) return place;
    const r = ref.current?.getBoundingClientRect();
    return r ? { right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom, size: CAPRI_DEFAULT_SIZE } : { right: 16, bottom: 16, size: CAPRI_DEFAULT_SIZE };
  }

  function drag(e: React.PointerEvent, mode: "move" | "size"): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const start = current();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let last = start;
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      const next =
        mode === "move"
          ? { ...start, right: start.right - dx, bottom: start.bottom - dy }
          : { ...start, size: start.size + Math.max(-dx, -dy) };
      last = clampPlace(next, window.innerWidth, window.innerHeight);
      setPlace(last);
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      savePlace(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function reset(): void {
    setPlace(null);
    savePlace(null);
  }

  const shown = place ? clampPlace(place, window.innerWidth, window.innerHeight) : null;
  return { shown, drag, reset };
}

/** Loops the mood's frames; a pulse dot while there are none. */
function CapriPlayer({ mood, reduced, onHas }: { mood: CapriMood; reduced: boolean; onHas: (has: boolean) => void }) {
  const [frames, setFrames] = useState<CapriFrames | null>(null);
  const [step, setStep] = useState(0);

  useEffect(() => {
    let live = true;
    const read = (): void =>
      void loadCapriFrames().then((f) => {
        if (!live) return;
        // warm the cache so a mood change never shows an empty frame
        for (const c of Object.values(f ?? {})) for (const url of c?.frames ?? []) new Image().src = url;
        setFrames(f);
        onHas(f !== null);
      });
    read();
    const off = onCapriFramesChanged(read);
    return () => {
      live = false;
      off();
    };
  }, [onHas]);

  const clip = frames ? capriClip(frames, mood) : null;
  const loops = clip !== null && clip.frames.length > 1 && !reduced;
  useEffect(() => {
    setStep(0);
    if (!loops || !clip) return;
    const timer = window.setInterval(() => setStep((s) => s + 1), clip.ms);
    return () => window.clearInterval(timer);
  }, [clip, loops]);

  if (!clip) return <span className="hq-capri-dot block h-3 w-3" aria-hidden="true" />;
  return (
    <>
      {/* keyed by clip, so a mood change remounts the image and its fade-in runs */}
      <img
        key={clip.frames[0]}
        src={capriFrameAt(clip, step * clip.ms, reduced)}
        alt=""
        draggable={false}
        className="hq-capri-img block h-full w-full object-cover"
      />
      <span className="hq-capri-scanlines pointer-events-none absolute inset-0" aria-hidden="true" />
    </>
  );
}

export function CapriCorner({ waiting }: { waiting: number }) {
  const mood = useCapriMood();
  const reduced = useReducedMotion();
  const [hover, setHover] = useState(false);
  const [panel, setPanel] = useState(false);
  const [has, setHas] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const lift = useLift(ref);
  const { shown, drag, reset } = usePlace(ref);

  const line = capriLine(mood, waiting);
  const showBubble = mood !== "idle" || hover;

  function open(): void {
    navigate(tabPath("now"));
    // the orchestrator pane mounts with the Now tab; focus it once it has
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => void capri.focus()));
  }

  return (
    <div
      ref={ref}
      data-lift={lift}
      data-mood={mood}
      data-placed={shown ? "" : undefined}
      className="hq-capri-corner fixed right-4 z-40 flex items-end gap-2.5"
      style={{
        transform: lift ? `translateY(-${lift}px)` : undefined,
        ...(shown ? { right: shown.right, bottom: shown.bottom, ["--hq-capri-size" as string]: `${shown.size}px` } : {}),
      }}
    >
      {showBubble ? (
        <div key={mood} className="hq-capri-bubble pointer-events-none flex max-w-[240px] flex-col gap-1 rounded-[6px] px-3 py-2.5" role="status" aria-live="polite">
          <span className="text-[10px] uppercase tracking-[0.14em] text-capri-soft">{LABEL[mood]}</span>
          <span className="font-sans text-[13px] leading-[1.4]" style={{ color: "var(--capri-text)" }}>{line}</span>
        </div>
      ) : (
        <span className="sr-only" role="status" aria-live="polite">{line}</span>
      )}
      <span className="hq-capri-badge relative block" data-mood={mood}>
        <span className="hq-capri-window flex flex-col">
          <span
            className="hq-capri-bar flex items-center justify-between gap-1 px-1.5 font-mono"
            title="Drag to move, double-click to reset"
            onPointerDown={(e) => {
              if (!(e.target as Element).closest("button")) drag(e, "move");
            }}
            onDoubleClick={reset}
          >
            <span className="hq-capri-exe">capri.exe</span>
            <span className="hq-capri-state">{LABEL[mood].toLowerCase()}</span>
            <button
              type="button"
              className="hq-capri-gear"
              aria-label="Capri: load images"
              aria-expanded={panel}
              title="Load images"
              onClick={() => setPanel((p) => !p)}
            >
              ⚙
            </button>
          </span>
          <button
            type="button"
            className="hq-capri-frame relative block cursor-pointer"
            data-mood={mood}
            title={has ? "Capri: open the orchestrator terminal" : "Capri: load your images"}
            aria-label={has ? `Capri, ${LABEL[mood].toLowerCase()}: open the orchestrator terminal` : "Capri has no images yet: load images"}
            onClick={has ? open : () => setPanel(true)}
            onPointerEnter={() => setHover(true)}
            onPointerLeave={() => setHover(false)}
            onFocus={() => setHover(true)}
            onBlur={() => setHover(false)}
          >
            <span className="hq-capri-inner">
              <CapriPlayer mood={mood} reduced={reduced} onHas={setHas} />
            </span>
          </button>
        </span>
        <span
          className="hq-capri-grip"
          role="separator"
          aria-label="Capri: drag to resize"
          title="Drag to resize"
          onPointerDown={(e) => drag(e, "size")}
        />
        {panel ? (
          <div className="absolute bottom-full right-0 mb-2">
            <CapriLoadPanel onClose={() => setPanel(false)} />
          </div>
        ) : null}
      </span>
    </div>
  );
}
