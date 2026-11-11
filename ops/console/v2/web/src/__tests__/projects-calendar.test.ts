import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@shared/api";
import { eventsByDay, monthLabel, monthView, shiftMonth } from "../projects/calendar";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");

function item(over: Partial<TimelineItem> & { id: string }): TimelineItem {
  return {
    title: over.id,
    kind: "bead",
    status: "open",
    start: "2026-09-01T00:00:00.000Z",
    end: "2026-09-02T00:00:00.000Z",
    projected: true,
    due: null,
    late: false,
    deps: [],
    critical: false,
    parent: null,
    ...over,
  };
}

describe("month arithmetic", () => {
  it("wraps across a year boundary in both directions", () => {
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
    expect(monthLabel(2026, 8)).toBe("September 2026");
  });
});

describe("events", () => {
  const sources = [
    {
      project: "fintrack",
      projectName: "fintrack-portfolio",
      items: [
        item({ id: "dh-42", due: "2026-09-12" }),
        item({ id: "dh-44", due: "2026-09-12T00:00:00.000Z", late: true }),
        item({ id: "shop-live", kind: "epic", due: "2026-09-12" }),
        item({ id: "dh-50" }),
      ],
    },
    { project: "acme", projectName: "acme-dashboard", items: [item({ id: "xd-9", due: "2026-08-29" })] },
  ];

  it("keys due dates by day and ignores items without one", () => {
    const map = eventsByDay(sources);
    expect([...map.keys()].sort()).toEqual(["2026-08-29", "2026-09-12"]);
    expect(map.get("2026-09-12")).toHaveLength(3);
  });

  it("puts the milestone first inside a day", () => {
    expect(eventsByDay(sources).get("2026-09-12")!.map((event) => event.id)).toEqual(["shop-live", "dh-42", "dh-44"]);
  });

  it("carries the project through so a click can open it", () => {
    expect(eventsByDay(sources).get("2026-08-29")![0]).toMatchObject({ project: "acme", id: "xd-9" });
  });
});

describe("month grid", () => {
  const view = monthView(2026, 8, eventsByDay([]), NOW);

  it("starts on a Monday and covers the whole month", () => {
    expect(new Date(`${view.weeks[0]![0]!.iso}T00:00:00.000Z`).getUTCDay()).toBe(1);
    const inMonth = view.weeks.flat().filter((day) => day.inMonth);
    expect(inMonth).toHaveLength(30);
    expect(inMonth[0]!.iso).toBe("2026-09-01");
    expect(inMonth[29]!.iso).toBe("2026-09-30");
  });

  it("has seven days per row and no more rows than it needs", () => {
    expect(view.weeks.every((week) => week.length === 7)).toBe(true);
    expect(view.weeks.length).toBeLessThanOrEqual(6);
    expect(view.weeks[view.weeks.length - 1]!.some((day) => day.inMonth)).toBe(true);
  });

  it("marks today and the weekend", () => {
    const today = view.weeks.flat().filter((day) => day.today);
    expect(today.map((day) => day.iso)).toEqual(["2026-09-10"]);
    expect(view.weeks[0]!.filter((day) => day.weekend)).toHaveLength(2);
  });

  it("hangs the events off their day", () => {
    const withEvents = monthView(
      2026,
      8,
      eventsByDay([{ project: "p", projectName: "p", items: [item({ id: "b1", due: "2026-09-12" })] }]),
      NOW,
    );
    const day = withEvents.weeks.flat().find((cell) => cell.iso === "2026-09-12")!;
    expect(day.events.map((event) => event.id)).toEqual(["b1"]);
  });
});
