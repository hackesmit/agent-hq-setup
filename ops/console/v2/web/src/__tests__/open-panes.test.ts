// Which terminals stay open. The bug this covers: leaving the Now tab unmounted
// the pane state, so a running session looked as though it had died.
import { describe, expect, it } from "vitest";
import { readOpenPanes, restorable } from "../now/openPanes";
import { columnsFor } from "../tabs/TerminalsTab";

describe("reading what was remembered", () => {
  it("survives anything that could be in storage", () => {
    expect(readOpenPanes(null)).toEqual([]);
    expect(readOpenPanes("")).toEqual([]);
    expect(readOpenPanes("{ not json")).toEqual([]);
    expect(readOpenPanes('"a string"')).toEqual([]);
    expect(readOpenPanes("{}")).toEqual([]);
    expect(readOpenPanes(JSON.stringify([1, 2, 3]))).toEqual([]);
  });

  it("keeps only plausible ids, deduplicated and bounded", () => {
    expect(readOpenPanes(JSON.stringify(["s-1", "s-2", "s-1"]))).toEqual(["s-1", "s-2"]);
    expect(readOpenPanes(JSON.stringify(["s-1", "", null, "s-2"]))).toEqual(["s-1", "s-2"]);
    expect(readOpenPanes(JSON.stringify(["x".repeat(200), "s-ok"]))).toEqual(["s-ok"]);
    expect(readOpenPanes(JSON.stringify(Array.from({ length: 40 }, (_, i) => `s-${i}`)))).toHaveLength(8);
  });
});

describe("restoring", () => {
  it("reopens only panes whose session is still live", () => {
    // A finished session must not be reopened: the attach would fail and a pane
    // that cannot attach is more confusing than an absent one.
    expect(restorable(["s-1", "s-gone", "s-2"], ["s-1", "s-2", "s-3"])).toEqual(["s-1", "s-2"]);
    expect(restorable(["s-gone"], ["s-1"])).toEqual([]);
    expect(restorable([], ["s-1"])).toEqual([]);
  });

  it("keeps the remembered order rather than the server's", () => {
    expect(restorable(["s-3", "s-1"], ["s-1", "s-2", "s-3"])).toEqual(["s-3", "s-1"]);
  });
});

describe("the terminals grid", () => {
  it("gives fewer panes more room rather than always filling the width", () => {
    // Four cramped terminals are worse than two readable ones, so the column
    // count grows more slowly than the pane count.
    expect(columnsFor(1, true)).toBe(1);
    expect(columnsFor(2, true)).toBe(2);
    expect(columnsFor(4, true)).toBe(2);
    expect(columnsFor(5, true)).toBe(3);
    expect(columnsFor(8, true)).toBe(3);
  });

  it("stacks on a narrow screen whatever the count", () => {
    for (const n of [1, 2, 4, 8]) expect(columnsFor(n, false)).toBe(1);
  });

  it("handles nothing open without dividing by it", () => {
    expect(columnsFor(0, true)).toBe(1);
    expect(columnsFor(0, false)).toBe(1);
  });
});
