// Palette verbs. This is a keyboard surface that dispatches work and answers workers, so
// the tests that matter are about what it offers, what command it says it will run, and
// above all what it refuses.
import { describe, expect, it } from "vitest";
import type { ConsoleState, ReadyBead, Request, Session } from "@shared/api";
import {
  answerable,
  answerText,
  filterVerbs,
  flowVerbs,
  isAnswerQuery,
  modelFor,
  modelLabel,
  nextModel,
  verbsFor,
  type VerbHandlers,
} from "./paletteVerbs";

function bead(over: Partial<ReadyBead> = {}): ReadyBead {
  return { rig: "acme-dashboard", id: "xd-207", title: "avance tema sync", priority: 1, labels: [], kind: "task", due: null, estimateMin: null, model: null, ...over };
}

function request(over: Partial<Request> = {}): Request {
  return {
    id: "r-3f2a", kind: "decide", severity: "P1", state: "open", rig: "chesski", bead: "ch-19",
    session: null, createdAt: "2026-08-20T10:00:00.000Z", ageSeconds: 60, question: "depth 18?",
    command: null, link: null, why: null, answer: null, settledAt: null, snoozedUntil: null, meta: {},
    ...over,
  };
}

function session(over: Partial<Session> = {}): Session {
  return {
    id: "js-4", kind: "worker", rig: "gym-tracker", bead: "gt-88", model: null, branch: null,
    worktree: null, state: "running", startedAt: "2026-08-20T10:00:00.000Z", lastActivityAt: null,
    phases: [], wakeAt: null, runner: "pty", attachable: true, focusable: true, writable: false, name: null, task: null, turn: null, turnAt: null,
    ...over,
  };
}

function stateOf(over: Partial<ConsoleState> = {}): ConsoleState {
  return { ready: [], requests: [], sessions: [], ...over } as ConsoleState;
}

function handlers(): VerbHandlers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    navigate: (p) => calls.push(`navigate:${p}`),
    dispatch: (b, m) => calls.push(`dispatch:${b.id}:${m}`),
    answer: (r, t) => calls.push(`answer:${r.id}:${t}`),
    openTerminal: (s) => calls.push(`terminal:${s.id}`),
    snooze: (r) => calls.push(`snooze:${r.id}`),
  };
}

describe("what the palette refuses", () => {
  it("never offers finish or kill as a runnable row", () => {
    const h = handlers();
    const verbs = verbsFor(
      stateOf({ sessions: [session({ id: "js-9", state: "finishable" }), session({ id: "js-4", state: "running" })] }),
      "",
      h,
    );
    const refused = verbs.filter((v) => v.kind === "refused");
    expect(refused.map((v) => v.label)).toEqual(["finish js-9 --confirm", "kill js-4"]);
    for (const row of refused) {
      expect(row.run, `${row.label} must not be runnable`).toBeUndefined();
      expect(row.cmd).toBeNull();
      expect(row.refused).toMatch(/two deliberate steps/);
    }
  });

  it("keeps refusing them however the query is spelled", () => {
    const h = handlers();
    const state = stateOf({ sessions: [session({ id: "js-9", state: "finishable" })] });
    for (const q of ["fin", "finish", "FINISH", "js-9"]) {
      const rows = filterVerbs(verbsFor(state, q, h), q);
      const finish = rows.find((r) => r.label.includes("finish"));
      if (finish) expect(finish.run).toBeUndefined();
    }
  });
});

