// Stack tab model (bead hq-fn4n): pure sorting, filtering and labels for the
// collector's report. The window is a client-side pick; the server ships all
// three so switching costs nothing.

import type { StackItem, StackReport, StackVerdict } from "@shared/api";
import type { ChipTone } from "../ui/primitives";

export type StackWindow = "7" | "30" | "90";

export const VERDICT_TONE: Record<StackVerdict, ChipTone> = {
  value: "ok",
  friction: "warn",
  "low-use": "warn",
  unused: "mute",
  stale: "bad",
  quiet: "mute",
};

export const KIND_LABEL: Record<StackItem["kind"], string> = {
  tool: "tool",
  cli: "CLI",
  skill: "skill",
  hook: "hook",
  mcp: "MCP",
  "mcp-profile": "MCP profile",
  agent: "agent",
  domain: "domain",
  automation: "automation",
};

export function sortedItems(report: StackReport | null, window: StackWindow, kind: string): StackItem[] {
  if (!report) return [];
  return report.items
    .filter((item) => (kind ? item.kind === kind : true))
    .slice()
    .sort(
      (a, b) =>
        b.windows[window].uses - a.windows[window].uses ||
        b.blocks90 - a.blocks90 ||
        a.id.localeCompare(b.id),
    );
}

export function kindsOf(report: StackReport | null): string[] {
  if (!report) return [];
  return [...new Set(report.items.map((item) => item.kind))].sort();
}

/** The one-line evidence summary per item. */
export function signalOf(item: StackItem, window: StackWindow): string {
  const w = item.windows[window];
  const bits: string[] = [];
  if (item.kind === "hook") {
    bits.push(item.blocks90 ? `${item.blocks90} blocks (90d)` : "no blocks seen");
    if (item.topBlockReason) bits.push(`top: ${item.topBlockReason}`);
  } else if (w.errors > 0) {
    bits.push(`${w.errors} errors of ${w.uses}`);
  }
  if (item.stale) bits.push(item.stale);
  if (item.detail) bits.push(item.detail);
  if (item.unstamped > 0) bits.push(`${item.unstamped} all-time (unstamped)`);
  return bits.join("; ") || "clean";
}

export function pendingDecisions(report: StackReport | null): number {
  if (!report) return 0;
  return report.items.filter(
    (item) => (item.verdictHint === "unused" || item.verdictHint === "stale") && item.acquisitions.length === 0,
  ).length;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
