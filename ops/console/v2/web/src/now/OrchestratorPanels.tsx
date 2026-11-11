// The orchestrator half of Now (bead hq-4npjr.5, mockup board F): the orchestrator's
// terminal on top, then what is the owner's to decide next to what the orchestrator
// decided for him, the live flow chart per project, the snoozed terminals and the
// files loaded for the orchestrator's next wake. Rules live in ./orchestrator.ts.

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { importOrReload } from "../app/lazyChunk";
import type { KeyboardEvent, PointerEvent } from "react";
import type { Alert, ConsoleState, OrchestratorReport, Request, Session } from "@shared/api";
import { api } from "../data/client";
import { FlowChart } from "../projects/FlowChart";
import { fmtAge } from "../ui/format";
import { HeadFoldToggle } from "../ui/Fold";
import { Button, Card, CardBody, CardHead, Chip, RigSigil, cx } from "../ui/primitives";
import type { ChipTone } from "../ui/primitives";
import { patchSession, useOpRunner } from "./ops";
import {
  findOrchestrator,
  flowTabs,
  fmtSize,
  forYou,
  heldCount,
  hhmm,
  liveOrchestrator,
  p0Alerts,
  snoozedSessions,
  topCounts,
} from "./orchestrator";
import { startOrchestrator } from "./http";
import { RequestCard } from "./RequestCard";
import { termPath } from "./popout";
import { ORCH_KEY_STEP, ORCH_MIN_PX, clampHeight, dragHeight, readHeight, saveHeight } from "./orchHeight";
import { toastError, toastInfo } from "./toast";
import { TOUCH_SM } from "./ui";
import { useUploadQueue } from "./uploadQueue";

const TerminalPane = lazy(importOrReload(async () => ({ default: (await import("./Terminal")).TerminalPane })));
const POLL_MS = 30_000;

/** GET /api/orchestrator every 30 s, plus on demand after a change. */
export function useOrchestratorReport(): { report: OrchestratorReport | null; reload: () => void } {
  const [report, setReport] = useState<OrchestratorReport | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .orchestrator()
        .then((r) => live && setReport(r))
        .catch(() => {
          /* the link being down is already reported in the top strip */
        });
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [tick]);
  return { report, reload };
}

function Section({ title, sub, chip, children, className }: { title: string; sub?: string; chip?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHead
        title={title}
        chip={
          <>
            {chip}
            {sub ? <span className="text-[11px] normal-case tracking-normal text-faint">{sub}</span> : null}
          </>
        }
      />
      {children}
    </Card>
  );
}

// ---------- header strip ----------

export function OrchestratorStrip({ state, report, now }: { state: ConsoleState | null; report: OrchestratorReport | null; now: number }) {
  const sessions = state?.sessions ?? [];
  const mine = forYou(state?.requests ?? [], sessions, now).length + p0Alerts(state?.alerts ?? []).length;
  const c = topCounts(sessions, mine);
  const held = heldCount(state?.requests ?? [], sessions, now);
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1 text-[12px] text-mute" data-testid="orch-strip">
      <span className="flex flex-wrap gap-x-4">
        <span>
          live <span className="text-ok">{c.live}</span>
        </span>
        <span>
          asleep <span className="text-ink">{c.asleep}</span>
        </span>
        <span>
          for you <span className={c.forYou > 0 ? "text-warn" : "text-ink"}>{c.forYou}</span>
        </span>
        {held > 0 ? <span>orchestrator answering {held}</span> : null}
      </span>
      {report ? (
        <span>
          {report.eventsToday ?? 0} orchestrator events today, {report.approvedToday} handled without you
        </span>
      ) : null}
    </div>
  );
}

// ---------- orchestrator terminal ----------

/**
 * One click starts the orchestrator chat terminal (hq-4npjr.11). Shown only while none
 * is found, so a crashed or ended one restarts from here; state lives in files, so a
 * fresh terminal loses nothing. It appears on top once its card is named.
 */
