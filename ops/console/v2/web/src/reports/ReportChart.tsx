// A chart fence drawn as inline SVG. No chart library: five shapes, each drawn from a
// validated spec (blocks.ts), in the console's own tokens, so it follows the theme and
// stays inside the CSP. Marks follow the money tab's method: series hues from the
// color-blind-checked categorical ramp, text always in text tokens and never in a
// series color, a legend in words beside any color, and a table view under every chart
// so no figure rests on color alone.
//
// The viewBox is the measured pixel width of the reader, not a fixed canvas, so an
// 11px label is 11px on a phone and on a desktop rather than scaling with the column.

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { donutSlices, ringPath } from "../money/model";
import { formatValue, niceTicks, SERIES_VARS, stackTotals, type ChartSpec } from "./blocks";

const FONT = 11;
const CHAR_W = 6.4; // a mono glyph at 11px, for fitting labels
const DEFAULT_W = 640;

function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(DEFAULT_W);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const read = () => setWidth(Math.max(240, Math.round(el.clientWidth)));
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function clip(label: string, room: number): string {
  const fits = Math.max(1, Math.floor(room / CHAR_W));
  return label.length <= fits ? label : `${label.slice(0, Math.max(1, fits - 1))}…`;
}

function Axis({ ticks, y, x0, x1, unit }: { ticks: number[]; y: (v: number) => number; x0: number; x1: number; unit: string }) {
  return (
    <g>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x0} x2={x1} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={t === 0 ? 1.5 : 1} />
          <text x={x0 - 6} y={y(t) + 4} textAnchor="end" fontSize={FONT - 1} fill="var(--faint)">
            {formatValue(t, unit)}
          </text>
        </g>
      ))}
    </g>
  );
}

/** Which category labels to print along x so they never overlap: every nth. */
function labelEvery(labels: readonly string[], band: number): number {
  const longest = Math.min(14, Math.max(...labels.map((l) => l.length)));
  return Math.max(1, Math.ceil((longest * CHAR_W + 8) / Math.max(band, 1)));
}

