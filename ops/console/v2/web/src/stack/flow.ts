// Flow panel's pure model (bead hq-3y18): formatting and row shaping for the
// lead-time / blocked-share / rework numbers. Numbers for the retro, never
// triggers, which is why nothing in here fires an action.

import type { FlowReport, FlowRig, FlowWindow } from "@shared/api";

export type FlowWindowKey = "7" | "30" | "90";

/** Seconds to a human span: 42s, 38m, 5.2h, 2.3d. Null stays a dash. */
export function fmtDur(s: number | null): string {
  if (s == null || !Number.isFinite(s) || s < 0) return "-";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

/** A 0..1 share to a percentage, one decimal only when it matters. */
export function fmtShare(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const pct = v * 100;
  return `${pct < 10 && pct !== 0 ? pct.toFixed(1) : Math.round(pct)}%`;
}

export interface FlowRow {
  rig: string;
  closed: number;
  medianLead: string;
  p90Lead: string;
  blockedShare: string;
  /** blocked share as a number for the warn tint, null when unknown */
  blockedRaw: number | null;
  reopened: number;
  reworkShare: string;
  /** weekly median leads for the sparkline; gaps become 0 so the line stays drawable */
  trend: number[];
  /** how many weekly buckets actually had closes (a 1-point trend is noise) */
  trendWeeks: number;
}

/** Rigs with any closes in the window first, busiest first; idle rigs kept but last. */
export function flowRows(report: FlowReport | null, window: FlowWindowKey): FlowRow[] {
  if (!report) return [];
  const rows = report.rigs.map((rig: FlowRig) => {
    const w: FlowWindow = rig.windows[window];
    return {
      rig: rig.rig,
      closed: w.closed,
      medianLead: fmtDur(w.medianLeadS),
      p90Lead: fmtDur(w.p90LeadS),
      blockedShare: fmtShare(w.blockedShare),
      blockedRaw: w.blockedShare,
      reopened: w.reopened,
      reworkShare: fmtShare(w.reworkShare),
      trend: rig.weekly.map((wk) => wk.medianLeadS ?? 0),
      trendWeeks: rig.weekly.filter((wk) => wk.closed > 0).length,
    };
  });
  return rows.sort((a, b) => (b.closed - a.closed) || a.rig.localeCompare(b.rig));
}

/**
 * The one-line reading of the numbers, because the point of time-in-status is
 * the inference: blocked time dominating means the bottleneck is the owner's
 * attention, and the fix is queue policy, not more workers.
 */
export function flowHint(report: FlowReport | null, window: FlowWindowKey): string | null {
  if (!report) return null;
  const rows = flowRows(report, window).filter((r) => r.closed > 0);
  if (rows.length === 0) return null;
  const worst = rows.reduce((a, b) => ((b.blockedRaw ?? -1) > (a.blockedRaw ?? -1) ? b : a));
  if (worst.blockedRaw != null && worst.blockedRaw >= 0.5) {
    return `${worst.rig} spent ${fmtShare(worst.blockedRaw)} of its active time blocked: the queue is waiting on you, not on workers.`;
  }
  return null;
}
