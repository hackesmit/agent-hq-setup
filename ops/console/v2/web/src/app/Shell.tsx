// Global chrome: the five tabs in three responsive shapes (left rail >= 1280, top bar
// 768 to 1279 and always in Paper, bottom bar < 768), the top strip, the Capri (meta
// terminal) button, keyboard shortcuts and the command palette.

import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { importOrReload } from "./lazyChunk";
import { linkPill } from "./linkPill";
import type { ConsoleState, OrchestratorUsage, ReportsSummary } from "@shared/api";
import { useConsole } from "../data/store";
import { getFatal, noteHealthyResponse, onFatal, type FatalState } from "../data/client";
import { DESIGNS, DESIGN_LABELS, useDesign } from "../theme/design";
import { Badge, Button, cx } from "../ui/primitives";
import { TickNum } from "../ui/TickNum";
import { fmtClock, fmtCount, fmtDayStamp } from "../ui/format";
import { reportsIndicator, tabBadges, waitingStrip } from "./badges";
import { REPORTS_SUMMARY_EVENT } from "../reports/api";
import { ToastHost } from "../now/toast";
import { CapriCorner } from "../now/CapriCorner";
import { NewNoteButton, NotesLayer, useNotes } from "../now/Notes";
import { CommandPalette } from "./CommandPalette";
import { Standby } from "./Standby";
import { SettingsDialog, useSettings } from "./Settings";
import { idleMs } from "./settings";
import { useCues } from "./useCues";
import { useConsoleFavicon } from "../now/favicon";
import { setSigilsEnabled } from "../ui/sigil";
import { navigate, useRoute } from "./router";
import { TAB_LABELS, TABS, tabForKey, tabPath, type TabId } from "./routes";
import { BoardTab } from "../tabs/BoardTab";
import { MachinesTab } from "../tabs/MachinesTab";
const TerminalsTab = lazy(importOrReload(async () => ({ default: (await import("../tabs/TerminalsTab")).TerminalsTab })));
const ErrorsTab = lazy(importOrReload(async () => ({ default: (await import("../tabs/ErrorsTab")).ErrorsTab })));
const ReportsTab = lazy(importOrReload(async () => ({ default: (await import("../tabs/ReportsTab")).ReportsTab })));
import { MoneyTab } from "../tabs/MoneyTab";
import { NowTab } from "../tabs/NowTab";
import { ProjectDetail, ProjectsTab } from "../tabs/ProjectsTab";
import { StackTab } from "../tabs/StackTab";


function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function TabButton({
  tab,
  active,
  badge,
  variant,
}: {
  tab: TabId;
  active: boolean;
  badge: { count: number; tone: "p0" | "p1" | "neutral" | "none" };
  variant: "rail" | "top" | "bottom";
}) {
  const base =
    "flex cursor-pointer items-center gap-2 border-0 bg-transparent text-left text-ink hover:bg-panel2";
  const shape =
    variant === "rail"
      ? cx("w-full justify-between rounded-sub px-2.5 py-2", active && "bg-panel2 shadow-[inset_3px_0_0_var(--accent)]")
      : variant === "top"
        ? cx("rounded-t-sub px-2.5 py-1.5", active && "shadow-[inset_0_-2px_0_var(--accent)]")
        : cx("flex-1 flex-col justify-center gap-0.5 px-1 py-2 text-[11px]", active && "shadow-[inset_0_3px_0_var(--accent)]");

  // Nine tabs do not fit a phone's bottom bar, so it scrolls; keep the open one in view.
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (variant === "bottom" && active) ref.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [variant, active]);

  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      aria-selected={active}
      aria-current={active ? "page" : undefined}
      className={cx(base, shape)}
      onClick={() => navigate(tabPath(tab))}
    >
      <span>{TAB_LABELS[tab]}</span>
      <Badge count={badge.count} tone={badge.tone} />
    </button>
  );
}

// The release is the basename of releases/current, which in production is a full 40
// character commit sha: one unbreakable word far wider than the 212px rail, so it used
// to paint through the rail border and shove ", protocol N" onto a line of its own.
// The rail shows the short form and keeps the whole value in the title.
export function shortRelease(release: string): string {
  return /^[0-9a-f]{12,}$/i.test(release) ? release.slice(0, 8) : release;
}

function releaseLine(state: ConsoleState | null): { short: string; full: string } {
  const release = state?.version.release ?? "no release";
  const protocol = state?.version.protocol ?? "?";
  return { short: `${shortRelease(release)}, protocol ${protocol}`, full: `${release}, protocol ${protocol}` };
}

