// The two fences a report may carry beyond plain markdown, and the tagged table cell.
//
//   ```chart      a JSON spec drawn as an inline SVG chart (ReportChart.tsx)
//   ```keypoints  one point per line, lifted into a summary card above the body
//   | [good] up |  a table cell that starts with a tag is colored by it
//
// Everything here is plain data: no markup from a report body ever reaches the page as
// markup. A chart spec is validated field by field and anything off-shape returns null,
// so the reader shows the fence as the code block it would have been. Colors are a fixed
// set of token names or a #rrggbb hex, never a CSS string, so a spec cannot reach url().

import { splitTables, type MdSegment } from "./mdTables";

/** Largest magnitude a chart value may have; beyond it the fence renders as code. */
export const MAX_ABS_VALUE = 1e15;
/** Smallest nonzero magnitude; below it geometry rounds to nothing. */
export const MIN_ABS_VALUE = 1e-9;
/** The key-points card holds at most this many points, each at most this long. */
export const MAX_KEYPOINTS = 50;
export const MAX_KEYPOINT_CHARS = 500;

export const CHART_TYPES = ["bar", "hbar", "stacked", "donut", "line"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const TONES = ["good", "warn", "bad", "info"] as const;
export type Tone = (typeof TONES)[number];

/** CSS custom property per tone; the inks the rest of the console uses for the same words. */
export const TONE_VAR: Record<Tone, string> = { good: "--ok", warn: "--warn", bad: "--bad", info: "--cat-1" };

/** The categorical ramp from tokens.css, validated for color-blind separation; never cycled. */
export const SERIES_VARS = ["--cat-1", "--cat-2", "--cat-3", "--cat-4", "--cat-5", "--cat-6"] as const;

export interface ChartSeries {
  name: string;
  values: number[];
  color: string; // a resolved CSS value: var(--token) or #rrggbb
}

export interface ChartSpec {
  type: ChartType;
  title: string;
  labels: string[];
  series: ChartSeries[];
  unit: string;
}

export interface KeyPoint {
  tone: Tone | null;
  text: string;
}

export type ReportSegment =
  | MdSegment
  | { t: "chart"; spec: ChartSpec }
  | { t: "code"; lang: string; text: string }; // a chart fence that did not parse

export interface ReportParts {
  keypoints: KeyPoint[];
  segments: ReportSegment[];
}

export const MAX_SPEC_CHARS = 20_000;
export const MAX_LABELS = 60;
export const MAX_SERIES = 6;
const MAX_TEXT = 120;

const HEX = /^#[0-9a-f]{6}$/i;

function text(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value === "string") return value.trim().slice(0, max);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** A series color from the spec: a tone, cat-1..cat-6, or a hex. Anything else is ignored. */
export function seriesColor(raw: unknown, index: number): string {
  const fallback = `var(${SERIES_VARS[index % SERIES_VARS.length]})`;
  if (typeof raw !== "string") return fallback;
  const value = raw.trim().toLowerCase();
  if ((TONES as readonly string[]).includes(value)) return `var(${TONE_VAR[value as Tone]})`;
  const cat = /^cat-([1-6])$/.exec(value);
  if (cat) return `var(--cat-${cat[1]})`;
  if (HEX.test(value)) return value;
  return fallback;
}

/** Parse and validate a chart fence body. Null for anything the chart cannot draw honestly. */
export function parseChart(source: string): ChartSpec | null {
  if (source.length > MAX_SPEC_CHARS) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const spec = raw as Record<string, unknown>;
  const type = spec.type;
  if (typeof type !== "string" || !(CHART_TYPES as readonly string[]).includes(type)) return null;
  if (!Array.isArray(spec.labels) || spec.labels.length === 0 || spec.labels.length > MAX_LABELS) return null;
  const labels: string[] = [];
  for (const label of spec.labels) {
    const value = text(label);
    if (value === null) return null;
    labels.push(value);
  }
  if (!Array.isArray(spec.series) || spec.series.length === 0 || spec.series.length > MAX_SERIES) return null;
  const series: ChartSeries[] = [];
  for (let i = 0; i < spec.series.length; i += 1) {
    const entry = spec.series[i] as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.values)) return null;
    if (entry.values.length !== labels.length) return null;
    const values: number[] = [];
    for (const v of entry.values) {
      // Bounded so sums, ranges and tick steps stay finite (a near-max double overflowed the ticks loop).
      if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > MAX_ABS_VALUE) return null;
      if (v !== 0 && Math.abs(v) < MIN_ABS_VALUE) return null; // too small to draw honestly
      values.push(v);
    }
    series.push({ name: text(entry.name) ?? `series ${i + 1}`, values, color: seriesColor(entry.color, i) });
  }
  const t = type as ChartType;
  // A stack or a ring is a part-to-whole: a negative part has no length to draw.
  if ((t === "stacked" || t === "donut") && series.some((s) => s.values.some((v) => v < 0))) return null;
  // A ring is one series; a second one would have nowhere to go.
  if (t === "donut" && series.length !== 1) return null;
  return { type: t, title: text(spec.title) ?? "", labels, series, unit: text(spec.unit, 12) ?? "" };
}

