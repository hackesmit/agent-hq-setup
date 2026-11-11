// Synthetic question cards for unconfirmed assumptions (design 4.2). The
// server marks them with meta.truths; no worker waits on them, so the ctl
// verbs (answer/skip/snooze/sink) must never be sent at their ids. Settling
// one means editing the entry: Confirm here does a read-modify-write through
// the projects truths API, and the card disappears when the collector
// re-reads the file.

import type { Request, TruthEntry, TruthsDoc } from "@shared/api";
import { isConflict, projectsApi } from "../projects/api";

export interface TruthsCardMeta {
  project: string;
  entryId: string;
}

export function truthsCard(request: Request): TruthsCardMeta | null {
  const meta = request.meta as Record<string, unknown> | null | undefined;
  if (!meta || meta.truths !== true) return null;
  const project = typeof meta.project === "string" ? meta.project : null;
  const entryId = typeof meta.entryId === "string" ? meta.entryId : null;
  return project && entryId ? { project, entryId } : null;
}

export interface TruthsApi {
  truths: (project: string) => Promise<TruthsDoc>;
  saveTruths: (project: string, rev: number, entries: TruthEntry[]) => Promise<TruthsDoc>;
}

async function saveConfirmed(project: string, entryId: string, api: TruthsApi): Promise<"confirmed" | "gone"> {
  const doc = await api.truths(project);
  const entry = doc.entries.find((candidate) => candidate.id === entryId);
  if (!entry) return "gone";
  if (!entry.confirmed) {
    const entries = doc.entries.map((candidate) =>
      candidate.id === entryId ? { ...candidate, confirmed: true } : candidate,
    );
    await api.saveTruths(project, doc.rev, entries);
  }
  return "confirmed";
}

/**
 * Flip one assumption to confirmed. A 409 means someone else wrote between the
 * read and the save; one reload-and-retry resolves it, anything after that
 * surfaces as the error it is.
 */
export async function confirmAssumption(
  project: string,
  entryId: string,
  api: TruthsApi = projectsApi,
): Promise<"confirmed" | "gone"> {
  try {
    return await saveConfirmed(project, entryId, api);
  } catch (error) {
    if (isConflict(error)) return saveConfirmed(project, entryId, api);
    throw error;
  }
}
