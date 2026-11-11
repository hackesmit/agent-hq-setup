// The money tab's shapes beyond bars, each picked by the data's job (dataviz
// method, choosing-a-form): a trend over time is a LINE, a part-to-whole with
// at most six parts is a RING, a single ratio against a limit is a METER.
//
// the owner, 2026-10-06: "only bar graphs? can we get some variety?" Variety here
// is not decoration: each form was chosen because it reads its data better
// than a bar would. Marks follow the method: 2px lines, markers at least 8px,
// 2px surface gaps between ring segments, text in text tokens never in the
// series color, a hover layer on the line, and a table view for the line.

import { useState } from "react";
import { cx } from "../ui/primitives";
import { donutSlices, fmtCents, fmtShortCents, ringPath, type RunningPoint } from "./model";

/** Fixed categorical order, never cycled: a seventh part folds into gray "more". */
const CAT = ["--cat-1", "--cat-2", "--cat-3", "--cat-4", "--cat-5", "--cat-6"];

const TONE_INK: Record<string, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad" };

// ---- the running line ------------------------------------------------------

// The same geometry as the tokens chart, which shares a half-width column: a
// narrower viewBox scales its text and markers up with the column and reads as
// a poster rather than a chart.
const W = 640;
const FULL_H = 170;
const PAD = { top: 16, right: 54, bottom: 22, left: 10 };

/** Where the money has got to, month by month: the nets added up into one line. */
export function RunningNet({ points, currency, compact = false }: { points: RunningPoint[]; currency: string; compact?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) {
    return <p className="m-0 text-[13px] text-mute">Nothing to add up yet.</p>;
  }
  // Compact is the same line at half the height for a row inside a list: same
  // marks, same hover, no table (the row's figures are the table).
  const H = compact ? 84 : FULL_H;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const vals = points.map((p) => p.runningCents);
  // Zero is always on the axis: a line that never shows its baseline cannot say
  // whether it is above or below water.
  const max = Math.max(0, ...vals);
  const min = Math.min(0, ...vals);
  const span = max - min || 1;
  const x = (i: number) => (points.length === 1 ? PAD.left + plotW / 2 : PAD.left + (i / (points.length - 1)) * plotW);
  const y = (v: number) => PAD.top + ((max - v) / span) * plotH;
  const coords = points.map((p, i) => `${x(i).toFixed(1)},${y(p.runningCents).toFixed(1)}`);
  const area = `M ${x(0).toFixed(1)},${y(0).toFixed(1)} L ${coords.join(" L ")} L ${x(points.length - 1).toFixed(1)},${y(0).toFixed(1)} Z`;
  const last = points[points.length - 1]!;
  const lastTone = last.runningCents >= 0 ? "ok" : "bad";
  const step = points.length > 1 ? plotW / (points.length - 1) : plotW;

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`Running net over ${points.length} months, now ${fmtCents(last.runningCents, currency)}`}
        onMouseLeave={() => setHover(null)}
      >
        {/* the baseline: above it the money came out ahead, below it behind */}
        <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} stroke="var(--line)" strokeWidth="1" />
        <text x={W - PAD.right + 4} y={y(0) + 3} fontSize="9" fill="var(--faint)">
          0
        </text>
        <path d={area} fill="var(--chart-1)" opacity="0.22" pointerEvents="none" />
        <polyline points={coords.join(" ")} fill="none" stroke="var(--chart-2)" strokeWidth="2" strokeLinejoin="round" pointerEvents="none" />
        {points.map((p, i) => (
          <g key={p.month}>
            {/* hit target wider than the mark */}
            <rect
              x={x(i) - step / 2}
              y={PAD.top}
              width={step}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
            <circle
              cx={x(i)}
              cy={y(p.runningCents)}
              r={hover === i || i === points.length - 1 ? 4 : 3}
              fill="var(--chart-2)"
              stroke="var(--panel)"
              strokeWidth="2"
              pointerEvents="none"
            />
            <text x={x(i)} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--faint)">
              {p.month.slice(5)}
            </text>
          </g>
        ))}
        {/* the latest value is the one direct label; everything else is in the hover */}
        <text
          x={x(points.length - 1) + 7}
          y={y(last.runningCents) + 4}
          fontSize="11"
          fontWeight="600"
          fill="var(--ink)"
          pointerEvents="none"
        >
          {fmtShortCents(last.runningCents)}
        </text>
        {hover !== null && points[hover] ? (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--mute)" strokeWidth="1" strokeDasharray="2 3" />
            {(() => {
              const p = points[hover]!;
              const bx = Math.min(W - PAD.right - 190, Math.max(PAD.left, x(hover) - 95));
              return (
                <>
                  <rect x={bx} y={PAD.top - 12} width={190} height={44} rx="6" fill="var(--panel)" stroke="var(--line)" />
                  <text x={bx + 8} y={PAD.top + 4} fontSize="11" fontWeight="600" fill="var(--ink)">
                    {p.month}
                  </text>
                  <text x={bx + 8} y={PAD.top + 18} fontSize="11" fill="var(--mute)">
                    month {fmtShortCents(p.netCents)}, running {fmtShortCents(p.runningCents)}
                  </text>
                </>
              );
            })()}
          </g>
        ) : null}
      </svg>
      <div className="flex items-baseline gap-2 text-[11px] text-mute">
        <span>{compact ? "running net, oldest first" : "nets added up, oldest first; the point is where it stands"}</span>
        <span className={cx("ml-auto tabular-nums", TONE_INK[lastTone])}>{fmtCents(last.runningCents, currency)}</span>
      </div>
      {compact ? null : (
      <details className="mt-1 text-[12px] text-mute">
        <summary className="cursor-pointer">table view</summary>
        <table className="mt-1 w-full text-left text-[12px]">
          <thead>
            <tr>
              <th className="pr-3 font-medium">month</th>
              <th className="pr-3 text-right font-medium">net</th>
              <th className="text-right font-medium">running</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.month}>
                <td className="pr-3">{p.month}</td>
                <td className="pr-3 text-right tabular-nums">{fmtCents(p.netCents, currency)}</td>
                <td className="text-right tabular-nums">{fmtCents(p.runningCents, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      )}
    </figure>
  );
}

