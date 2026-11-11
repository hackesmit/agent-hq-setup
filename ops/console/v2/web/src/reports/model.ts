// Reports tab model (bead hq-o6wn.5): the pure half of the tab, so the tests can pin it
// without a DOM. The store and its API are hq-o6wn.1 and hq-o6wn.4; the contract is the
// "reports" block in shared/api.ts.

import type { ReportDetail, ReportHeader, ReportKind, ReportsSummary } from "@shared/api";
import type { ChipTone } from "../ui/primitives";
import { fmtDayStamp } from "../ui/format";
import { beadPath as projectBeadPath } from "../app/routes";

// Error, digest, fixed and logged mail live on the Errors tab, not here.
export const REPORT_KINDS: readonly ReportKind[] = [
  "escalate",
  "reply",
  "security",
  "stack",
  "retro",
];

export const KIND_LABELS: Record<ReportKind, string> = {
  error: "Error",
  escalate: "Escalate",
  digest: "Digest",
  fixed: "Fixed",
  logged: "Logged",
  reply: "Reply",
  security: "Security",
  stack: "Stack",
  retro: "Retro",
};

const KIND_TONE: Record<ReportKind, ChipTone> = {
  error: "bad",
  escalate: "bad",
  digest: "default",
  fixed: "ok",
  logged: "mute",
  reply: "accent",
  security: "warn",
  stack: "default",
  retro: "default",
};

/** An unknown kind (a newer store than this build) still gets a chip, just a plain one. */
export function kindTone(kind: string): ChipTone {
  return (KIND_TONE as Record<string, ChipTone>)[kind] ?? "default";
}

export function kindLabel(kind: string): string {
  return (KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

export type SeverityTone = "p0" | "p1" | "p2" | "info";

/** The colour of the bar on a row. Anything the store did not name is info. */
export function severityTone(severity: string | null | undefined): SeverityTone {
  if (severity === "P0") return "p0";
  if (severity === "P1") return "p1";
  if (severity === "P2") return "p2";
  return "info";
}

// ---------- filters and the list query ----------

export interface ReportsFilter {
  kind: ReportKind | null;
  unread: boolean;
}

export const NO_FILTER: ReportsFilter = { kind: null, unread: false };

export const PAGE_SIZE = 100;
/** The server's own cap on one page (server/src/reports.js). */
export const MAX_LIMIT = 200;

/** The query string for GET /api/reports. Only what the server reads, nothing else. */
export function listQuery(filter: ReportsFilter, offset = 0, limit: number = PAGE_SIZE): string {
  const parts: string[] = [];
  if (filter.kind) parts.push(`kind=${encodeURIComponent(filter.kind)}`);
  if (filter.unread) parts.push("unread=1");
  parts.push(`limit=${limit}`);
  if (offset > 0) parts.push(`offset=${offset}`);
  return `?${parts.join("&")}`;
}

/** Whether a header passes the filter, so a local read mark can drop it from "Unread". */
export function passes(item: ReportHeader, filter: ReportsFilter): boolean {
  if (filter.kind && item.kind !== filter.kind) return false;
  if (filter.unread && item.read) return false;
  return true;
}

// ---------- grouping by day ----------

export interface DayGroup {
  key: string; // local YYYY-MM-DD
  label: string;
  items: ReportHeader[];
}

function localKey(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
}

export function dayLabel(date: Date, now: Date = new Date()): string {
  const key = localKey(date);
  if (key === localKey(now)) return "Today";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (key === localKey(yesterday)) return "Yesterday";
  const stamp = fmtDayStamp(date);
  return date.getFullYear() === now.getFullYear() ? stamp : `${stamp} ${date.getFullYear()}`;
}

/**
 * Newest first, one group per local day. The server already sorts newest first; this
 * sorts again so a page merged with the next one, or a mock, cannot come out of order.
 * A header whose time does not parse goes to an "Undated" group at the end.
 */
export function groupByDay(items: readonly ReportHeader[], now: Date = new Date()): DayGroup[] {
  const dated: { item: ReportHeader; ts: number }[] = [];
  const undated: ReportHeader[] = [];
  for (const item of items) {
    const ts = Date.parse(item.created);
    if (Number.isFinite(ts)) dated.push({ item, ts });
    else undated.push(item);
  }
  dated.sort((a, b) => b.ts - a.ts);
  const groups: DayGroup[] = [];
  for (const { item, ts } of dated) {
    const date = new Date(ts);
    const key = localKey(date);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(date, now), items: [item] });
  }
  if (undated.length > 0) groups.push({ key: "undated", label: "Undated", items: undated });
  return groups;
}