function servicesLine(state: ConsoleState | null): string {
  const collectors = state?.collectors ?? [];
  if (collectors.length === 0) return "services unknown";
  const failing = collectors.filter((collector) => collector.error !== null);
  const healthy = collectors.length - failing.length;
  if (failing.length === 0) return `services ${healthy}/${collectors.length}, all up`;
  return `services ${healthy}/${collectors.length}, ${failing[0]!.name} failing`;
}

/**
 * The reports summary the icon shows: the live one from the state slice, or the counts a
 * mark-read just answered with, until the slice next moves. Comparing against the slice
 * value the answer arrived on keeps a later push from being hidden by an old answer.
 */
function useReportsSummary(live: ReportsSummary | null | undefined): ReportsSummary | null | undefined {
  const [local, setLocal] = useState<{ summary: ReportsSummary; base: ReportsSummary | null | undefined } | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  useEffect(() => {
    function onSummary(event: Event): void {
      const summary = (event as CustomEvent<ReportsSummary>).detail;
      if (summary) setLocal({ summary, base: liveRef.current });
    }
    window.addEventListener(REPORTS_SUMMARY_EVENT, onSummary);
    return () => window.removeEventListener(REPORTS_SUMMARY_EVENT, onSummary);
  }, []);
  return local && local.base === live ? local.summary : live;
}

