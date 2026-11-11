// WebSocket link to the console server plus the external store the React tree reads.
//
// Flow (design doc section 3): the page fetches a one-use token over the authenticated
// HTTPS origin (POST /api/ws-token), then connects to wss://host/ws presenting
// ["hq-console-v1", "tok.<token>"] as subprotocols, because a browser cannot set headers
// on an upgrade. The server replies with hello (full state), then pushes slice replaces,
// alerts, ops and terminal frames. Reconnect is exponential; if the socket has been down
// for more than 5 s the client polls GET /api/state every 3 s until it is back, so the
// console degrades to stale-by-three-seconds instead of going blank.

import type { Alert, ClientMessage, ConsoleState, Op, ServerMessage } from "@shared/api";
import { WS_PROTOCOL } from "@shared/api";
import { api, ApiError, API_BASE } from "./client";
import { isStaleFullState, mergeState } from "./hello";
import { MOCK_ENABLED, mockState } from "./mock";
import { capri } from "../now/capri";
import {
  initialWsState,
  linkStatus,
  PING_MS,
  POLL_INTERVAL_MS,
  socketDead,
  WAKE_PROBE_MS,
  wsReduce,
  type LinkStatus,
  type WsMachineState,
} from "./wsMachine";

export type StateSource = "socket" | "poll" | "mock" | "none";

export interface ConsoleSnapshot {
  state: ConsoleState | null;
  status: LinkStatus;
  source: StateSource;
  error: string | null;
  lastUpdateMs: number | null;
  ops: Op[];
  /** The server now runs a different release than the one this page first saw. */
  updateReady: boolean;
}

export interface TermFrameHandlers {
  onOpen?(frame: { replay: string; cols: number; rows: number; writable: boolean }): void;
  onData?(data: string): void;
  onExit?(code: number | null): void;
  /** The program's size changed, usually because another view of it resized. */
  onSize?(cols: number, rows: number): void;
  onError?(error: string): void;
  /** A route-3 voice draft for this (meta) pane: show it as a banner, never
   *  auto-type it (proposal 25). the owner commits it with a click. */
  onInject?(draft: { id: string; text: string }): void;
}

const TICK_MS = 500;
const MAX_OPS = 25;

