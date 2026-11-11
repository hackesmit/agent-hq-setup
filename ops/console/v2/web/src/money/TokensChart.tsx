// Tokens-per-day chart (bead hq-9fri), per the dataviz method: stacked bars of
// the two comparable magnitudes (input, output) on ONE axis; cache reads are a
// different order of magnitude, so they live in the tooltip and the table view,
// never on the same scale. Marks: thin bars, 2px surface gaps between stacked
// segments, 4px rounded top on the stack, recessive grid, legend + per-bar
// hover tooltip, and a <details> table as the accessible fallback. Series
// colors are the validated --chart-* tokens; text wears text tokens only.

import { useState } from "react";
import { fmtCount } from "../ui/format";
import type { ChartDay } from "./model";

const W = 640;
const H = 180;
const PAD = { top: 8, right: 8, bottom: 22, left: 44 };

export function TokensChart({ days }: { days: ChartDay[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (days.length === 0) {
    return <p className="m-0 text-[13px] text-mute">No usage series yet.</p>;
  }
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const max = Math.max(1, ...days.map((d) => d.total));
  const step = plotW / days.length;
  const barW = Math.max(3, Math.min(28, step - 4));
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const gridLines = [0.5, 1].map((f) => Math.round(max * f));
  const labelEvery = Math.ceil(days.length / 6);

  return (
    <figure className="m-0">
      <div className="mb-1.5 flex items-center gap-3 text-[12px] text-mute" aria-hidden="true">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: "var(--chart-1)" }} />
          input
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: "var(--chart-2)" }} />
          output
        </span>
        <span className="text-faint">cache reads in the tooltip and table</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`Tokens per day, ${days.length} days, peak ${fmtCount(max)}`}
        onMouseLeave={() => setHover(null)}
      >
        {gridLines.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth="1" />
            <text x={PAD.left - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill="var(--faint)">
              {fmtCount(v)}
            </text>
          </g>
        ))}
        <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} stroke="var(--line)" strokeWidth="1" />
        {days.map((d, i) => {
          const x = PAD.left + i * step + (step - barW) / 2;
          const yIn = y(d.input);
          const yTop = y(d.total);
          const inputH = Math.max(0, y(0) - yIn);
          const outputH = Math.max(0, yIn - yTop - (d.output > 0 && d.input > 0 ? 2 : 0));
          return (
            <g key={d.day}>
              {/* hit target wider than the mark */}
              <rect
                x={PAD.left + i * step}
                y={PAD.top}
                width={step}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
              {d.input > 0 ? (
                <rect x={x} y={yIn} width={barW} height={inputH} fill="var(--chart-1)" pointerEvents="none" />
              ) : null}
              {d.output > 0 ? (
                <rect
                  x={x}
                  y={yTop}
                  width={barW}
                  height={outputH}
                  rx="4"
                  fill="var(--chart-2)"
                  pointerEvents="none"
                />
              ) : null}
              {i % labelEvery === 0 ? (
                <text x={x + barW / 2} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--faint)">
                  {d.day.slice(5)}
                </text>
              ) : null}
            </g>
          );
        })}
        {hover !== null && days[hover] ? (
          <g pointerEvents="none">
            <rect
              x={Math.min(W - PAD.right - 168, Math.max(PAD.left, PAD.left + hover * step - 60))}
              y={PAD.top}
              width={168}
              height={58}
              rx="6"
              fill="var(--panel)"
              stroke="var(--line)"
            />
            {(() => {
              const d = days[hover]!;
              const tx = Math.min(W - PAD.right - 160, Math.max(PAD.left + 8, PAD.left + hover * step - 52));
              return (
                <>
                  <text x={tx} y={PAD.top + 16} fontSize="11" fill="var(--ink)" fontWeight="600">
                    {d.day}
                  </text>
                  <text x={tx} y={PAD.top + 30} fontSize="11" fill="var(--mute)">
                    input {fmtCount(d.input)}, output {fmtCount(d.output)}
                  </text>
                  <text x={tx} y={PAD.top + 44} fontSize="11" fill="var(--mute)">
                    cache reads {fmtCount(d.cacheRead)}
                  </text>
                </>
              );
            })()}
          </g>
        ) : null}
      </svg>
      <details className="mt-1.5 text-[12px] text-mute">
        <summary className="cursor-pointer">table view</summary>
        <table className="mt-1 w-full text-left text-[12px]">
          <thead>
            <tr>
              <th className="pr-3 font-medium">day</th>
              <th className="pr-3 text-right font-medium">input</th>
              <th className="pr-3 text-right font-medium">output</th>
              <th className="text-right font-medium">cache reads</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.day}>
                <td className="pr-3">{d.day}</td>
                <td className="pr-3 text-right tabular-nums">{d.input.toLocaleString("en-US")}</td>
                <td className="pr-3 text-right tabular-nums">{d.output.toLocaleString("en-US")}</td>
                <td className="text-right tabular-nums">{d.cacheRead.toLocaleString("en-US")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