function ReportsButton({ summary, active }: { summary: ReportsSummary | null | undefined; active: boolean }) {
  const ind = reportsIndicator(summary);
  return (
    <button
      type="button"
      title={ind.title}
      aria-label={ind.title}
      aria-current={active ? "page" : undefined}
      onClick={() => navigate(tabPath("reports"))}
      className={cx(
        "relative flex cursor-pointer items-center rounded-sub border border-line bg-transparent px-1.5 py-0.5 hover:text-ink",
        active ? "text-ink" : "text-faint",
      )}
    >
      {/* an envelope: the reports are the HQ mails, read here instead */}
      <svg aria-hidden width="16" height="14" viewBox="0 0 16 14" fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="1" y="1.5" width="14" height="11" rx="1.5" />
        <path d="M1.5 2.5 8 8l6.5-5.5" />
      </svg>
      {ind.label ? (
        <span
          className={cx(
            "ml-1 min-w-4 rounded-full px-1 text-center font-mono text-[10px] leading-4",
            ind.unavailable ? "bg-bad text-white" : "bg-accent text-accent-ink",
          )}
        >
          {ind.label}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The stale-boot-key dead end, made visible. When the reload budget is spent,
 * data/client sets a fatal state and every guarded POST fails until the page is
 * reloaded by hand; until this banner existed that state was invisible (nothing
 * subscribed to onFatal), so the console looked alive while every button
 * silently 403'd. Self-subscribing so both Shell returns can render it.
 */
function FatalBanner() {
  const [fatal, setFatal] = useState<FatalState>(() => getFatal());
  useEffect(() => onFatal(setFatal), []);
  if (!fatal) return null;
  return (
    <div className="col-span-full sticky top-0 z-50 flex items-center justify-center gap-3 border-b border-bad/40 bg-bad/15 px-3 py-2 text-[13px] text-ink" role="alert">
      <span>{fatal.message}</span>
      <Button size="sm" variant="primary" onClick={() => { noteHealthyResponse(); window.location.reload(); }}>
        Reload
      </Button>
    </div>
  );
}

export function Shell() {
  const route = useRoute();
  const { state, status, source, error, updateReady } = useConsole();
  const [design, setDesign] = useDesign();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const clock = useClock();
  const badges = tabBadges(state);
  const waiting = waitingStrip(state);
  const reportsSummary = useReportsSummary(state?.reports);
  // Capri is enabled per box (proposal 19 flags); the rail button reflects that.
  // Sticky notes live above every tab, so they are owned here rather than in a tab.
  const notes = useNotes();
  const [settings, updateSettings] = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // one flag the sigil primitive reads, rather than a prop threaded through every row
  setSigilsEnabled(settings.sigils);
  // Sound cues. Called before the pop-out early return so hook order is stable, and fed
  // a null state in a pop-out window so one event never rings twice on one desk.
  const cues = useCues(route.termSid ? null : state, settings);
  // The tab icon and title carry the terminals' marks (question, done, working); a
  // pop-out marks its own terminal instead (NowTab), so it passes null here.
  useConsoleFavicon(route.termSid ? null : (state?.sessions ?? null), clock.getTime());

  // pop-out terminal window: the Now tab renders the single terminal, no chrome
  if (route.termSid) {
    return (
      <div className="min-h-screen bg-bg text-ink">
        <FatalBanner />
        <NowTab state={state} focusRequest={null} />
        <ToastHost />
      </div>
    );
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable === true;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (event.key === "Escape" && paletteOpen) {
        setPaletteOpen(false);
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      const tab = tabForKey(event.key);
      if (tab) {
        event.preventDefault();
        navigate(tabPath(tab));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [paletteOpen]);

  const version = releaseLine(state);

  const live = (state?.sessions ?? []).filter((session) =>
    ["running", "waiting", "draining"].includes(session.state),
  ).length;

  return (
    <div className="hq-app grid min-h-screen grid-cols-1 xl:grid-cols-[212px_minmax(0,1fr)]">
      <FatalBanner />
      <nav
        aria-label="Sections"
        className="hq-rail sticky top-0 hidden h-screen min-w-0 flex-col gap-1 border-r border-line bg-panel px-2.5 py-3.5 xl:flex"
        role="tablist"
      >
        <div className="flex items-center gap-2 px-2.5 pt-1.5 pb-3.5 font-semibold tracking-[0.02em]">
          <span className={cx("inline-block h-2 w-2 rounded-full", status === "live" ? "bg-ok hq-live-dot" : "bg-warn")} />
          Token Burner 5000 <small className="font-normal text-mute">{state?.owner ? "hqbox" : "offline"}</small>
        </div>
        {TABS.map((tab) => (
          <TabButton key={tab} tab={tab} active={route.tab === tab} badge={badges[tab]} variant="rail" />
        ))}
        <div className="flex-1" />
        <div className="px-2.5 py-2 text-[11px] leading-5 text-faint">
          <div className="mb-1 truncate" title={version.full}>
            {version.short}
          </div>
          <div className="flex flex-wrap gap-1">
            {/* One direction, so no switcher: a row of buttons offering a single
                choice is furniture. The picker returns if a second one ever does. */}
            {DESIGNS.length > 1
              ? DESIGNS.map((option) => (
                  <Button
                    key={option}
                    size="sm"
                    variant={design === option ? "primary" : "default"}
                    aria-pressed={design === option}
                    onClick={() => setDesign(option)}
                  >
                    {DESIGN_LABELS[option]}
                  </Button>
                ))
              : null}
            <Button size="sm" title="settings for this screen" onClick={() => setSettingsOpen(true)}>
              settings
            </Button>
          </div>
        </div>
      </nav>

      <div className="min-w-0 pb-16 md:pb-0">
        <div className="sticky top-0 z-20 flex flex-wrap items-center gap-4 border-b border-line bg-panel px-5 py-2.5 text-[12px] text-mute">
          <span>
            <b className="font-semibold text-ink">{fmtClock(clock)}</b> {fmtDayStamp(clock)}
          </span>
          <span>
            tokens today <b className="font-semibold text-ink">{state?.usage ? fmtCount(state.usage.tokensToday) : "-"}</b>
          </span>
          {state?.usage?.orchestrator ? <OrchestratorUsageLine u={state.usage.orchestrator} /> : null}
          <span>
            live <TickNum className={live > 0 ? "text-ok hq-fig-live" : "text-ink"} value={live} />
          </span>
          <span title="Questions waiting on you. Each one is on the card of the terminal that asked it, under Sessions on Now.">
            waiting <TickNum className={waiting.count > 0 ? "text-accent hq-fig-accent" : "text-ink"} value={waiting.count} />
            {waiting.p0 ? " (P0)" : ""}
          </span>
          <span className="hidden sm:inline">{servicesLine(state)}</span>
          <div className="ml-auto flex items-center gap-2">
            {(() => {
              const link = linkPill(status, source);
              return (
                <span
                  role="status"
                  className={cx(link.tone, link.pill && "rounded-full border border-current px-2 py-0.5 text-[11px]")}
                >
                  {link.label}
                </span>
              );
            })()}
            {updateReady ? (
              <button
                type="button"
                title="A new console release is live. Reload to use it."
                className="rounded-full border border-line px-2 py-0.5 text-[11px] text-faint hover:text-ink"
                onClick={() => window.location.reload()}
              >
                update ready
              </button>
            ) : null}
            <ReportsButton summary={reportsSummary} active={route.tab === "reports"} />
            <NewNoteButton onAdd={() => void notes.add()} />
            <button
              type="button"
              className="rounded-sub border border-line px-2 py-0.5 font-mono text-[11px] text-faint hover:text-ink"
              onClick={() => setPaletteOpen(true)}
            >
              Cmd-K
            </button>
          </div>
        </div>

        <nav
          aria-label="Sections"
          role="tablist"
          className="hq-topbar hidden gap-1 border-b border-line bg-panel px-5 py-1.5 md:flex xl:hidden"
        >
          {TABS.map((tab) => (
            <TabButton key={tab} tab={tab} active={route.tab === tab} badge={badges[tab]} variant="top" />
          ))}
          <span className="flex-1" />
        </nav>

        {error ? (
          <p role="status" className="m-0 border-b border-line bg-bad/10 px-5 py-1.5 text-[12px] text-bad">
            {error}
          </p>
        ) : null}

        <main className="px-5 pt-4 pb-10">
          {route.tab === "now" ? <NowTab state={state} focusRequest={route.requestId} /> : null}
          {route.tab === "terminals" ? (
            <Suspense fallback={null}>
              <TerminalsTab state={state} />
            </Suspense>
          ) : null}
          {route.tab === "board" ? <BoardTab board={state?.board ?? null} /> : null}
          {route.tab === "projects" && !route.projectId ? <ProjectsTab projects={state?.projects ?? []} discovered={state?.discovered ?? null} /> : null}
          {route.tab === "projects" && route.projectId ? (
            <ProjectDetail
              id={route.projectId}
              beadId={route.beadId ?? null}
              flow={route.flow ?? null}
              project={(state?.projects ?? []).find((project) => project.id === route.projectId) ?? null}
            />
          ) : null}
          {route.tab === "stack" ? (
            <StackTab stack={state?.stack ?? null} flow={state?.flow ?? null} understudy={state?.understudy ?? null} />
          ) : null}
          {route.tab === "machines" ? (
            <MachinesTab machine={state?.machine ?? null} collectors={state?.collectors ?? []} services={state?.services ?? null} monitors={state?.monitors ?? null} deploys={state?.deploys ?? null} />
          ) : null}
          {route.tab === "money" ? <MoneyTab usage={state?.usage ?? null} money={state?.money ?? null} /> : null}
          {route.tab === "errors" ? (
            <Suspense fallback={null}>
              <ErrorsTab errors={state?.errors ?? null} />
            </Suspense>
          ) : null}
          {route.tab === "reports" ? (
            <Suspense fallback={null}>
              <ReportsTab summary={state?.reports ?? null} reportId={route.reportId ?? null} />
            </Suspense>
          ) : null}
        </main>
      </div>

      <nav
        aria-label="Sections"
        role="tablist"
        className="hq-scroll fixed inset-x-0 bottom-0 z-30 flex overflow-x-auto border-t border-line bg-panel md:hidden"
      >
        {TABS.map((tab) => (
          <TabButton key={tab} tab={tab} active={route.tab === tab} badge={badges[tab]} variant="bottom" />
        ))}
      </nav>

      {/* Toasts render at the SHELL, not inside a tab. They were mounted only in
          NowTab, so a money-tab failure pushed an error toast into a store that
          nothing displayed: the add looked like it did nothing (2026-08-27). */}
      <ToastHost />
      <CapriCorner waiting={waiting.count} />
      <CommandPalette open={paletteOpen} state={state} onClose={() => setPaletteOpen(false)} />
      <NotesLayer notes={notes.notes} onPatch={notes.patch} onRemove={notes.remove} />
      <Standby state={state} connected={status === "live"} enabled={settings.standby} idleMs={idleMs(settings)} />
      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onChange={updateSettings}
        onPreview={cues.fire}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}

const shortModel = (m: string) => m.replace(/^claude-/, "");

/** Header line (hq-4npjr.7): orchestrator tokens today and this week by model, share of HQ usage, plan week. */
function OrchestratorUsageLine({ u }: { u: OrchestratorUsage }) {
  const share = u.shareOfHq == null ? "-" : `${(u.shareOfHq * 100).toFixed(1)}%`;
  const high = u.shareOfHq != null && u.shareOfHq >= u.threshold;
  const byModel = u.week.models.map((m) => `${shortModel(m.model)} ${fmtCount(m.inputTokens + m.outputTokens)}`).join(", ") || "none";
  const plan = u.planWeeklyPct == null ? "" : `, plan week ${Math.round(u.planWeeklyPct)}%`;
  return (
    <span title={`Orchestrator calls. Today ${fmtCount(u.today.inputTokens + u.today.outputTokens)} tokens, week ${fmtCount(u.week.inputTokens + u.week.outputTokens)} (${byModel}). Share is list-price equivalent over 7 days; alert at ${Math.round(u.threshold * 100)}%.`}>
      orchestrator <b className="font-semibold text-ink">{fmtCount(u.today.inputTokens + u.today.outputTokens)}</b> today, share{" "}
      <b className={high ? "font-semibold text-accent" : "font-semibold text-ink"}>{share}</b>
      {plan}
    </span>
  );
}
