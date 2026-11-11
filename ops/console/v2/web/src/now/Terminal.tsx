// Embedded terminal. One xterm instance per mounted view, attached over the console
// WebSocket with term.attach / term.detach / term.resize (contract: shared/api.ts).
//
// Workers are output-only by design: they are headless jobs and nobody types into them, so
// keyboard input is only forwarded when the server says the session is writable, and the
// pane says which it is. Resizes are debounced, because a drag of the drawer edge fires
// ResizeObserver dozens of times and every one of them would be a socket message and a
// SIGWINCH in the PTY. Re-attach after a reconnect is handled by the link itself (it
// replays term.attach for every open pane when the socket comes back), so a dropped
// connection ends with the same pane still streaming.
//
// Getting text OUT of a pane needs code, which is why it did not work at all until
// 2026-08-24. Two things are in the way and they are independent. First, tmux runs
// with `mouse on`, so the application asks for mouse reporting and xterm hands drags
// to it rather than building a selection: Shift forces selection back (Option on a
// Mac, hence macOptionClickForcesSelection). Second, an xterm selection is not a DOM
// selection, so the browser's own copy has nothing to take and Ctrl+C would be SIGINT
// anyway. Copying is therefore explicit: the chord and the button both read
// term.getSelection(), and with nothing selected the button takes the whole scrollback,
// which is also the only way to copy from a phone where there is no drag to make.
// Getting text IN needs code too: left to itself, this xterm maps plain Ctrl+V to the
// control byte 0x16, sends that to the PTY and preventDefaults the keydown, so the
// browser paste never fires and the chord does nothing visible. The key handler
// returns false for the paste chord instead, which makes xterm step aside entirely:
// the native paste event then reaches xterm's own textarea listener, which writes it
// bracketed-paste wrapped, with no clipboard-read permission involved. An image-only
// paste (a screenshot) is caught before xterm sees it: the bitmap uploads through the
// inbox and the returned path on the box is pasted as text for the session to read.

import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { addDraft, headDraft, removeDraft, submitBytes, draftLabel, type Draft } from "./injectBanner";
import type { Session } from "@shared/api";
import { consoleLink } from "../data/ws";
import { useConsoleSlice } from "../data/store";
import { Button, Chip, RigSigil, cx } from "../ui/primitives";
import { copyText } from "./clipboard";
import { pastedImages } from "./clipboardImages";
import { droppedFiles, runDrop } from "./dropUpload";
import { uploadAnyFile, uploadPastedImage } from "./pasteUpload";
import { termPath } from "./popout";
import { ATTENTION_TEXT, cueOf, needsYou, useAttention } from "./attention";
import { FlowLink } from "./FlowLink";
import { usePaneManage } from "./PaneManage";
import { toastError } from "./toast";
import { TOUCH_SM } from "./ui";
import { capri, capriMood, useCapriListening } from "./capri";

const RESIZE_DEBOUNCE_MS = 150;
// Same floor as the runner (runner/src/manager.js MIN_COLS / MIN_ROWS).
const MIN_COLS = 20;
const MIN_ROWS = 5;
const COPY_FLASH_MS = 1400;

const IS_MAC =
  typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || "");

/** Mac copies with Cmd+C; everywhere else Ctrl+C is SIGINT, so copy takes Shift. */
export const COPY_CHORD = IS_MAC ? "Cmd+C" : "Ctrl+Shift+C";
export const SELECT_HINT = IS_MAC ? "Option+drag" : "Shift+drag";

/**
 * The chord that must reach the browser as a real paste. Ctrl+V in any modifier
 * combination on PC (plain pastes, Ctrl+Shift+V pastes without formatting), Cmd+V
 * on a Mac. Returning false from the key handler for these is what makes paste
 * work at all: xterm 6 otherwise turns plain Ctrl+V into the control byte 0x16
 * for the PTY and cancels the event, so the paste never happens. The cost is that
 * ^V cannot be typed into the PTY (readline quoted-insert), which nothing in a
 * claude pane needs.
 */
