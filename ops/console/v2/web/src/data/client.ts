// Typed REST client for the console server (contract: ops/console/v2/shared/api.ts).
//
// Every POST carries X-Console-Key, the per-boot CSRF key the server injects into
// index.html as window.__CONSOLE_BOOT_KEY__. When the server restarts, the key it
// injected is stale; it answers 403 with {reload:true}. The page then RE-KEYS IN PLACE:
// it fetches a fresh index.html, reads the new key from it and retries the request
// once. Only if that fails does it fall back to a full reload. Every merge to hq main
// restarts the server (52 restarts in 48 h on 2026-11-05), and a full reload per
// restart wiped the page each time, which read as the console going offline (hq-aukwy).
// GETs need no key (the connection itself is already authenticated by the tailnet
// peer check).

import type { ConsoleState, MoneyEntry, Op, UploadEntry, MoneyCommitment, MoneyGoal, MoneyGoalInput } from "@shared/api";

export const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** The key learned by the last in-place re-key; wins over the one the page booted with. */
let rekeyedKey: string | null = null;
let rekeying: Promise<string | null> | null = null;

/** Pull the boot key out of a served index.html, or null when it carries none. */
export function parseBootKey(html: string): string | null {
  const m = /<meta\s+name="console-boot-key"\s+content="([^"]*)"/i.exec(String(html));
  const v = m ? m[1] : "";
  if (!v || v === "__CONSOLE_BOOT_KEY__") return null;
  return v;
}

/**
 * Fetch a fresh index.html (no-store, same origin) and adopt the key in it. Single
 * flight: every request that hits the stale key at once shares one fetch. Resolves to
 * the new key, or null when the server is unreachable or the page carried no key.
 */
export function rekey(): Promise<string | null> {
  if (!rekeying) {
    rekeying = (async () => {
      try {
        const res = await fetch(API_BASE + "/", { credentials: "same-origin", cache: "no-store" });
        if (!res.ok) return null;
        const key = parseBootKey(await res.text());
        if (key) rekeyedKey = key;
        return key;
      } catch {
        return null;
      } finally {
        rekeying = null;
      }
    })();
  }
  return rekeying;
}

/** Test hook: forget a learned key. */
export function resetRekeyForTest(): void {
  rekeyedKey = null;
  rekeying = null;
}

export function bootKey(): string {
  if (rekeyedKey) return rekeyedKey;
  const g0 = globalThis as unknown as { __CONSOLE_BOOT_KEY__?: string; window?: { __CONSOLE_BOOT_KEY__?: string } };
  const g = { __CONSOLE_BOOT_KEY__: g0.window?.__CONSOLE_BOOT_KEY__ ?? g0.__CONSOLE_BOOT_KEY__ };
  if (typeof document === "undefined") return g.__CONSOLE_BOOT_KEY__ ?? "";
  const meta = document.querySelector('meta[name="console-boot-key"]');
  const v = meta ? meta.getAttribute("content") || "" : "";
  // the raw placeholder means the server did not inject a key (dev server without the console)
  if (!v || v === "__CONSOLE_BOOT_KEY__") return g.__CONSOLE_BOOT_KEY__ ?? "";
  return v;
}

/**
 * A 403 {reload:true} means our boot key is stale (server restarted). Reload to
 * fetch a fresh index, but never loop: at most RELOAD_LIMIT reloads per browser
 * session (sessionStorage), then surface a fatal state the shell renders as a
 * banner ("console restarted; reload the page").
 */
const RELOAD_LIMIT = 2;
const RELOAD_KEY = "hq-console-reloads";
let reloading = false;
export type FatalState = { kind: "stale-key"; message: string } | null;
let fatal: FatalState = null;
const fatalListeners = new Set<(f: FatalState) => void>();
export function onFatal(fn: (f: FatalState) => void): () => void {
  fatalListeners.add(fn);
  return () => fatalListeners.delete(fn);
}
export function getFatal(): FatalState { return fatal; }
export function noteHealthyResponse(): void {
  try { if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(RELOAD_KEY); } catch { /* ignore */ }
}
export function reloadOnce(): boolean {
  if (reloading) return true;
  let count = 0;
  try { count = Number(sessionStorage.getItem(RELOAD_KEY) || "0"); } catch { count = 0; }
  if (count >= RELOAD_LIMIT) {
    fatal = { kind: "stale-key", message: "The console restarted and this page cannot re-key itself. Reload the page." };
    fatalListeners.forEach((fn) => fn(fatal));
    return false;
  }
  reloading = true;
  try { sessionStorage.setItem(RELOAD_KEY, String(count + 1)); } catch { /* ignore */ }
  if (typeof window !== "undefined") window.location.reload();
  return true;
}

