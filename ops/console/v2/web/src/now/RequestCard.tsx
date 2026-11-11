// One Needs-you card: severity stripe, who asks, a live age, the question, the copyable
// command for "run this for me", and the actions that close the loop with the waiting
// worker. Which actions exist depends on the kind (design doc section 5):
//
//   run                 Done, Skip, Answer, Snooze, Sink
//   decide/info/login   Answer, Skip, Snooze, Sink
//   autofix             Approve, Open diff, Reject
//   keep-or-revert      Keep, Revert, plus the decide set
//
// Every action is optimistic: the card moves the instant it is pressed, the op is polled,
// and a failure both restores the card (state refresh) and raises a toast.

import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import type { Request } from "@shared/api";
import { api } from "../data/client";
import { Button, ButtonRow, Chip, cx, inputClass } from "../ui/primitives";
import { fmtDuration } from "../ui/format";
import { projectPath } from "../app/routes";
import { copyText } from "./clipboard";
import { pastedImages } from "./clipboardImages";
import { fadeOpacity, liveAgeSeconds, safeLink } from "./lanes";
import { optimisticSettle, patchRequest, useOpRunner } from "./ops";
import { uploadPastedImage } from "./pasteUpload";
import { customSnoozeIso, defaultCustomInput, snoozePresets } from "./snooze";
import { confirmAssumption, truthsCard } from "./truthsCards";
import { FlowLink } from "./FlowLink";
import { SEVERITY_STRIPE, TOUCH } from "./ui";

const KIND_LABEL: Record<Request["kind"], string> = {
  run: "run this",
  decide: "decide",
  login: "login",
  info: "info",
  autofix: "auto-fixed, review",
  "keep-or-revert": "keep or revert",
};

const KIND_TONE: Record<Request["kind"], "warn" | "default" | "accent"> = {
  run: "warn",
  decide: "default",
  login: "warn",
  info: "default",
  autofix: "accent",
  "keep-or-revert": "accent",
};

type Mode = null | "answer" | "skip" | "snooze";

export interface CardSignal {
  seq: number;
  action: "answer" | "done";
  /** The card the keypress was aimed at; a signal is never acted on by any other card. */
  target: string;
}

export interface RequestCardProps {
  request: Request;
  now: number;
  /** Deep-linked from an ntfy push (/now?req=...). */
  highlight?: boolean;
  /** The keyboard cursor is on this card. */
  focused?: boolean;
  /** j/k/a/d commands from the lane list. */
  signal?: CardSignal | null;
  /** Settled card inside its 2-minute fade. */
  fading?: boolean;
  onSelect?: (id: string) => void;
}