// ---- the ring ---------------------------------------------------------------

export interface DonutRow {
  category: string;
  cents: number;
  share: number;
  rest?: true; // the folded tail: drawn gray, never given a categorical hue
}

/**
 * At most six named parts. The model already folds its tail, but the ring
 * enforces the cap itself so no caller can hand it eight parts and get two
 * pairs sharing a hue: anything past six, plus any remainder already present,
 * becomes one gray "more" row with its share recomputed.
 */
export function capParts(rows: DonutRow[], max = CAT.length): DonutRow[] {
  const named = rows.filter((r) => !r.rest);
  const rest = rows.filter((r) => r.rest);
  if (named.length <= max && rest.length <= 1) return rows;
  const head = named.slice(0, max);
  const tail = [...named.slice(max), ...rest];
  const tailCents = tail.reduce((n, r) => n + r.cents, 0);
  const total = head.reduce((n, r) => n + r.cents, 0) + tailCents;
  const folded = named.length - max + rest.reduce((n, r) => n + Number(r.category.match(/^(\d+) more$/)?.[1] ?? 1), 0);
  return [
    ...head.map((r) => ({ ...r, share: total > 0 ? r.cents / total : 0 })),
    { category: `${folded} more`, cents: tailCents, share: total > 0 ? tailCents / total : 0, rest: true },
  ];
}

/**
 * Part-to-whole at a glance: at most six named parts plus one gray remainder.
 * The total sits in the middle as the one number the ring is about. Each part
 * is also listed beside it with its value and share, so identity never rests
 * on color alone and the ring is readable in print.
 */
export function Donut({ rows: given, currency, caption }: { rows: DonutRow[]; currency: string; caption: string }) {
  const rows = capParts(given);
  const total = rows.reduce((n, r) => n + r.cents, 0);
  const slices = donutSlices(rows.map((r) => r.cents));
  const cxp = 60;
  const cyp = 60;
  // Hue by position among the NAMED parts (never cycled, the cap guarantees it
  // fits); the remainder is gray by its flag, never by what its label says.
  const colorOf = (i: number, row: DonutRow) => (row.rest ? "var(--faint)" : `var(${CAT[i]})`);
  return (
    <div className="flex items-center gap-4">
      <svg
        viewBox="0 0 120 120"
        className="h-[120px] w-[120px] shrink-0"
        role="img"
        aria-label={`${caption}: ${fmtCents(total, currency)} across ${rows.length} types`}
      >
        {slices.map((s, i) => (
          <path key={rows[i]!.category} d={ringPath(cxp, cyp, 56, 40, s.start, s.end)} fill={colorOf(i, rows[i]!)} stroke="var(--panel)" strokeWidth="2">
            <title>
              {rows[i]!.category}: {fmtCents(rows[i]!.cents, currency)}, {Math.round(s.share * 100)}%
            </title>
          </path>
        ))}
        <text x={cxp} y={cyp - 1} textAnchor="middle" fontSize="14" fontWeight="600" fill="var(--ink)">
          {fmtShortCents(total, false)}
        </text>
        <text x={cxp} y={cyp + 12} textAnchor="middle" fontSize="9" fill="var(--mute)">
          {caption}
        </text>
      </svg>
      <ul className="m-0 flex min-w-0 flex-1 list-none flex-col gap-1 p-0 text-[12px]">
        {rows.map((r, i) => (
          <li key={r.category} className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: colorOf(i, r) }} aria-hidden="true" />
            <span className="truncate text-ink" title={r.category}>
              {r.category}
            </span>
            <span className="ml-auto shrink-0 text-[10px] tabular-nums text-mute">{Math.round(r.share * 100)}%</span>
            <span className="w-28 shrink-0 text-right text-[11px] tabular-nums text-ink">{fmtCents(r.cents, currency)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- the meter --------------------------------------------------------------

/** A single ratio against a limit, drawn as a half ring with the figure inside. */
export function ArcMeter({ pct, tone, label }: { pct: number; tone: "ok" | "warn" | "bad"; label: string }) {
  const shown = Math.min(100, Math.max(0, pct));
  const d = "M 10 62 A 50 50 0 0 1 110 62";
  return (
    <svg viewBox="0 0 120 70" className="h-[70px] w-[120px] shrink-0" role="img" aria-label={label}>
      <path d={d} fill="none" stroke="var(--chip)" strokeWidth="10" strokeLinecap="round" />
      {shown > 0 ? (
        <path d={d} fill="none" stroke={`var(--${tone})`} strokeWidth="10" strokeLinecap="round" pathLength={100} strokeDasharray={`${shown} 100`} />
      ) : null}
      <text x="60" y="60" textAnchor="middle" fontSize="20" fontWeight="600" fill="var(--ink)">
        {Math.round(pct)}
        <tspan fontSize="10" fill="var(--mute)">
          %
        </tspan>
      </text>
    </svg>
  );
}
