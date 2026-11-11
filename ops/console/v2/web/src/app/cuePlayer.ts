// The noise half of the cue system: WebAudio, asset loading, and the synthesized
// fallbacks that make the feature work before a single sound file exists.
//
// the owner supplies the real sounds. Until they land (and whenever one is missing, fails
// to fetch, or fails to decode) each cue falls back to a short synthesized tone whose
// SHAPE matches the cue: rising for "attention", falling for "finished", a flat click
// for routine, a low thud for failure. The vocabulary is therefore learnable from day
// one and the assets are an upgrade rather than a prerequisite.
//
// Bead: hq-4lxc.

import type { CueName } from "./cues";

/** One synthesized voice: a sequence of (frequency, duration) steps. */
interface Tone {
  /** Hz for each step, in order. */
  steps: number[];
  /** Seconds per step. */
  step: number;
  /** Peak gain, 0 to 1. This is where salience is encoded audibly. */
  gain: number;
  /** Oscillator shape. `sine` reads as soft, `triangle` as present, `square` as urgent. */
  wave: OscillatorType;
  /** Slide between steps rather than stepping, for blips. */
  glide?: boolean;
}

/**
 * Fallback voices. The shapes are the ones drawn in the design memo, so what you hear
 * and what is documented agree.
 */
export const TONES: Record<CueName, Tone> = {
  // Two rising tones. The one that must never be missed.
  NEEDS_YOU: { steps: [660, 880], step: 0.13, gain: 0.3, wave: "triangle" },
  // Three insistent tones, harder edged.
  URGENT: { steps: [880, 660, 880], step: 0.12, gain: 0.36, wave: "square" },
  // A single soft tick.
  ANSWERED: { steps: [1180], step: 0.05, gain: 0.14, wave: "sine" },
  // Warm two-note fall.
  DONE: { steps: [740, 494], step: 0.16, gain: 0.24, wave: "sine" },
  // Short click, deliberately quiet: this one happens all day.
  DISPATCHED: { steps: [1000], step: 0.028, gain: 0.08, wave: "sine" },
  // Dull low thud. Must not be mistakable for DONE.
  FAILED: { steps: [196, 147], step: 0.14, gain: 0.26, wave: "triangle" },
  // Rising blip: the ear opened.
  LISTENING: { steps: [520, 1040], step: 0.09, gain: 0.22, wave: "sine", glide: true },
  // Confirming chirp: it took.
  COMMITTED: { steps: [780, 1170, 780], step: 0.055, gain: 0.2, wave: "sine" },
  // Descending blip: nothing happened.
  CANCEL: { steps: [780, 390], step: 0.09, gain: 0.18, wave: "sine", glide: true },
};

/** Shape of public/cues/cues.json. Unknown keys are ignored, missing keys fall back. */
export interface CueManifest {
  /** Cue name to a path relative to the manifest, or an absolute path. */
  files?: Partial<Record<CueName, string>>;
  /** Multiply every cue's gain, so one badly recorded set can be levelled globally. */
  gain?: number;
}

export const MANIFEST_URL = "/cues/cues.json";

/** Parse a manifest defensively: a broken file must degrade to synthesis, never throw. */
export function parseManifest(raw: unknown): CueManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const rec = raw as Record<string, unknown>;
  const out: CueManifest = {};
  if (rec.files && typeof rec.files === "object" && !Array.isArray(rec.files)) {
    const files: Partial<Record<CueName, string>> = {};
    for (const [k, v] of Object.entries(rec.files as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) files[k as CueName] = v.trim();
    }
    out.files = files;
  }
  if (typeof rec.gain === "number" && Number.isFinite(rec.gain) && rec.gain > 0) {
    out.gain = Math.min(4, rec.gain);
  }
  return out;
}

/** Resolve a manifest entry against the manifest's own location. */
export function resolveAsset(path: string, base = MANIFEST_URL): string {
  if (/^(https?:)?\/\//.test(path) || path.startsWith("/")) return path;
  const dir = base.slice(0, base.lastIndexOf("/") + 1);
  return dir + path;
}

type Ctx = AudioContext;

export class CuePlayer {
  private ctx: Ctx | null = null;
  private manifest: CueManifest = {};
  private buffers = new Map<CueName, AudioBuffer>();
  /** Cues whose asset failed; never retried, so a 404 is not fetched on every ring. */
  private failed = new Set<CueName>();
  private loading: Promise<void> | null = null;

  /**
   * Browsers refuse to start audio before a gesture. The Shell calls this from the first
   * pointer or key event; until then every play() is a silent no-op rather than an error.
   */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    try {
      const Ctor: typeof AudioContext | undefined =
        (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      void this.loadManifest();
    } catch {
      /* no audio on this device: the console is still fully usable in silence */
    }
  }

  private async loadManifest(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const res = await fetch(MANIFEST_URL, { cache: "no-cache" });
        if (!res.ok) return;
        this.manifest = parseManifest(await res.json());
      } catch {
        /* no manifest yet: synthesized voices are the whole vocabulary */
      }
    })();
    return this.loading;
  }

  private async buffer(cue: CueName): Promise<AudioBuffer | null> {
    if (this.buffers.has(cue)) return this.buffers.get(cue) ?? null;
    if (this.failed.has(cue)) return null;
    const path = this.manifest.files?.[cue];
    if (!path || !this.ctx) return null;
    try {
      const res = await fetch(resolveAsset(path), { cache: "force-cache" });
      if (!res.ok) throw new Error(String(res.status));
      const decoded = await this.ctx.decodeAudioData(await res.arrayBuffer());
      this.buffers.set(cue, decoded);
      return decoded;
    } catch {
      // One failure is permanent for this page load. A missing or corrupt file must
      // never become a fetch on every event.
      this.failed.add(cue);
      return null;
    }
  }

  /** Play a cue. Never throws, never blocks the caller. */
  play(cue: CueName): void {
    if (!this.ctx) return;
    void (async () => {
      try {
        const buf = await this.buffer(cue);
        if (buf) this.playBuffer(buf);
        else this.playTone(cue);
      } catch {
        /* a cue that cannot be played is not an error worth surfacing */
      }
    })();
  }

  private gainScale(): number {
    return this.manifest.gain ?? 1;
  }

  private playBuffer(buf: AudioBuffer): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = Math.min(1, this.gainScale());
    src.connect(g).connect(ctx.destination);
    src.start();
  }

  private playTone(cue: CueName): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const tone = TONES[cue];
    const t0 = ctx.currentTime + 0.005;
    const total = tone.step * tone.steps.length;
    const peak = Math.min(1, tone.gain * this.gainScale());

    const osc = ctx.createOscillator();
    osc.type = tone.wave;
    const g = ctx.createGain();

    if (tone.glide) {
      osc.frequency.setValueAtTime(tone.steps[0], t0);
      osc.frequency.exponentialRampToValueAtTime(tone.steps[tone.steps.length - 1], t0 + total);
    } else {
      tone.steps.forEach((hz, i) => osc.frequency.setValueAtTime(hz, t0 + i * tone.step));
    }

    // A short attack and an exponential release: a raw gate on an oscillator clicks.
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    g.gain.setValueAtTime(peak, t0 + Math.max(0.012, total - 0.05));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + total + 0.06);

    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + total + 0.08);
  }
}