async function request<T>(path: string, init?: RequestInit, rekeyed = false): Promise<T> {
  const res = await fetch(API_BASE + path, {
    credentials: "same-origin",
    ...init,
  });

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }

  if (res.status === 403 && isReloadHint(body)) {
    // The server restarted under us. Re-key in place and retry once; a reload is the
    // last resort, because it throws away everything on the page.
    if (!rekeyed) {
      const key = await rekey();
      if (key) {
        const headers = { ...((init?.headers as Record<string, string> | undefined) ?? {}), "X-Console-Key": key };
        return request<T>(path, { ...init, headers }, true);
      }
    }
    reloadOnce();
    throw new ApiError(403, "boot key stale, reloading", body);
  }
  if (!res.ok) {
    throw new ApiError(res.status, errorMessage(body) ?? `${res.status} ${res.statusText}`, body);
  }
  // The reload budget counts consecutive failed re-keys, not restarts over the tab's
  // whole life: any healthy answer proves the current key works, so the budget resets.
  // Without this a long-lived tab (the phone PWA) wedged permanently on the third
  // server restart, and every action 403'd with nothing on screen but a fading toast.
  noteHealthyResponse();
  return body as T;
}

function isReloadHint(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { reload?: unknown }).reload === true;
}

function errorMessage(body: unknown): string | null {
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 300);
  if (typeof body === "object" && body !== null) {
    const err = (body as { error?: unknown }).error;
    if (typeof err === "string") return err;
  }
  return null;
}

function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: "GET", signal });
}

/**
 * A GET that carries the per-boot key. Reads are normally unguarded, but a read that
 * starts a privileged process on the box (the branch diffstat, the service logs) is
 * guarded like a mutation, so a page the owner happens to visit cannot keep one
 * spawning.
 */
function getGuarded<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: "GET", headers: { "X-Console-Key": bootKey() }, signal });
}

function post<T>(path: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { "X-Console-Key": bootKey() };
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  return request<T>(path, {
    method: "POST",
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal,
  });
}

/**
 * The one POST path for callers outside this file (now/http.ts re-exports it). Carries
 * the boot key and, crucially, the 403 {reload:true} re-key handling: a bespoke fetch
 * that skips request() also skips the reload, which is how "New terminal" could fail
 * against a restarted server with no recovery.
 */
export function postJson<T>(path: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
  return post<T>(path, payload, signal);
}

/** A POST of raw bytes (Capri Load images) with the boot key and the same re-key handling. */
export function postBytes<T>(path: string, bytes: Blob, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: "POST", headers: { "X-Console-Key": bootKey() }, body: bytes, signal });
}

export type SessionVerb = "focus" | "snooze" | "wake" | "kill" | "finish" | "finish-check" | "name";

export interface MoneyCommitmentInput {
  label: string;
  amountCents: number;
  currency: "MXN" | "USD";
  category: string;
  cadence: "weekly" | "monthly" | "quarterly" | "yearly";
  startsOn: string;
  endsOn?: string;
  client?: string;
  vendor?: string;
  project?: string;
}

