// Flow chart (beads hq-c4pl0.2, hq-c4pl0.7): a project's beads as a top-down
// dependency chart. Each node is a title with a state accent; epics add a progress
// bar. Epic nodes open their children in place, with a breadcrumb back; a bead opens
// its row in the beads list. Layout and colours come from flow.ts (pure); this file
// measures the width, draws and handles clicks and hover.

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { FlowNode, FlowState } from "@shared/api";
import { navigate } from "../app/router";
import { beadPath } from "../app/routes";
import { errorText, projectsApi } from "./api";
import {
  FLOW_STATES,
  FOLDABLE,
  NODE_H,
  PROJECT_SHOWN,
  STATE_LABEL,
  STATE_TOKEN,
  coreTitle,
  edgeKey,
  edgePath,
  focusGraph,
  layoutFlow,
  neighbours,
  stateCounts,
  wrapTitle,
} from "./flow";
import { useAsync } from "./useAsync";

/** Node padding plus border, left and right (styles.css .hq-flow-node), off the title width. */
const NODE_PAD_X = 38;
const ATTENTION_FIRST: readonly FlowState[] = ["waiting", "blocked", "active", "upcoming", "deferred", "done"];

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** Pixel width of a title line in the node face's font, so the wrap matches what renders. */
function titleWidth(text: string): number {
  if (measureCtx === undefined) {
    measureCtx = document.createElement("canvas").getContext("2d");
    if (measureCtx) {
      const sans = getComputedStyle(document.documentElement).getPropertyValue("--sans").trim() || "sans-serif";
      measureCtx.font = `13px ${sans}`;
    }
  }
  // no canvas: a generous 7.5px a glyph keeps the wrap inside the box
  return measureCtx ? measureCtx.measureText(text).width : text.length * 7.5;
}

function tooltip(node: FlowNode): string {
  const progress = node.kind === "epic" ? `, ${node.doneCount}/${node.childCount} done` : "";
  const outside = node.kind === "stub" ? ", outside this project" : "";
  return `${node.id}  ${node.title}\n${STATE_LABEL[node.state]}${progress}${outside}`;
}

/** One quiet line: a dot and a count per state; folded states are toggles. */
function Legend({
  nodes,
  foldable,
  unfolded,
  onToggle,
}: {
  nodes: readonly FlowNode[];
  foldable: boolean;
  unfolded: ReadonlySet<FlowState>;
  onToggle: (s: FlowState) => void;
}) {
  const counts = stateCounts(nodes.filter((n) => n.kind !== "stub"));
  return (
    <span className="hq-flow-legend">
      {ATTENTION_FIRST.filter((s) => counts[s] > 0)
        .sort((a, b) => Number(FOLDABLE.includes(a)) - Number(FOLDABLE.includes(b)))
        .map((s) => {
          const dot = <span aria-hidden className="hq-flow-dot" style={{ background: STATE_TOKEN[s] }} />;
          const label = `${counts[s]} ${STATE_LABEL[s]}`;
          if (!foldable || !FOLDABLE.includes(s)) {
            return (
              <span key={s} className="hq-flow-count">
                {dot}
                {label}
              </span>
            );
          }
          const on = unfolded.has(s);
          return (
            <button
              key={s}
              type="button"
              aria-pressed={on}
              title={on ? `Hide ${STATE_LABEL[s]}` : `Show ${STATE_LABEL[s]}`}
              className="hq-flow-count hq-flow-toggle hq-press"
              onClick={() => onToggle(s)}
            >
              {dot}
              {label}
            </button>
          );
        })}
    </span>
  );
}

