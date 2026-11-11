// The calendar card. The point of it is the invitations nobody answered, so that
// is what most of this covers: the owner's actual complaint was an invite arriving
// by mail and never being noticed.
import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "@shared/api";
import { byDay, minutesUntil } from "../now/Calendar";

const at = (iso: string, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: iso,
  title: "an event",
  startsAt: iso,
  endsAt: iso,
  allDay: false,
  response: null,
  meetLink: null,
  organizer: "",
  location: "",
  ...over,
});

describe("how long until it starts", () => {
  const now = Date.parse("2026-08-21T10:00:00Z");

  it("counts forward and backward", () => {
    expect(minutesUntil(at("2026-08-21T10:30:00Z"), now)).toBe(30);
    expect(minutesUntil(at("2026-08-21T09:45:00Z"), now)).toBe(-15);
    expect(minutesUntil(at("2026-08-21T10:00:00Z"), now)).toBe(0);
  });

  it("says nothing rather than something wrong for an unreadable date", () => {
    expect(minutesUntil(at("not a date"), now)).toBe(null);
    expect(minutesUntil(at(""), now)).toBe(null);
  });
});

describe("grouping by day", () => {
  it("keeps consecutive events on one heading and starts a new one on a new day", () => {
    const groups = byDay([
      at("2026-08-21T09:00:00Z"),
      at("2026-08-21T15:00:00Z"),
      at("2026-08-22T09:00:00Z"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.events).toHaveLength(2);
    expect(groups[1]!.events).toHaveLength(1);
  });

  it("drops an event whose date cannot be read rather than making a heading from it", () => {
    expect(byDay([at("nonsense"), at("2026-08-21T09:00:00Z")])).toHaveLength(1);
  });

  it("handles nothing at all", () => {
    expect(byDay([])).toEqual([]);
  });
});
