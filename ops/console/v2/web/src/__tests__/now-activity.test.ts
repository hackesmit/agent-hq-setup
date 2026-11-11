// Activity stream (bead hq-mhxk): the pure filter model, and a render smoke of
// the collapsed-by-default panel inside the Now tab.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActivityEvent } from "@shared/api";
import { ACTIVITY_FILTERS, filterActivity, filterCounts, groupOf, typeTone } from "../now/activity";
import { Activity } from "../now/Activity";
import { mockState } from "../data/mock";
import { NowTab } from "../tabs/NowTab";

const ev = (id: string, type: ActivityEvent["type"], rest: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id,
  ts: "2026-08-18T12:00:00Z",
  type,
  rig: null,
  session: null,
  bead: null,
  title: id,
  detail: null,
  sev: null,
  ...rest,
});

describe("activity model", () => {
  const events = [
    ev("c1", "commit"),
    ev("m1", "merge"),
    ev("d1", "dispatch"),
    ev("f1", "finish"),
    ev("o1", "op"),
    ev("a1", "ask", { sev: "P1" }),
    ev("an1", "answer"),
    ev("e1", "error", { sev: "P1" }),
    ev("cap1", "capture"),
    ev("s1", "snooze"),
  ];

  it("puts every type in exactly one filter group", () => {
    for (const event of events) {
      const group = groupOf(event.type);
      expect(["changes", "ops", "asks", "errors"]).toContain(group);
      expect(filterActivity([event], group)).toEqual([event]);
      for (const other of ACTIVITY_FILTERS) {
        if (other.id === "all" || other.id === group) continue;
        expect(filterActivity([event], other.id)).toEqual([]);
      }
    }
  });

  it("counts agree with the filters and sum to all", () => {
    const counts = filterCounts(events);
    expect(counts.all).toBe(events.length);
    expect(counts.changes + counts.ops + counts.asks + counts.errors).toBe(events.length);
    expect(counts.changes).toBe(2);
    expect(counts.asks).toBe(2);
    expect(counts.errors).toBe(1);
  });

  it("tones: errors and P0/P1 stand out, routine work stays calm", () => {
    expect(typeTone(ev("e", "error"))).toBe("bad");
    expect(typeTone(ev("a", "ask", { sev: "P0" }))).toBe("bad");
    expect(typeTone(ev("a", "ask", { sev: "P1" }))).toBe("warn");
    expect(typeTone(ev("m", "merge"))).toBe("ok");
    expect(typeTone(ev("c", "commit"))).toBe("mute");
  });
});

describe("Activity panel", () => {
  it("renders collapsed with a count and its newest age", () => {
    const now = Date.parse("2026-08-18T12:10:00Z");
    const html = renderToStaticMarkup(
      createElement(Activity, { events: [ev("m1", "merge", { title: "Merge branch x" })], now }),
    );
    expect(html).toContain("Activity");
    expect(html).toContain("last 10 min ago");
    expect(html).not.toContain("Merge branch x");
  });

  it("shows quiet when there is nothing", () => {
    const html = renderToStaticMarkup(createElement(Activity, { events: [], now: 0 }));
    expect(html).toContain("quiet");
  });

  it("is part of the Now tab", () => {
    const html = renderToStaticMarkup(createElement(NowTab, { state: mockState(), focusRequest: null }));
    expect(html).toContain("Activity");
  });
});
