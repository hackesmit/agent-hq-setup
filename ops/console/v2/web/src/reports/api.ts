// REST calls for the Reports tab (contract: shared/api.ts, the "reports" block; server:
// server/src/reports.js). GETs mirror projects/api.ts; the POSTs go through data/client's
// postJson so they carry the boot key and the 403 {reload:true} re-key handling.

import type { ReportDetail, ReportsPage, ReportsSummary } from "@shared/api";
import { API_BASE, ApiError, postJson } from "../data/client";
import { listQuery, type ReportsFilter } from "./model";

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(API_BASE + path, { credentials: "same-origin", method: "GET", signal });
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

export function listReports(filter: ReportsFilter, offset: number, signal?: AbortSignal, limit?: number): Promise<ReportsPage> {
  return get<ReportsPage>(`/api/reports${listQuery(filter, offset, limit)}`, signal);
}

export function getReport(id: string, signal?: AbortSignal): Promise<ReportDetail> {
  return get<ReportDetail>(`/api/reports/${encodeURIComponent(id)}`, signal);
}

export interface MarkResult {
  ok: boolean;
  total: number | null;
  unread: number | null;
}

/**
 * A mark answers with the new counts. The shell's unread icon takes them at once rather
 * than waiting up to 20 s for the server's next summary push.
 */
export const REPORTS_SUMMARY_EVENT = "hq:reports-summary";

function announce<T extends MarkResult>(result: T): T {
  if (typeof window !== "undefined" && result && "unread" in result) {
    const summary: ReportsSummary = { total: result.total ?? null, unread: result.unread ?? null };
    window.dispatchEvent(new CustomEvent<ReportsSummary>(REPORTS_SUMMARY_EVENT, { detail: summary }));
  }
  return result;
}

export function markRead(id: string): Promise<MarkResult> {
  return postJson<MarkResult>(`/api/reports/${encodeURIComponent(id)}/read`).then(announce);
}

export function markAllRead(kind: string | null): Promise<MarkResult & { marked: number }> {
  return postJson<MarkResult & { marked: number }>("/api/reports/read-all", kind ? { kind } : {}).then(announce);
}