export const api = {
  state: (signal?: AbortSignal) => get<ConsoleState>("/api/state", signal),
  slice: <K extends keyof ConsoleState>(name: K, signal?: AbortSignal) =>
    get<ConsoleState[K]>(`/api/state/${String(name)}`, signal),

  wsToken: () => post<{ token: string; expiresInS: number }>("/api/ws-token"),

  answer: (rid: string, text: string) => post<Op>("/api/answer", { rid, text }),
  resolve: (rid: string, reason?: string) => post<Op>("/api/resolve", { rid, reason }),
  done: (rid: string) => post<Op>("/api/done", { rid }),
  skip: (rid: string, reason: string) => post<Op>("/api/skip", { rid, reason }),
  reqSnooze: (rid: string, until: string) => post<Op>("/api/req-snooze", { rid, until }),
  reqUnsnooze: (rid: string) => post<Op>("/api/req-unsnooze", { rid }),
  reqClear: (rid: string) => post<Op>("/api/req-clear", { rid }),
  sink: (rid: string, top?: boolean) => post<Op>("/api/sink", { rid, top }),


  dispatch: (rig: string, bead: string, model: string) => post<Op>("/api/dispatch", { rig, bead, model }),
  dispatchBatch: (rig: string, beads: string[], model: string) =>
    post<Op>("/api/dispatch-batch", { rig, beads, model }),

  session: (id: string, verb: SessionVerb, payload?: unknown) =>
    post<Op>(`/api/session/${encodeURIComponent(id)}/${verb}`, payload),

  phase: (bead: string, phase: string, done: boolean) => post<Op>("/api/phase", { bead, phase, done }),
  capture: (rig: string, title: string, body?: string) => post<Op>("/api/capture", { rig, title, body }),
  stackKeep: (item: string, bead?: string | null, note?: string) =>
    post<Op>("/api/stack-keep", { item, bead: bead || undefined, note }),
  stackRevert: (item: string, bead?: string | null, note?: string) =>
    post<Op>("/api/stack-revert", { item, bead: bead || undefined, note }),
  serviceLogs: (id: string, n = 50) =>
    getGuarded<{ id: string; lines: string[] }>(`/api/service/${encodeURIComponent(id)}/logs?n=${n}`),
  serviceRestart: (service: string, op: string) => post<Op>("/api/service-restart", { service, op }),
  mailSwitch: (sw: "disabled" | "log-only", on: boolean, op: string) =>
    post<Op>("/api/mail-switch", { switch: sw, on, op }),
  moneyEntry: (
    op: string,
    amountCents: number,
    currency: "MXN" | "USD",
    category: string,
    note?: string,
    tags?: { client?: string; vendor?: string; project?: string },
  ) => post<MoneyEntry>("/api/money/entry", { op, amountCents, currency, category, note, ...(tags ?? {}) }),
  moneyDelete: (op: string, target: string) => post<{ ok: boolean; target: string }>("/api/money/delete", { op, target }),
  // A commitment is a schedule, not money that moved, so it gets its own pair of
  // routes rather than a flag on the entry ones.
  moneyCommitment: (op: string, body: MoneyCommitmentInput) =>
    post<MoneyCommitment>("/api/money/commitment", { op, ...body }),
  moneyCommitmentCancel: (op: string, target: string) =>
    post<{ ok: boolean; target: string }>("/api/money/commitment/cancel", { op, target }),
  // A goal is a yardstick, not money: its own store on the server, its own pair.
  moneyGoal: (op: string, body: MoneyGoalInput) => post<MoneyGoal>("/api/money/goal", { op, ...body }),
  moneyGoalDelete: (op: string, target: string) =>
    post<{ ok: boolean; target: string }>("/api/money/goal/delete", { op, target }),

  ackAlert: (id: string) => post<Op>(`/api/alerts/${encodeURIComponent(id)}/ack`),
  op: (id: string) => get<Op>(`/api/op/${encodeURIComponent(id)}`),
  uploads: (date: string) => get<UploadEntry[]>(`/api/uploads?date=${encodeURIComponent(date)}`),
  diffstat: (id: string) => getGuarded<import("../now/handoff").Diffstat>(`/api/session/${encodeURIComponent(id)}/diffstat`),
  seen: () => get<{ at: string | null }>("/api/seen"),
  markSeen: (at?: string) => post<{ at: string | null }>("/api/seen", at ? { at } : {}),
  artifacts: () => get<import("../now/Artifacts").ArtifactRow[]>("/api/artifacts"),
  orchestrator: () => get<import("@shared/api").OrchestratorReport>("/api/orchestrator"),
  orchestratorLoad: (id: string) => post<{ ok: boolean; id: string }>("/api/orchestrator/load", { id }),
  orchestratorUnload: (id: string) => post<{ ok: boolean; id: string }>("/api/orchestrator/unload", { id }),
  notes: () => get<import("../now/Notes").StickyNote[]>("/api/notes"),
  noteCreate: (body: Partial<import("../now/Notes").StickyNote>) => post<import("../now/Notes").StickyNote>("/api/notes", body),
  noteUpdate: (id: string, body: Partial<import("../now/Notes").StickyNote>) =>
    post<import("../now/Notes").StickyNote>(`/api/notes/${encodeURIComponent(id)}`, body),
  noteDelete: (id: string) => post<{ ok: boolean; id: string }>(`/api/notes/${encodeURIComponent(id)}/delete`, {}),
  metaStatus: () => get<import("@shared/api").MetaStatus>("/api/meta/status"),
  passkeyRegisterOptions: (capability?: string) => post<unknown>("/api/passkey/register/options", capability ? { capability } : {}),
  passkeyRegister: (response: unknown, expectedChallenge: string, label?: string) =>
    post<{ verified: boolean; count: number }>("/api/passkey/register", { response, expectedChallenge, label }),
  passkeyAssertOptions: () => post<unknown>("/api/passkey/assert/options", {}),
  passkeyAssert: (response: unknown, expectedChallenge: string) =>
    post<{ capability: string; expiresInS: number }>("/api/passkey/assert", { response, expectedChallenge }),
  metaNew: (capability: string) => post<{ ok: boolean; sid: string }>("/api/meta/new", { capability }),
};

export type Api = typeof api;
