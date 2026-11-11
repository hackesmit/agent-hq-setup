// Understudy panel's pure model (bead hq-ufx9.4): formatting for the shadow
// predictor's scores. Understudy watches the console's questions, predicts
// each answer silently when the question arrives, and is graded when the owner's
// real answer lands (tools/understudy, proposal 26). Nothing here acts for
// him; these are the scores of watching, shown so the training is checkable.

import type { UnderstudyReport } from "@shared/api";
import { fmtShare } from "./flow";

export interface UnderstudyTile {
  label: string;
  value: string;
  detail?: string;
}

/** A probability-space score to three decimals. Null stays a dash. */
export function fmtScore(v: number | null): string {
  return v == null || !Number.isFinite(v) ? "-" : v.toFixed(3);
}

export function understudyTiles(r: UnderstudyReport | null): UnderstudyTile[] {
  if (!r) return [];
  return [
    { label: "corpus", value: String(r.corpus.answered), detail: "answered questions learned from" },
    { label: "predicted", value: String(r.live.stamped), detail: `${r.live.abstentions} abstained` },
    { label: "graded", value: String(r.live.graded), detail: "scored against his real answer" },
    { label: "accuracy", value: fmtShare(r.live.accuracy), detail: "on graded predictions" },
    { label: "brier", value: fmtScore(r.live.brier), detail: "0 is perfect, 0.25 is coin-flip" },
    { label: "skill", value: fmtScore(r.live.skill), detail: "vs guessing the base rate" },
  ];
}

/** Graded count over time; the sparkline needs two points to draw. */
export function gradedTrend(r: UnderstudyReport | null): number[] {
  return (r?.history ?? []).map((p) => p.graded);
}

export function understudyHint(r: UnderstudyReport | null): string | null {
  if (!r) return null;
  if (r.live.graded === 0) {
    return "Nothing graded yet: it scores once the owner answers a question it predicted first.";
  }
  return null;
}

/** The leave-one-out backtest over the whole corpus, as one quiet line. */
export function backtestLine(r: UnderstudyReport | null): string | null {
  if (!r || r.backtest.n === 0) return null;
  const parts = [
    `coverage ${fmtShare(r.backtest.coverage)}`,
    `accuracy ${fmtShare(r.backtest.accuracy)}`,
    `Brier ${fmtScore(r.backtest.brier)}`,
  ];
  return `backtest over ${r.backtest.n} answered: ${parts.join(", ")}`;
}
