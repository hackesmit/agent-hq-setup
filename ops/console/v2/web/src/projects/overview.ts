// Projects overview logic: attention ordering, filter chips and the burn-up sparkline
// path. Pure on purpose (design 4.2 sorts "blocked and needs-you first"), so the order a
// card lands in is a unit test, not a thing you eyeball on the grid.

import type { ProjectSummary } from "@shared/api";

export type Attention = ProjectSummary["attention"];

/** Sort key. Lower comes first: what wants the owner, then what is stuck, then the rest. */
export const ATTENTION_RANK: Record<Attention, number> = {
  "needs-you": 0,
  blocked: 1,
  late: 2,
  ok: 3,
  quiet: 4,
};

export const ATTENTION_CHIP: Record<Attention, { tone: "bad" | "warn" | "ok" | "mute"; label: string }> = {
  "needs-you": { tone: "bad", label: "waiting on you" },
  blocked: { tone: "bad", label: "blocked" },
  late: { tone: "warn", label: "late" },
  quiet: { tone: "mute", label: "quiet" },
  ok: { tone: "ok", label: "on track" },
};

/**
 * Attention first, then the loudest project inside a band (needs-you count, then blocked
 * count), then name so the grid never reshuffles on equal input.
 */
export function sortProjects(projects: readonly ProjectSummary[]): ProjectSummary[] {
  return [...projects].sort(
    (a, b) =>
      ATTENTION_RANK[a.attention] - ATTENTION_RANK[b.attention] ||
      b.needsYou - a.needsYou ||
      b.counts.blocked - a.counts.blocked ||
      a.name.localeCompare(b.name),
  );
}

export const PROJECT_FILTERS = ["all", "work", "personal", "rigs", "non-code", "paused"] as const;
export type ProjectFilter = (typeof PROJECT_FILTERS)[number];

export const FILTER_LABELS: Record<ProjectFilter, string> = {
  all: "All",
  work: "Work",
  personal: "Personal",
  rigs: "Rigs",
  "non-code": "Non-code",
  paused: "Paused",
};

/**
 * "all" hides paused projects (they are noise on the working grid); "paused" is the only
 * way to see them, which is why it is a filter rather than a sort band. "work" and
 * "personal" read the registry's sphere field; a project with no sphere shows only
 * under "all", so an unclassified entry is visibly unclassified rather than guessed.
 */
export function matchesFilter(project: ProjectSummary, filter: ProjectFilter): boolean {
  switch (filter) {
    case "work":
      return project.sphere === "work" && project.status !== "paused";
    case "personal":
      return project.sphere === "personal" && project.status !== "paused";
    case "rigs":
      return project.kind === "rig" && project.status !== "paused";
    case "non-code":
      return project.kind !== "rig" && project.status !== "paused";
    case "paused":
      return project.status === "paused";
    case "all":
    default:
      return project.status !== "paused";
  }
}

export function filterProjects(
  projects: readonly ProjectSummary[],
  filter: ProjectFilter,
): ProjectSummary[] {
  return sortProjects(projects.filter((project) => matchesFilter(project, filter)));
}

export function filterCounts(projects: readonly ProjectSummary[]): Record<ProjectFilter, number> {
  const counts = { all: 0, work: 0, personal: 0, rigs: 0, "non-code": 0, paused: 0 } as Record<ProjectFilter, number>;
  for (const filter of PROJECT_FILTERS) {
    counts[filter] = projects.filter((project) => matchesFilter(project, filter)).length;
  }
  return counts;
}

// ---------- activity chart ----------

export interface ActivityBar {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The count this bar stands for, so a tooltip does not have to re-derive it. */
  value: number;
}

export interface ActivityGeometry {
  bars: ActivityBar[];
  width: number;
  height: number;
  /** Tallest day in the window, which is what the height is scaled against. */
  peak: number;
}

