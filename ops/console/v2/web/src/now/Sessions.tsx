// The sessions panel: everything alive, ordered by what wants attention first, plus the
// one control that starts a new interactive session on hqbox.
//
// It is also where questions are answered (the owner, 2026-10-20: the Needs-you panel is
// gone). An agent asks in its own terminal and waits there; its card here carries the
// waiting mark, the question and an answer box. A question with no live asker (filed
// with no session, or its terminal has finished or looks finished) is listed at the foot
// of this card so it stays answerable, an answer that never reached its terminal is
// listed there too, and deferred questions fold away under it.
//
// On the phone the body collapses behind its header, but opens by itself while any
// question waits, because a waiting question is the first thing a small screen must show.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Request, Session } from "@shared/api";
import { api } from "../data/client";
import { Button, ButtonRow, Card, CardBody, CardHead, Chip } from "../ui/primitives";
import { newSession } from "./http";
import { patchRequest, useOpRunner } from "./ops";
import { RequestCard } from "./RequestCard";
import { openAfterLayoutChange, routeRequests } from "./sessionRequests";
import { isLive, knownRigs, sortSessions } from "./sessions";
import { SessionRow } from "./SessionRow";
import { TOUCH_SM } from "./ui";
import { toastInfo } from "./toast";

export function Sessions({
  sessions,
  requests = [],
  focusRequest = null,
  now,
  selected,
  onOpen,
  rigs,
  collapsible = false,
}: {
  sessions: Session[];
  requests?: Request[];
  /** Deep-linked from an ntfy push (/now?req=...): that question's card is outlined. */
  focusRequest?: string | null;
  now: number;
  selected: string[];
  onOpen: (id: string) => void;
  rigs?: string[];
  collapsible?: boolean;
}) {
  const run = useOpRunner();
  const [open, setOpen] = useState(!collapsible);
  const wasCollapsible = useRef(collapsible);
  const [spawning, setSpawning] = useState(false);
  const [rig, setRig] = useState("");
  const [busy, setBusy] = useState(false);

  // The phone layout only learns it is a phone after the first paint (matchMedia runs in
  // an effect), so the panel folds itself away when that flips, and unfolds on the way
  // back to a wide screen.
  const routed = useMemo(() => routeRequests(requests, sessions), [requests, sessions]);
  const questions = requests.filter((request) => request.state === "open").length;

  useEffect(() => {
    if (collapsible === wasCollapsible.current) return;
    wasCollapsible.current = collapsible;
    setOpen(openAfterLayoutChange(collapsible, questions));
    // questions is read, not watched: only the layout flip decides here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsible]);

  // A question arriving on the phone unfolds the panel once; folding it again sticks.
  const hadQuestions = useRef(false);
  useEffect(() => {
    if (collapsible && questions > 0 && !hadQuestions.current) setOpen(true);
    hadQuestions.current = questions > 0;
  }, [collapsible, questions]);

  const live = sortSessions(sessions.filter(isLive));
  const snoozed = sortSessions(sessions.filter((session) => session.state === "snoozed"));
  const waiting = live.filter((session) => session.state === "waiting").length;
  const options = rigs && rigs.length > 0 ? rigs : knownRigs(sessions.map((session) => session.rig));

  async function startTerminal(): Promise<void> {
    setBusy(true);
    try {
      const result = await run("new terminal", () => newSession(rig || null));
      if (result.ok) {
        setSpawning(false);
        toastInfo(rig ? `interactive session starting in ${rig}` : "interactive session starting");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHead
        title="Sessions"
        chip={
          <Chip tone={waiting > 0 || routed.orphans.length > 0 ? "warn" : "mute"}>
            {live.length} live{waiting > 0 ? `, ${waiting} waiting on you` : ""}
            {routed.orphans.length > 0 ? `, ${routed.orphans.length} with no terminal` : ""}
          </Chip>
        }
        actions={
          <ButtonRow>
            <Button size="sm" className={TOUCH_SM} onClick={() => setSpawning((value) => !value)}>
              New terminal
            </Button>
            {collapsible ? (
              <Button size="sm" className={TOUCH_SM} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
                {open ? "hide" : "show"}
              </Button>
            ) : null}
          </ButtonRow>
        }
      />
      {open ? (
        <CardBody>
          {spawning ? (
            <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-sub border border-line bg-panel2/50 px-2 py-2">
              <label className="text-[12px] text-mute" htmlFor="new-terminal-rig">
                project
              </label>
              <select
                id="new-terminal-rig"
                className="rounded-sub border border-line bg-panel px-1.5 py-1 text-[12px] text-ink"
                value={rig}
                onChange={(event) => setRig(event.target.value)}
              >
                <option value="">hq (no rig)</option>
                {options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void startTerminal()}>
                Start
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSpawning(false)}>
                cancel
              </Button>
              <span className="text-[11px] text-faint">
                interactive, writable, spawned by the runner as owner
              </span>
            </div>
          ) : null}

          {live.length === 0 ? (
            <p className="m-0 text-[13px] text-mute">No live sessions. Dispatch ready work to start one.</p>
          ) : (
            live.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                questions={routed.bySession.get(session.id) ?? []}
                delivering={routed.delivering.get(session.id) ?? []}
                focusRequest={focusRequest}
                now={now}
                selected={selected.includes(session.id)}
                onOpen={onOpen}
              />
            ))
          )}

          {snoozed.length > 0 ? (
            <div className="mt-2 border-t border-line pt-2">
              <p className="m-0 mb-1 text-[11px] uppercase tracking-[0.05em] text-mute">
                snoozed <span className="text-faint">{snoozed.length}</span>
              </p>
              {snoozed.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  questions={routed.bySession.get(session.id) ?? []}
                  focusRequest={focusRequest}
                  now={now}
                  selected={selected.includes(session.id)}
                  onOpen={onOpen}
                />
              ))}
            </div>
          ) : null}

          {routed.orphans.length > 0 ? (
            <section className="mt-2 border-t border-line pt-2" aria-label="Questions with no terminal">
              <p className="m-0 mb-1 text-[11px] uppercase tracking-[0.05em] text-mute">
                Questions with no terminal <span className="text-faint">{routed.orphans.length}</span>
              </p>
              <p className="m-0 mb-1.5 text-[12px] text-faint">
                Filed with no session, or the terminal that asked has finished. An answer is still recorded on
                the request.
              </p>
              {routed.orphans.map((request) => (
                <RequestCard key={request.id} request={request} now={now} highlight={request.id === focusRequest} />
              ))}
            </section>
          ) : null}

          {routed.undelivered.length > 0 ? (
            // An answer that never reached its terminal, whose terminal is not on this
            // card (ended, looks ended, or none was bound). Nothing retries it, so it
            // stays here until the owner clears it: no answer drops off the board.
            <section className="mt-2 border-t border-line pt-2" aria-label="Answers not yet in a terminal">
              <p className="m-0 mb-1 text-[11px] uppercase tracking-[0.05em] text-mute">
                Answers not yet in a terminal <span className="text-faint">{routed.undelivered.length}</span>
              </p>
              <ul className="m-0 list-none p-0">
                {routed.undelivered.map((request) => (
                  <li
                    key={request.id}
                    className="flex flex-wrap items-center gap-2 border-b border-line py-1.5 text-[12px] text-mute last:border-b-0"
                  >
                    <span className="font-semibold text-p1">answered, not yet in the terminal:</span>
                    <span className="font-mono text-ink">{request.session ?? request.id}</span>
                    <span className="min-w-0 flex-1 truncate text-ink">{request.question}</span>
                    <span className="text-faint">recorded on {request.id}</span>
                    <Button
                      size="sm"
                      className={TOUCH_SM}
                      onClick={() =>
                        void run("clear", async () => {
                          patchRequest(request.id, { state: "cancelled" });
                          return api.reqClear(request.id);
                        })
                      }
                    >
                      Clear
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {routed.snoozed.length > 0 ? (
            <section className="mt-2 border-t border-line pt-2" aria-label="Snoozed questions">
              <p className="m-0 mb-1 text-[11px] uppercase tracking-[0.05em] text-mute">
                snoozed questions <span className="text-faint">{routed.snoozed.length}</span>
              </p>
              <ul className="m-0 list-none p-0">
                {routed.snoozed.map((request) => (
                  <li
                    key={request.id}
                    className="flex flex-wrap items-center gap-2 border-b border-line py-1.5 text-[12px] text-mute last:border-b-0"
                  >
                    <span className="font-mono text-ink">{request.session ?? request.bead ?? request.id}</span>
                    <span className="min-w-0 flex-1 truncate">{request.question}</span>
                    <span>
                      wakes {request.snoozedUntil ? new Date(request.snoozedUntil).toLocaleString() : "unknown"}
                    </span>
                    <Button
                      size="sm"
                      className={TOUCH_SM}
                      onClick={() =>
                        void run("wake", async () => {
                          patchRequest(request.id, { state: "open", snoozedUntil: null });
                          return api.reqUnsnooze(request.id);
                        })
                      }
                    >
                      Wake now
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </CardBody>
      ) : null}
    </Card>
  );
}