export function isPasteChord(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">, isMac: boolean): boolean {
  // AltGr on a Windows layout reports as Ctrl+Alt, and AltGr+V can be a real
  // character in the layout, so Alt disqualifies the chord on every platform.
  if (event.key.toLowerCase() !== "v" || event.altKey) return false;
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/**
 * A console terminal: a runner-owned PTY (a tmux client on the hqterm server) that
 * the runner may wiggle. An adopted hq:work pane (runner "tmux") shares its window
 * with the tiled panes, and a worker or Capri is never redrawn this way.
 */
export function isConsoleTerm(session: Pick<Session, "runner" | "kind">): boolean {
  return session.runner === "pty" && session.kind === "interactive";
}

/** Two redraws closer than this are one: a double click is not two wiggles. */
export const REDRAW_GAP_MS = 1000;

/**
 * Redraw on the way INTO a pane (2026-10-20, the owner's garbled panes). Called on
 * every pointerdown with whether the pane already held focus: a click into a pane
 * that had it is typing or selecting, and a redraw then would only flicker.
 */
export function focusRedrawer(redraw: () => void, now: () => number = Date.now): (hadFocus: boolean) => boolean {
  let last = -Infinity;
  return (hadFocus) => {
    if (hadFocus) return false;
    const t = now();
    if (t - last < REDRAW_GAP_MS) return false;
    last = t;
    redraw();
    return true;
  };
}

function readToken(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * The whole scrollback as text. A soft-wrapped line is one line to the shell that
 * printed it, so the continuation rows are joined back and only a row that really
 * ends a line is right-trimmed: that is the difference between a copied command you
 * can paste and one broken at column 80.
 */
export function bufferText(term: Pick<XTerm, "buffer">): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i += 1) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const continues = buffer.getLine(i + 1)?.isWrapped ?? false;
    const text = line.translateToString(!continues);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

type CopyResult = "ok" | "empty" | "fail";

/** Selection when there is one, the whole buffer when there is not. */
async function copyOut(term: XTerm): Promise<CopyResult> {
  const text = term.hasSelection() ? term.getSelection() : bufferText(term);
  // An empty pane and a refused clipboard are different problems and the button
  // says which, because "Copy failed" on a pane that had nothing in it sends you
  // looking for a browser permission bug that is not there.
  if (!text.trim()) return "empty";
  return (await copyText(text)) ? "ok" : "fail";
}

export function TerminalPane({
  capability,
  session,
  meta = false,
  fill = false,
  onClose,
  popout = true,
  manage = false,
}: {
  session: Session;
  /** Capri only: hands the pane its one-use passkey proof for this attach. */
  capability?: (sid: string) => string | undefined;
  meta?: boolean;
  /** Fill the parent instead of the fixed 260 px pane height (pop-out and phone). */
  fill?: boolean;
  onClose?: (id: string) => void;
  popout?: boolean;
  /** Snooze and Kill in the header (the Terminals page). */
  manage?: boolean;
}) {
  const managed = usePaneManage(session);
  const host = useRef<HTMLDivElement | null>(null);
  const { attention, seen } = useAttention(session);
  const wants = needsYou(attention);
  // Finished and killable: a red border until it is killed or starts new work (cueOf).
  const finished = cueOf(session) === "finished";
  // The question this terminal is waiting on (ctl ask), shown on the pane itself so a
  // glance at the terminal says what it asked. A string, so an unrelated state push
  // does not hand the render a new array.
  const asked = useConsoleSlice((state) =>
    (state?.requests ?? [])
      .filter((request) => request.state === "open" && request.session === session.id)
      .map((request) => request.question)
      .join("  /  "),
  );
  // A pane that is the whole page (pop-out tab, phone) is seen whenever its tab is in
  // front; a pane in the grid is seen when the owner clicks or types in it.
  useEffect(() => {
    if (popout || attention !== "done") return;
    const check = (): void => {
      if (document.visibilityState === "visible" && document.hasFocus()) seen();
    };
    check();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [popout, attention, seen]);
  const termRef = useRef<XTerm | null>(null);
  // Read inside the attach effect without re-attaching when the row changes.
  const redrawable = isConsoleTerm(session);
  const redrawableRef = useRef(redrawable);
  redrawableRef.current = redrawable;
  const [status, setStatus] = useState<"connecting" | "open" | "exited" | "error">("connecting");
  const [detail, setDetail] = useState<string | null>(null);
  const [reauthBusy, setReauthBusy] = useState(false);
  const [selected, setSelected] = useState(false);
  const [copied, setCopied] = useState<CopyResult | "idle">("idle");
  // Route 3 voice drafts (proposal 25): spoken tasks pushed to this Capri pane,
  // shown one at a time as a banner, committed only on the owner's Send click,
  // never auto-typed. A FIFO queue so a rapid second task does not drop the first.
  const [drafts, setDrafts] = useState<Draft[]>([]);

  // One timer for the button label, shared with the keyboard path and cleared on
  // unmount. Two independent timers meant an older copy could reset the label of a
  // newer one, or fire into a pane that had already gone.
  const flashTimer = useRef<number | null>(null);
  const flash = useCallback((result: CopyResult) => {
    setCopied(result);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => {
      flashTimer.current = null;
      setCopied("idle");
    }, COPY_FLASH_MS);
  }, []);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );

  useEffect(() => {
    const node = host.current;
    if (!node) return;

    const term = new XTerm({
      convertEol: true,
      cursorBlink: false,
      disableStdin: !session.writable,
      fontFamily: readToken("--mono", "ui-monospace, monospace"),
      fontSize: 12,
      // Option+drag forces a selection past the application's mouse reporting; without
      // this a Mac has no way to select at all while tmux holds the mouse.
      macOptionClickForcesSelection: true,
      scrollback: 4000,
      theme: {
        background: readToken("--term-bg", "#000000"),
        foreground: readToken("--term-ink", "#d9d2ff"),
        cursor: readToken("--accent", "#b388ff"),
        selectionBackground: readToken("--line", "#24242e"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // A printed URL is a link: click opens it in a new tab of whatever browser
    // is showing the console (the owner's ask, 2026-08-28). noopener/noreferrer so
    // the opened page can never script its way back into the console.
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        window.open(uri, "_blank", "noopener,noreferrer");
      }),
    );
    term.open(node);
    termRef.current = term;
    try {
      const dims = fit.proposeDimensions();
      if (dims && dims.cols >= MIN_COLS && dims.rows >= MIN_ROWS) fit.fit();
    } catch {
      // container not laid out yet; the observer below refits
    }

    setStatus("connecting");
    setDetail(null);
    setSelected(false);

    const detach = consoleLink.attachTerm(
      session.id,
      term.cols,
      term.rows,
      {
      onOpen: (frame) => {
        setStatus("open");
        setDetail(null);
        term.reset();
        // Draw at the size the program really has. When it differs from this
        // pane's fit, every redraw lands in the wrong cells (the bleeding text).
        if (frame.cols > 0 && frame.rows > 0 && (frame.cols !== term.cols || frame.rows !== term.rows)) term.resize(frame.cols, frame.rows);
        if (frame.replay) term.write(frame.replay);
      },
      onSize: (cols, rows) => {
        if (cols > 0 && rows > 0 && (cols !== term.cols || rows !== term.rows)) term.resize(cols, rows);
      },
      onData: (data) => {
        term.write(data);
        // Capri's corner (hq-ymxzt.5) speaks on new orchestrator output
        if (meta) capriMood.heard(data);
      },
      onExit: (code) => {
        setStatus("exited");
        setDetail(code === null ? "exited" : `exited (${code})`);
      },
      onError: (error) => {
        setStatus("error");
        setDetail(error);
      },
      onInject: (d) => setDrafts((q) => addDraft(q, d)),
      },
      { capability: capability?.(session.id), meta },
    );

    const input = session.writable
      ? term.onData((data) => {
          if (meta) capriMood.typed();
          consoleLink.inputTerm(session.id, data);
        })
      : null;

    // The button's label promises what it will actually do, so it has to know whether
    // there is a selection right now.
    const selection = term.onSelectionChange(() => setSelected(term.hasSelection()));

    // Selecting IS copying: when the drag that made a selection ends, the text
    // goes straight to the system clipboard, the way every terminal the owner uses
    // behaves. The chord and the button remain for retries and whole-buffer
    // copies; a refused clipboard stays silent here because the selection is
    // still held and both of those paths do report failure. The timeout lets
    // xterm finalise the selection before it is read.
    const autoCopy = () => {
      window.setTimeout(() => {
        if (!term.hasSelection()) return;
        const text = term.getSelection();
        if (!text.trim()) return;
        void copyText(text).then((ok) => {
          if (ok) flash("ok");
        });
      }, 0);
    };
    node.addEventListener("mouseup", autoCopy);

    // A click into a console terminal that did not have focus repaints it, so a
    // garbled screen (stale cells, doubled borders) is put right on the way in.
    // Capture phase, before xterm moves focus into its textarea.
    const redrawOnEntry = focusRedrawer(() => consoleLink.redrawTerm(session.id));
    const onPointerDown = () => {
      if (!redrawableRef.current) return;
      redrawOnEntry(node.contains(document.activeElement));
    };
    node.addEventListener("pointerdown", onPointerDown, true);

    // Returning false takes the key away from xterm, so it never reaches the PTY.
    //
    // COPY is intercepted and handled here. PASTE is stepped away from: returning
    // false for the paste chord stops xterm from swallowing it (sending ^V to the
    // PTY and preventDefaulting the keydown, which is what "Ctrl+V does nothing"
    // was), and with xterm out of the way the browser fires its native paste event,
    // which xterm's own textarea listener already turns into bracketed-paste input.
    // No script ever reads the clipboard, so no permission prompt in any browser
    // (the constraint lucy raised on 2026-08-24 still holds; the earlier comment
    // just assumed xterm let the native paste through on its own, and this version
    // does not).
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      if (isPasteChord(event, IS_MAC)) return false;
      const key = event.key.toLowerCase();
      const mod = event.ctrlKey || event.metaKey;
      // Plain Ctrl+C with a live selection copies, exactly as VS Code's terminal
      // does; the selection is then cleared so the very next Ctrl+C is SIGINT
      // again. Without a selection it stays SIGINT untouched.
      if (!IS_MAC && key === "c" && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && term.hasSelection()) {
        void copyText(term.getSelection()).then((ok) => flash(ok ? "ok" : "fail"));
        term.clearSelection();
        return false;
      }
      const copyChord = IS_MAC ? event.metaKey && !event.ctrlKey && key === "c" : mod && event.shiftKey && key === "c";
      if (!copyChord) return true;
      if (term.hasSelection()) {
        void copyText(term.getSelection()).then((ok) => flash(ok ? "ok" : "fail"));
        return false;
      }
      // A bare Cmd+C on a Mac was probably meant for something else, so let it
      // through. Ctrl+Shift+C means nothing else here, so say why nothing happened.
      if (IS_MAC) return true;
      flash("empty");
      return false;
    });

    // A minimized or popped-in pane measures as a few cells. Fitting to that
    // shrank the live program to 2 columns (the runner used to accept it), and
    // what it drew meanwhile stayed behind as two-letter fragments at the start
    // of every line. Only a real size is fitted and sent; a hidden pane keeps
    // its last geometry until it is visible again.
    const refitIfReal = () => {
      const dims = fit.proposeDimensions();
      if (!dims || !(dims.cols >= MIN_COLS) || !(dims.rows >= MIN_ROWS)) return;
      fit.fit();
      consoleLink.resizeTerm(session.id, term.cols, term.rows);
    };

    let timer: number | null = null;
    const observer = new ResizeObserver(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        try {
          refitIfReal();
        } catch {
          // ignore transient layout errors
        }
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(node);

    // A hidden pane measures as zero, and coming back does not necessarily CHANGE
    // the container size, so the observer never fires and xterm keeps the tiny
    // geometry it took while the tab was in the background. That is the shrunken
    // terminal in the corner of an otherwise blank page. Refit on the way back in,
    // after a frame so the layout has actually happened.
    const refit = () => {
      window.requestAnimationFrame(() => {
        try {
          refitIfReal();
        } catch {
          // ignore transient layout errors
        }
      });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refit();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", refit);
    window.addEventListener("focus", refit);

    // A pasted SCREENSHOT is a bitmap the PTY cannot receive, so it goes the long
    // way: upload through the inbox (same store as drag-and-drop), then paste the
    // returned absolute path as text for the session to read. Capture phase, so an
    // image-only paste never reaches xterm's own textarea listener (which would
    // send an empty bracketed paste). Text pastes fall through untouched, and a
    // mixed clipboard (Excel, Word) stays text: see pastedImages.
    const onPaste = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      if (!data) return;
      const images = pastedImages([...data.items], data.getData("text/plain"));
      if (images.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (!session.writable) {
        toastError("this session is read-only; the screenshot was not uploaded");
        return;
      }
      void (async () => {
        for (const image of images) {
          const uploaded = await uploadPastedImage(image);
          // paste() routes through the same bracketed-paste path as text, so
          // the session sees the path exactly as if it had been typed.
          if (uploaded) termRef.current?.paste(`${uploaded} `);
        }
      })();
    };
    node.addEventListener("paste", onPaste, true);

    // Files dragged from the PC: upload each, then paste the box paths (no Enter).
    // Always preventDefault so the browser never navigates to the dropped file.
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      node.setAttribute("data-dropping", "");
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget instanceof Node && node.contains(e.relatedTarget)) return;
      node.removeAttribute("data-dropping");
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      node.removeAttribute("data-dropping");
      if (!session.writable) {
        toastError("this session is read-only; the files were not uploaded");
        return;
      }
      const { files, folders } = droppedFiles([...(e.dataTransfer?.items ?? [])]);
      if (folders > 0) toastError("folders are not supported; drop files");
      if (files.length === 0) return;
      void runDrop(files, uploadAnyFile).then((text) => {
        if (text) termRef.current?.paste(text);
      });
    };
    node.addEventListener("dragover", onDragOver);
    node.addEventListener("dragleave", onDragLeave);
    node.addEventListener("drop", onDrop);

    return () => {
      node.removeEventListener("dragover", onDragOver);
      node.removeEventListener("dragleave", onDragLeave);
      node.removeEventListener("drop", onDrop);
      if (timer !== null) window.clearTimeout(timer);
      node.removeEventListener("mouseup", autoCopy);
      node.removeEventListener("pointerdown", onPointerDown, true);
      node.removeEventListener("paste", onPaste, true);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", refit);
      window.removeEventListener("focus", refit);
      observer.disconnect();
      input?.dispose();
      selection.dispose();
      detach();
      termRef.current = null;
      term.dispose();
    };
    // Deliberately NOT capability/meta: capability is a fresh closure on every render
    // of the parent, and depending on it would tear the terminal down and re-attach it
    // on every state tick. Both are read once, at attach, which is when they matter.
  }, [session.id, session.writable, flash]);

  const statusText =
    status === "open"
      ? "attached"
      : status === "connecting"
        ? "runner not connected"
        : (detail ?? status);

  // A Capri pane whose proof was spent (a reconnect, or a cancelled second touch)
  // is not broken, it is locked: one more passkey touch re-attaches it in place.
  const needsPasskey = meta && status === "error" && /passkey/i.test(detail ?? "");
  async function reauth(): Promise<void> {
    setReauthBusy(true);
    try {
      const { authorizeAttach } = await import("./capriMeta");
      await authorizeAttach(session.id, (sid, capability) => consoleLink.reattachMeta(sid, capability));
      setStatus("connecting");
      setDetail(null);
    } catch (e) {
      setDetail(e instanceof Error ? e.message : String(e));
    } finally {
      setReauthBusy(false);
    }
  }

  // Capri (hq-ymxzt.2): the orchestrator input takes the cursor on a wake word, so
  // Wispr Flow pastes here. Only a writable meta pane can take it.
  const capriTarget = meta && session.writable;
  useEffect(() => {
    if (!capriTarget) return;
    return capri.register(() => termRef.current?.focus());
  }, [capriTarget]);
  const capriListening = useCapriListening() && capriTarget;

  return (
    <div
      className={cx(
        "flex min-w-0 flex-col overflow-hidden rounded-sub border bg-term-bg",
        fill ? "h-full" : "",
        meta ? "border-p0 shadow-[inset_0_0_0_1px_var(--p0)]" : finished ? "hq-done-ring" : wants ? "hq-attn-ring" : "border-line",
      )}
      data-attention={attention ?? undefined}
      data-finished={finished || undefined}
      onPointerDownCapture={seen}
      onKeyDownCapture={seen}
    >
      {attention === "working" ? (
        <div className="hq-attn-scan" aria-hidden="true" />
      ) : (
        <div className={cx("h-[2px]", finished ? "bg-bad" : wants ? "bg-p1" : "bg-transparent")} aria-hidden="true" />
      )}
      <div
        className={cx(
          "flex flex-wrap items-center gap-2 border-b px-2.5 py-1.5 text-[11px] text-mute",
          finished ? "border-bad/30 bg-bad/10" : wants ? "border-p1/30 bg-p1/10" : "border-line",
        )}
      >
        <b className="font-mono text-ink">{session.name ?? session.id}</b>
        {session.rig ? (
          <span className="inline-flex items-center gap-1.5">
            <RigSigil id={session.rig} size={12} />
            {session.rig}
          </span>
        ) : null}
        {session.bead ? <span>{session.bead}</span> : null}
        {session.writable ? <Chip tone="warn">input on</Chip> : <Chip tone="mute">output only</Chip>}
        <span className="ml-auto flex items-center gap-1.5">
          {finished ? (
            <span className="font-mono font-semibold text-bad">finished</span>
          ) : attention ? (
            <span
              className={cx(
                "font-mono",
                wants ? "font-semibold text-p1" : attention === "working" ? "text-ok" : "text-mute",
              )}
            >
              {ATTENTION_TEXT[attention]}
            </span>
          ) : null}
          <span className={status === "exited" || status === "error" ? "text-warn" : undefined}>{statusText}</span>
          {needsPasskey ? (
            <Button size="sm" variant="primary" className={TOUCH_SM} disabled={reauthBusy} onClick={() => void reauth()}>
              {reauthBusy ? "asking..." : "Re-authenticate"}
            </Button>
          ) : null}
          {redrawable && status === "open" ? (
            <Button
              size="sm"
              variant="ghost"
              className={TOUCH_SM}
              title="Repaint this terminal: fixes stale text or doubled borders. Clicking into the pane does the same."
              onClick={() => consoleLink.redrawTerm(session.id)}
            >
              Redraw
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className={TOUCH_SM}
            title={`${selected ? "Copy the selection" : "Copy the whole scrollback"}. Selecting copies by itself (${COPY_CHORD} retries). Select with ${SELECT_HINT} if the app inside holds the plain mouse; click a URL to open it.`}
            onClick={() => {
              const term = termRef.current;
              if (!term) return;
              void copyOut(term).then(flash);
            }}
          >
            {copied === "ok"
              ? "Copied"
              : copied === "empty"
                ? "Nothing to copy"
                : copied === "fail"
                  ? "Copy blocked"
                  : selected
                    ? "Copy selection"
                    : "Copy all"}
          </Button>
          {/* A real link with target=_blank, never a scripted window.open: Brave
              and friends block the popup, and the old fallback then REPLACED the
              console with the terminal, which is how you lose your place. */}
          {popout ? (
            <a
              href={termPath(session.id)}
              target="_blank"
              rel="noopener noreferrer"
              className="hq-press inline-flex min-h-11 items-center gap-1.5 rounded-sub border border-transparent px-2 py-0.5 text-[11px] text-mute no-underline hover:bg-panel2 hover:text-ink md:min-h-0"
              title="Open this terminal in a new tab"
            >
              Pop out
            </a>
          ) : null}
          <FlowLink rig={session.rig} bead={session.bead} newTab className="min-h-11 md:min-h-0" />
          {manage ? managed.buttons : null}
          {onClose ? (
            <Button size="sm" variant="ghost" className={TOUCH_SM} onClick={() => onClose(session.id)}>
              Close
            </Button>
          ) : null}
        </span>
      </div>
      {manage ? managed.panel : null}
      {asked ? (
        <div
          className="border-b border-p1/30 bg-p1/10 px-2.5 py-1.5 text-[12px] text-ink"
          aria-label={`Question from ${session.name ?? session.id}`}
        >
          <span className="mr-1.5 font-mono text-[11px] font-semibold text-p1">question</span>
          <span className="line-clamp-3 whitespace-pre-line">{asked}</span>
          <span className="mt-0.5 block text-[11px] text-mute">
            {session.writable
              ? "Answer by typing here, or on its card under Sessions."
              : "Answer on its card under Sessions on Now; the worker picks it up."}
          </span>
        </div>
      ) : null}
      {capriListening ? (
        <div className="flex items-center gap-2 border-b border-p0/40 bg-p0/10 px-2.5 py-1.5 text-[12px]" role="status">
          <span className="hq-capri-bars" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span className="font-mono text-p0">Capri</span>
          <span className="text-ink">listening, speak now</span>
        </div>
      ) : null}
      {headDraft(drafts) && session.writable ? (() => {
        const draft = headDraft(drafts)!;
        return (
          <div className="flex flex-wrap items-center gap-2 border-b border-p0 bg-p0/10 px-2.5 py-1.5 text-[12px]">
            <span className="text-p0 font-mono">voice task{drafts.length > 1 ? ` (+${drafts.length - 1})` : ""}</span>
            <span className="min-w-0 flex-1 truncate text-ink" title={draft.text}>{draftLabel(draft)}</span>
            <Button
              size="sm"
              variant="primary"
              className={TOUCH_SM}
              title="Type this into Capri and submit it."
              onClick={() => {
                consoleLink.inputTerm(session.id, submitBytes(draft));
                setDrafts((q) => removeDraft(q, draft.id));
              }}
            >
              Send
            </Button>
            <Button size="sm" variant="ghost" className={TOUCH_SM} onClick={() => setDrafts((q) => removeDraft(q, draft.id))}>
              Dismiss
            </Button>
          </div>
        );
      })() : null}
      <div className={cx("hq-term relative", fill ? "min-h-0 flex-1" : "h-[260px]")}>
        <div ref={host} className="absolute inset-0" />
        {status === "connecting" ? (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-faint">
            runner not connected
          </p>
        ) : null}
        {status === "exited" || status === "error" ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-panel/90 px-2.5 py-1.5 text-[12px] text-warn">
            <span>{detail ?? "session ended"}</span>
            {onClose ? (
              <Button
                size="sm"
                className={cx(TOUCH_SM, "pointer-events-auto")}
                onClick={() => onClose(session.id)}
              >
                Close pane
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
