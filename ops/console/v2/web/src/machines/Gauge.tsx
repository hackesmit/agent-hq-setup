// A hardware figure on a scale that says whether it is fine.
//
// Three things in one block, because between them they answer one question:
//
//   the number      what it is right now
//   the gradient    where that sits between fine and not, with the limit marked
//   the trace       whether it is going anywhere
//
// The gradient is the part the owner asked for and the part that does the work: a
// reader who has never seen this hardware can tell 73 degrees from 93 degrees
// without knowing that one of them is near a throttle point.
//
// Colour is never the only carrier. The needle's POSITION says the same thing as
// its colour, the thresholds are drawn as physical marks on the track, the trend
// is a word rather than a glyph, and every gauge carries a sentence in its title
// and aria-label. A gauge that only worked in colour would fail exactly the
// person squinting at a phone at night.
import { bandOf, fmtValue, markAt, positionOn, readingOf, trendOf, type Scale } from "./scales";
import { cx } from "../ui/primitives";

const BAND_INK: Record<string, string> = {
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
};

/** The rolling trace behind the number. Plain SVG: no library for one path. */
function Trace({ values, scale, band }: { values: (number | null)[]; scale: Scale; band: string | null }) {
  const points = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (points.length < 2) return null;
  // At most one point per horizontal pixel; more is invisible and costs DOM.
  const width = 120;
  const height = 22;
  const step = Math.max(1, Math.ceil(points.length / width));
  const sampled = points.filter((_, i) => i % step === 0);
  const d = sampled
    .map((v, i) => {
      const x = (i / Math.max(1, sampled.length - 1)) * width;
      const y = height - (positionOn(v, scale) ?? 0) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="opacity-70">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.25" className={band ? BAND_INK[band] : "text-mute"} />
    </svg>
  );
}

export function Gauge({
  label,
  value,
  scale,
  series,
  detail,
}: {
  label: string;
  value: number | null;
  scale: Scale;
  series?: (number | null)[];
  /** The absolute figure behind a percentage, such as 12.1 of 31.9 GB. */
  detail?: string;
}) {
  const band = bandOf(value, scale);
  const at = positionOn(value, scale);
  const reading = readingOf(value, scale, label);
  const trend = series && series.length ? trendOf(series) : null;
  const unit = scale.unit === "x" ? "" : scale.unit;

  return (
    <div className="flex flex-col gap-1.5 rounded-sub border border-line bg-panel2/40 px-3 py-2.5" title={reading}>
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-[0.14em] text-mute">{label}</span>
        {trend && trend !== "steady" ? (
          <span className="text-[10px] text-mute" title={`${label} is ${trend}`}>
            {trend}
          </span>
        ) : null}
        <span className="ml-auto tabular-nums text-[19px] font-semibold leading-none">
          {value === null || !Number.isFinite(value) ? (
            <span className="text-[13px] font-normal text-mute">no reading</span>
          ) : (
            <span className={band ? BAND_INK[band] : undefined}>
              {fmtValue(value as number, scale)}
              <span className="ml-0.5 text-[12px] font-normal text-mute">{scale.unit === "x" ? "x" : scale.unit}</span>
            </span>
          )}
        </span>
      </div>

      {/* The track. The gradient IS the scale, so the needle's position carries
          the judgement even for a reader who cannot separate the colours. */}
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-chip" role="img" aria-label={reading}>
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(90deg, var(--ok) 0%, var(--ok) " +
              `${markAt(scale.warn, scale) * 100}%, var(--warn) ` +
              `${markAt(scale.warn, scale) * 100}%, var(--warn) ` +
              `${markAt(scale.bad, scale) * 100}%, var(--bad) ` +
              `${markAt(scale.bad, scale) * 100}%, var(--bad) 100%)`,
            opacity: 0.28,
          }}
        />
        {/* The two limits, as marks, so they survive without colour. */}
        {[scale.warn, scale.bad].map((t) => (
          <span
            key={t}
            className="absolute top-0 h-full w-px bg-line"
            style={{ left: `${markAt(t, scale) * 100}%` }}
            aria-hidden="true"
          />
        ))}
        {at === null ? null : (
          <span
            className={cx("absolute top-0 h-full w-[3px] rounded-full bg-current", band ? BAND_INK[band] : "text-mute")}
            style={{ left: `calc(${at * 100}% - 1.5px)` }}
            aria-hidden="true"
          />
        )}
      </div>

      <div className="flex items-center gap-2 text-[10px] text-mute">
        <span className="tabular-nums">
          {scale.min}
          {unit}
        </span>
        <span className="min-w-0 flex-1 truncate text-center">{detail ?? scale.ceiling}</span>
        <span className="tabular-nums">
          {scale.max}
          {unit}
        </span>
      </div>

      {series && series.length > 1 ? (
        <div className="mt-0.5">
          <Trace values={series} scale={scale} band={band} />
        </div>
      ) : null}
    </div>
  );
}
