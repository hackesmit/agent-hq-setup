import { describe, expect, it } from "vitest";
import type { Session } from "@shared/api";
import { attentionOf, byAttention, cueOf, markSeen, needsYou } from "./attention";

function session(over: Partial<Session>): Session {
  return {
    id: "s-1", kind: "interactive", rig: "acme-dashboard", bead: null, model: null, branch: null,
    worktree: null, state: "running", startedAt: "2026-10-20T00:00:00Z", lastActivityAt: null,
    phases: [], wakeAt: null, runner: "pty", focusable: false, attachable: true, writable: true,
    name: null, task: null, turn: null, turnAt: null, ...over,
  };
}

describe("terminal attention", () => {
  it("a question beats everything", () => {
    expect(attentionOf(session({ state: "waiting", turn: "working", turnAt: "2026-10-20T01:00:00Z" }), null, Date.parse("2026-10-20T01:01:00Z"))).toBe("question");
  });

  it("a finishable worker needs you even after you looked", () => {
    expect(attentionOf(session({ state: "finishable" }), "2026-10-20T09:00:00Z")).toBe("done");
  });

  it("a running turn is working until its mark goes 30 minutes stale", () => {
    const s = session({ turn: "working", turnAt: "2026-10-20T01:00:00Z" });
    expect(attentionOf(s, null, Date.parse("2026-10-20T01:20:00Z"))).toBe("working");
    expect(attentionOf(s, null, Date.parse("2026-10-20T01:31:00Z"))).toBe("idle");
  });

  it("a finished turn needs you until you look, then it is idle", () => {
    const s = session({ turn: "idle", turnAt: "2026-10-20T01:00:00Z" });
    expect(attentionOf(s, null)).toBe("done");
    expect(attentionOf(s, "2026-10-20T00:59:59Z")).toBe("done");
    expect(attentionOf(s, "2026-10-20T01:00:00Z")).toBe("idle");
    expect(attentionOf(s, "2026-10-20T01:05:00Z")).toBe("idle");
  });

  it("no turn data is idle, and closed, snoozed or draining sessions have no attention", () => {
    expect(attentionOf(session({}), null)).toBe("idle");
    for (const state of ["closed", "snoozed", "draining"] as const) {
      expect(attentionOf(session({ state, turn: "idle", turnAt: "2026-10-20T01:00:00Z" }), null)).toBeNull();
    }
  });

  it("only question and done count as needing you", () => {
    expect(needsYou("question")).toBe(true);
    expect(needsYou("done")).toBe(true);
    expect(needsYou("working")).toBe(false);
    expect(needsYou("idle")).toBe(false);
    expect(needsYou(null)).toBe(false);
  });

  it("markSeen survives blocked storage", () => {
    expect(() => markSeen("s-1", "2026-10-20T01:00:00Z")).not.toThrow();
  });
});

describe("terminal grid order", () => {
  const now = Date.parse("2026-10-20T01:05:00Z");
  it("puts needs you first, then working, then idle, keeping open order inside a rank", () => {
    const idleA = session({ id: "idle-a" });
    const working = session({ id: "working", turn: "working", turnAt: "2026-10-20T01:00:00Z" });
    const question = session({ id: "question", state: "waiting" });
    const idleB = session({ id: "idle-b" });
    const done = session({ id: "done", turn: "idle", turnAt: "2026-10-20T01:00:00Z" });
    const order = byAttention([idleA, working, question, idleB, done], {}, now).map((s) => s.id);
    expect(order).toEqual(["question", "done", "working", "idle-a", "idle-b"]);
  });

  it("a done turn you have seen drops to idle", () => {
    const done = session({ id: "done", turn: "idle", turnAt: "2026-10-20T01:00:00Z" });
    const working = session({ id: "working", turn: "working", turnAt: "2026-10-20T01:00:00Z" });
    const order = byAttention([done, working], { done: "2026-10-20T01:00:00Z" }, now).map((s) => s.id);
    expect(order).toEqual(["working", "done"]);
  });
});

describe("terminal cue (red border when finished)", () => {
  const now = Date.parse("2026-11-03T01:10:00Z");

  it("a finished turn is finished, and stays finished after the owner looks", () => {
    const s = session({ turn: "idle", turnAt: "2026-11-03T01:00:00Z" });
    expect(cueOf(s, now)).toBe("finished");
  });

  it("a finishable worker is finished", () => {
    expect(cueOf(session({ kind: "worker", state: "finishable" }), now)).toBe("finished");
  });

  it("new work clears it: the same terminal working again is not finished", () => {
    const s = session({ turn: "working", turnAt: "2026-11-03T01:05:00Z" });
    expect(cueOf(s, now)).toBe("working");
  });

  it("a question is the question cue, never finished", () => {
    expect(cueOf(session({ state: "waiting", turn: "idle", turnAt: "2026-11-03T01:00:00Z" }), now)).toBe("question");
  });

  it("killed or gone has no cue", () => {
    for (const state of ["closed", "snoozed", "draining"] as const) {
      expect(cueOf(session({ state, turn: "idle", turnAt: "2026-11-03T01:00:00Z" }), now)).toBeNull();
    }
  });

  it("unknown is never finished: no turn data, a stale working mark, or an idle mark with no time", () => {
    expect(cueOf(session({}), now)).toBe("idle");
    expect(cueOf(session({ turn: "working", turnAt: "2026-11-03T00:30:00Z" }), now)).toBe("idle");
    expect(cueOf(session({ turn: "idle", turnAt: null }), now)).toBe("idle");
  });

  it("the meta terminal is never finished: it is not a terminal to kill", () => {
    expect(cueOf(session({ kind: "meta", turn: "idle", turnAt: "2026-11-03T01:00:00Z" }), now)).toBe("idle");
  });

  it("a turn that ended with background work outstanding is working, never finished", () => {
    const s = session({ kind: "interactive", turn: "background", turnAt: "2026-11-03T01:00:00Z" });
    expect(cueOf(s, now)).toBe("working");
    expect(cueOf(s, Date.parse("2026-11-03T01:01:00Z"))).not.toBe("finished");
    expect(cueOf(session({ kind: "worker", turn: "background", turnAt: "2026-11-03T01:00:00Z" }), now)).toBe("working");
  });

  it("a background mark older than 30 minutes goes idle, still not red", () => {
    expect(cueOf(session({ turn: "background", turnAt: "2026-11-03T00:30:00Z" }), now)).toBe("idle");
    expect(cueOf(session({ turn: "background", turnAt: null }), now)).toBe("idle");
  });

  it("attention reads a background turn as working, not done", () => {
    expect(attentionOf(session({ turn: "background", turnAt: "2026-11-03T01:00:00Z" }), null, now)).toBe("working");
  });
});
