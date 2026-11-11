// Board logic, pure so the grouping and the row order are unit tests rather than
// something you eyeball. The server already sorts (board.js sortBoard); this
// splits that order into the bands the page draws and decides what a row says.

import type { BoardItem, BoardProject } from "@shared/api";

export interface BoardGroups {
  work: BoardProject[];
  personal: BoardProject[];
  paused: BoardProject[];
}

/** Paused and done projects leave the working bands whatever their sphere; an
 *  unclassified project reads as personal rather than vanishing. */
export function groupBoard(projects: readonly BoardProject[]): BoardGroups {
  const out: BoardGroups = { work: [], personal: [], paused: [] };
  for (const p of projects) {
    if (p.status !== "active") out.paused.push(p);
    else if (p.sphere === "work") out.work.push(p);
    else out.personal.push(p);
  }
  return out;
}

export type Mark = "done" | "moving" | "blocked" | "todo";

/** The box drawn before a checklist row. */
export function markOf(item: BoardItem): Mark {
  if (item.status === "closed") return "done";
  if (item.status === "in_progress") return "moving";
  if (item.status === "blocked") return "blocked";
  return "todo";
}

/** One line that says where the project stands, for the row header. */
export function stateLine(p: BoardProject): string {
  if (p.error) return "ledger unreachable";
  if (p.needsYou > 0) return `${p.needsYou} waiting on you`;
  if (p.counts.blocked > 0) return `${p.counts.blocked} blocked`;
  if (p.next && p.next.status === "in_progress") return "in motion";
  if (p.next) return "ready to start";
  if (p.doneTotal === 0 && p.todoTotal === 0) return "no ledger work";
  if (p.todoTotal === 0) return "nothing open";
  return "quiet";
}

/** How many rows the card hides past the cap, phrased for the footer. */
export function moreLabel(shown: number, total: number, noun: string): string | null {
  const rest = total - shown;
  if (rest <= 0) return null;
  return `and ${rest} more ${noun}`;
}

/** Projects with any of these need a glance; the tab badge counts them. */
export function attentionCount(projects: readonly BoardProject[]): number {
  return projects.filter((p) => p.status === "active" && (p.needsYou > 0 || p.counts.blocked > 0)).length;
}
