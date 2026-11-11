// Running a console action and finding out whether it actually worked.
//
// Every action POST answers 202 with an Op that is still queued: the real work is a
// shell-out (ctl, bd, spawn, finish) that finishes later. So the UI starts the op, polls
// GET /api/op/:id until it settles, and only then decides between "done" and an error
// toast. Optimistic patches make the card move at once; the poll is what corrects it.

import { useCallback } from "react";
import type { ConsoleState, Op, Request, Session } from "@shared/api";
import { api, ApiError } from "../data/client";
import { useAction } from "../data/store";
import { consoleLink } from "../data/ws";
import { toastError, toastInfo } from "./toast";

export const OP_POLL_MS = 700;
export const OP_TIMEOUT_MS = 45_000;

export function isOp(value: unknown): value is Op {
  if (typeof value !== "object" || value === null) return false;
  const op = value as Partial<Op>;
  return typeof op.id === "string" && typeof op.state === "string";
}

export function isSettledOp(op: Op): boolean {
  return op.state === "done" || op.state === "failed";
}

export interface SettleOptions {
  fetchOp?: (id: string) => Promise<Op>;
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll one op until it is done or failed. On timeout the last known op is returned
 * unsettled, which the caller reports as "still running" rather than as a failure: a slow
 * finish.sh is not a broken one.
 */
export async function settleOp(op: Op, options: SettleOptions = {}): Promise<Op> {
  const fetchOp = options.fetchOp ?? api.op;
  const intervalMs = options.intervalMs ?? OP_POLL_MS;
  const timeoutMs = options.timeoutMs ?? OP_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  let current = op;
  const deadline = now() + timeoutMs;
  while (!isSettledOp(current) && now() < deadline) {
    await sleep(intervalMs);
    try {
      current = await fetchOp(current.id);
    } catch {
      // A single failed poll is not a failed op; keep trying until the deadline.
    }
  }
  return current;
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "the server does not have this endpoint yet";
    if (err.status === 403) return "the console rejected the request (stale boot key?)";
    return `${err.status}: ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return "unknown error";
}

export function opFailureText(op: Op): string {
  const detail = op.error ?? op.output ?? "no output";
  return detail.trim().slice(0, 300) || "no output";
}

export interface ActionResult {
  ok: boolean;
  op: Op | null;
  error: string | null;
  pending: boolean;
}

export type RunAction = (label: string, start: () => Promise<unknown>) => Promise<ActionResult>;

/**
 * The one way this tab performs an action: run it, settle its op, toast on failure, and
 * always refresh state afterwards so the panel agrees with the server again.
 */
export function useOpRunner(): RunAction {
  const act = useAction();
  return useCallback<RunAction>(
    async (label, start) => {
      let result: ActionResult = { ok: false, op: null, error: null, pending: false };
      try {
        await act(async () => {
          const started = await start();
          if (!isOp(started)) {
            result = { ok: true, op: null, error: null, pending: false };
            return;
          }
          const settled = isSettledOp(started) ? started : await settleOp(started);
          if (settled.state === "failed") {
            const message = `${label} failed: ${opFailureText(settled)}`;
            toastError(message);
            result = { ok: false, op: settled, error: message, pending: false };
            return;
          }
          if (!isSettledOp(settled)) {
            toastInfo(`${label} is still running`);
            result = { ok: true, op: settled, error: null, pending: true };
            return;
          }
          result = { ok: true, op: settled, error: null, pending: false };
        });
      } catch (err) {
        const message = `${label} failed: ${errorText(err)}`;
        toastError(message);
        result = { ok: false, op: null, error: message, pending: false };
      }
      return result;
    },
    [act],
  );
}

// ---------- optimistic patches ----------

function patchState(fn: (state: ConsoleState) => ConsoleState): void {
  consoleLink.patchState(fn);
}

/** Move a card locally so it leaves its lane the moment the button is pressed. */
export function patchRequest(rid: string, patch: Partial<Request>): void {
  patchState((state) => ({
    ...state,
    requests: state.requests.map((request) => (request.id === rid ? { ...request, ...patch } : request)),
  }));
}

/** Mark a request settled now, which is what starts the 2-minute fade. */
export function optimisticSettle(rid: string, state: Request["state"], answer?: string): void {
  patchRequest(rid, {
    state,
    settledAt: new Date().toISOString(),
    ...(answer === undefined ? {} : { answer }),
  });
}

export function patchSession(id: string, patch: Partial<Session>): void {
  patchState((state) => ({
    ...state,
    sessions: state.sessions.map((session) => (session.id === id ? { ...session, ...patch } : session)),
  }));
}
