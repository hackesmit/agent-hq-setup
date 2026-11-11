// REST calls for the project drill-down (contract: ops/console/v2/shared/api.ts, the
// "Phase 1 additions" block). These live here rather than in data/client.ts because the
// projects feature owns them; when the phase settles they should fold into the shared
// `api` object (noted in the handoff).
//
// The request shape mirrors data/client.ts on purpose: same base, same CSRF header on
// POST, same ApiError, so a caller cannot tell which module made the call.

import type { Bead, FlowGraph, ProcessChartInfo, ProcessChartSource, ProjectDetail, TimelineItem, TruthEntry, TruthsDoc } from "@shared/api";
import { API_BASE, ApiError, bootKey } from "../data/client";

export interface DocPayload {
  name: string;
  markdown: string;
  path: string;
  updatedAt: string | null;
}

export type DocName = "knowledge" | "hub" | "decisions";

export const DOC_LABELS: Record<DocName, string> = {
  knowledge: "Knowledge.md",
  hub: "Hub _index.md",
  decisions: "DECISIONS.md",
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, { credentials: "same-origin", ...init });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const message =
      typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}

function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: "GET", signal });
}

function post<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "X-Console-Key": bootKey(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
}

const id = encodeURIComponent;

export const projectsApi = {
  detail: (project: string, signal?: AbortSignal) => get<ProjectDetail>(`/api/projects/${id(project)}`, signal),

  beads: (project: string, status?: Bead["status"], signal?: AbortSignal) =>
    get<Bead[]>(`/api/projects/${id(project)}/beads${status ? `?status=${id(status)}` : ""}`, signal),

  timeline: (project: string, signal?: AbortSignal) =>
    get<TimelineItem[]>(`/api/projects/${id(project)}/timeline`, signal),

  /**
   * No epic: the project's idea level. With one: that epic's children. A focus
   * bead with no epic opens the epic that bead sits on (the server resolves it).
   */
  flow: (project: string, epic: string | null, focus: string | null = null, signal?: AbortSignal) => {
    const q = [epic ? `epic=${id(epic)}` : "", focus ? `focus=${id(focus)}` : ""].filter(Boolean).join("&");
    return get<FlowGraph>(`/api/projects/${id(project)}/flow${q ? `?${q}` : ""}`, signal);
  },

  flowCharts: (project: string, signal?: AbortSignal) =>
    get<ProcessChartInfo[]>(`/api/projects/${id(project)}/flows`, signal),

  flowChart: (project: string, name: string, signal?: AbortSignal) =>
    get<ProcessChartSource>(`/api/projects/${id(project)}/flows/${id(name)}`, signal),

  truths: (project: string, signal?: AbortSignal) => get<TruthsDoc>(`/api/projects/${id(project)}/truths`, signal),

  /** 409 (ApiError.status) means the revision moved: reload and let the operator reapply. */
  saveTruths: (project: string, rev: number, entries: TruthEntry[], signal?: AbortSignal) =>
    post<TruthsDoc>(`/api/projects/${id(project)}/truths`, { rev, entries }, signal),

  doc: (project: string, name: DocName, signal?: AbortSignal) =>
    get<DocPayload>(`/api/projects/${id(project)}/doc?name=${id(name)}`, signal),

  /**
   * Drag-to-set-due. Not implemented server side yet (phase 1 lead owns it), so the UI
   * action stays behind FEATURES.timelineDueDrag until the route answers.
   */
  setBeadDue: (project: string, bead: string, due: string | null, signal?: AbortSignal) =>
    post<Bead>(`/api/projects/${id(project)}/beads/${id(bead)}`, { due }, signal),
};

export function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return `${error.status}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "request failed";
}
