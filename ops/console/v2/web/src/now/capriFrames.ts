// Capri's frames (hq-ymxzt.5): images the owner prepares himself and drops in
// state/capri/frames/<state>/ on hqbox (format: docs/capri-frames.md). The server
// lists them at /api/capri/frames; this module checks that list and decides which
// frame shows when. Nothing is drawn or cropped here, and no frame ships with the
// console: with no frames the corner shows a pulse dot.
import { postBytes } from "../data/client";
import type { CapriMood } from "./capri";

export const CAPRI_FRAMES_URL = "/api/capri/frames";
const MOODS = ["idle", "listening", "thinking", "speaking"] as const;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(?:png|webp|jpe?g|gif)$/i;
const MIN_MS = 40;
const MAX_MS = 5_000;

export interface CapriClip {
  ms: number;
  frames: string[];
}

export type CapriFrames = Partial<Record<CapriMood, CapriClip>>;

function clip(mood: CapriMood, raw: unknown): CapriClip | null {
  if (!raw || typeof raw !== "object") return null;
  const { ms, frames } = raw as { ms?: unknown; frames?: unknown };
  if (!Array.isArray(frames)) return null;
  // only "<this state>/<file>", so a list can never point the page anywhere else
  const urls = frames
    .filter((f): f is string => typeof f === "string" && f.startsWith(`${mood}/`) && NAME.test(f.slice(mood.length + 1)))
    .map((f) => `${CAPRI_FRAMES_URL}/${f}`);
  if (urls.length === 0) return null;
  const n = typeof ms === "number" && Number.isFinite(ms) ? ms : 500;
  return { ms: Math.min(MAX_MS, Math.max(MIN_MS, Math.round(n))), frames: urls };
}

/** A checked manifest, or null when it is missing, malformed or holds no frame. */
export function parseCapriFrames(raw: unknown): CapriFrames | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as { version?: unknown; states?: unknown };
  if (m.version !== 1 || !m.states || typeof m.states !== "object") return null;
  const out: CapriFrames = {};
  for (const mood of MOODS) {
    const c = clip(mood, (m.states as Record<string, unknown>)[mood]);
    if (c) out[mood] = c;
  }
  return Object.keys(out).length ? out : null;
}

/** The clip for a mood: its own, else idle, else any state the owner supplied. */
export function capriClip(frames: CapriFrames, mood: CapriMood): CapriClip {
  return (frames[mood] ?? frames.idle ?? frames.listening ?? frames.thinking ?? frames.speaking) as CapriClip;
}

/** The frame to show `elapsed` ms into a clip. Reduced motion holds the first frame. */
export function capriFrameAt(c: CapriClip, elapsed: number, reduced: boolean): string {
  if (reduced || c.frames.length === 1) return c.frames[0];
  return c.frames[Math.floor(Math.max(0, elapsed) / c.ms) % c.frames.length];
}

let loading: Promise<CapriFrames | null> | null = null;
const listeners = new Set<() => void>();

/** Fetches the manifest once per page load. A failure is the no-frames state, not an error. */
export function loadCapriFrames(fetcher: typeof fetch = fetch): Promise<CapriFrames | null> {
  loading ??= fetcher(CAPRI_FRAMES_URL, { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : null))
    .then(parseCapriFrames)
    .catch(() => null);
  return loading;
}

/** Forgets the cached manifest and tells the corner and the panel to read it again. */
export function reloadCapriFrames(): void {
  loading = null;
  for (const fn of listeners) fn();
}

export function onCapriFramesChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------- Load images (hq-ymxzt.8) ----------
export const CAPRI_MAX_BYTES = 5 * 1024 * 1024;
const TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Why a file cannot be loaded, or null. The server checks the real bytes again. */
export function capriFileProblem(f: { name: string; type: string; size: number }): string | null {
  if (!TYPES.has(f.type) && !/\.(png|jpe?g|webp|gif)$/i.test(f.name)) return "Use a png, jpg, webp or gif.";
  if (f.size > CAPRI_MAX_BYTES) return "Over 5 MB.";
  if (f.size === 0) return "Empty file.";
  return null;
}

export function capriFrameUrl(frame: string): string {
  return `${CAPRI_FRAMES_URL}/${frame}`;
}

export async function uploadCapriFrame(mood: CapriMood, file: File): Promise<string> {
  const r = await postBytes<{ frame: string }>(`${CAPRI_FRAMES_URL}/${mood}/${encodeURIComponent(file.name)}`, file);
  reloadCapriFrames();
  return r.frame;
}

export async function removeCapriFrame(frame: string): Promise<void> {
  await postBytes(`${CAPRI_FRAMES_URL}/${frame}/delete`, new Blob([]));
  reloadCapriFrames();
}