describe("dispatch", () => {
  it("shows the exact command, including the model", () => {
    const h = handlers();
    const verbs = verbsFor(stateOf({ ready: [bead()] }), "", h);
    const row = verbs.find((v) => v.kind === "dispatch");
    expect(row?.cmd).toBe("ctl.sh dispatch xd-207 --rig acme-dashboard --model claude-opus-5-5");
    row?.run?.();
    expect(h.calls).toEqual(["dispatch:xd-207:claude-opus-5-5"]);
  });

  it("honours a model override, so Tab changes the command that fires", () => {
    const h = handlers();
    const verbs = verbsFor(stateOf({ ready: [bead()] }), "", h, { "xd-207": "claude-sonnet-5-5" });
    const row = verbs.find((v) => v.kind === "dispatch");
    expect(row?.cmd).toContain("--model claude-sonnet-5-5");
    row?.run?.();
    expect(h.calls).toEqual(["dispatch:xd-207:claude-sonnet-5-5"]);
  });

  it("sizes up rather than down when the bead names no model", () => {
    expect(modelFor(bead({ model: null }))).toBe("claude-opus-5-5");
    expect(modelFor(bead({ model: "claude-sonnet-5-5" }))).toBe("claude-sonnet-5-5");
    expect(modelFor(bead({ model: "something-else" }))).toBe("claude-opus-5-5");
  });

  it("honours an explicit previous-generation id instead of replacing it", () => {
    // lucy round 1 (2026-10-08): the three-item Tab cycle was also the override
    // validator, so claude-sonnet-5 on a bead silently dispatched Opus 5.5.
    expect(modelFor(bead({ model: "claude-sonnet-5" }))).toBe("claude-sonnet-5");
    expect(modelFor(bead({ model: "Opus 4.8" }))).toBe("claude-opus-4-8");
    expect(nextModel("claude-sonnet-5")).toBe("claude-opus-5-5");
  });

  it("surfaces the redteam label, since it changes how the bead should be worked", () => {
    const h = handlers();
    const verbs = verbsFor(stateOf({ ready: [bead({ labels: ["redteam"] })] }), "", h);
    expect(verbs[0].hint).toContain("redteam");
  });

  it("cycles models in the routing order", () => {
    expect(nextModel("claude-opus-5-5")).toBe("claude-sonnet-5-5");
    expect(nextModel("claude-sonnet-5-5")).toBe("claude-haiku-5-5");
    expect(nextModel("claude-haiku-5-5")).toBe("claude-opus-5-5");
    expect(modelLabel("claude-opus-5-5")).toBe("opus-5.5");
  });
});

describe("the answer composer", () => {
  it("takes over the list, so nothing else can be hit by accident", () => {
    const h = handlers();
    const state = stateOf({ ready: [bead()], requests: [request()], sessions: [session()] });
    const verbs = verbsFor(state, "> use depth 18", h);
    expect(verbs).toHaveLength(1);
    expect(verbs[0].kind).toBe("answer");
    expect(verbs[0].cmd).toBe('ctl.sh answer r-3f2a "use depth 18"');
    verbs[0].run?.();
    expect(h.calls).toEqual(["answer:r-3f2a:use depth 18"]);
  });

  it("names the target in the label rather than guessing silently", () => {
    const h = handlers();
    const verbs = verbsFor(stateOf({ requests: [request({ id: "r-9", severity: "P0" })] }), "> yes", h);
    expect(verbs[0].label).toContain("r-9");
  });

  it("aims at the most severe and oldest open request, as Needs-you orders them", () => {
    const rows = answerable(
      stateOf({
        requests: [
          request({ id: "r-new-p1", severity: "P1", createdAt: "2026-08-20T12:00:00.000Z" }),
          request({ id: "r-old-p1", severity: "P1", createdAt: "2026-08-20T08:00:00.000Z" }),
          request({ id: "r-p0", severity: "P0", createdAt: "2026-08-20T11:00:00.000Z" }),
          request({ id: "r-answered", state: "answered" }),
        ],
      }),
    );
    expect(rows.map((r) => r.id)).toEqual(["r-p0", "r-old-p1", "r-new-p1"]);
  });

  it("will not send an empty answer", () => {
    const h = handlers();
    const verbs = verbsFor(stateOf({ requests: [request()] }), ">", h);
    expect(verbs[0].run).toBeUndefined();
    expect(verbs[0].cmd).toBeNull();
  });

  it("says so when nothing is waiting", () => {
    const h = handlers();
    const verbs = verbsFor(stateOf({}), "> hello", h);
    expect(verbs[0].kind).toBe("refused");
    expect(verbs[0].run).toBeUndefined();
  });

  it("recognises the marker and strips it", () => {
    expect(isAnswerQuery("> hi")).toBe(true);
    expect(isAnswerQuery("  >hi")).toBe(true);
    expect(isAnswerQuery("finish")).toBe(false);
    expect(answerText("> use depth 18 ")).toBe("use depth 18");
    expect(answerText(">yes")).toBe("yes");
  });
});

