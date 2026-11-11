// Light month calendar across projects: bead due dates and epic (milestone) due dates,
// taken from the same timeline projection the Gantt uses. Wake times and scheduled jobs
// join in phase 2 (design 4.2), so the shape here is deliberately event-source agnostic.
//
// UTC throughout, matching timeline.ts: bd due dates are date-only strings.

import type { TimelineItem } from "@shared/api";
import { DAY_MS, isoDay } from "./timeline";

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export interface CalendarEvent {
  project: string;
  projectName: string;
  id: string;
  title: string;
  kind: TimelineItem["kind"];
  late: boolean;
  done: boolean;
}

export interface CalendarDay {
  iso: string;
  day: number;
  inMonth: boolean;
  weekend: boolean;
  today: boolean;
  events: CalendarEvent[];
}

export interface MonthView {
  year: number;
  month: number; // 0-11
  label: string;
  weeks: CalendarDay[][];
}

export function monthLabel(year: number, month: number): string {
  return `${MONTHS[month] ?? ""} ${year}`;
}

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const total = year * 12 + month + delta;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}

export interface EventSource {
  project: string;
  projectName: string;
  items: readonly TimelineItem[];
}

/** Due dates keyed by day. An item with no due date is not a calendar event. */
export function eventsByDay(sources: readonly EventSource[]): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const source of sources) {
    for (const item of source.items) {
      if (!item.due) continue;
      const at = Date.parse(item.due);
      if (Number.isNaN(at)) continue;
      const key = isoDay(at);
      const list = map.get(key) ?? [];
      list.push({
        project: source.project,
        projectName: source.projectName,
        id: item.id,
        title: item.title,
        kind: item.kind,
        late: item.late,
        done: item.status === "closed",
      });
      map.set(key, list);
    }
  }
  // Epics (milestones) first inside a day, then by id, so a day never reshuffles.
  for (const list of map.values()) {
    list.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "epic" ? -1 : 1));
  }
  return map;
}

/** Monday-first grid covering the whole month plus the head and tail days that pad it. */
export function monthView(
  year: number,
  month: number,
  events: Map<string, CalendarEvent[]>,
  nowMs: number = Date.now(),
): MonthView {
  const first = Date.UTC(year, month, 1);
  const weekday = (new Date(first).getUTCDay() + 6) % 7; // 0 = Monday
  const gridStart = first - weekday * DAY_MS;
  const today = isoDay(nowMs);

  const weeks: CalendarDay[][] = [];
  let cursor = gridStart;
  for (let week = 0; week < 6; week += 1) {
    const row: CalendarDay[] = [];
    for (let day = 0; day < 7; day += 1) {
      const date = new Date(cursor);
      const iso = isoDay(cursor);
      row.push({
        iso,
        day: date.getUTCDate(),
        inMonth: date.getUTCMonth() === month && date.getUTCFullYear() === year,
        weekend: date.getUTCDay() === 0 || date.getUTCDay() === 6,
        today: iso === today,
        events: events.get(iso) ?? [],
      });
      cursor += DAY_MS;
    }
    weeks.push(row);
    // A month never needs a sixth row unless it starts late; drop the empty tail.
    if (week >= 4 && row.every((cell) => !cell.inMonth)) {
      weeks.pop();
      break;
    }
  }

  return { year, month, label: monthLabel(year, month), weeks };
}