/** "07:15" in local time for a row; the day is already the group heading. */
export function rowTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Merge a further page onto what is shown, dropping ids already present. */
export function mergePage(shown: readonly ReportHeader[], next: readonly ReportHeader[]): ReportHeader[] {
  const ids = new Set(shown.map((item) => item.id));
  return [...shown, ...next.filter((item) => !ids.has(item.id))];
}

/** Mark one id read in a list, returning the same array when nothing changed. */
export function markReadLocally(items: ReportHeader[], id: string): ReportHeader[] {
  if (!items.some((item) => item.id === id && !item.read)) return items;
  return items.map((item) => (item.id === id ? { ...item, read: true } : item));
}

// ---------- the summary line ----------

/**
 * The unread figure as text. A null count means the store could not be read
 * (hq-o6wn.4 review): that is said in words, never shown as zero.
 */
export function unreadText(summary: ReportsSummary | null | undefined): { text: string; unavailable: boolean } {
  if (!summary) return { text: "store not loaded", unavailable: true };
  if (summary.unread === null || summary.total === null) return { text: "store unavailable", unavailable: true };
  if (summary.unread === 0) return { text: `all ${summary.total} read`, unavailable: false };
  return { text: `${summary.unread} unread of ${summary.total}`, unavailable: false };
}

// ---------- the reading view ----------

export type BodyMode = "html" | "markdown" | "text";

/**
 * How a report body is shown. Mail with an html part shows that part (sanitized on the
 * server, rebuilt again here without innerHTML). The file reports (stack usage, the
 * retro) are markdown. Everything else is a plain mail body: its line breaks are the
 * layout, and a markdown pass would fold them into one paragraph.
 */
export function bodyMode(report: Pick<ReportDetail, "kind" | "source" | "body_html">): BodyMode {
  if (report.body_html) return "html";
  if (report.kind === "stack" || report.kind === "retro" || /\.md$/i.test(report.source)) return "markdown";
  return "text";
}

/** Mail bodies arrive with CRLF; the reader wants plain newlines. */
export function plainBody(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

// A bead id named in the report: "bead hq-o6wn.5" or a dotted child id. A bare
// "word-word" is not taken, because project names look exactly like bead ids.
const BEAD_AFTER_WORD = /\bbeads?[\s:#]+([a-z][a-z0-9]{1,15}-[a-z0-9]{3,6}(?:\.\d{1,3})*)\b/i;
const BEAD_DOTTED = /\b([a-z][a-z0-9]{1,15}-[a-z0-9]{3,6}\.\d{1,3}(?:\.\d{1,3})*)\b/;

export function findBead(...texts: (string | null | undefined)[]): string | null {
  for (const text of texts) {
    if (!text) continue;
    const named = BEAD_AFTER_WORD.exec(text);
    if (named) return named[1]!.toLowerCase();
  }
  for (const text of texts) {
    if (!text) continue;
    const dotted = BEAD_DOTTED.exec(text);
    if (dotted) return dotted[1]!;
  }
  return null;
}

/** Where the bead link goes: its project's page with that bead open in the beads list. */
export function beadPath(project: string, bead: string): string {
  const prefix = bead.split("-")[0] ?? "";
  const target = project || prefix || "hq";
  return projectBeadPath(target, bead);
}

export function fullTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const d = new Date(ts);
  return `${fmtDayStamp(d)} ${d.getFullYear()}, ${rowTime(iso)}`;
}
