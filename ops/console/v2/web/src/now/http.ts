// The three Now-tab endpoints the shared REST client does not expose as api.* verbs yet:
// POST /api/session/new, POST /api/uploads/:id/keep and POST /api/uploads/:id/delete
// (contract: shared/api.ts, "Phase 1 additions"). They delegate to data/client's
// postJson rather than carrying their own fetch: the shared path is what handles the
// 403 {reload:true} re-key when the server has restarted, and a bespoke fetch here is
// exactly how "New terminal" once failed with no recovery on a stale boot key.

import type { UploadEntry } from "@shared/api";
import { postJson } from "../data/client";

/** Spawn an interactive session through the runner (contract: POST /api/session/new). */
export function newSession(rig: string | null, cwd?: string): Promise<unknown> {
  const payload: Record<string, unknown> = { kind: "interactive" };
  if (rig) payload.rig = rig;
  if (cwd) payload.cwd = cwd;
  return postJson<unknown>("/api/session/new", payload);
}

/**
 * Start the orchestrator chat terminal (hq-4npjr.11): the server picks ~/hq, the
 * decide model from ops/config/orchestrator.json and the seed, names the card, and
 * answers 409 while one is live or starting.
 */
export function startOrchestrator(): Promise<unknown> {
  return postJson<unknown>("/api/session/new", { kind: "interactive", role: "orchestrator" });
}

/** Pin an upload against the 30-day sweep, or unpin it. */
export function keepUpload(id: string, keep: boolean): Promise<UploadEntry> {
  return postJson<UploadEntry>(`/api/uploads/${encodeURIComponent(id)}/keep`, { keep });
}

/** Delete the bytes; the idempotency row stays, so the id answers "gone" afterwards. */
export function deleteUpload(id: string): Promise<{ ok: boolean }> {
  return postJson<{ ok: boolean }>(`/api/uploads/${encodeURIComponent(id)}/delete`);
}