const TAG = /^\s*\[(good|warn|bad|info)\]\s*/i;

/** A leading [good] [warn] [bad] [info] tag, split off the rest of the text. */
export function splitTag(value: string): KeyPoint {
  const m = TAG.exec(value);
  if (!m) return { tone: null, text: value };
  return { tone: m[1]!.toLowerCase() as Tone, text: value.slice(m[0].length) };
}

/** One point per non-blank line; a list marker in front is allowed and dropped. */
export function parseKeypoints(source: string): KeyPoint[] {
  const out: KeyPoint[] = [];
  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    const stripped = line.replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, "").trim();
    if (!stripped) continue;
    const point = splitTag(stripped);
    if (point.text.trim()) out.push({ tone: point.tone, text: point.text.trim().slice(0, MAX_KEYPOINT_CHARS) });
    if (out.length > MAX_KEYPOINTS) break;
  }
  return out;
}

// The same fence shapes the shared parser reads (projects/markdown.ts).
const FENCE = /^ {0,3}(```+|~~~+)\s*([^`\s]*)\s*$/;

function closes(line: string, open: string): boolean {
  const m = /^ {0,3}(```+|~~~+)\s*$/.exec(line);
  return !!m && m[1]![0] === open[0] && m[1]!.length >= open.length;
}

/**
 * Split a report into its key points (hoisted, wherever the fences sat) and the body
 * segments in order: prose, pipe tables, charts, and chart fences that did not parse.
 * Any other fence stays in the prose untouched, so a code block that merely shows a
 * chart spec (```json) is never drawn.
 */
export function splitReport(source: string): ReportParts {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const keypoints: KeyPoint[] = [];
  const segments: ReportSegment[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.length > 0) for (const seg of splitTables(prose.join("\n"))) segments.push(seg);
    prose = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (!fence) {
      prose.push(line);
      continue;
    }
    const open = fence[1]!;
    const lang = (fence[2] ?? "").toLowerCase();
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !closes(lines[j]!, open)) {
      body.push(lines[j]!);
      j += 1;
    }
    if (lang !== "chart" && lang !== "keypoints") {
      // Some other fence: keep it whole in the prose, closing line included.
      for (let k = i; k < Math.min(j + 1, lines.length); k += 1) prose.push(lines[k]!);
      i = j;
      continue;
    }
    flush();
    const inner = body.join("\n");
    const kps = lang === "keypoints" ? parseKeypoints(inner) : [];
    // Past the cap the fence stays one plain code block (one element), never thousands of items.
    if (lang === "keypoints" && keypoints.length + kps.length <= MAX_KEYPOINTS) for (const kp of kps) keypoints.push(kp);
    else if (lang === "keypoints") segments.push({ t: "code", lang, text: inner });
    else {
      const spec = parseChart(inner);
      segments.push(spec ? { t: "chart", spec } : { t: "code", lang, text: inner });
    }
    i = j;
  }
  flush();
  return { keypoints, segments };
}

// ---- geometry the chart component draws from ---------------------------------

/** Round steps (1, 2, 2.5, 5 times a power of ten) covering min..max, zero always included. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (hi === lo) return [0, 1];
  const rough = (hi - lo) / count;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * pow >= rough) ?? 10) * pow;
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(start)) return [0, 1];
  // Bounded loop: float drift or overflow can never spin the main thread.
  for (let i = 0, v = start; i < 64 && Number.isFinite(v) && v <= hi + step * 1e-9; i += 1, v = start + i * step) ticks.push(Number(v.toPrecision(12)));
  if (ticks[ticks.length - 1]! < hi) ticks.push(Number((ticks[ticks.length - 1]! + step).toPrecision(12)));
  return ticks;
}

/** A value as a reader says it: grouped, at most one decimal, compact past ten thousand. */
export function formatValue(value: number, unit = ""): string {
  const abs = Math.abs(value);
  const n =
    abs >= 10_000
      ? new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value)
      : new Intl.NumberFormat("en", { maximumFractionDigits: abs < 10 ? 2 : 1 }).format(value);
  if (!unit) return n;
  // A currency sign goes in front of the figure, as it is read.
  if (/^[$€£¥]$/.test(unit)) return value < 0 ? `-${unit}${n.slice(1)}` : `${unit}${n}`;
  return unit.length === 1 && !/[a-z]/i.test(unit) ? `${n}${unit}` : `${n} ${unit}`;
}

/** Stack totals per label, for the stacked bars' axis. */
export function stackTotals(series: readonly ChartSeries[], count: number): number[] {
  const totals = new Array<number>(count).fill(0);
  for (const s of series) s.values.forEach((v, i) => (totals[i]! += v));
  return totals;
}
