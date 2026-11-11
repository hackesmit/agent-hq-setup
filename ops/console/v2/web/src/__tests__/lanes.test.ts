import { describe, expect, it } from "vitest";
import type { Request } from "@shared/api";
import { groupRequests, isActionable, oldestOpenSeconds, openCount, sortRequests, snoozedRequests } from "../now/lanes";

function req(
  id: string,
  severity: Request["severity"],
  minutesOld: number,
  state: Request["state"] = "open",
): Request {
  const base = Date.parse("2026-08-18T12:00:00.000Z");
  return {
    id,
    kind: "decide",
    severity,
    state,
    rig: null,
    bead: null,
    session: null,
    createdAt: new Date(base - minutesOld * 60_000).toISOString(),
    ageSeconds: minutesOld * 60,
    question: id,
    command: null,
    link: null,
    why: null,
    answer: null,
    settledAt: null,
    snoozedUntil: null,
    meta: {},
  };
}

describe("sortRequests", () => {
  it("puts P0 first and the oldest first inside a lane", () => {
    const sorted = sortRequests([
      req("a", "P1", 5),
      req("b", "P0", 2),
      req("c", "P0", 40),
      req("d", "P2", 200),
      req("e", "P1", 90),
    ]);
    expect(sorted.map((request) => request.id)).toEqual(["c", "b", "e", "a", "d"]);
  });

  it("breaks ties by id so the order is stable", () => {
    const sorted = sortRequests([req("z", "P1", 10), req("a", "P1", 10)]);
    expect(sorted.map((request) => request.id)).toEqual(["a", "z"]);
  });

  it("does not mutate its input", () => {
    const input = [req("a", "P2", 1), req("b", "P0", 1)];
    const copy = [...input];
    sortRequests(input);
    expect(input).toEqual(copy);
  });

  it("falls back to the server age when the timestamp is unusable", () => {
    const broken = { ...req("bad", "P1", 0), createdAt: "not a date", ageSeconds: 6000 };
    const fresh = req("fresh", "P1", 1);
    expect(sortRequests([fresh, broken]).map((request) => request.id)).toEqual(["fresh", "bad"]);
  });
});

describe("groupRequests", () => {
  it("returns the three lanes in P0, P1, P2 order", () => {
    const lanes = groupRequests([req("a", "P2", 1), req("b", "P0", 1)]);
    expect(lanes.map((lane) => lane.severity)).toEqual(["P0", "P1", "P2"]);
    expect(lanes[0]!.items.map((item) => item.id)).toEqual(["b"]);
    expect(lanes[1]!.items).toEqual([]);
    expect(lanes[2]!.items.map((item) => item.id)).toEqual(["a"]);
  });

  it("keeps only open cards in the lanes", () => {
    const lanes = groupRequests([
      req("open", "P0", 3),
      req("answered", "P0", 4, "answered"),
      req("resolved", "P0", 5, "resolved"),
      req("snoozed", "P0", 6, "snoozed"),
      req("cancelled", "P0", 7, "cancelled"),
      req("delivered", "P0", 8, "delivered"),
    ]);
    expect(lanes[0]!.items.map((item) => item.id)).toEqual(["open"]);
  });
});

describe("counts", () => {
  const requests = [req("a", "P0", 41), req("b", "P1", 12), req("c", "P2", 5, "resolved"), req("d", "P1", 3, "snoozed")];

  it("counts open cards only", () => {
    expect(openCount(requests)).toBe(2);
    expect(isActionable(requests[2]!)).toBe(false);
  });

  it("reports the oldest open age in seconds", () => {
    expect(oldestOpenSeconds(requests)).toBe(41 * 60);
    expect(oldestOpenSeconds([])).toBe(0);
  });

  it("lists snoozed cards separately", () => {
    expect(snoozedRequests(requests).map((request) => request.id)).toEqual(["d"]);
  });
});
