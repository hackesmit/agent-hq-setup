// Redraw for garbled panes (2026-10-20): the button and a click into a pane that
// did not have focus send term.redraw, only for console terminals, and a click
// inside a pane that already has focus (typing, selecting) never does.
import { describe, expect, it } from "vitest";
import { consoleLink } from "../data/ws";
import { REDRAW_GAP_MS, focusRedrawer, isConsoleTerm } from "../now/Terminal";

describe("isConsoleTerm", () => {
  it("is true only for a runner-owned interactive terminal", () => {
    expect(isConsoleTerm({ runner: "pty", kind: "interactive" })).toBe(true);
    expect(isConsoleTerm({ runner: "tmux", kind: "interactive" })).toBe(false); // adopted hq:work pane
    expect(isConsoleTerm({ runner: "tmux", kind: "worker" })).toBe(false);
    expect(isConsoleTerm({ runner: "pty", kind: "worker" })).toBe(false);
    expect(isConsoleTerm({ runner: "pty", kind: "meta" })).toBe(false); // Capri
  });
});

describe("focusRedrawer", () => {
  it("redraws on the way in, never while the pane already has focus", () => {
    let now = 10_000;
    let calls = 0;
    const onEntry = focusRedrawer(() => (calls += 1), () => now);
    expect(onEntry(true)).toBe(false);
    expect(calls).toBe(0);
    expect(onEntry(false)).toBe(true);
    expect(calls).toBe(1);
    now += 50;
    expect(onEntry(false)).toBe(false); // a double click is one redraw
    now += REDRAW_GAP_MS;
    expect(onEntry(false)).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("consoleLink.redrawTerm", () => {
  it("sends term.redraw for an open pane and nothing for one it never attached", () => {
    const link: any = consoleLink;
    const sent: any[] = [];
    link.send = (m: any) => {
      sent.push(m);
      return true;
    };
    consoleLink.redrawTerm("ghost");
    expect(sent.filter((m) => m.t === "term.redraw")).toHaveLength(0);
    consoleLink.attachTerm("r1", 80, 24, {});
    consoleLink.redrawTerm("r1");
    expect(sent.filter((m) => m.t === "term.redraw")).toEqual([{ t: "term.redraw", sid: "r1" }]);
  });
});