export function StartOrchestrator() {
  const run = useOpRunner();
  const [busy, setBusy] = useState(false);
  async function start(): Promise<void> {
    setBusy(true);
    try {
      const r = await run("start orchestrator", () => startOrchestrator());
      if (r.ok) toastInfo("orchestrator starting");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button className="mt-2" disabled={busy} onClick={() => void start()} data-testid="orch-start">
      {busy ? "Starting..." : "Start orchestrator"}
    </Button>
  );
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function viewport(): number {
  return typeof window === "undefined" ? 800 : window.innerHeight;
}

/**
 * The orchestrator box (hq-4npjr.17): opens at 65vh, its bottom edge drags between
 * 240 px and 90vh, the height is kept per browser. The terminal inside fills the box
 * and refits through its own ResizeObserver, which debounces the resize messages.
 */
function ResizableBox({ children }: { children: React.ReactNode }) {
  const [px, setPx] = useState<number | null>(() => readHeight(storage()));
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const start = useRef<{ y: number; px: number } | null>(null);
  const current = (): number => box.current?.getBoundingClientRect().height ?? px ?? clampHeight(Number.NaN, viewport());
  function commit(next: number): void {
    setPx(next);
    saveHeight(storage(), next);
  }
  function down(e: PointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { y: e.clientY, px: current() };
    setDragging(true);
  }
  function move(e: PointerEvent<HTMLDivElement>): void {
    if (!start.current) return;
    setPx(dragHeight(start.current.px, start.current.y, e.clientY, viewport()));
  }
  function up(e: PointerEvent<HTMLDivElement>): void {
    if (!start.current) return;
    const next = dragHeight(start.current.px, start.current.y, e.clientY, viewport());
    start.current = null;
    setDragging(false);
    commit(next);
  }
  function key(e: KeyboardEvent<HTMLDivElement>): void {
    const step = e.key === "ArrowDown" ? ORCH_KEY_STEP : e.key === "ArrowUp" ? -ORCH_KEY_STEP : 0;
    if (!step) return;
    e.preventDefault();
    commit(clampHeight(current() + step, viewport()));
  }
  const height = px == null ? "65vh" : `min(${Math.round(px)}px, 90vh)`;
  return (
    <>
      <div ref={box} className="p-1.5" style={{ height, minHeight: ORCH_MIN_PX }} data-testid="orch-box">
        {children}
      </div>
      <div
        className="hq-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the orchestrator terminal"
        aria-valuenow={px == null ? undefined : Math.round(px)}
        tabIndex={0}
        data-dragging={dragging ? "" : undefined}
        data-testid="orch-resize"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
      />
    </>
  );
}

export function OrchestratorTerminal({ sessions }: { sessions: readonly Session[] }) {
  const orch = findOrchestrator(sessions);
  const live = liveOrchestrator(sessions) !== null;
  if (!orch) {
    return (
      <Section title="Orchestrator" sub="not running">
        <CardBody>
          <p className="m-0 text-[13px] text-mute" data-testid="orch-missing">
            No orchestrator is running. Worker questions come to you below.
          </p>
          <StartOrchestrator />
        </CardBody>
      </Section>
    );
  }
  const sub = [orch.id, orch.model, orch.rig, live ? "awake" : orch.state].filter(Boolean).join(" · ");
  return (
    <Section
      title="Orchestrator"
      sub={sub}
      chip={
        <a href={termPath(orch.id)} target="_blank" rel="noopener" className={cx("text-[12px] text-mute no-underline hover:text-ink", TOUCH_SM)}>
          pop out
        </a>
      }
    >
      <ResizableBox>
        {orch.attachable ? (
          <Suspense fallback={<p className="m-0 p-3 text-[13px] text-mute">loading terminal...</p>}>
            <TerminalPane session={orch} fill popout={false} />
          </Suspense>
        ) : (
          <p className="m-0 p-3 text-[13px] text-mute">The orchestrator terminal has no view on this box ({orch.state}).</p>
        )}
      </ResizableBox>
    </Section>
  );
}

// ---------- For you ----------

function AlertRow({ alert, now }: { alert: Alert; now: number }) {
  return (
    <li className="flex items-baseline gap-2 border-b border-line/60 px-3.5 py-2 text-[13px] last:border-b-0">
      <Chip tone="bad">P0</Chip>
      <span className="min-w-0 flex-1">
        <span className="block text-ink">{alert.title}</span>
        {alert.detail ? <span className="block truncate text-[12px] text-mute">{alert.detail}</span> : null}
      </span>
      <span className="shrink-0 text-[11px] text-faint">{fmtAge(alert.createdAt, now)}</span>
    </li>
  );
}

export function ForYou({ requests, sessions, alerts, now }: { requests: readonly Request[]; sessions: readonly Session[]; alerts: readonly Alert[]; now: number }) {
  const asks = forYou(requests, sessions, now);
  const urgent = p0Alerts(alerts);
  return (
    <Section title="For you" sub="only what is yours to decide" chip={asks.length + urgent.length > 0 ? <Chip tone="warn">{asks.length + urgent.length}</Chip> : null}>
      {asks.length + urgent.length === 0 ? (
        <CardBody>
          <p className="m-0 text-[13px] text-mute" data-testid="for-you-empty">
            Nothing needs you.
          </p>
        </CardBody>
      ) : (
        <>
          {urgent.length > 0 ? (
            <ul className="m-0 list-none p-0">
              {urgent.map((a) => (
                <AlertRow key={a.id} alert={a} now={now} />
              ))}
            </ul>
          ) : null}
          <div className="flex flex-col gap-2 p-2">
            {asks.map((r) => (
              <RequestCard key={r.id} request={r} now={now} />
            ))}
          </div>
        </>
      )}
    </Section>
  );
}

// ---------- Orchestrator approved ----------

const KIND_TONE: Record<string, ChipTone> = {
  merge: "ok",
  review: "accent",
  answer: "default",
  forward: "warn",
  block: "bad",
  fix: "accent",
  snooze: "mute",
  wake: "mute",
  dispatch: "default",
};

export function Approved({ report }: { report: OrchestratorReport | null }) {
  const rows = report?.approved ?? [];
  return (
    <Section title="Orchestrator approved" sub="newest first">
      {rows.length === 0 ? (
        <CardBody>
          <p className="m-0 text-[13px] text-mute">No decisions logged yet.</p>
        </CardBody>
      ) : (
        <ul className="m-0 max-h-[360px] list-none overflow-y-auto p-0">
          {rows.map((a, i) => (
            <li key={`${a.ts}-${i}`} className="flex items-baseline gap-2 border-b border-line/60 px-3.5 py-1.5 text-[13px] last:border-b-0">
              <span className="w-11 shrink-0 text-[11px] tabular-nums text-faint" title={a.ts}>
                {hhmm(a.ts)}
              </span>
              <Chip tone={KIND_TONE[a.kind] ?? "default"}>{a.kind}</Chip>
              <span className="min-w-0 flex-1">
                <span className="block text-ink">{a.text}</span>
                {a.why ? <span className="block text-[12px] text-mute">{a.why}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---------- flow charts ----------

const TAB_KEY = "hq.now.flowTab";

export function ProjectFlows({ state, report }: { state: ConsoleState | null; report: OrchestratorReport | null }) {
  const tabs = flowTabs(state?.projects ?? []);
  const [picked, setPicked] = useState<string>(() => {
    try {
      return localStorage.getItem(TAB_KEY) ?? "hq";
    } catch {
      return "hq";
    }
  });
  const current = tabs.find((t) => t.id === picked)?.id ?? tabs[0]?.id ?? null;
  function pick(id: string) {
    setPicked(id);
    try {
      localStorage.setItem(TAB_KEY, id);
    } catch {
      /* private mode: the pick lasts this page only */
    }
  }
  const update = current ? report?.updates[current] : undefined;
  return (
    <Card>
      <div className="hq-card-head flex flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
        <HeadFoldToggle title="Flow" className="mr-2 pl-1.5" />
        <div className="contents" role="tablist" aria-label="Project flow charts">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === current}
            onClick={() => pick(t.id)}
            className={cx(
              "rounded-sub px-2 py-1 text-[12px]",
              TOUCH_SM,
              t.id === current ? "bg-chip text-ink" : "text-mute hover:text-ink",
            )}
          >
            {t.label}
            {t.pct !== null ? <span className="ml-1.5 text-faint">{t.pct}%</span> : null}
          </button>
        ))}
        </div>
      </div>
      {update ? (
        <p className="m-0 border-b border-line/60 px-3.5 py-1.5 text-[12px] text-mute" data-testid="project-update">
          <span className="text-faint">{hhmm(update.at)}</span> {update.text}
        </p>
      ) : null}
      <CardBody>{current ? <FlowChart key={current} project={current} /> : <p className="m-0 text-[13px] text-mute">No project has work in flight.</p>}</CardBody>
    </Card>
  );
}

// ---------- Snoozed terminals ----------

function wakeLabel(iso: string | null): string {
  if (!iso) return "no wake time";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "no wake time" : d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

export function Snoozed({ sessions }: { sessions: readonly Session[] }) {
  const run = useOpRunner();
  const [busy, setBusy] = useState<string | null>(null);
  const rows = snoozedSessions(sessions);
  async function wake(s: Session) {
    setBusy(s.id);
    await run("wake", async () => {
      const r = await api.session(s.id, "wake");
      patchSession(s.id, { state: "running", wakeAt: null });
      return r;
    });
    setBusy(null);
  }
  return (
    <Section title="Snoozed terminals" sub="each wakes, works, reports back" chip={rows.length > 0 ? <Chip tone="mute">{rows.length}</Chip> : null}>
      {rows.length === 0 ? (
        <CardBody>
          <p className="m-0 text-[13px] text-mute">Nothing is asleep.</p>
        </CardBody>
      ) : (
        <ul className="m-0 list-none p-0">
          {rows.map((s) => (
            <li key={s.id} className="flex items-center gap-2 border-b border-line/60 px-3.5 py-1.5 text-[13px] last:border-b-0">
              <RigSigil id={s.rig} size={12} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ink">{s.name || s.task || s.bead || s.id}</span>
                <span className="block truncate text-[12px] text-mute">{[s.rig, s.bead, s.id].filter(Boolean).join(" · ")}</span>
              </span>
              <span className="shrink-0 text-[11px] text-faint" title={s.wakeAt ?? undefined}>
                {wakeLabel(s.wakeAt)}
              </span>
              <Button size="sm" className={TOUCH_SM} disabled={busy === s.id} onClick={() => void wake(s)}>
                wake now
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---------- Loaded for the orchestrator ----------

export function Loaded({ report, reload }: { report: OrchestratorReport | null; reload: () => void }) {
  const [over, setOver] = useState(false);
  const queue = useUploadQueue((id) => {
    api
      .orchestratorLoad(id)
      .then(reload)
      .catch((e: unknown) => toastError(`could not load the file for the orchestrator: ${e instanceof Error ? e.message : "error"}`));
  });
  const files = report?.loaded ?? [];
  const pending = queue.items.filter((i) => i.phase !== "done" && i.phase !== "error").length;
  const total = files.reduce((n, f) => n + f.size, 0);
  async function unload(id: string) {
    try {
      await api.orchestratorUnload(id);
    } catch (e) {
      toastError(`could not unload: ${e instanceof Error ? e.message : "error"}`);
    }
    reload();
  }
  return (
    <Section title="Loaded for the orchestrator" chip={files.length > 0 ? <Chip tone="mute">{`${files.length} · ${fmtSize(total)}`}</Chip> : null}>
      {files.length > 0 ? (
        <ul className="m-0 list-none p-0">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 border-b border-line/60 px-3.5 py-1 text-[13px] last:border-b-0">
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink" title={f.name}>
                {f.name}
              </span>
              <span className="shrink-0 text-[11px] text-faint">{fmtSize(f.size)}</span>
              <button type="button" className={cx("text-mute hover:text-ink", TOUCH_SM)} aria-label={`Unload ${f.name}`} onClick={() => void unload(f.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <label
        className={cx(
          "m-2 flex cursor-pointer flex-col items-center gap-0.5 rounded-card border border-dashed px-3 py-4 text-center",
          over ? "border-accent bg-accent/10" : "border-line",
        )}
        onDragOver={(e) => {
          if (!e.dataTransfer?.types?.includes("Files")) return;
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          const list = e.dataTransfer?.files;
          if (!list || list.length === 0) return;
          e.preventDefault();
          e.stopPropagation(); // the page-wide drop would queue it a second time
          setOver(false);
          queue.add([...list]);
        }}
      >
        <span className="text-[13px] text-ink">Drop files to load</span>
        <span className="text-[11px] text-mute">{pending > 0 ? `uploading ${pending}` : "or click to choose · read on the next wake"}</span>
        <input
          type="file"
          multiple
          className="sr-only"
          aria-label="Load files for the orchestrator"
          onChange={(e) => {
            const list = e.target.files;
            if (list && list.length > 0) queue.add([...list]);
            e.target.value = "";
          }}
        />
      </label>
    </Section>
  );
}