describe("terminals and snooze", () => {
  it("offers a terminal only for an attachable session", () => {
    const h = handlers();
    const verbs = verbsFor(
      stateOf({ sessions: [session({ id: "js-1", attachable: true }), session({ id: "js-2", attachable: false })] }),
      "",
      h,
    );
    const terminals = verbs.filter((v) => v.kind === "terminal");
    expect(terminals.map((t) => t.label)).toEqual(["Open terminal js-1"]);
  });

  it("snoozes an open request with the command shown", () => {
    const h = handlers();
    const verbs = verbsFor(stateOf({ requests: [request()] }), "", h);
    const row = verbs.find((v) => v.kind === "snooze");
    expect(row?.cmd).toBe("ctl.sh req-snooze r-3f2a tomorrow");
    row?.run?.();
    expect(h.calls).toEqual(["snooze:r-3f2a"]);
  });
});

describe("filtering", () => {
  it("matches label and hint, and never filters the answer composer", () => {
    const h = handlers();
    const state = stateOf({ ready: [bead(), bead({ id: "gt-88", rig: "gym-tracker" })] });
    const verbs = verbsFor(state, "gym", h);
    expect(filterVerbs(verbs, "gym").map((v) => v.label)).toEqual(["Dispatch gt-88 to gym-tracker"]);
    const answer = verbsFor(stateOf({ requests: [request()] }), "> anything", h);
    expect(filterVerbs(answer, "> anything")).toHaveLength(1);
  });
});

describe("flow charts", () => {
  const projects = [{ id: "hq" }, { id: "gym-tracker" }] as ConsoleState["projects"];

  it("offers every project and every bead on screen that maps to a project", () => {
    const h = handlers();
    const state = stateOf({
      projects,
      sessions: [session(), session({ id: "js-9", rig: null, bead: "hq-c4pl0.3" }), session({ id: "js-0", bead: null })],
      requests: [request({ rig: "gym-tracker", bead: "gt-88" }), request({ id: "r-x", rig: "chesski", bead: "ch-19" })],
    });
    const verbs = flowVerbs(state, "", h);
    expect(verbs.map((v) => v.label)).toEqual(["flow hq", "flow gym-tracker", "flow gt-88", "flow hq-c4pl0.3"]);
    verbs.find((v) => v.label === "flow gt-88")?.run?.();
    verbs.find((v) => v.label === "flow hq")?.run?.();
    expect(h.calls).toEqual(["navigate:/projects/gym-tracker/flow?focus=gt-88", "navigate:/projects/hq/flow"]);
  });

  it("resolves a typed bead id by its prefix, and only a bead id", () => {
    const h = handlers();
    const state = stateOf({ projects });
    const typed = flowVerbs(state, "flow hq-zz9.2", h).filter((v) => v.id === "flow:hq-zz9.2");
    expect(typed).toHaveLength(1);
    typed[0]?.run?.();
    expect(h.calls).toEqual(["navigate:/projects/hq/flow?focus=hq-zz9.2"]);
    expect(flowVerbs(state, "flow xd-1", h).some((v) => v.id === "flow:xd-1")).toBe(false);
    expect(flowVerbs(state, "flow ../x", h).some((v) => v.id.includes(".."))).toBe(false);
  });

  it("is part of verbsFor and filters on 'flow'", () => {
    const verbs = verbsFor(stateOf({ projects }), "flow gym", handlers());
    expect(filterVerbs(verbs, "flow gym").map((v) => v.label)).toEqual(["flow gym-tracker"]);
  });
});
