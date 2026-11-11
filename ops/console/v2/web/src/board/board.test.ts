import { describe, expect, it } from "vitest";
import type { BoardItem, BoardProject } from "@shared/api";
import { attentionCount, groupBoard, markOf, moreLabel, stateLine } from "./board";

const row = (over: Partial<BoardProject> = {}): BoardProject => ({
  id: "x",
  name: "X",
  sphere: "work",
  client: null,
  status: "active",
  goal: null,
  attention: "ok",
  completion: 0.5,
  needsYou: 0,
  counts: { open: 1, inProgress: 0, blocked: 0, closed7d: 0 },
  lastCommit: null,
  epic: null,
  scope: "recent",
  next: null,
  blocked: [],
  done: [],
  todo: [],
  doneTotal: 0,
  todoTotal: 1,
  error: null,
  ...over,
});

const item = (status: BoardItem["status"]): BoardItem => ({ id: "i", title: "t", status, priority: 2, kind: "task", closedAt: null });

describe("groupBoard", () => {
  it("bands by sphere and pulls paused out whatever the sphere", () => {
    const g = groupBoard([
      row({ id: "a", sphere: "work" }),
      row({ id: "b", sphere: "personal" }),
      row({ id: "c", sphere: "work", status: "paused" }),
      row({ id: "d", sphere: null }),
    ]);
    expect(g.work.map((p) => p.id)).toEqual(["a"]);
    expect(g.personal.map((p) => p.id)).toEqual(["b", "d"]);
    expect(g.paused.map((p) => p.id)).toEqual(["c"]);
  });
});

describe("markOf", () => {
  it("maps each status to its box", () => {
    expect(markOf(item("closed"))).toBe("done");
    expect(markOf(item("in_progress"))).toBe("moving");
    expect(markOf(item("blocked"))).toBe("blocked");
    expect(markOf(item("open"))).toBe("todo");
    expect(markOf(item("deferred"))).toBe("todo");
  });
});

describe("stateLine", () => {
  it("says the loudest true thing first", () => {
    expect(stateLine(row({ error: "bd failed", needsYou: 2 }))).toBe("ledger unreachable");
    expect(stateLine(row({ needsYou: 2, counts: { open: 0, inProgress: 0, blocked: 3, closed7d: 0 } }))).toBe("2 waiting on you");
    expect(stateLine(row({ counts: { open: 0, inProgress: 0, blocked: 3, closed7d: 0 } }))).toBe("3 blocked");
    expect(stateLine(row({ next: { id: "a", title: "t", status: "in_progress" } }))).toBe("in motion");
    expect(stateLine(row({ next: { id: "a", title: "t", status: "ready" } }))).toBe("ready to start");
    expect(stateLine(row({ doneTotal: 0, todoTotal: 0 }))).toBe("no ledger work");
    expect(stateLine(row({ doneTotal: 3, todoTotal: 0 }))).toBe("nothing open");
    expect(stateLine(row())).toBe("quiet");
  });
});

describe("moreLabel and attentionCount", () => {
  it("phrases the overflow and counts what wants a glance", () => {
    expect(moreLabel(12, 20, "done")).toBe("and 8 more done");
    expect(moreLabel(5, 5, "open")).toBeNull();
    expect(
      attentionCount([
        row({ needsYou: 1 }),
        row({ counts: { open: 0, inProgress: 0, blocked: 1, closed7d: 0 } }),
        row({ status: "paused", needsYou: 4 }),
        row(),
      ]),
    ).toBe(2);
  });
});
