// One session row: state dot, what it is working on, phase progress, and every action the
// CLI has today. Two of them are deliberately two-step:
//
//   Finish  runs the server's finish-check gate FIRST and shows what it said, because
//           finish.sh merges; nothing merges on one click from a phone.
//   Kill    confirms, and says what survives (the worktree and its uncommitted work).

import { useState } from "react";
import type { Request, Session } from "@shared/api";
import { api } from "../data/client";
import { Button, ButtonRow, Chip, CapriWord, RigSigil, cx, ProgressBar } from "../ui/primitives";
import { copyText } from "./clipboard";
import { adviseOn, barWidths, biggestChurn, diffSummary, finishBody, mayConfirmFinish, mayFinish, readGate, reviewCommand, type Diffstat, type FinishApproval } from "./handoff";
import { fmtAge } from "../ui/format";
import { patchRequest, patchSession, useOpRunner } from "./ops";
import { phaseProgress, sessionLabel, STATE_DOT, STATE_TEXT } from "./sessions";
import { customSnoozeIso, defaultCustomInput, snoozePresets } from "./snooze";
import { TOUCH_SM } from "./ui";
import { ATTENTION_TEXT, cueOf, needsYou, useAttention } from "./attention";
import { FlowLink } from "./FlowLink";
import { RequestCard } from "./RequestCard";
import { cardMayClear } from "./sessionRequests";

type Panel = null | "snooze" | "rename" | "finish";

