// The activity stream's pure model: filter groups, chip labels and tones.
// The list itself comes assembled from the server (state.activity); the client
// only groups and filters, so this stays trivially testable.

import type { ActivityEvent, ActivityType } from "@shared/api";
import type { ChipTone } from "../ui/primitives";

export type ActivityFilter = "all" | "changes" | "ops" | "asks" | "errors";

export const ACTIVITY_FILTERS: { id: ActivityFilter; label: string }[] = [
  { id: "all", label: "all" },
  { id: "changes", label: "changes" },
  { id: "ops", label: "operations" },
  { id: "asks", label: "asks" },
  { id: "errors", label: "errors" },
];

const GROUP: Record<ActivityType, Exclude<ActivityFilter, "all">> = {
  commit: "changes",
  merge: "changes",
  dispatch: "ops",
  finish: "ops",
  snooze: "ops",
  capture: "ops",
  op: "ops",
  ask: "asks",
  answer: "asks",
  error: "errors",
};

export function groupOf(type: ActivityType): Exclude<ActivityFilter, "all"> {
  return GROUP[type] ?? "ops";
}

export function filterActivity(events: ActivityEvent[], filter: ActivityFilter): ActivityEvent[] {
  if (filter === "all") return events;
  return events.filter((event) => groupOf(event.type) === filter);
}

export function filterCounts(events: ActivityEvent[]): Record<ActivityFilter, number> {
  const counts: Record<ActivityFilter, number> = { all: events.length, changes: 0, ops: 0, asks: 0, errors: 0 };
  for (const event of events) counts[groupOf(event.type)] += 1;
  return counts;
}

export function typeTone(event: ActivityEvent): ChipTone {
  if (event.type === "error") return "bad";
  if (event.sev === "P0") return "bad";
  if (event.sev === "P1" || event.sev === "P2") return "warn";
  if (event.type === "merge" || event.type === "finish") return "ok";
  if (event.type === "dispatch" || event.type === "ask") return "accent";
  return "mute";
}
