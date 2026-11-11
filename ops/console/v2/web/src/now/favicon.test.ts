import { describe, expect, it } from "vitest";
import { buildWorkspaces } from "./workspace";
import type { Session } from "@shared/api";
import { consoleMark, dotIcon, hueColor, markIcon, markTitle, workspaceForRig } from "./favicon";

function session(over: Partial<Session>): Session {
  return {
    id: "s-1", kind: "interactive", rig: null, bead: null, model: null, branch: null,
    worktree: null, state: "running", startedAt: "2026-11-03T00:00:00Z", lastActivityAt: null,
    phases: [], wakeAt: null, runner: "pty", focusable: false, attachable: true, writable: true,
    name: null, task: null, turn: null, turnAt: null, ...over,
  };
}

describe("pop-out favicon", () => {
  const workspaces = buildWorkspaces([], ["acme-dashboard", "lodgeco-system", "agencyco-site", "gym-tracker"]);

  it("finds the workspace of a popped-out rig", () => {
    expect(workspaceForRig(workspaces, "acme-dashboard")?.id).toBe("orbit-acme");
    expect(workspaceForRig(workspaces, "lodgeco-system")?.id).toBe("lodgeco");
    expect(workspaceForRig(workspaces, "agencyco-site")?.id).toBe("agencyco");
    expect(workspaceForRig(workspaces, "gym-tracker")?.id).toBe("personal");
    expect(workspaceForRig(workspaces, null)).toBeNull();
  });

  it("gives the three client workspaces three different colours", () => {
    const colors = ["acme-dashboard", "lodgeco-system", "agencyco-site"].map((rig) =>
      hueColor(workspaceForRig(workspaces, rig)?.hue ?? 0),
    );
    expect(new Set(colors).size).toBe(3);
  });

  it("draws a dot in the given colour and refuses anything that is not a hex colour", () => {
    expect(decodeURIComponent(dotIcon("#c47f92"))).toContain('fill="#c47f92"');
    expect(decodeURIComponent(dotIcon('red"/><script>'))).toContain('fill="#ffd60a"');
    expect(dotIcon("#c47f92").startsWith("data:image/svg+xml,")).toBe(true);
  });
});

describe("state favicon", () => {
  const now = Date.parse("2026-11-03T01:10:00Z");
  const working = session({ id: "w", turn: "working", turnAt: "2026-11-03T01:05:00Z" });
  const finished = session({ id: "f", turn: "idle", turnAt: "2026-11-03T01:00:00Z" });
  const asking = session({ id: "q", state: "waiting" });
  const quiet = session({ id: "i" });
  const gone = session({ id: "x", state: "closed", turn: "idle", turnAt: "2026-11-03T01:00:00Z" });

  it("ranks question over done over working over idle", () => {
    expect(consoleMark([working, finished, asking, quiet], now).mark).toBe("question");
    expect(consoleMark([working, finished, quiet], now).mark).toBe("done");
    expect(consoleMark([working, quiet], now).mark).toBe("working");
    expect(consoleMark([quiet, gone], now).mark).toBeNull();
    expect(consoleMark([], now).mark).toBeNull();
  });

  it("counts questions and finished terminals, and ignores closed ones", () => {
    const summary = consoleMark([asking, asking, finished, gone], now);
    expect(summary.questions).toBe(2);
    expect(summary.finished).toBe(1);
  });

  it("puts the count in the title, questions first", () => {
    expect(markTitle("Console", { mark: "question", questions: 2, finished: 1 })).toBe("(2?) Console");
    expect(markTitle("Console", { mark: "done", questions: 0, finished: 3 })).toBe("(3 done) Console");
    expect(markTitle("Console", { mark: "working", questions: 0, finished: 0 })).toBe("Console");
    expect(markTitle("Console", { mark: null, questions: 0, finished: 0 })).toBe("Console");
  });

  it("draws a different icon for each mark, on the console's colours", () => {
    const icons = (["question", "done", "working", null] as const).map((mark) => decodeURIComponent(markIcon(mark)));
    expect(new Set(icons).size).toBe(4);
    expect(icons[0]).toContain('fill="#e7bd45"');
    expect(icons[1]).toContain('fill="#ff5147"');
    expect(icons[3]).toBe(decodeURIComponent(dotIcon("#ffd60a")));
  });

  it("keeps a pop-out's workspace colour under its mark, and refuses a colour that is not hex", () => {
    expect(decodeURIComponent(markIcon("done", "#c47f92"))).toContain('fill="#c47f92"');
    expect(decodeURIComponent(markIcon("question", 'red"/><script>'))).not.toContain("script");
  });
});
