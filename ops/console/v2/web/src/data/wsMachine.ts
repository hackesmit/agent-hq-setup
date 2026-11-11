// Pure reconnect / fallback state machine for the console WebSocket.
//
// Kept free of timers, sockets and fetch so it can be tested directly. ws.ts owns the
// effects and feeds this reducer events; the reducer decides when to reconnect and when
// the 3 s polling fallback is on. Rule from the design doc: the socket is the transport,
// and polling starts only once the socket has been down for more than 5 s, so a normal
// blip does not produce a burst of REST traffic.

export type WsPhase = "idle" | "connecting" | "open" | "backoff";

export interface WsMachineState {
  phase: WsPhase;
  /** Consecutive failed connection attempts; resets on open. */
  attempts: number;
  /** When the connection was first lost (or first attempted and not yet open). */
  downSince: number | null;
  /** True while the REST polling fallback should run. */
  polling: boolean;
  /** Timestamp of the next reconnect attempt while in backoff. */
  retryAt: number | null;
}

export type WsEvent =
  | { t: "start"; now: number }
  | { t: "open"; now: number }
  | { t: "closed"; now: number }
  | { t: "stop"; now: number }
  | { t: "tick"; now: number }
  /** The page became visible or the browser came back online: retry now, not at retryAt. */
  | { t: "wake"; now: number };

/** Down longer than this and the REST fallback takes over. */
export const POLL_AFTER_MS = 5_000;
/** Fallback poll cadence while the socket is down. */
export const POLL_INTERVAL_MS = 3_000;
export const BACKOFF_BASE_MS = 500;
// Capped at 4 s so a link that comes back is picked up within 5 s (hq-aukwy). The
// server restarts on every merge and is back in about half a second; a 30 s cap made
// a longer outage (network change, a slow restart) linger long after it ended. Each
// retry is one tiny POST, so a 4 s cadence while down costs nothing.
export const BACKOFF_MAX_MS = 4_000;

/** Ping cadence on an open socket. */
export const PING_MS = 10_000;
/** An open socket that has said nothing for this long is dead (no pong to two pings). */
export const SILENT_DEAD_MS = 25_000;
/** After a wake (tab visible, browser online) the socket must answer a ping this fast. */
export const WAKE_PROBE_MS = 3_000;

/**
 * Is an OPEN socket actually dead? A socket can stay "open" for minutes after the
 * network under it went away (a laptop lid, a Wi-Fi change), showing frozen data as
 * live. Dead when it has been silent past SILENT_DEAD_MS, or when a wake probe was
 * sent and nothing came back by its deadline.
 */
export function socketDead(lastRxAt: number, probeDeadline: number | null, now: number): boolean {
  if (now - lastRxAt >= SILENT_DEAD_MS) return true;
  return probeDeadline !== null && now >= probeDeadline && lastRxAt < probeDeadline - WAKE_PROBE_MS;
}

export function backoffDelay(attempts: number): number {
  const n = Math.max(0, attempts);
  const raw = BACKOFF_BASE_MS * 2 ** Math.min(n, 20);
  return Math.min(raw, BACKOFF_MAX_MS);
}

export const initialWsState: WsMachineState = {
  phase: "idle",
  attempts: 0,
  downSince: null,
  polling: false,
  retryAt: null,
};

function shouldPoll(downSince: number | null, now: number): boolean {
  return downSince !== null && now - downSince >= POLL_AFTER_MS;
}

export function wsReduce(state: WsMachineState, event: WsEvent): WsMachineState {
  switch (event.t) {
    case "start": {
      if (state.phase === "connecting" || state.phase === "open") return state;
      const downSince = state.downSince ?? event.now;
      return {
        phase: "connecting",
        attempts: state.attempts,
        downSince,
        polling: shouldPoll(downSince, event.now),
        retryAt: null,
      };
    }

    case "open":
      if (state.phase === "open" && !state.polling && state.attempts === 0) return state;
      return { phase: "open", attempts: 0, downSince: null, polling: false, retryAt: null };

    case "closed": {
      if (state.phase === "idle") return state;
      const downSince = state.downSince ?? event.now;
      const attempts = state.attempts + 1;
      return {
        phase: "backoff",
        attempts,
        downSince,
        polling: shouldPoll(downSince, event.now),
        // The first retry uses the shortest delay, then it doubles.
        retryAt: event.now + backoffDelay(attempts - 1),
      };
    }

    case "stop":
      return initialWsState;

    case "wake":
      if (state.phase !== "backoff") return state;
      return { ...state, retryAt: event.now };

    case "tick": {
      const polling = shouldPoll(state.downSince, event.now);
      const due = state.phase === "backoff" && state.retryAt !== null && event.now >= state.retryAt;
      if (due) {
        return {
          phase: "connecting",
          attempts: state.attempts,
          downSince: state.downSince,
          polling,
          retryAt: null,
        };
      }
      if (polling === state.polling) return state;
      return { ...state, polling };
    }

    default:
      return state;
  }
}

/** What the shell shows in the top strip. */
export type LinkStatus = "live" | "connecting" | "polling" | "offline";

export function linkStatus(state: WsMachineState): LinkStatus {
  if (state.phase === "open") return "live";
  if (state.polling) return "polling";
  if (state.phase === "idle") return "offline";
  return "connecting";
}
