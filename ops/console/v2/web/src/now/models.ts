// Model routing for dispatch.
//
// The bead's own Model: field wins when it has one (CLAUDE.md: "Honor the bead's Model:
// field at dispatch"). Otherwise the picker defaults from the routing rule: the current
// Opus (5.5) for complex or risky work and for the unsure case, the current Sonnet (5.5)
// for moderate and simple beads, and "when unsure, size up, not down". Haiku 5.5 is
// selectable but never a default until five trivial beads have run on it (stack refresh
// 2026-10-08, hq-rvn6.1; proposal 57 carries the CLAUDE.md wording).

import type { ReadyBead } from "@shared/api";

export interface ModelOption {
  id: string;
  label: string;
}

export const MODELS: ModelOption[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  { id: "claude-fable-5-1", label: "Fable 5.1" },
  // previous generation, still served; selectable so an old Model: field resolves
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-fable-5", label: "Fable 5" },
];

export const OPUS_55 = "claude-opus-5-5";
export const SONNET_55 = "claude-sonnet-5-5";
export const HAIKU_55 = "claude-haiku-5-5";
/** @deprecated previous-generation ids kept for the Model: field and the rank table */
export const OPUS_48 = "claude-opus-4-8";
export const OPUS_47 = "claude-opus-4-7";
export const SONNET_5 = "claude-sonnet-5";

/** Labels that mean "fresh context is worth most here": always the top model. */
export const HEAVY_LABELS = [
  "redteam",
  "security",
  "auth",
  "money",
  "payments",
  "billing",
  "checkout",
  "cfdi",
  "tax",
  "data",
  "migration",
  "public",
  "design",
];

/** Labels that mean "one-line, mechanical": the only case Sonnet is allowed. */
export const SIMPLE_LABELS = ["chore", "copy", "typo", "trivial", "docs", "rename"];

/** Beads at or above this estimate are multi-step work, so they size up. */
export const COMPLEX_ESTIMATE_MIN = 45;

/** Beads at or below this estimate can be simple enough for Sonnet. */
export const SIMPLE_ESTIMATE_MIN = 10;

function normalise(value: string): string {
  return value.trim().toLowerCase();
}

/** Map a bead's human model label ("Opus 4.8") onto an id the dispatch endpoint accepts. */
export function modelId(label: string | null | undefined): string | null {
  if (!label) return null;
  const wanted = normalise(label);
  const direct = MODELS.find((model) => model.id === wanted);
  if (direct) return direct.id;
  const byLabel = MODELS.find((model) => normalise(model.label) === wanted);
  if (byLabel) return byLabel.id;
  // Tolerate "opus 4.8", "opus-4-8", "sonnet", "fable".
  const compact = wanted.replace(/[^a-z0-9]/g, "");
  const fuzzy = MODELS.find(
    (model) =>
      model.id.replace(/[^a-z0-9]/g, "").endsWith(compact) ||
      normalise(model.label).replace(/[^a-z0-9]/g, "") === compact,
  );
  return fuzzy?.id ?? null;
}

export function hasHeavyLabel(labels: readonly string[]): boolean {
  return labels.some((label) => HEAVY_LABELS.includes(normalise(label)));
}

export function hasSimpleLabel(labels: readonly string[]): boolean {
  return labels.some((label) => SIMPLE_LABELS.includes(normalise(label)));
}

/** The picker's default for one ready bead. */
export function defaultModelFor(bead: Pick<ReadyBead, "labels" | "priority" | "estimateMin" | "model">): string {
  const explicit = modelId(bead.model);
  if (explicit) return explicit;

  const labels = bead.labels ?? [];
  if (hasHeavyLabel(labels)) return OPUS_55;
  if (bead.priority <= 0) return OPUS_55;
  if ((bead.estimateMin ?? 0) >= COMPLEX_ESTIMATE_MIN) return OPUS_55;
  if (hasSimpleLabel(labels) && (bead.estimateMin ?? SIMPLE_ESTIMATE_MIN) <= SIMPLE_ESTIMATE_MIN) {
    return SONNET_55;
  }
  // moderate work, and the unsure case: size up to Opus rather than down
  return OPUS_55;
}

const RANK: Record<string, number> = {
  "claude-fable-5-1": 6,
  "claude-fable-5": 6,
  [OPUS_55]: 5,
  "claude-opus-5": 4,
  [OPUS_48]: 3,
  [OPUS_47]: 2,
  [SONNET_55]: 2,
  [SONNET_5]: 1,
  [HAIKU_55]: 0,
};

/**
 * The model a batch runs on. A batch is worked in one session, so it takes the strongest
 * default any member asked for: sizing up is the safe direction.
 */
export function batchModelFor(beads: readonly Pick<ReadyBead, "labels" | "priority" | "estimateMin" | "model">[]): string {
  // Start from the first member, not from a floor: a floor above the members'
  // explicit choices (a Haiku-only batch, a legacy Sonnet 5 batch) would silently
  // override them (lucy round 1, 2026-10-08). An empty batch sizes up to Opus.
  if (beads.length === 0) return OPUS_55;
  let best = defaultModelFor(beads[0]!);
  for (const bead of beads.slice(1)) {
    const model = defaultModelFor(bead);
    if ((RANK[model] ?? 0) > (RANK[best] ?? 0)) best = model;
  }
  return best;
}

/** Beads that must never share a session (operating loop: risk gets fresh context). */
export function batchable(bead: Pick<ReadyBead, "labels" | "priority" | "rig">): boolean {
  // hq has no worktrees, so ctl refuses to spawn a worker for an hq bead at all:
  // that work happens in a terminal. Offering it in a batch would queue something
  // guaranteed to fail on dispatch.
  if (bead.rig === "hq") return false;
  return !hasHeavyLabel(bead.labels ?? []) && bead.priority > 0;
}
