// Stack tab (bead hq-fn4n): the pure model and a render smoke over mock data.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StackItem, StackReport } from "@shared/api";
import { fmtTokens, kindsOf, pendingDecisions, signalOf, sortedItems } from "../stack/model";
import { mockState } from "../data/mock";
import { StackTab } from "../tabs/StackTab";

const item = (id: string, over: Partial<StackItem> = {}): StackItem => ({
  id,
  name: id.split(":")[1] ?? id,
  kind: (id.split(":")[0] as StackItem["kind"]) || "tool",
  windows: {
    7: { uses: 0, sessions: 0, errors: 0 },
    30: { uses: 0, sessions: 0, errors: 0 },
    90: { uses: 0, sessions: 0, errors: 0 },
  },
  lastUsed: null,
  unstamped: 0,
  blocks90: 0,
  topBlockReason: null,
  tokens90: 0,
  inventory: true,
  stale: null,
  detail: null,
  acquisitions: [],
  verdictHint: "unused",
  ...over,
});

const report = (items: StackItem[]): StackReport => ({ generatedAt: "2026-08-19T00:00:00Z", windows: [7, 30, 90], items });

describe("stack model", () => {
  it("sorts by the picked window and filters by kind", () => {
    const r = report([
      item("cli:bd", { windows: { 7: { uses: 1, sessions: 1, errors: 0 }, 30: { uses: 9, sessions: 3, errors: 0 }, 90: { uses: 9, sessions: 3, errors: 0 } } }),
      item("cli:pp", { windows: { 7: { uses: 5, sessions: 2, errors: 0 }, 30: { uses: 5, sessions: 2, errors: 0 }, 90: { uses: 5, sessions: 2, errors: 0 } } }),
      item("hook:h", { blocks90: 3 }),
    ]);
    expect(sortedItems(r, "7", "").map((i) => i.id)).toEqual(["cli:pp", "cli:bd", "hook:h"]);
    expect(sortedItems(r, "30", "").map((i) => i.id)).toEqual(["cli:bd", "cli:pp", "hook:h"]);
    expect(sortedItems(r, "30", "hook").map((i) => i.id)).toEqual(["hook:h"]);
    expect(sortedItems(null, "30", "")).toEqual([]);
    expect(kindsOf(r)).toEqual(["cli", "hook"]);
  });

  it("pending decisions: unused/stale with no acquisition filed", () => {
    const r = report([
      item("skill:a", { verdictHint: "unused" }),
      item("skill:b", { verdictHint: "stale", acquisitions: [{ id: "hq-1", title: "t" }] }),
      item("cli:c", { verdictHint: "value" }),
    ]);
    expect(pendingDecisions(r)).toBe(1);
    expect(pendingDecisions(null)).toBe(0);
  });

  it("signals name the evidence, not a vibe", () => {
    expect(signalOf(item("hook:h", { blocks90: 4, topBlockReason: "Blocked: X" }), "30")).toBe("4 blocks (90d); top: Blocked: X");
    expect(
      signalOf(item("cli:bd", { windows: { 7: { uses: 0, sessions: 0, errors: 0 }, 30: { uses: 10, sessions: 2, errors: 3 }, 90: { uses: 10, sessions: 2, errors: 3 } } }), "30"),
    ).toBe("3 errors of 10");
    expect(signalOf(item("skill:s", { stale: "no SKILL.md", unstamped: 2 }), "30")).toBe("no SKILL.md; 2 all-time (unstamped)");
    expect(signalOf(item("cli:x"), "30")).toBe("clean");
    expect(fmtTokens(1_530_000)).toBe("1.5M");
    expect(fmtTokens(999)).toBe("999");
  });
});

describe("StackTab", () => {
  it("renders live rows, the window picker, and keep/revert", () => {
    const html = renderToStaticMarkup(createElement(StackTab, { stack: mockState().stack }));
    expect(html).toContain("Inventory and evidence");
    expect(html).toContain("cli:bd");
    expect(html).toContain("Keep");
    expect(html).toContain("Revert");
    expect(html).toContain("7d");
    expect(html).toContain("90d");
    expect(html).toContain("hook-write-containment-guard");
    expect(html).toContain("no SKILL.md");
    expect(html).not.toContain("sample");
  });

  it("renders the loading state without a report", () => {
    const html = renderToStaticMarkup(createElement(StackTab, { stack: null }));
    expect(html).toContain("has not reported yet");
  });
});
