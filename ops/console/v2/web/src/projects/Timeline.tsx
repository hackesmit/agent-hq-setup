// The Gantt. Bars come from the server's projection (TimelineItem[]); this file only maps
// them to pixels through timeline.ts, so the arithmetic is unit tested and what you see is
// what the projection said.
//
// Reading the bars: green is closed (created to closed), accent is projected, red is
// blocked, amber is late, the dotted outline is the due date and the red vertical line is
// today. Emphasised bars are on the critical path.

import { useRef, useState } from "react";
import type { TimelineItem } from "@shared/api";
import { Button, ButtonRow, Chip } from "../ui/primitives";
import { FEATURES } from "./features";
import {
  BAR_H,
  HEADER_H,
  ROW_H,
  ZOOMS,
  ZOOM_LABELS,
  chartHeight,
  dayTicks,
  depArrows,
  dueFromX,
  layoutRows,
  makeScale,
  todayX,
  tooltipFor,
  type BarTone,
  type Zoom,
} from "./timeline";

const LABEL_W = 236;

const TONE_FILL: Record<BarTone, string> = {
  done: "var(--ok)",
  active: "var(--accent2)",
  projected: "var(--accent)",
  blocked: "var(--bad)",
  late: "var(--warn)",
};

const TONE_LABEL: Record<BarTone, { tone: "ok" | "warn" | "bad" | "accent" | "mute"; text: string }> = {
  done: { tone: "ok", text: "done" },
  active: { tone: "accent", text: "active" },
  projected: { tone: "mute", text: "ready" },
  blocked: { tone: "bad", text: "blocked" },
  late: { tone: "warn", text: "late" },
};