function wsUrl(): string {
  const base = API_BASE ? new URL(API_BASE, window.location.href) : new URL(window.location.href);
  const proto = base.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${base.host}/ws`;
}

class ConsoleLink {
  private snapshot: ConsoleSnapshot = {
    state: null,
    status: "offline",
    source: "none",
    error: null,
    lastUpdateMs: null,
    ops: [],
    updateReady: false,
  };

  private listeners = new Set<() => void>();
  private machine: WsMachineState = initialWsState;
  private socket: WebSocket | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private refs = 0;
  private connecting = false;
  /** Last time the open socket delivered anything (a pong counts). */
  private lastRxAt = 0;
  /** Deadline for the answer to a wake probe, while one is out. */
  private probeDeadline: number | null = null;
  /** The release the first hello reported; a different one later means a deploy. */
  private firstRelease: string | null = null;
  private wakeHandler = (): void => this.wake();
  private terms = new Map<
    string,
    { handlers: TermFrameHandlers; cols: number; rows: number; meta?: boolean; pendingCapability?: string }
  >();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.retain();
    return () => {
      this.listeners.delete(listener);
      this.release();
    };
  };

  getSnapshot = (): ConsoleSnapshot => this.snapshot;

  private emit(patch: Partial<ConsoleSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private retain(): void {
    this.refs += 1;
    if (this.refs === 1) this.start();
  }

  private release(): void {
    this.refs -= 1;
    if (this.refs <= 0) {
      this.refs = 0;
      this.stop();
    }
  }

  private start(): void {
    if (MOCK_ENABLED) {
      this.emit({ state: mockState(), status: "live", source: "mock", lastUpdateMs: Date.now(), error: null });
      return;
    }
    this.machine = wsReduce(this.machine, { t: "start", now: Date.now() });
    this.syncStatus();
    void this.openSocket();
    void this.pollOnce();
    if (!this.tickTimer) this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    if (typeof window !== "undefined" && typeof document !== "undefined") {
      window.addEventListener("online", this.wakeHandler);
      document.addEventListener("visibilitychange", this.wakeHandler);
    }
  }

  /**
   * The tab became visible or the browser came back online. A link in backoff retries
   * now instead of at its scheduled time (a hidden tab's timers are throttled, so that
   * time may be long past), and an open socket must prove it is alive with a pong
   * within WAKE_PROBE_MS, or it is dropped and reopened.
   */
  wake(): void {
    if (this.refs === 0 || MOCK_ENABLED) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const now = Date.now();
    if (this.machine.phase === "backoff") {
      this.machine = wsReduce(this.machine, { t: "wake", now });
      this.tick();
      return;
    }
    if (this.machine.phase === "open" && this.socket && this.probeDeadline === null) {
      this.probeDeadline = now + WAKE_PROBE_MS;
      this.send({ t: "ping", ts: now });
    }
  }

  /** Give up on a socket that is open on paper but dead on the wire, and reconnect. */
  private dropSocket(): void {
    const sock = this.socket;
    if (!sock) return;
    this.socket = null;
    sock.onclose = null;
    sock.onerror = null;
    sock.onmessage = null;
    sock.onopen = null;
    try {
      sock.close();
    } catch {
      // already gone
    }
    this.stopPing();
    this.probeDeadline = null;
    this.machine = wsReduce(this.machine, { t: "closed", now: Date.now() });
    this.syncStatus();
  }

  private stop(): void {
    if (typeof window !== "undefined" && typeof document !== "undefined") {
      window.removeEventListener("online", this.wakeHandler);
      document.removeEventListener("visibilitychange", this.wakeHandler);
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.stopPolling();
    this.stopPing();
    if (this.socket) {
      const sock = this.socket;
      this.socket = null;
      sock.onclose = null;
      sock.onerror = null;
      sock.onmessage = null;
      sock.onopen = null;
      try {
        sock.close();
      } catch {
        // already gone
      }
    }
    this.machine = wsReduce(this.machine, { t: "stop", now: Date.now() });
    this.syncStatus();
  }

  private tick(): void {
    const now = Date.now();
    // A hidden tab's timers are throttled to about one a minute, so silence there
    // proves nothing; the wake probe covers the moment it becomes visible again.
    const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
    if (this.machine.phase === "open" && this.socket && visible && socketDead(this.lastRxAt, this.probeDeadline, now)) {
      this.dropSocket();
    }
    const before = this.machine;
    this.machine = wsReduce(this.machine, { t: "tick", now });
    if (this.machine !== before) this.syncStatus();
    if (before.phase === "backoff" && this.machine.phase === "connecting") void this.openSocket();
    if (this.machine.polling && !this.pollTimer) this.startPolling();
    if (!this.machine.polling && this.pollTimer) this.stopPolling();
  }

  private syncStatus(): void {
    const status = linkStatus(this.machine);
    if (status !== this.snapshot.status) this.emit({ status });
  }

  // ---------- socket ----------

  private async openSocket(): Promise<void> {
    if (this.connecting || this.socket || this.refs === 0) return;
    this.connecting = true;
    try {
      const { token } = await api.wsToken();
      if (this.refs === 0) return;
      const sock = new WebSocket(wsUrl(), [WS_PROTOCOL, `tok.${token}`]);
      this.socket = sock;
      sock.onopen = () => {
        this.lastRxAt = Date.now();
        this.probeDeadline = null;
        this.machine = wsReduce(this.machine, { t: "open", now: Date.now() });
        this.syncStatus();
        this.stopPolling();
        this.startPing();
        this.emit({ error: null });
        // Re-attach every open pane at the size it is actually showing.
        for (const [sid, pane] of this.terms) {
          // A Capri pane may only re-attach with proof. An unspent capability (the
          // link was down when the pane mounted) is used now; otherwise the pane is
          // asked for a fresh assertion, because the previous one is already spent.
          if (pane.meta && !pane.pendingCapability) {
            pane.handlers.onError?.("passkey required");
            continue;
          }
          if (this.sendAttach(sid, pane)) pane.pendingCapability = undefined;
        }
      };
      sock.onmessage = (ev: MessageEvent) => {
        this.lastRxAt = Date.now();
        this.probeDeadline = null;
        if (typeof ev.data !== "string") return;
        this.handle(ev.data);
      };
      // Transport failures are NOT page errors: the link pill in the top strip already
      // says "reconnecting". Putting "websocket error" or "Failed to fetch" in the red
      // error bar on every server restart is what made a half-second deploy blip look
      // like the console had gone down (hq-aukwy).
      sock.onerror = () => {};
      sock.onclose = () => {
        if (this.socket === sock) this.socket = null;
        this.stopPing();
        this.machine = wsReduce(this.machine, { t: "closed", now: Date.now() });
        this.syncStatus();
        if (this.machine.polling) this.startPolling();
      };
    } catch (err) {
      this.socket = null;
      this.machine = wsReduce(this.machine, { t: "closed", now: Date.now() });
      this.syncStatus();
      // An HTTP refusal is a real problem worth showing; an unreachable server during a
      // restart is the pill's job.
      if (err instanceof ApiError && err.status !== 403) this.emit({ error: err.message });
      if (this.machine.polling) this.startPolling();
    } finally {
      this.connecting = false;
    }
  }

  private handle(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.t) {
      case "hello": {
        // A hello can only upgrade what the page shows (see hello.ts): a cold
        // server's placeholders and a failed compile's null state used to
        // replace real data, which read as the console wiping itself.
        const release = msg.state?.version?.release ?? msg.release ?? null;
        if (release && release !== "dev") {
          if (this.firstRelease === null) this.firstRelease = release;
          else if (release !== this.firstRelease && !this.snapshot.updateReady) this.emit({ updateReady: true });
        }
        const merged = mergeState(this.snapshot.state, msg.state);
        if (merged) {
          this.emit({
            state: merged,
            source: "socket",
            lastUpdateMs: Date.now(),
            error: msg.state ? null : msg.error || "console restarting; showing the last good state",
          });
        } else {
          this.emit({ error: msg.error || "console state pending" });
        }
        break;
      }
      case "state":
        this.applySlice(msg.slice, msg.data);
        break;
      case "alert":
        this.applyAlert(msg.alert);
        break;
      case "op":
        this.applyOp(msg.op);
        break;
      case "term.open": {
        // The program's real size is now this pane's last known size too, so a
        // later refit to a different width is sent instead of skipped as a repeat.
        const opened = this.terms.get(msg.sid);
        if (opened && msg.cols > 0 && msg.rows > 0) {
          opened.cols = msg.cols;
          opened.rows = msg.rows;
        }
        this.terms.get(msg.sid)?.handlers.onOpen?.({
          replay: msg.replay,
          cols: msg.cols,
          rows: msg.rows,
          writable: msg.writable,
        });
        break;
      }
      case "term.data":
        this.terms.get(msg.sid)?.handlers.onData?.(msg.data);
        break;
      case "term.exit":
        this.terms.get(msg.sid)?.handlers.onExit?.(msg.code);
        break;
      case "term.size": {
        const pane = this.terms.get(msg.sid);
        if (pane && msg.cols > 0 && msg.rows > 0) {
          pane.cols = msg.cols;
          pane.rows = msg.rows;
        }
        pane?.handlers.onSize?.(msg.cols, msg.rows);
        break;
      }
      case "term.error":
        this.terms.get(msg.sid)?.handlers.onError?.(msg.error);
        break;
      case "meta.inject":
        this.terms.get(msg.sid)?.handlers.onInject?.({ id: String(msg.id || ""), text: String(msg.text || "") });
        break;
      case "capri": {
        // The ack lets the listener on George tell "a page put the cursor in the
        // orchestrator input" from "nothing to paste into" (no Wispr Flow then).
        const focused = capri.receive(msg.event);
        if (msg.event === "wake" && typeof msg.id === "string") this.send({ t: "capri.ack", id: msg.id, focused });
        break;
      }
      case "pong":
        break;
      default:
        break;
    }
  }

  private applySlice(slice: keyof ConsoleState, data: unknown): void {
    const current = this.snapshot.state;
    if (!current) return;
    const next = { ...current, [slice]: data } as ConsoleState;
    this.emit({ state: next, source: "socket", lastUpdateMs: Date.now() });
  }

  private applyAlert(alert: Alert): void {
    const current = this.snapshot.state;
    if (!current) return;
    const rest = current.alerts.filter((a) => a.id !== alert.id);
    this.emit({ state: { ...current, alerts: [alert, ...rest] }, lastUpdateMs: Date.now() });
  }

  private applyOp(op: Op): void {
    const rest = this.snapshot.ops.filter((o) => o.id !== op.id);
    this.emit({ ops: [op, ...rest].slice(0, MAX_OPS) });
  }

  private startPing(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => this.send({ t: "ping", ts: Date.now() }), PING_MS);
  }

  private stopPing(): void {
    if (!this.pingTimer) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  // ---------- polling fallback ----------

  private startPolling(): void {
    if (this.pollTimer) return;
    void this.pollOnce();
    this.pollTimer = setInterval(() => void this.pollOnce(), POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async pollOnce(): Promise<void> {
    if (this.refs === 0 || MOCK_ENABLED) return;
    try {
      // Same merge as the hello: a poll that lands while the server is warming
      // up after a restart must not downgrade populated panels to placeholders,
      // and a slow poll that resolves after a fresher hello must not roll the
      // board backwards.
      const incoming = await api.state();
      if (isStaleFullState(this.snapshot.state, incoming)) return;
      const state = mergeState(this.snapshot.state, incoming);
      if (!state) return;
      const source: StateSource = this.socket && this.socket.readyState === WebSocket.OPEN ? "socket" : "poll";
      this.emit({ state, source, lastUpdateMs: Date.now(), error: null });
    } catch (err) {
      // Dev convenience only: with no server running, show the mockup data rather than
      // an empty shell. Never in a production build.
      if (import.meta.env.DEV && !this.snapshot.state) {
        this.emit({ state: mockState(), source: "mock", lastUpdateMs: Date.now(), error: null });
        return;
      }
      // An unreachable server (a restart, a network blip) is the link pill's job, not
      // the red bar's, as long as there is a last good state on screen.
      if (err instanceof ApiError) this.emit({ error: `state ${err.status}: ${err.message}` });
      else if (!this.snapshot.state) this.emit({ error: "state fetch failed" });
    }
  }

  // ---------- outbound ----------

  send(msg: ClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(msg));
    return true;
  }

  /**
   * Attach a terminal view to a session. Returns the detach function.
   * `capability` is the one-use passkey proof a Capri (meta) pane needs; it is spent
   * by this attach, so a later reconnect asks the pane to re-authenticate instead of
   * silently reattaching without proof.
   */
  attachTerm(
    sid: string,
    cols: number,
    rows: number,
    handlers: TermFrameHandlers,
    opts?: { capability?: string; meta?: boolean },
  ): () => void {
    const capability = opts?.capability;
    const pane = { handlers, cols, rows, meta: Boolean(opts?.meta), pendingCapability: capability };
    this.terms.set(sid, pane);
    // The proof is held until the link actually carries it: attaching while the socket
    // is down would otherwise burn a one-use capability that never left the tab.
    if (this.sendAttach(sid, pane)) pane.pendingCapability = undefined;
    return () => {
      this.terms.delete(sid);
      this.send({ t: "term.detach", sid });
    };
  }

  /** Send one attach frame for a pane, carrying its proof when it has one. */
  private sendAttach(sid: string, pane: { cols: number; rows: number; pendingCapability?: string }): boolean {
    const { cols, rows, pendingCapability } = pane;
    return this.send(
      pendingCapability
        ? { t: "term.attach", sid, cols, rows, capability: pendingCapability }
        : { t: "term.attach", sid, cols, rows },
    );
  }

  /**
   * Re-authorize an open Capri pane with a fresh capability: used after a reconnect
   * (the previous proof is spent) and to adopt a session that is already running.
   */
  reattachMeta(sid: string, capability: string): boolean {
    const pane = this.terms.get(sid);
    if (!pane) return false;
    pane.meta = true;
    pane.pendingCapability = capability;
    if (this.sendAttach(sid, pane)) {
      pane.pendingCapability = undefined;
      return true;
    }
    return false;
  }

  resizeTerm(sid: string, cols: number, rows: number): void {
    const pane = this.terms.get(sid);
    if (pane) {
      if (pane.cols === cols && pane.rows === rows) return;
      pane.cols = cols;
      pane.rows = rows;
    }
    this.send({ t: "term.resize", sid, cols, rows });
  }

  /** Ask the runner to repaint a console terminal (stale cells, doubled borders). */
  redrawTerm(sid: string): void {
    if (!this.terms.has(sid)) return;
    this.send({ t: "term.redraw", sid });
  }

  /** Ignored by the server for worker sessions; the UI also refuses to call it. */
  inputTerm(sid: string, data: string): void {
    this.send({ t: "term.input", sid, data });
  }

  /** Optimistic local patch, used by action buttons before the next push lands. */
  patchState(fn: (state: ConsoleState) => ConsoleState): void {
    const current = this.snapshot.state;
    if (!current) return;
    this.emit({ state: fn(current) });
  }

  refresh(): void {
    void this.pollOnce();
  }
}

export const consoleLink = new ConsoleLink();
