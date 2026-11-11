// The working tab: who is working and who waits on you, and the terminals. Signal puts
// the terminal column first in width, because terminals are the main thing in this
// direction (design doc section 11).
//
// There is no Needs-you panel (the owner, 2026-10-20). An agent asks in its own terminal and
// waits there; the question, its waiting mark and the answer box are on that terminal's
// card in Sessions. Questions with no live terminal are listed at the foot of that card.
//
// Two shapes. Desktop and laptop: two columns, files and activity on the left, sessions
// then pinned terminals on the right. Phone (<768): one column with sessions first
// (folded, but open while a question waits), and terminals full screen only, because a
// pinned 12 px xterm in a phone column is not a terminal, it is a decoration.
//
// No Ready work and no Capri panel (the owner, hq-4npjr.17): the orchestrator terminal on
// top is where he talks to the system; the floating CapriCorner stays. Every section
// folds from its head (ui/Fold.tsx), the fold kept per section in this browser.
//
// The whole tab is also a drop target: dropping files anywhere queues them for upload.
//
// Orchestrator (bead hq-4npjr.5, mockup board F): in the unscoped view the page opens
// with the orchestrator's terminal, then For you next to Orchestrator approved, the
// project flow charts, and Snoozed next to Loaded for the orchestrator. The worker
// controls below stay as they were, so nothing is lost while the orchestrator is new.
//
// Workspaces (now/workspace.ts): the strip under the title narrows every rig-keyed card
// to one client and tints the page with its hue. Everything is the unscoped tab. In a
// workspace the cards that belong to no project (the orchestrator, the calendar) step
// aside.

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { importOrReload } from "../app/lazyChunk";
import type { ReactNode } from "react";
import type { CSSProperties } from "react";
import type { ConsoleState, Session } from "@shared/api";
import { Activity } from "../now/Activity";
import { QuickCapture } from "../now/QuickCapture";
import { Artifacts } from "../now/Artifacts";
import { SinceYouLeft, useSeen } from "../now/SinceYouLeft";
import { loadSettings } from "../app/settings";
import { Sessions } from "../now/Sessions";
import { Uploads } from "../now/Uploads";
import { useIsPhone, useNowMs } from "../now/clock";
import { usePopoutSid } from "../now/popout";
import { cueMark, useWorkspaceFavicon, workspaceForRig } from "../now/favicon";
import { cueOf } from "../now/attention";
import { readOpenPanes, saveOpenPanes } from "../now/openPanes";
import { Calendar } from "../now/Calendar";
import { knownRigs, terminalRigs } from "../now/sessions";
import { useUploadQueue } from "../now/uploadQueue";
import { WorkspaceTabs } from "../now/WorkspaceTabs";
import { buildWorkspaces, findWorkspace, readWorkspace, saveWorkspace, scopeTo } from "../now/workspace";
import { Card, CardBody, CardHead, PageHeader } from "../ui/primitives";
import { Fold } from "../ui/Fold";
import { Approved, ForYou, Loaded, OrchestratorStrip, OrchestratorTerminal, ProjectFlows, Snoozed, useOrchestratorReport } from "../now/OrchestratorPanels";
import { visibleRequests } from "../now/orchestrator";

// xterm is the heaviest dependency in the app and only matters once a pane is open, so the
// whole terminal deck loads on demand instead of sitting in the first paint.
const TerminalDeck = lazy(importOrReload(async () => ({ default: (await import("../now/TerminalDeck")).TerminalDeck })));
const TerminalOverlay = lazy(importOrReload(async () => ({ default: (await import("../now/TerminalDeck")).TerminalOverlay })));
const TerminalPage = lazy(importOrReload(async () => ({ default: (await import("../now/TerminalDeck")).TerminalPage })));

const MAX_PANES = 4;

const TERM_FALLBACK = <p className="m-0 text-[13px] text-mute">loading terminal...</p>;