export function SessionRow({
  session,
  questions = [],
  delivering = [],
  focusRequest = null,
  now,
  selected,
  onOpen,
}: {
  session: Session;
  /** Open questions this session asked (ctl ask): the waiting mark and the answer box. */
  questions?: Request[];
  /** Answered questions whose answer has not reached this terminal yet. */
  delivering?: Request[];
  focusRequest?: string | null;
  now: number;
  selected: boolean;
  onOpen: (id: string) => void;
}) {
  const { attention } = useAttention(session);
  const wants = needsYou(attention);
  const finished = cueOf(session) === "finished";
  const dot = finished
    ? "bg-bad"
    : attention
    ? wants
      ? "bg-p1 hq-attn-ping"
      : attention === "working"
        ? "bg-ok"
        : "border border-mute bg-transparent"
    : STATE_DOT[session.state];
  const run = useOpRunner();
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [name, setName] = useState(session.name ?? "");
  const [custom, setCustom] = useState("");
  const [gate, setGate] = useState<string | null>(null);
  const [stat, setStat] = useState<Diffstat | null>(null);
  // The approval minted by the finish-check we are currently showing. Finish is only
  // offered while we hold one, so a click always answers the reading on screen rather
  // than whatever the branch happens to look like by the time it arrives.
  const [approval, setApproval] = useState<FinishApproval | null>(null);
  const reading = readGate(gate);
  const advice = adviseOn(reading);
  const reviewCmd = reviewCommand(session.rig, stat?.base ?? "main", `${session.bead ?? session.id}: ${session.task ?? "the change on this branch"}`);
  const { done, total, current, ratio } = phaseProgress(session);

  async function act(label: string, fn: () => Promise<unknown>, optimistic?: () => void): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    optimistic?.();
    try {
      const result = await run(label, fn);
      return result.ok;
    } finally {
      setBusy(false);
    }
  }

  async function checkFinish(): Promise<void> {
    setPanel("finish");
    setGate("checking...");
    setStat(null);
    // Drop the old approval before asking again: for the moment between the two
    // readings there is nothing on screen that a confirmation could honestly answer.
    setApproval(null);
    setBusy(true);
    // the diffstat is a separate, optional read: a branch the console cannot stat is
    // still a decision it can show the gate for
    api
      .diffstat(session.id)
      .then(setStat)
      .catch(() => setStat(null));
    try {
      const result = await run("finish check", () => api.session(session.id, "finish-check"));
      const output = result.op?.output?.trim() ?? result.error ?? "";
      setGate(output || (result.ok ? "gate passed, nothing to report" : "gate check failed"));
      const seal = result.op?.seal;
      setApproval(seal && result.op ? { seal, op: result.op.id, issuedAt: Date.now() } : null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={cx(
        "grid grid-cols-[auto_1fr] items-start gap-2.5 border-b border-line py-2 last:border-b-0 lg:grid-cols-[auto_1fr_auto]",
        selected && "bg-panel2/60",
        wants && !selected && "bg-p1/10",
        finished && "shadow-[inset_2px_0_0_0_var(--bad)]",
      )}
      data-attention={attention ?? undefined}
      data-finished={finished || undefined}
    >
      <span className={cx("mt-1.5 h-2.5 w-2.5 rounded-full", dot)} aria-hidden="true" />

      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-2">
          <b className="font-mono">{session.id}</b>
          {session.rig ? (
            <span className="inline-flex items-center gap-1.5">
              <RigSigil id={session.rig} />
              <Chip>{session.rig}</Chip>
            </span>
          ) : (
            <Chip tone="mute">no rig</Chip>
          )}
          {session.bead ? <Chip tone="mute">{session.bead}</Chip> : null}
          {session.model ? <Chip tone="mute">{session.model}</Chip> : null}
          {session.kind === "meta" ? (
            <Chip tone="bad">
              <CapriWord tone="quiet" />, live
            </Chip>
          ) : null}
          {session.writable ? <Chip tone="warn">input on</Chip> : <Chip tone="mute">output only</Chip>}
        </div>

        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-mute">
          <span>
            <span className={finished ? "font-semibold text-bad" : wants ? "font-semibold text-p1" : attention === "working" ? "text-ok" : undefined}>
              {finished ? "finished" : attention ? ATTENTION_TEXT[attention] : STATE_TEXT[session.state]}
            </span>{" "}
            {fmtAge(session.lastActivityAt ?? session.startedAt, now)}
          </span>
          {total > 0 ? (
            <span className="flex items-center gap-1.5">
              phase {done}/{total}
              {current ? <span className="text-ink">{current}</span> : null}
              <ProgressBar value={ratio} />
            </span>
          ) : null}
          {session.state === "snoozed" && session.wakeAt ? (
            <span>wakes {new Date(session.wakeAt).toLocaleString()}</span>
          ) : null}
        </div>

        {panel === "rename" ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <label className="sr-only" htmlFor={`sess-${session.id}-name`}>
              Name for {session.id}
            </label>
            <input
              id={`sess-${session.id}-name`}
              className="rounded-sub border border-line bg-panel px-2 py-1 text-[12px] text-ink"
              value={name}
              placeholder="short label"
              autoFocus
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setPanel(null);
                if (event.key !== "Enter") return;
                const value = name.trim();
                if (!value) return;
                void act("rename", () => api.session(session.id, "name", { name: value }), () =>
                  patchSession(session.id, { name: value }),
                ).then((ok) => {
                  if (ok) setPanel(null);
                });
              }}
            />
            <Button
              size="sm"
              variant="primary"
              disabled={busy || name.trim().length === 0}
              onClick={() =>
                void act("rename", () => api.session(session.id, "name", { name: name.trim() }), () =>
                  patchSession(session.id, { name: name.trim() }),
                ).then((ok) => {
                  if (ok) setPanel(null);
                })
              }
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPanel(null)}>
              cancel
            </Button>
          </div>
        ) : (
          <button
            type="button"
            className="mt-0.5 cursor-pointer border-0 bg-transparent p-0 text-left text-[12px] text-faint hover:text-ink"
            onClick={() => {
              setName(session.name ?? "");
              setPanel("rename");
            }}
            title="Rename this session"
          >
            {session.name ? `"${session.name}"` : `name: ${sessionLabel(session)}`}
          </button>
        )}

        {questions.length > 0 ? (
          // The terminal asked and is waiting in its own pane. The card shows the question
          // and takes the answer; ctl answer types it into a live pane, or the worker's
          // poll (ask --wait) or revival picks it up.
          <div className="mt-1.5" aria-label={`Questions waiting from ${session.id}`}>
            <p className="m-0 mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-p1">
              <span className="h-2 w-2 rounded-full bg-p1 hq-attn-ping" aria-hidden="true" />
              waiting on you{questions.length > 1 ? ` (${questions.length})` : ""}
            </p>
            {questions.map((request) => (
              <RequestCard key={request.id} request={request} now={now} highlight={request.id === focusRequest} />
            ))}
          </div>
        ) : null}

        {delivering.length > 0 ? (
          // A card answer that could not be typed into this terminal. It is never
          // retried (a retry could type it twice), so it stays visible here rather
          // than looking delivered; the answer is recorded on the request.
          <div className="mt-1.5" aria-label={`Answers not yet delivered to ${session.id}`}>
            {delivering.map((request) => (
              <p key={request.id} className="m-0 mb-1 text-[12px] text-mute">
                <span className="font-semibold text-p1">answered, not yet in the terminal:</span>{" "}
                <span className="text-ink">{request.question}</span>
                {cardMayClear(session) ? (
                  <span className="text-faint"> (the answer is recorded on {request.id}; tell the terminal yourself)</span>
                ) : (
                  <span className="text-faint"> (the answer is recorded on {request.id}; the worker takes it on its next poll)</span>
                )}{" "}
                {cardMayClear(session) ? (
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
                ) : null}
              </p>
            ))}
          </div>
        ) : null}

        {panel === "snooze" ? (
          <div className="mt-1.5 rounded-sub border border-line bg-panel2/50 px-2 py-2">
            <ButtonRow>
              <span className="text-[12px] text-mute">wake</span>
              {snoozePresets(new Date(now)).map((preset) => (
                <Button
                  key={preset.id}
                  size="sm"
                  className={TOUCH_SM}
                  disabled={busy}
                  onClick={() =>
                    void act("snooze", () => api.session(session.id, "snooze", { until: preset.iso }), () =>
                      patchSession(session.id, { state: "snoozed", wakeAt: preset.iso }),
                    ).then((ok) => {
                      if (ok) setPanel(null);
                    })
                  }
                >
                  {preset.label}
                </Button>
              ))}
              <input
                type="datetime-local"
                aria-label={`Custom wake time for ${session.id}`}
                className="rounded-sub border border-line bg-panel px-2 py-1 text-[12px] text-ink"
                value={custom || defaultCustomInput(new Date(now))}
                onChange={(event) => setCustom(event.target.value)}
              />
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  const iso = customSnoozeIso(custom || defaultCustomInput(new Date(now)));
                  if (!iso) return;
                  void act("snooze", () => api.session(session.id, "snooze", { until: iso }), () =>
                    patchSession(session.id, { state: "snoozed", wakeAt: iso }),
                  ).then((ok) => {
                    if (ok) setPanel(null);
                  });
                }}
              >
                Set
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPanel(null)}>
                cancel
              </Button>
            </ButtonRow>
          </div>
        ) : null}

        {panel === "finish" ? (
          <div className="mt-1.5 rounded-sub border border-accent bg-panel2/50 px-2 py-2">
            <p className="m-0 mb-1 text-[11px] uppercase tracking-[0.05em] text-mute">the handoff</p>

            {session.branch ? (
              <p className="m-0 mb-1.5 font-mono text-[11px] text-mute">
                branch {session.branch}
                {stat ? ` , base ${stat.base}` : ""}
              </p>
            ) : null}

            {stat ? (
              <div className="mb-1.5">
                <p className="m-0 text-[12px] text-ink">{diffSummary(stat)}</p>
                <div className="mt-1 flex flex-col gap-0.5">
                  {stat.files.slice(0, 6).map((file) => {
                    const w = barWidths(file, biggestChurn(stat.files));
                    return (
                      <div key={file.path} className="flex items-center gap-2 text-[11px]">
                        <span className="min-w-0 flex-1 truncate font-mono text-mute" title={file.path}>
                          {file.path}
                        </span>
                        <span className="w-16 shrink-0 text-right tabular-nums text-faint">
                          {file.added === null ? "bin" : `+${file.added}`} {file.removed === null ? "" : `-${file.removed}`}
                        </span>
                        <span className="flex w-24 shrink-0 gap-px" aria-hidden="true">
                          <span className="h-1.5 bg-ok" style={{ width: w.add }} />
                          <span className="h-1.5 bg-bad" style={{ width: w.del }} />
                        </span>
                      </div>
                    );
                  })}
                  {stat.files.length > 6 ? (
                    <span className="text-[11px] text-faint">and {stat.files.length - 6} more</span>
                  ) : null}
                </div>
              </div>
            ) : null}

            <p
              className={cx(
                "m-0 mb-1.5 rounded-sub px-2 py-1.5 text-[12px]",
                reading.verdict === "pass" ? "bg-ok/10 text-ok" : reading.verdict === "block" ? "bg-p0/10 text-p0" : "bg-chip text-mute",
              )}
            >
              {reading.line}
            </p>

            {/* A refusal used to name a condition without naming the thing that
                satisfies it, so Finish locked and there was no way to tell
                whether a path forward existed. The gate is unchanged; it just
                says what would open it now. */}
            {advice ? (
              <div className="mb-2 rounded-sub border border-line bg-panel2/50 px-2.5 py-2">
                <p className="m-0 text-[12px] text-ink">{advice.says}</p>
                <p className="m-0 mt-1 text-[12px] text-mute">
                  <span className="text-mute">Next: </span>
                  {advice.next}
                </p>
              </div>
            ) : null}

            <p className="m-0 mb-1 text-[11px] uppercase tracking-[0.05em] text-mute">hand yourself the review</p>
            <div className="mb-1.5 flex items-start gap-1.5">
              <code className="hq-scroll min-w-0 flex-1 overflow-x-auto rounded-sub bg-code px-2 py-1.5 font-mono text-[11px] text-mute">
                {reviewCmd}
              </code>
              <Button
                size="sm"
                className={TOUCH_SM}
                onClick={() => {
                  void copyText(reviewCmd);
                }}
              >
                Copy
              </Button>
            </div>

            <p className="m-0 mb-1 text-[11px] uppercase tracking-[0.05em] text-mute">gate output</p>
            <pre className="hq-scroll m-0 max-h-40 overflow-auto whitespace-pre-wrap rounded-sub bg-code px-2 py-1.5 font-mono text-[11px] text-ink">
              {gate ?? ""}
            </pre>
            <ButtonRow className="mt-1.5">
              <Button
                variant="primary"
                size="sm"
                className={TOUCH_SM}
                disabled={busy || !mayConfirmFinish(reading, approval)}
                title={
                  !approval
                    ? "read the gate first: finish answers a specific check"
                    : mayFinish(reading)
                      ? "merge, remove the worktree, close the bead"
                      : advice
                        ? advice.next
                        : "the gate has not passed"
                }
                onClick={() => {
                  if (!approval) return;
                  const held = approval;
                  void act("finish", () => api.session(session.id, "finish", finishBody(held))).then((ok) => {
                    if (ok) {
                      setApproval(null);
                      setPanel(null);
                      return;
                    }
                    // The server refuses a stale or spent approval. Re-read rather than
                    // leaving a button that will keep failing: the operator needs to see
                    // what changed, and a fresh reading is the only thing that can be
                    // approved next.
                    void checkFinish();
                  });
                }}
              >
                Finish now
              </Button>
              <Button size="sm" variant="ghost" onClick={() => {
                  setApproval(null);
                  setPanel(null);
                }}>
                cancel
              </Button>
            </ButtonRow>
          </div>
        ) : null}
      </div>

      <ButtonRow className="col-span-2 lg:col-span-1 lg:justify-end">
        <FlowLink rig={session.rig} bead={session.bead} className={TOUCH_SM} />
        <Button
          size="sm"
          className={TOUCH_SM}
          disabled={!session.attachable}
          title={session.attachable ? "Open the terminal" : "No terminal for this session"}
          onClick={() => onOpen(session.id)}
        >
          Open
        </Button>
        {session.focusable ? (
          <Button
          size="sm"
          className={TOUCH_SM}
          disabled={busy}
          title="Select this pane on hqbox. Useful at the machine; from a browser it moves something you are not looking at."
          onClick={() => void act("focus", () => api.session(session.id, "focus"))}
        >
          Focus
        </Button>
        ) : null}
        {session.state === "finishable" || session.state === "idle" ? (
          <Button
            size="sm"
            variant="primary"
            className={TOUCH_SM}
            disabled={busy}
            onClick={() => void checkFinish()}
          >
            Finish
          </Button>
        ) : null}
        {session.state === "snoozed" && session.runner === "pty" && session.kind === "interactive" ? (
          <Button
            size="sm"
            className={TOUCH_SM}
            disabled={busy}
            onClick={() =>
              void act("wake", () => api.session(session.id, "wake"), () => patchSession(session.id, { state: "running", wakeAt: null }))
            }
          >
            Wake
          </Button>
        ) : (
          <Button
            size="sm"
            className={TOUCH_SM}
            disabled={busy}
            onClick={() => setPanel(panel === "snooze" ? null : "snooze")}
          >
            Snooze
          </Button>
        )}
        <Button
          size="sm"
          variant="danger"
          className={TOUCH_SM}
          disabled={busy}
          onClick={() => {
            if (!window.confirm(`Kill ${session.id}? Uncommitted work in its worktree stays on disk.`)) return;
            void act("kill", () => api.session(session.id, "kill"), () =>
              patchSession(session.id, { state: "closed" }),
            );
          }}
        >
          Kill
        </Button>
      </ButtonRow>
    </div>
  );
}