export function FlowChart({
  project,
  epic: epicProp,
  onEpic,
  focus = null,
}: {
  project: string;
  /** Controlled epic scope; leave undefined to let the chart keep its own. */
  epic?: string | null;
  onEpic?: (epic: string | null) => void;
  /** A bead to ring, for a chart opened from a terminal or a request. */
  focus?: string | null;
}) {
  const [ownTrail, setOwnTrail] = useState<{ id: string; title: string }[]>([]);
  const [unfolded, setUnfolded] = useState<ReadonlySet<FlowState>>(new Set());
  const [hover, setHover] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const asked = epicProp !== undefined ? epicProp : (ownTrail[ownTrail.length - 1]?.id ?? null);
  const flow = useAsync(
    (signal) => projectsApi.flow(project, asked, focus, signal),
    `${project}:flow:${asked ?? ""}:${focus ?? ""}`,
  );
  // The server may pick the epic (a focus bead opens the epic it sits on).
  const epic = flow.data ? flow.data.epic : asked;
  // An epic the chart did not open itself (a deep link) starts a fresh trail.
  const trail =
    epic === null ? [] : ownTrail[ownTrail.length - 1]?.id === epic ? ownTrail : [{ id: epic, title: flow.data?.epicTitle ?? "" }];

  function open(node: FlowNode): void {
    if (node.kind === "epic") {
      setOwnTrail([...trail, { id: node.id, title: node.title }]);
      setHover(null);
      onEpic?.(node.id);
      return;
    }
    navigate(beadPath(project, node.id));
  }
  function back(depth: number): void {
    setOwnTrail(trail.slice(0, depth));
    setHover(null);
    onEpic?.(depth === 0 ? null : (trail[depth - 1]?.id ?? null));
  }
  function toggle(s: FlowState): void {
    const next = new Set(unfolded);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setUnfolded(next);
  }

  const graph = flow.data;
  // An epic shows all its children (done ones dimmed); the project level shows work in
  // flight and folds the rest into the legend's toggles.
  const shownStates = new Set<FlowState>(epic ? FLOW_STATES : [...PROJECT_SHOWN, ...unfolded]);
  // a focused bead is always on screen, whatever its state
  const shown = graph
    ? focusGraph(graph, shownStates, focus ? new Set([focus]) : undefined, { hideActiveSingles: !epic && !unfolded.has("active") })
    : null;
  const layout = shown && width > 0 ? layoutFlow(shown, width) : null;
  const near = layout ? neighbours(layout.edges, hover) : null;
  const lit = near && near.edges.size > 0 ? near : null;
  const byId = new Map(layout?.nodes.map((n) => [n.id, n]));
  const titleMax = layout ? layout.nodeW - NODE_PAD_X : 0;

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px]">
        <span className="min-w-[min(100%,16rem)] flex-1 truncate text-mute">
          {epic ? (
            <>
              <a
                href="#"
                onClick={(event) => {
                  event.preventDefault();
                  back(0);
                }}
              >
                All epics
              </a>
              {trail.map((t, i) => (
                <span key={t.id}>
                  {" / "}
                  {i < trail.length - 1 ? (
                    <a
                      href="#"
                      onClick={(event) => {
                        event.preventDefault();
                        back(i + 1);
                      }}
                    >
                      {t.id}
                    </a>
                  ) : (
                    <span className="text-ink" title={`${t.id} ${t.title}`}>
                      {coreTitle(t.title) || t.id}
                    </span>
                  )}
                </span>
              ))}
            </>
          ) : (
            "All epics"
          )}
        </span>
        {graph ? <Legend nodes={graph.nodes} foldable={!epic} unfolded={unfolded} onToggle={toggle} /> : null}
      </div>

      {flow.error ? <p className="m-0 text-[12px] text-bad">Could not load the chart. {errorText(flow.error)}</p> : null}
      {flow.loading && !graph ? <p className="m-0 text-[12px] text-mute">Loading.</p> : null}
      {shown && shown.nodes.length === 0 ? (
        <p className="m-0 text-[12px] text-mute">
          {graph && graph.nodes.length > 0 ? "Nothing in flight. Open a count above to see the rest." : "No beads here yet."}
        </p>
      ) : null}

      <div ref={box} className="relative w-full" style={{ height: layout?.height ?? 0 }}>
        {layout ? (
          <>
            <svg
              className="pointer-events-none absolute inset-0"
              width={layout.width}
              height={layout.height}
              aria-hidden
            >
              <defs>
                <marker id="hq-flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" fill="var(--flow-edge)" />
                </marker>
                <marker id="hq-flow-arrow-hot" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" fill="var(--accent)" />
                </marker>
              </defs>
              {layout.edges.map((edge) => {
                const from = byId.get(edge.from);
                const to = byId.get(edge.to);
                if (!from || !to) return null;
                const hot = lit ? lit.edges.has(edgeKey(edge)) : edge.critical;
                return (
                  <path
                    key={edgeKey(edge)}
                    d={edgePath(from, to, layout.nodeW)}
                    fill="none"
                    stroke={hot ? "var(--accent)" : "var(--flow-edge)"}
                    strokeWidth={hot ? 1.5 : 1}
                    opacity={lit && !hot ? 0.35 : hot ? 0.85 : 1}
                    markerEnd={`url(#${hot ? "hq-flow-arrow-hot" : "hq-flow-arrow"})`}
                  />
                );
              })}
            </svg>
            {layout.nodes.map((node) => {
              const lines = wrapTitle(coreTitle(node.title), titleMax, 2, titleWidth);
              const style: CSSProperties & Record<"--flow-state", string> = {
                left: node.x,
                top: node.y,
                width: layout.nodeW,
                height: NODE_H,
                "--flow-state": STATE_TOKEN[node.state],
              };
              return (
                <button
                  key={node.id}
                  type="button"
                  className="hq-flow-node"
                  data-state={node.state}
                  data-kind={node.kind}
                  data-focus={node.id === focus || undefined}
                  data-critical={layout.critical.has(node.id) || undefined}
                  data-lit={lit ? (lit.nodes.has(node.id) ? "on" : "off") : undefined}
                  style={style}
                  title={tooltip(node)}
                  aria-label={`${node.id} ${node.title}, ${STATE_LABEL[node.state]}`}
                  onClick={() => open(node)}
                  onMouseEnter={() => setHover(node.id)}
                  onMouseLeave={() => setHover((h) => (h === node.id ? null : h))}
                  onFocus={() => setHover(node.id)}
                  onBlur={() => setHover((h) => (h === node.id ? null : h))}
                >
                  <span aria-hidden className="hq-flow-dot hq-flow-node-dot" />
                  <span className="hq-flow-title">
                    {lines.map((line, i) => (
                      <span key={i}>{line}</span>
                    ))}
                  </span>
                  {node.kind === "epic" && node.childCount > 0 ? (
                    <span aria-hidden className="hq-flow-progress">
                      <span style={{ width: `${(100 * node.doneCount) / node.childCount}%` }} />
                    </span>
                  ) : null}
                </button>
              );
            })}
          </>
        ) : null}
      </div>
    </div>
  );
}