export const SPARK_WIDTH = 300;
export const SPARK_HEIGHT = 36;
const GAP = 1;
/** A day with activity never renders as nothing; one is visibly not zero. */
const MIN_BAR = 1.5;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * One column per day in a fixed 300x36 viewBox (the card stretches it with
 * preserveAspectRatio="none").
 *
 * Scaled against the window's own peak, not a shared axis: these cards sit next to
 * each other and a rig that merges forty times a week would flatten every other one
 * to a hairline. So height compares a project against ITSELF over the month, and the
 * caption carries the absolute number. A zero day is drawn as nothing at all, which
 * is the whole point of moving off a cumulative line: gaps have to look like gaps.
 */
export function activityGeometry(
  values: readonly number[],
  width: number = SPARK_WIDTH,
  height: number = SPARK_HEIGHT,
): ActivityGeometry {
  if (values.length === 0) return { bars: [], width, height, peak: 0 };
  const usable = (value: number): boolean => Number.isFinite(value) && value > 0;
  const peak = values.reduce((best, value) => (usable(value) && value > best ? value : best), 0);
  if (peak === 0) return { bars: [], width, height, peak: 0 };
  // Slots come from the ORIGINAL length, and a bad sample is skipped in place rather
  // than filtered out. Compacting the array first moved every later day one slot to
  // the left, so a single NaN silently redrew the month against the wrong dates.
  const slot = width / values.length;
  const barWidth = Math.max(0.5, slot - GAP);
  const bars: ActivityBar[] = [];
  values.forEach((value, index) => {
    if (!usable(value)) return;
    const h = Math.max(MIN_BAR, (value / peak) * height);
    bars.push({
      x: round(index * slot),
      y: round(height - h),
      width: round(barWidth),
      height: round(h),
      value,
    });
  });
  return { bars, width, height, peak };
}

/** Total over the window: the number the caption states. */
export function activityTotal(values: readonly number[]): number {
  return values.filter((value) => Number.isFinite(value) && value > 0).reduce((sum, value) => sum + value, 0);
}

/** What the caption calls the thing it counted. */
export function activityLabel(total: number, source: "commits" | "beads"): string {
  const noun = source === "commits" ? "commit" : "bead closed";
  if (total === 1) return `1 ${noun} in 30 days`;
  return source === "commits" ? `${total} commits in 30 days` : `${total} beads closed in 30 days`;
}

// ---------- project page tiles ----------

export interface Milestone {
  id: string;
  title: string;
  due: string | null;
  children: number;
  closed: number;
}

/**
 * Milestone percent for the tiles: children closed over children total, across every epic
 * that has a due date (design 4.2: "a milestone is an epic with a due date"). Falls back
 * to all epics when none carries a due date, and returns null when there is nothing to
 * measure rather than a misleading 0 or 100.
 */
export function milestoneProgress(epics: readonly Milestone[]): {
  pct: number;
  closed: number;
  total: number;
  lead: Milestone | null;
} | null {
  const dated = epics.filter((epic) => epic.due !== null);
  const pool = (dated.length > 0 ? dated : epics).filter((epic) => epic.children > 0);
  if (pool.length === 0) return null;
  const closed = pool.reduce((sum, epic) => sum + Math.min(epic.closed, epic.children), 0);
  const total = pool.reduce((sum, epic) => sum + epic.children, 0);
  const lead =
    [...pool].sort((a, b) => {
      if (a.due === b.due) return a.title.localeCompare(b.title);
      if (a.due === null) return 1;
      if (b.due === null) return -1;
      return a.due.localeCompare(b.due);
    })[0] ?? null;
  return { pct: total === 0 ? 0 : Math.round((closed / total) * 100), closed, total, lead };
}

/** Whole days from now to an ISO date; negative when the date is in the past. */
export function daysUntil(iso: string | null, nowMs: number = Date.now()): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return Math.round((at - nowMs) / 86_400_000);
}
