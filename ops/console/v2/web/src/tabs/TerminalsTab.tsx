// Every open terminal, on one page.
//
// the owner: "if I have a page similar to just team looks where I can see all of
// them, where I can just have all of the terminals I have open and be shown
// there... that would be pretty awesome."
//
// The split with the Now tab is deliberate and worth keeping: Now is where you
// CONTROL sessions (dispatch, answer, finish, kill) and shows a terminal or two
// as context. This page is where you WATCH them, so the whole width is theirs and
// the panes are as large as the count allows.
//
// It deliberately owns no session state of its own. Which panes are open is the
// same remembered list the Now tab uses, so opening a terminal in one place and
// switching to the other shows the same thing rather than two disagreeing views.
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { importOrReload } from "../app/lazyChunk";
import type { ConsoleState, Session } from "@shared/api";
import { Button, ButtonRow, Card, CardBody, Chip, PageHeader, RigSigil, cx } from "../ui/primitives";
import { readOpenPanes, restorable, saveOpenPanes } from "../now/openPanes";
import { useAttentionOrder } from "../now/attention";
import { WorkStrip } from "../now/WorkStrip";

const TerminalPane = lazy(importOrReload(async () => ({ default: (await import("../now/Terminal")).TerminalPane })));

const FALLBACK = (
  <div className="rounded-card border border-line bg-panel px-3.5 py-6 text-center text-[12px] text-mute">
    loading the terminal
  </div>
);

/** How many columns for a given pane count. One big pane beats four cramped ones. */
export function columnsFor(count: number, wide: boolean): number {
  if (count <= 1) return 1;
  if (!wide) return 1;
  if (count === 2) return 2;
  if (count <= 4) return 2;
  return 3;
}

export function TerminalsTab({ state }: { state: ConsoleState | null }) {
  const sessions = useMemo(() => state?.sessions ?? [], [state?.sessions]);
  const attachable = useMemo(() => sessions.filter((s) => s.attachable !== false && s.state !== "closed" && s.state !== "snoozed"), [sessions]);
  const [open, setOpen] = useState<string[]>(() => readOpenPanes());
  // The question each waiting terminal asked, for its chip's tooltip.
  const asked = useMemo(() => {
    const map = new Map<string, string>();
    for (const request of state?.requests ?? []) {
      if (request.state !== "open" || !request.session) continue;
      map.set(request.session, map.has(request.session) ? `${map.get(request.session)} / ${request.question}` : request.question);
    }
    return map;
  }, [state?.requests]);
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1100);

  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 1100);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Follow the same rule the Now tab does: a remembered pane whose session has
  // gone is dropped rather than shown as a terminal that cannot attach.
  const liveIds = useMemo(() => attachable.map((s) => s.id), [attachable]);
  const shown = useMemo(() => restorable(open, liveIds), [open, liveIds]);
  const panes = useMemo(
    () => shown.map((id) => attachable.find((s) => s.id === id)).filter((s): s is Session => Boolean(s)),
    [shown, attachable],
  );
  const { ordered, ...holdOrder } = useAttentionOrder(panes);

  function toggle(id: string): void {
    setOpen((current) => {
      const next = current.includes(id) ? current.filter((x) => x !== id) : [id, ...current].slice(0, 8);
      saveOpenPanes(next);
      return next;
    });
  }

  function openAll(): void {
    const next = liveIds.slice(0, 8);
    setOpen(next);
    saveOpenPanes(next);
  }

  function closeAll(): void {
    setOpen([]);
    saveOpenPanes([]);
  }

  const columns = columnsFor(panes.length, wide);

  return (
    <>
      <PageHeader
        title="Terminals"
      />

      <WorkStrip state={state} sessions={attachable} />

      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-[11px] uppercase tracking-[0.14em] text-mute">Attachable</span>
          {attachable.length === 0 ? (
            <span className="text-[13px] text-mute">
              No session is attachable right now. Start one from Now, or dispatch ready work.
            </span>
          ) : (
            attachable.map((session) => {
              const on = shown.includes(session.id);
              return (
                <button
                  key={session.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(session.id)}
                  className={cx(
                    "hq-press inline-flex items-center gap-1.5 rounded-sub border px-2 py-1 text-[12px]",
                    on ? "border-accent bg-accent/15 text-accent" : "border-line bg-panel text-mute hover:text-ink",
                  )}
                  title={
                    (on ? `Close ${session.id}` : `Open ${session.id}`) +
                    (asked.get(session.id) ? `. Waiting on you: ${asked.get(session.id)}` : "")
                  }
                >
                  <RigSigil id={session.rig} size={11} />
                  <span className="font-mono">{session.name ?? session.id}</span>
                  {session.state === "waiting" ? <Chip tone="warn">waiting</Chip> : null}
                </button>
              );
            })
          )}
          <ButtonRow className="ml-auto">
            <Button size="sm" onClick={openAll} disabled={attachable.length === 0}>
              Open all
            </Button>
            <Button size="sm" variant="ghost" onClick={closeAll} disabled={panes.length === 0}>
              Close all
            </Button>
          </ButtonRow>
        </CardBody>
      </Card>

      {panes.length === 0 ? (
        <Card>
          <CardBody>
            <p className="m-0 text-[13px] text-mute">
              Nothing open. Pick a session above and it appears here, and on the Now tab, until you close it.
            </p>
          </CardBody>
        </Card>
      ) : (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          {...holdOrder}
        >
          {ordered.map((session) => (
            <div
              key={session.id}
              // Taller than the Now tab's fixed pane: the whole page is theirs
              // here, and a terminal you are watching is worth more rows than one
              // you glance at beside a request card. Fewer panes, more rows each.
              className="flex min-h-64 flex-col"
              style={{ height: panes.length <= 2 ? "62vh" : panes.length <= 4 ? "42vh" : "34vh" }}
            >
              <Suspense fallback={FALLBACK}>
                <TerminalPane session={session} fill manage meta={session.kind === "meta"} onClose={() => toggle(session.id)} />
              </Suspense>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