function Columns({ spec, width }: { spec: ChartSpec; width: number }) {
  const stacked = spec.type === "stacked";
  const totals = stacked ? stackTotals(spec.series, spec.labels.length) : [];
  const all = stacked ? totals : spec.series.flatMap((s) => s.values);
  const ticks = niceTicks(Math.min(...all), Math.max(...all));
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const left = Math.min(72, 12 + Math.max(...ticks.map((t) => formatValue(t, spec.unit).length)) * CHAR_W);
  const pad = { top: 10, right: 8, bottom: 26, left };
  const H = 220;
  const plotW = width - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const y = (v: number) => pad.top + ((hi - v) / (hi - lo)) * plotH;
  const band = plotW / spec.labels.length;
  const gap = Math.min(12, band * 0.2);
  const every = labelEvery(spec.labels, band);
  const inner = stacked ? band - gap : (band - gap) / spec.series.length;
  return (
    <svg viewBox={`0 0 ${width} ${H}`} width={width} height={H} className="block max-w-full" role="img" aria-label={spec.title || `${spec.type} chart`}>
      <Axis ticks={ticks} y={y} x0={pad.left} x1={width - pad.right} unit={spec.unit} />
      {spec.labels.map((label, i) => {
        const bx = pad.left + i * band + gap / 2;
        let base = 0;
        return (
          <g key={i}>
            {spec.series.map((s, k) => {
              const v = s.values[i]!;
              const from = stacked ? base : 0;
              const to = stacked ? base + v : v;
              if (stacked) base += v;
              const top = y(Math.max(from, to));
              const h = Math.max(stacked && v > 0 ? 1 : 0, Math.abs(y(from) - y(to)));
              return (
                <rect
                  key={k}
                  x={stacked ? bx : bx + k * inner}
                  y={top}
                  width={Math.max(1, (stacked ? inner : inner - (spec.series.length > 1 ? 1 : 0)))}
                  height={h}
                  fill={s.color}
                  stroke={stacked ? "var(--panel)" : "none"}
                  strokeWidth={stacked ? 1 : 0}
                >
                  <title>{`${label}, ${s.name}: ${formatValue(v, spec.unit)}`}</title>
                </rect>
              );
            })}
            {i % every === 0 ? (
              <text x={bx + (band - gap) / 2} y={H - 8} textAnchor="middle" fontSize={FONT} fill="var(--mute)">
                {clip(label, band * every - 6)}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function Rows({ spec, width }: { spec: ChartSpec; width: number }) {
  const all = spec.series.flatMap((s) => s.values);
  const ticks = niceTicks(Math.min(...all), Math.max(...all));
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const longest = Math.max(...spec.labels.map((l) => l.length));
  const labelW = Math.min(Math.round(width * 0.38), longest * CHAR_W + 10);
  const valueW = 8 + Math.max(...all.map((v) => formatValue(v, spec.unit).length)) * CHAR_W;
  const pad = { top: 4, right: valueW, bottom: 4, left: labelW };
  const barH = spec.series.length > 1 ? 10 : 14;
  const rowH = spec.series.length * barH + 10;
  const H = pad.top + pad.bottom + rowH * spec.labels.length;
  const plotW = Math.max(40, width - pad.left - pad.right);
  const x = (v: number) => pad.left + ((v - lo) / (hi - lo)) * plotW;
  return (
    <svg viewBox={`0 0 ${width} ${H}`} width={width} height={H} className="block max-w-full" role="img" aria-label={spec.title || "bar chart"}>
      <line x1={x(0)} x2={x(0)} y1={pad.top} y2={H - pad.bottom} stroke="var(--line)" strokeWidth="1.5" />
      {spec.labels.map((label, i) => {
        const ry = pad.top + i * rowH + 5;
        return (
          <g key={i}>
            <text x={labelW - 8} y={ry + (spec.series.length * barH) / 2 + 4} textAnchor="end" fontSize={FONT} fill="var(--ink)">
              {clip(label, labelW - 10)}
              <title>{label}</title>
            </text>
            {spec.series.map((s, k) => {
              const v = s.values[i]!;
              const x0 = Math.min(x(0), x(v));
              const w = Math.abs(x(v) - x(0));
              const by = ry + k * barH;
              return (
                <g key={k}>
                  <rect x={x0} y={by} width={Math.max(v === 0 ? 0 : 1, w)} height={barH - 2} fill={s.color} rx="1">
                    <title>{`${label}, ${s.name}: ${formatValue(v, spec.unit)}`}</title>
                  </rect>
                  <text x={Math.max(x(0), x(v)) + 5} y={by + barH - 3.5} fontSize={FONT - 1} fill="var(--mute)">
                    {formatValue(v, spec.unit)}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

function Lines({ spec, width }: { spec: ChartSpec; width: number }) {
  const all = spec.series.flatMap((s) => s.values);
  const ticks = niceTicks(Math.min(...all), Math.max(...all));
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const left = Math.min(72, 12 + Math.max(...ticks.map((t) => formatValue(t, spec.unit).length)) * CHAR_W);
  const pad = { top: 10, right: 14, bottom: 26, left };
  const H = 220;
  const plotW = width - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const n = spec.labels.length;
  const x = (i: number) => (n === 1 ? pad.left + plotW / 2 : pad.left + (i / (n - 1)) * plotW);
  const y = (v: number) => pad.top + ((hi - v) / (hi - lo)) * plotH;
  const every = labelEvery(spec.labels, n > 1 ? plotW / (n - 1) : plotW);
  const markers = plotW / Math.max(1, n - 1) >= 10;
  return (
    <svg viewBox={`0 0 ${width} ${H}`} width={width} height={H} className="block max-w-full" role="img" aria-label={spec.title || "line chart"}>
      <Axis ticks={ticks} y={y} x0={pad.left} x1={width - pad.right} unit={spec.unit} />
      {spec.labels.map((label, i) =>
        i % every === 0 ? (
          <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 && n > 1 ? "start" : i === n - 1 && n > 1 ? "end" : "middle"} fontSize={FONT} fill="var(--mute)">
            {clip(label, (plotW / Math.max(1, n - 1)) * every - 6)}
          </text>
        ) : null,
      )}
      {spec.series.map((s, k) => (
        <g key={k}>
          <polyline
            points={s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}
            fill="none"
            stroke={s.color}
            strokeWidth="2"
            strokeLinejoin="round"
          />
          {markers
            ? s.values.map((v, i) => (
                <circle key={i} cx={x(i)} cy={y(v)} r="3.5" fill={s.color} stroke="var(--panel)" strokeWidth="1.5">
                  <title>{`${spec.labels[i]}, ${s.name}: ${formatValue(v, spec.unit)}`}</title>
                </circle>
              ))
            : null}
        </g>
      ))}
    </svg>
  );
}

const RING_PARTS = SERIES_VARS.length;

function Ring({ spec }: { spec: ChartSpec }) {
  // At most six named parts in the fixed ramp; a tail past that folds into one gray
  // "more", never a cycled hue (two parts sharing a color would read as one).
  const values = spec.series[0]!.values;
  const named = spec.labels.slice(0, RING_PARTS).map((label, i) => ({ label, value: values[i]!, color: `var(${SERIES_VARS[i]})` }));
  const tail = values.slice(RING_PARTS);
  const parts =
    tail.length > 0 ? [...named, { label: `${tail.length} more`, value: tail.reduce((a, b) => a + b, 0), color: "var(--faint)" }] : named;
  const total = parts.reduce((a, p) => a + p.value, 0);
  const slices = donutSlices(parts.map((p) => p.value));
  return (
    <div className="flex flex-wrap items-center gap-4">
      <svg viewBox="0 0 140 140" width="140" height="140" className="shrink-0" role="img" aria-label={`${spec.title || "share"}: ${formatValue(total, spec.unit)} in ${parts.length} parts`}>
        {slices.map((s, i) => (
          <path key={i} d={ringPath(70, 70, 66, 46, s.start, s.end)} fill={parts[i]!.color} stroke="var(--panel)" strokeWidth="2">
            <title>{`${parts[i]!.label}: ${formatValue(parts[i]!.value, spec.unit)}, ${Math.round(s.share * 100)}%`}</title>
          </path>
        ))}
        <text x="70" y="74" textAnchor="middle" fontSize="15" fontWeight="600" fill="var(--ink)">
          {formatValue(total, spec.unit)}
        </text>
      </svg>
      <ul className="m-0 flex min-w-[180px] max-w-[380px] flex-1 list-none flex-col gap-1 p-0 text-[12px]">
        {parts.map((p, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: p.color }} aria-hidden="true" />
            <span className="min-w-0 truncate text-ink" title={p.label}>
              {p.label}
            </span>
            {spec.unit === "%" ? null : (
              <span className="ml-auto shrink-0 tabular-nums text-mute">{total > 0 ? Math.round((p.value / total) * 100) : 0}%</span>
            )}
            <span className="ml-auto w-20 shrink-0 text-right tabular-nums text-ink">{formatValue(p.value, spec.unit)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Legend({ spec }: { spec: ChartSpec }) {
  if (spec.type === "donut" || spec.series.length < 2) return null;
  return (
    <ul className="m-0 mb-1.5 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[12px] text-ink">
      {spec.series.map((s, k) => (
        <li key={k} className="flex items-center gap-1.5">
          <span
            className={spec.type === "line" ? "inline-block h-[3px] w-3.5 rounded-full" : "inline-block h-2.5 w-2.5 rounded-[2px]"}
            style={{ background: s.color }}
            aria-hidden="true"
          />
          {s.name}
        </li>
      ))}
    </ul>
  );
}

function TableView({ spec }: { spec: ChartSpec }) {
  return (
    <details className="mt-1 text-[12px] text-mute">
      <summary className="cursor-pointer">table view</summary>
      <div className="hq-scroll overflow-x-auto">
        <table className="mt-1 w-full border-collapse text-left text-[12px]">
          <thead>
            <tr>
              <th className="border-b border-line py-0.5 pr-3 font-medium" />
              {spec.series.map((s, k) => (
                <th key={k} className="border-b border-line py-0.5 pr-3 text-right font-medium">
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {spec.labels.map((label, i) => (
              <tr key={i}>
                <td className="py-0.5 pr-3 text-ink">{label}</td>
                {spec.series.map((s, k) => (
                  <td key={k} className="py-0.5 pr-3 text-right tabular-nums text-ink">
                    {formatValue(s.values[i]!, spec.unit)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function ReportChart({ spec }: { spec: ChartSpec }) {
  const [ref, width] = useWidth();
  let figure: ReactNode;
  if (spec.type === "donut") figure = <Ring spec={spec} />;
  else if (spec.type === "hbar") figure = <Rows spec={spec} width={width} />;
  else if (spec.type === "line") figure = <Lines spec={spec} width={width} />;
  else figure = <Columns spec={spec} width={width} />;
  return (
    <figure className="my-4 rounded-sub border border-line bg-panel2/40 px-3 py-2.5" data-chart={spec.type}>
      {spec.title ? <figcaption className="mb-1.5 text-[13px] font-semibold text-ink">{spec.title}</figcaption> : null}
      <Legend spec={spec} />
      <div ref={ref} className="w-full overflow-hidden">
        {figure}
      </div>
      <TableView spec={spec} />
    </figure>
  );
}