export function RequestCard({
  request,
  now,
  highlight,
  focused,
  signal,
  fading,
  onSelect,
}: RequestCardProps) {
  const run = useOpRunner();
  // Unconfirmed-assumption cards are synthetic: no worker waits, so no ctl
  // verbs and no answer box. Confirm and the project's Truths are the actions.
  const truths = truthsCard(request);
  const [mode, setMode] = useState<Mode>(request.kind === "decide" && !truths ? "answer" : null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const [custom, setCustom] = useState("");
  // Screenshots still uploading; Send waits so an answer never goes out without them.
  const [uploading, setUploading] = useState(0);
  const node = useRef<HTMLElement | null>(null);
  const textField = useRef<HTMLTextAreaElement | null>(null);
  const lastSignal = useRef(0);

  const link = safeLink(request.link);
  const settled = request.state !== "open";
  const age = fmtDuration(liveAgeSeconds(request, now));
  const opacity = fading ? fadeOpacity(request, now) : 1;

  // Bring the keyboard cursor, and any deep-linked card, into view.
  useEffect(() => {
    if (!focused && !highlight) return;
    node.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [focused, highlight]);

  async function act(label: string, fn: () => Promise<unknown>, optimistic?: () => void): Promise<void> {
    if (busy) return;
    setBusy(true);
    optimistic?.();
    try {
      const result = await run(label, fn);
      if (result.ok) {
        setText("");
        setMode(null);
      }
    } finally {
      setBusy(false);
    }
  }

  function sendAnswer(value: string): void {
    const trimmed = value.trim();
    if (!trimmed || uploading > 0) return;
    void act("answer", () => api.answer(request.id, trimmed), () =>
      optimisticSettle(request.id, "answered", trimmed),
    );
  }

  // A pasted screenshot uploads to the box and its path lands at the cursor, the same
  // way a terminal pane takes one; the worker reads the image from that path.
  function onPasteImages(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const images = pastedImages([...event.clipboardData.items], event.clipboardData.getData("text/plain"));
    if (images.length === 0) return;
    event.preventDefault();
    const field = event.currentTarget;
    let at = field.selectionStart;
    let end = field.selectionEnd;
    setUploading((n) => n + images.length);
    void (async () => {
      for (const image of images) {
        const uploaded = await uploadPastedImage(image);
        setUploading((n) => n - 1);
        if (!uploaded) continue;
        const insert = `${uploaded} `;
        setText((prev) => {
          const from = Math.min(at, prev.length);
          const to = Math.min(Math.max(end, from), prev.length);
          const before = prev.slice(0, from);
          const pad = before.length > 0 && !/\s$/.test(before) ? " " : "";
          at = from + pad.length + insert.length;
          end = at;
          return `${before}${pad}${insert}${prev.slice(to)}`;
        });
      }
    })();
  }

  function markDone(): void {
    void act("done", () => api.done(request.id), () => optimisticSettle(request.id, "answered", "done"));
  }

  function skipWith(reason: string): void {
    const trimmed = reason.trim();
    if (!trimmed) return;
    void act("skip", () => api.skip(request.id, trimmed), () =>
      optimisticSettle(request.id, "answered", `skipped: ${trimmed}`),
    );
  }

  function snoozeTo(iso: string): void {
    void act("snooze", () => api.reqSnooze(request.id, iso), () =>
      patchRequest(request.id, { state: "snoozed", snoozedUntil: iso }),
    );
  }

  function sink(): void {
    void act("sink", () => api.sink(request.id), () => patchRequest(request.id, { severity: "P2" }));
  }

  function confirmTruths(): void {
    if (!truths) return;
    void act(
      "confirm assumption",
      () => confirmAssumption(truths.project, truths.entryId),
      () => optimisticSettle(request.id, "resolved"),
    );
  }

  // Keyboard commands arrive as a bumped sequence number from the lane list.
  useEffect(() => {
    if (!signal || signal.target !== request.id || signal.seq === lastSignal.current) return;
    lastSignal.current = signal.seq;
    if (settled || truths) return;
    if (signal.action === "answer") {
      setMode("answer");
      window.setTimeout(() => textField.current?.focus(), 0);
      return;
    }
    if (signal.action === "done" && request.kind === "run") markDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal]);

  const canAnswer = !settled;
  const isAutofix = request.kind === "autofix";

  return (
    <article
      id={`req-${request.id}`}
      ref={node}
      aria-labelledby={`req-${request.id}-q`}
      style={opacity === 1 ? undefined : { opacity }}
      onMouseDown={() => onSelect?.(request.id)}
      className={cx(
        "mb-2 rounded-sub border border-l-4 border-line bg-panel px-3 py-2.5 transition-opacity",
        SEVERITY_STRIPE[request.severity] ?? "border-l-line",
        focused && "border-accent",
        highlight && "outline-2 outline-accent outline-offset-2",
        busy && "opacity-70",
      )}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[12px] text-mute">
        {request.rig ? <Chip>{request.rig}</Chip> : null}
        <span className="font-mono">
          {[request.session, request.bead].filter(Boolean).join(", ") || request.id}
        </span>
        <span>{settled ? `settled, was ${age}` : `waiting ${age}`}</span>
        <Chip tone={KIND_TONE[request.kind]}>{KIND_LABEL[request.kind]}</Chip>
        {request.state === "snoozed" ? <Chip tone="mute">snoozed</Chip> : null}
        {focused ? <Chip tone="accent">selected</Chip> : null}
        <FlowLink rig={request.rig} bead={request.bead} className="ml-auto" />
      </div>

      <p id={`req-${request.id}-q`} className="mt-0 mb-2 text-ink">
        {request.question}
      </p>

      {request.command ? (
        <div className="relative mb-2">
          <pre className="hq-scroll m-0 overflow-x-auto rounded-sub border border-line bg-code px-2.5 py-2 pr-20 font-mono text-[12px] leading-relaxed text-ink">
            {request.command}
          </pre>
          <Button
            size="sm"
            className="absolute right-1.5 top-1.5"
            onClick={async () => {
              const ok = await copyText(request.command ?? "");
              setCopied(ok ? "ok" : "fail");
              window.setTimeout(() => setCopied("idle"), 1400);
            }}
          >
            {copied === "idle" ? "Copy" : copied === "ok" ? "Copied" : "Copy failed"}
          </Button>
        </div>
      ) : null}

      {request.why ? <p className="mt-0 mb-2 text-[12px] text-mute">{request.why}</p> : null}
      {link ? (
        <p className="mt-0 mb-2 text-[12px] break-all">
          <a href={link} target="_blank" rel="noreferrer noopener">
            {link}
          </a>
        </p>
      ) : null}
      {request.answer ? (
        <p className="mt-0 mb-2 text-[12px] text-mute">
          answered: <span className="font-mono text-ink">{request.answer}</span>
        </p>
      ) : null}

      {mode === "answer" || mode === "skip" ? (
        <div className="mb-1.5">
          <label className="sr-only" htmlFor={`req-${request.id}-text`}>
            {mode === "answer" ? "Answer" : "Skip reason"}
          </label>
          <textarea
            id={`req-${request.id}-text`}
            ref={textField}
            className={inputClass}
            rows={2}
            value={text}
            placeholder={
              mode === "answer"
                ? "Answer goes straight to the worker (paste a screenshot to attach it)"
                : "Why this is skipped"
            }
            onChange={(event) => setText(event.target.value)}
            onPaste={mode === "answer" ? onPasteImages : undefined}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                if (mode === "answer") sendAnswer(text);
                else skipWith(text);
              }
              if (event.key === "Escape") setMode(null);
            }}
          />
        </div>
      ) : null}

      {mode === "snooze" ? (
        <div className="mb-1.5 rounded-sub border border-line bg-panel2/50 px-2 py-2">
          <ButtonRow>
            <span className="text-[12px] text-mute">wake</span>
            {snoozePresets(new Date(now)).map((preset) => (
              <Button
                key={preset.id}
                size="sm"
                className={TOUCH}
                disabled={busy}
                onClick={() => snoozeTo(preset.iso)}
              >
                {preset.label}
              </Button>
            ))}
          </ButtonRow>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <label className="text-[12px] text-mute" htmlFor={`req-${request.id}-custom`}>
              custom
            </label>
            <input
              id={`req-${request.id}-custom`}
              type="datetime-local"
              className="rounded-sub border border-line bg-panel px-2 py-1 text-[12px] text-ink"
              value={custom || defaultCustomInput(new Date(now))}
              onChange={(event) => setCustom(event.target.value)}
            />
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                const iso = customSnoozeIso(custom || defaultCustomInput(new Date(now)));
                if (iso) snoozeTo(iso);
              }}
            >
              Set
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
              cancel
            </Button>
          </div>
        </div>
      ) : null}

      {truths ? (
        <ButtonRow>
          <Button variant="primary" className={TOUCH} disabled={busy || settled} onClick={confirmTruths}>
            Confirm
          </Button>
          <a
            className="inline-flex min-h-11 items-center gap-1.5 rounded-sub border border-line bg-panel px-3 text-[12px] text-ink no-underline hover:bg-panel2 md:min-h-0 md:px-2.5 md:py-1"
            href={projectPath(truths.project)}
          >
            Open Truths
          </a>
        </ButtonRow>
      ) : (
      <ButtonRow>
        {isAutofix ? (
          <>
            <Button
              variant="primary"
              className={TOUCH}
              disabled={busy || settled}
              onClick={() => sendAnswer("approve")}
            >
              Approve
            </Button>
            {link ? (
              <a
                className="inline-flex min-h-11 items-center gap-1.5 rounded-sub border border-line bg-panel px-3 text-[12px] text-ink no-underline hover:bg-panel2 md:min-h-0 md:px-2.5 md:py-1"
                href={link}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open diff
              </a>
            ) : null}
            <Button
              variant="danger"
              className={TOUCH}
              disabled={busy || settled}
              onClick={() => setMode(mode === "skip" ? null : "skip")}
            >
              Reject
            </Button>
          </>
        ) : null}

        {request.kind === "run" ? (
          <Button variant="primary" className={TOUCH} disabled={busy || settled} onClick={markDone}>
            Done
          </Button>
        ) : null}

        {request.kind === "keep-or-revert" ? (
          <>
            <Button className={TOUCH} disabled={busy || settled} onClick={() => sendAnswer("keep")}>
              Keep
            </Button>
            <Button className={TOUCH} disabled={busy || settled} onClick={() => sendAnswer("revert")}>
              Revert
            </Button>
          </>
        ) : null}

        {mode === "answer" ? (
          <Button
            variant="primary"
            className={TOUCH}
            disabled={busy || uploading > 0 || text.trim().length === 0}
            onClick={() => sendAnswer(text)}
          >
            {uploading > 0 ? "Uploading" : "Send"}
          </Button>
        ) : (
          <Button className={TOUCH} disabled={busy || !canAnswer} onClick={() => setMode("answer")}>
            Answer
          </Button>
        )}

        {mode === "skip" ? (
          <Button
            variant="danger"
            className={TOUCH}
            disabled={busy || text.trim().length === 0}
            onClick={() => skipWith(text)}
          >
            {isAutofix ? "Confirm reject" : "Confirm skip"}
          </Button>
        ) : isAutofix ? null : (
          <Button className={TOUCH} disabled={busy || settled} onClick={() => setMode("skip")}>
            Skip
          </Button>
        )}

        <Button
          className={TOUCH}
          disabled={busy || settled}
          onClick={() => setMode(mode === "snooze" ? null : "snooze")}
        >
          Snooze
        </Button>

        <Button
          className={TOUCH}
          disabled={busy || settled}
          title="Push to the bottom of the P2 lane"
          onClick={sink}
        >
          Sink
        </Button>

        {request.state === "snoozed" ? (
          <Button
            className={TOUCH}
            disabled={busy}
            onClick={() =>
              void act("wake", () => api.reqUnsnooze(request.id), () =>
                patchRequest(request.id, { state: "open", snoozedUntil: null }),
              )
            }
          >
            Wake now
          </Button>
        ) : null}
      </ButtonRow>
      )}
    </article>
  );
}