export function NowTab({ state, focusRequest }: { state: ConsoleState | null; focusRequest: string | null }) {
  const now = useNowMs();
  const phone = useIsPhone();
  const popout = usePopoutSid();
  // Remembered across navigation and reload: leaving the tab used to unmount this
  // and the terminal was gone when you came back, which reads as the session
  // having died while it was in fact still running on the box.
  const [selected, setSelected] = useState<string[]>(() => readOpenPanes());
  const restored = useRef(false);
  const seen = useSeen();
  const [paneLimit, setPaneLimit] = useState(2);
  const [dragging, setDragging] = useState(false);
  const queue = useUploadQueue();
  const orch = useOrchestratorReport();

  // `all*` is the box; the unprefixed names are what the current workspace shows.
  const allSessions = state?.sessions ?? [];
  const allReady = state?.ready ?? [];
  const [workspaceId, setWorkspaceId] = useState<string>(() => readWorkspace());
  const workspaces = useMemo(
    () =>
      buildWorkspaces(state?.projects ?? [], [
        ...allSessions.map((session) => session.rig),
        ...allReady.map((bead) => bead.rig),
      ]),
    [state?.projects, allSessions, allReady],
  );
  const workspace = findWorkspace(workspaces, workspaceId);
  // A popped-out terminal tab wears its rig's workspace colour in the tab strip. Called
  // before the pop-out early return so hook order is stable; null on the console itself.
  const popped = popout ? (allSessions.find((entry) => entry.id === popout) ?? null) : null;
  useWorkspaceFavicon(workspaceForRig(workspaces, popped?.rig ?? null)?.hue ?? null, popped ? cueMark(cueOf(popped)) : null, popped != null);
  const everything = useMemo(
    // An ask the orchestrator is answering is not the owner's yet (hq-4npjr.5), so it is
    // left out everywhere on this page; it comes back if the orchestrator does not act.
    () => ({ sessions: allSessions, requests: visibleRequests(state?.requests ?? [], allSessions, now), ready: allReady, activity: state?.activity ?? [] }),
    [allSessions, state?.requests, allReady, state?.activity, now],
  );
  const scoped = useMemo(() => scopeTo(workspace, everything), [workspace, everything]);
  const sessions = scoped.sessions;
  const ready = scoped.ready;
  function pickWorkspace(id: string): void {
    setWorkspaceId(id);
    saveWorkspace(id);
  }

  const rigs = useMemo(
    () =>
      workspace
        ? workspace.rigs
        : knownRigs(
            (state?.projects ?? []).map((project) => project.id),
            ready.map((bead) => bead.rig),
            sessions.map((session) => session.rig),
          ),
    [workspace, state?.projects, ready, sessions],
  );

  // Stricter list for the new-terminal picker: only projects that can actually
  // host a terminal on this box (see terminalRigs for the why).
  const spawnableRigs = useMemo(
    () =>
      terminalRigs(
        state?.projects ?? [],
        ready.map((bead) => bead.rig),
        sessions.map((session) => session.rig),
      ).filter((rig) => !workspace || workspace.rigs.includes(rig)),
    [workspace, state?.projects, ready, sessions],
  );

  // Drop panes whose session went away. On the phone nothing is pinned: a terminal is
  // opened deliberately and covers the screen while it is open.
  useEffect(() => {
    setSelected((current) => {
      const live = current.filter((id) => allSessions.some((session) => session.id === id));
      return live.length === current.length ? current : live;
    });
  }, [allSessions]);

  // Persist the selection, but only once the session list has arrived. Writing
  // before then would save the empty list the pruning effect produces while the
  // sessions are still loading, and quietly forget every pane on every reload.
  useEffect(() => {
    if (allSessions.length === 0 && !restored.current) return;
    restored.current = true;
    saveOpenPanes(selected);
  }, [selected, allSessions.length]);

  useEffect(() => {
    if (!focusRequest) return;
    const node = document.getElementById(`req-${focusRequest}`);
    node?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [focusRequest]);

  const panes = useMemo(
    () =>
      selected
        .map((id) => sessions.find((session) => session.id === id))
        .filter((session): session is Session => Boolean(session))
        .slice(0, phone ? 1 : paneLimit),
    [selected, paneLimit, sessions, phone],
  );

  function openTerminal(id: string): void {
    setSelected((current) => (current.includes(id) ? current : [id, ...current].slice(0, MAX_PANES)));
  }
  function closeTerminal(id: string): void {
    setSelected((current) => current.filter((entry) => entry !== id));
  }

  // ---------- pop-out route: /term/<sid>, one terminal, nothing else ----------
  if (popout) {
    const session = allSessions.find((entry) => entry.id === popout) ?? null;
    // Until the first state snapshot arrives the registry is unknown, not empty, so the
    // page says it is loading. "Not found" only once state is in and the id is absent.
    const loading = state === null;
    return (
      <>
        <PageHeader
          title={session ? `Terminal ${session.name ?? session.id}` : "Terminal"}
          sub={session || loading ? undefined : "That session is not in the registry (it may have finished)."}
        />
        {/* A popped-out terminal is a whole tab with nothing else in it, so it
            needs its own way home. Without this the only route back to the
            console is the browser's back button or retyping the address. */}
        <p className="-mt-2 mb-3 text-[12px]">
          <a href="/" className="text-mute no-underline hover:text-ink">
            Back to the console
          </a>
          {session ? <span className="ml-2 text-faint">{session.rig ?? "no rig"}</span> : null}
        </p>
        {session ? (
          <Suspense fallback={TERM_FALLBACK}>
            <TerminalPage session={session} />
          </Suspense>
        ) : loading ? (
          <p className="m-0 text-[13px] text-mute" data-testid="popout-loading">
            loading session...
          </p>
        ) : (
          <Card>
            <CardBody>
              <p className="m-0 text-[13px] text-mute">
                No live session with id <span className="font-mono text-ink">{popout}</span>.
              </p>
            </CardBody>
          </Card>
        )}
      </>
    );
  }

  const awayRibbon = loadSettings().awayRibbon ? (
    <SinceYouLeft state={state && workspace ? { ...state, ...scoped } : state} now={now} since={seen.at} onMarkSeen={seen.mark} />
  ) : null;
  // Every section folds (hq-4npjr.17): click its title, the state is kept per id.
  const fold = (id: string, panel: ReactNode): ReactNode => (panel ? <Fold id={`now.${id}`}>{panel}</Fold> : null);
  // The Commands card is retired (proposal 58): agents run those steps themselves.
  // On the phone Sessions keeps its own hide/show (it opens while a question waits).
  const sessionsPanelRaw = (
    <Sessions
      sessions={sessions}
      requests={scoped.requests}
      focusRequest={focusRequest}
      now={now}
      selected={selected}
      onOpen={openTerminal}
      rigs={spawnableRigs}
      collapsible={phone}
    />
  );
  const sessionsPanel = phone ? sessionsPanelRaw : fold("sessions", sessionsPanelRaw);
  // Ready work and the Capri panel are gone from Now (the owner, hq-4npjr.17): he never
  // used Ready work, and the orchestrator terminal on top replaces the Capri panel.
  // The floating CapriCorner stays.
  const capturePanel = rigs.length > 0 ? fold("capture", <QuickCapture key={workspace?.id ?? "all"} rigs={rigs} />) : null;
  const uploadsPanel = fold("uploads", <Uploads queue={queue} />);
  const artifactsPanel = fold("artifacts", <Artifacts rigs={workspace?.rigs ?? null} now={now} />);
  const activityPanel = fold("activity", <Activity events={scoped.activity} now={now} since={seen.at} />);
  // High in the left column, because an invitation nobody answered is the same
  // kind of thing as a worker waiting on you: something addressed to you that
  // will keep sitting there until you look at it.
  const calendarPanel = workspace ? null : fold("calendar", <Calendar report={state?.calendar ?? null} />);
  // Board F: only in the unscoped view, since the orchestrator works across every project.
  const orchestratorBoard = workspace ? null : (
    <div className="mb-6 flex flex-col gap-4" data-testid="orchestrator-board">
      <OrchestratorStrip state={state} report={orch.report} now={now} />
      {phone ? null : fold("orchestrator", <OrchestratorTerminal sessions={allSessions} />)}
      <div className="grid items-start gap-4 xl:grid-cols-2">
        {fold("foryou", <ForYou requests={state?.requests ?? []} sessions={allSessions} alerts={state?.alerts ?? []} now={now} />)}
        {fold("approved", <Approved report={orch.report} />)}
      </div>
      {fold("flows", <ProjectFlows state={state} report={orch.report} />)}
      <div className="grid items-start gap-4 xl:grid-cols-2">
        {fold("snoozed", <Snoozed sessions={allSessions} />)}
        {fold("loaded", <Loaded report={orch.report} reload={orch.reload} />)}
      </div>
      <h2 className="m-0 mt-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-mute">Workers</h2>
    </div>
  );
  // The tint: the workspace hue becomes the accent, and the hairlines take a little of
  // it. Two nested elements because a custom property cannot be mixed from itself.
  const hue = workspace ? `var(--sigil-${workspace.hue})` : null;
  const tintOuter = hue ? ({ "--ws-line": "var(--line)" } as CSSProperties) : undefined;
  const tintInner = hue
    ? ({ "--accent": hue, "--accent2": hue, "--line": `color-mix(in srgb, ${hue} 22%, var(--ws-line))` } as CSSProperties)
    : undefined;

  return (
    <div style={tintOuter}>
    <div
      style={tintInner}
      onDragOver={(event) => {
        if (!event.dataTransfer?.types?.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return;
        event.preventDefault();
        setDragging(false);
        queue.add([...files]);
      }}
    >
      <PageHeader title={workspace ? `Now, ${workspace.label}` : "Now"} />
      <WorkspaceTabs workspaces={workspaces} current={workspace} all={everything} onPick={pickWorkspace} />

      {dragging ? (
        <div
          className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-bg/70"
          aria-hidden="true"
        >
          <p className="rounded-card border-2 border-dashed border-accent bg-panel px-6 py-4 text-[14px] text-ink">
            Drop to upload into the hqbox inbox
          </p>
        </div>
      ) : null}

      {orchestratorBoard}

      {phone ? (
        <div className="flex flex-col gap-4">
          {awayRibbon}
          {sessionsPanel}
          {calendarPanel}
          {capturePanel}
          {uploadsPanel}
          {artifactsPanel}
          {activityPanel}
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            {awayRibbon}
            {calendarPanel}
            {workspace ? null : capturePanel}
            {uploadsPanel}
            {artifactsPanel}
            {activityPanel}
            {workspace ? capturePanel : null}
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            {sessionsPanel}
            {panes.length === 0 ? (
              // Nothing is attached yet, so xterm is not loaded at all: the empty deck is
              // plain markup and the lazy chunk only arrives with the first Open.
              fold(
                "terminals",
                <Card>
                  <CardHead title="Terminals" />
                  <CardBody>
                    <p className="m-0 text-[13px] text-mute">No terminal open.</p>
                  </CardBody>
                </Card>,
              )
            ) : (
              <Suspense
                fallback={
                  <Card>
                    <CardBody>{TERM_FALLBACK}</CardBody>
                  </Card>
                }
              >
                <Fold id="now.terminals">
                  <TerminalDeck panes={panes} paneLimit={paneLimit} onPaneLimit={setPaneLimit} onClose={closeTerminal} />
                </Fold>
              </Suspense>
            )}
          </div>
        </div>
      )}

      {phone && panes.length > 0 ? (
        <Suspense fallback={null}>
          <TerminalOverlay session={panes[0]!} onClose={closeTerminal} />
        </Suspense>
      ) : null}

    </div>
    </div>
  );
}