export function Timeline({
  items,
  nowMs,
  onSetDue,
}: {
  items: readonly TimelineItem[];
  nowMs?: number;
  onSetDue?: (bead: string, due: string) => void;
}) {
  const [zoom, setZoom] = useState<Zoom>("6w");
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number } | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const scale = makeScale(zoom, nowMs ?? Date.now());
  const rows = layoutRows(items, scale);
  const arrows = depArrows(rows);
  const height = chartHeight(rows.length);
  const today = todayX(scale);
  const dragEnabled = FEATURES.timelineDueDrag && typeof onSetDue === "function";

  /** Pointer x in chart coordinates (scrolled track space), for date math. */
  function localX(clientX: number): number {
    const box = trackRef.current?.getBoundingClientRect();
    const scroll = trackRef.current?.scrollLeft ?? 0;
    return clientX - (box?.left ?? 0) + scroll;
  }

  /** Pointer x in card coordinates, for placing the tooltip. */
  function wrapX(clientX: number): number {
    const box = wrapRef.current?.getBoundingClientRect();
    return clientX - (box?.left ?? 0);
  }

  const hovered = hover ? rows.find((row) => row.item.id === hover.id) : undefined;
  const tip = hovered ? tooltipFor(hovered.item) : null;

  if (rows.length === 0) {
    return (
      <p className="m-0 text-[12px] text-mute">
        No dated work yet. Bars appear once beads carry an estimate, a dependency or a due date.
      </p>
    );
  }

  return (
    <div>
      <ButtonRow className="mb-2 justify-between">
        <ButtonRow>
          {ZOOMS.map((option) => (
            <Button
              key={option}
              size="sm"
              variant={option === zoom ? "primary" : "default"}
              onClick={() => setZoom(option)}
            >
              {ZOOM_LABELS[option]}
            </Button>
          ))}
        </ButtonRow>
        <span className="text-[11px] text-faint">
          {dragEnabled ? "Drag a bar's right edge to set its due date." : "Read-only: due dates move from bd for now."}
        </span>
      </ButtonRow>

      <div ref={wrapRef} className="relative flex rounded-sub border border-line">
        <div className="shrink-0 border-r border-line" style={{ width: LABEL_W }}>
          <div style={{ height: HEADER_H }} />
          {rows.map((row) => {
            const label = TONE_LABEL[row.tone];
            return (
              <div
                key={row.item.id}
                className="flex items-center gap-1.5 overflow-hidden px-2 text-[12px]"
                style={{ height: ROW_H }}
                title={`${row.item.id} ${row.item.title}`}
              >
                <Chip tone={row.item.kind === "epic" ? "accent" : label.tone}>
                  {row.item.kind === "epic" ? "epic" : label.text}
                </Chip>
                <span className="truncate">
                  <span className="font-mono text-faint">{row.item.id}</span> {row.item.title}
                </span>
              </div>
            );
          })}
        </div>

        <div ref={trackRef} className="hq-scroll min-w-0 flex-1 overflow-x-auto">
          <svg
            width={scale.width}
            height={height}
            role="img"
            aria-label={`Timeline, ${rows.length} rows, ${scale.days} days`}
            onPointerMove={(event) => {
              if (!drag) return;
              setDrag({ id: drag.id, x: localX(event.clientX) });
            }}
            onPointerUp={() => {
              if (drag && onSetDue) onSetDue(drag.id, dueFromX(scale, drag.x));
              setDrag(null);
            }}
            onPointerLeave={() => setDrag(null)}
          >
            {dayTicks(scale).map((tick) => (
              <g key={tick.ms}>
                <rect
                  x={tick.x}
                  y={HEADER_H}
                  width={scale.pxPerDay}
                  height={height - HEADER_H}
                  fill={tick.weekend ? "var(--panel2)" : "transparent"}
                  opacity={tick.weekend ? 0.5 : 1}
                />
                <line
                  x1={tick.x}
                  y1={HEADER_H}
                  x2={tick.x}
                  y2={height}
                  stroke="var(--line)"
                  strokeWidth={tick.major ? 1 : 0.5}
                />
                {tick.label ? (
                  <text x={tick.x + 3} y={HEADER_H - 8} fill="var(--mute)" fontSize="10">
                    {tick.label}
                  </text>
                ) : null}
              </g>
            ))}

            {arrows.map((arrow) => (
              <polyline
                key={`${arrow.from}-${arrow.to}`}
                points={arrow.points}
                fill="none"
                stroke={arrow.critical ? "var(--accent)" : "var(--faint)"}
                strokeWidth={arrow.critical ? 1.2 : 0.8}
                opacity={arrow.critical ? 0.8 : 0.4}
              />
            ))}

            {rows.map((row) => {
              const rect = row.rect;
              const dragX = drag && drag.id === row.item.id ? drag.x : null;
              return (
                <g
                  key={row.item.id}
                  onPointerEnter={(event) => setHover({ id: row.item.id, x: wrapX(event.clientX), y: row.y })}
                  onPointerLeave={() => setHover((current) => (current?.id === row.item.id ? null : current))}
                >
                  {rect ? (
                    <rect
                      x={rect.x}
                      y={row.y}
                      width={rect.width}
                      height={row.item.kind === "epic" ? BAR_H - 4 : BAR_H}
                      rx="2"
                      fill={TONE_FILL[row.tone]}
                      opacity={row.item.kind === "epic" ? 0.3 : row.item.projected ? 0.65 : 0.95}
                      stroke={row.item.critical ? "var(--ink)" : "none"}
                      strokeWidth={row.item.critical ? 1 : 0}
                    />
                  ) : null}

                  {row.dueX !== null ? (
                    <rect
                      x={row.dueX - 3}
                      y={row.y - 2}
                      width={6}
                      height={BAR_H + 4}
                      fill="none"
                      stroke="var(--warn)"
                      strokeWidth="1"
                      strokeDasharray="2 2"
                    />
                  ) : null}

                  {dragEnabled && rect && row.item.kind !== "epic" ? (
                    <rect
                      x={(dragX ?? rect.x + rect.width) - 4}
                      y={row.y}
                      width={8}
                      height={BAR_H}
                      fill="transparent"
                      className="cursor-ew-resize"
                      onPointerDown={(event) => {
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setDrag({ id: row.item.id, x: localX(event.clientX) });
                      }}
                    />
                  ) : null}
                </g>
              );
            })}

            <line x1={today} y1={HEADER_H - 4} x2={today} y2={height} stroke="var(--p0)" strokeWidth="1" />
            <text x={today + 3} y={HEADER_H - 12} fill="var(--p0)" fontSize="9">
              today
            </text>
          </svg>
        </div>

        {tip && hover ? (
          <div
            className="pointer-events-none absolute z-10 max-w-[260px] rounded-sub border border-line bg-panel px-2 py-1 text-[11px] shadow-card"
            style={{ left: Math.max(8, hover.x - 60), top: hover.y + ROW_H }}
          >
            <b className="block">
              <span className="font-mono text-faint">{tip.id}</span> {tip.title}
            </b>
            {tip.lines.map((line) => (
              <span key={line} className="block text-mute">
                {line}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
