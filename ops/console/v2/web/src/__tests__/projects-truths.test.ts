import { describe, expect, it } from "vitest";
import type { TruthEntry, TruthsDoc } from "@shared/api";
import {
  CONFLICT_MESSAGE,
  EMPTY_TRUTHS,
  groupByKind,
  makeEntryId,
  savePayload,
  truthsMarkdown,
  truthsReducer,
  unconfirmed,
  type TruthsAction,
  type TruthsState,
} from "../projects/truths";

const AT = "2026-08-18T12:00:00.000Z";

function entry(over: Partial<TruthEntry> & { id: string }): TruthEntry {
  return {
    kind: "truth",
    text: over.id,
    confirmed: true,
    added: AT,
    source: null,
    ...over,
  };
}

function doc(over: Partial<TruthsDoc> = {}): TruthsDoc {
  return { project: "fintrack", rev: 4, updatedAt: AT, entries: [entry({ id: "t1" })], ...over };
}

function run(actions: TruthsAction[], from: TruthsState = EMPTY_TRUTHS): TruthsState {
  return actions.reduce(truthsReducer, from);
}

const loaded = run([{ t: "loaded", doc: doc() }]);

describe("load", () => {
  it("takes the server revision and starts clean", () => {
    expect(loaded).toMatchObject({ project: "fintrack", rev: 4, dirty: false, conflict: false, loaded: true });
    expect(loaded.entries).toHaveLength(1);
  });
});

describe("add", () => {
  it("appends an entry and marks the state dirty", () => {
    const state = run([{ t: "add", kind: "truth", text: "  Prices are in MXN.  ", source: "dh-41", at: AT }], loaded);
    expect(state.dirty).toBe(true);
    expect(state.entries[1]).toMatchObject({ text: "Prices are in MXN.", source: "dh-41", confirmed: true });
  });

  it("starts an assumption unconfirmed and everything else confirmed", () => {
    const state = run([{ t: "add", kind: "assumption", text: "Mexico only.", source: null, at: AT }], loaded);
    expect(state.entries[1]!.confirmed).toBe(false);
    expect(unconfirmed(state.entries).map((item) => item.text)).toEqual(["Mexico only."]);
  });

  it("refuses empty text without touching the list", () => {
    const state = run([{ t: "add", kind: "truth", text: "   ", source: null, at: AT }], loaded);
    expect(state.entries).toHaveLength(1);
    expect(state.dirty).toBe(false);
    expect(state.error).toBeTruthy();
  });

  it("mints ids that do not collide", () => {
    const entries = [entry({ id: "t1" }), entry({ id: "t2" })];
    expect(makeEntryId("truth", entries)).toBe("t3");
    expect(makeEntryId("assumption", entries)).toBe("a1");
  });
});

describe("edit, confirm, delete", () => {
  it("edits one entry in place", () => {
    const state = run([{ t: "edit", id: "t1", text: "  new text " }], loaded);
    expect(state.entries[0]!.text).toBe("new text");
    expect(state.dirty).toBe(true);
  });

  it("does not blank an entry by accident", () => {
    const state = run([{ t: "edit", id: "t1", text: "  " }], loaded);
    expect(state.entries[0]!.text).toBe("t1");
    expect(state.dirty).toBe(false);
  });

  it("confirms an assumption", () => {
    const base = run([{ t: "loaded", doc: doc({ entries: [entry({ id: "a1", kind: "assumption", confirmed: false })] }) }]);
    const state = run([{ t: "confirm", id: "a1" }], base);
    expect(state.entries[0]!.confirmed).toBe(true);
    expect(unconfirmed(state.entries)).toHaveLength(0);
  });

  it("deletes by id and leaves the rest", () => {
    const base = run([{ t: "loaded", doc: doc({ entries: [entry({ id: "t1" }), entry({ id: "t2" })] }) }]);
    const state = run([{ t: "delete", id: "t1" }], base);
    expect(state.entries.map((item) => item.id)).toEqual(["t2"]);
    expect(state.dirty).toBe(true);
  });

  it("sends the revision it read", () => {
    const state = run([{ t: "add", kind: "term", text: "drop", source: null, at: AT }], loaded);
    expect(savePayload(state)).toEqual({ rev: 4, entries: state.entries });
  });
});

describe("409 handling", () => {
  const edited = run([{ t: "edit", id: "t1", text: "mine" }, { t: "saving" }], loaded);
  const server = doc({ rev: 7, entries: [entry({ id: "t1", text: "theirs" }), entry({ id: "t2", text: "new one" })] });
  const conflicted = run([{ t: "conflict", doc: server }], edited);

  it("shows the server copy, parks the local edit and says what happened", () => {
    expect(conflicted.rev).toBe(7);
    expect(conflicted.entries.map((item) => item.text)).toEqual(["theirs", "new one"]);
    expect(conflicted.pending!.map((item) => item.text)).toEqual(["mine"]);
    expect(conflicted.conflict).toBe(true);
    expect(conflicted.dirty).toBe(false);
    expect(conflicted.saving).toBe(false);
    expect(conflicted.error).toBe(CONFLICT_MESSAGE);
  });

  it("reapplies the parked edit against the new revision", () => {
    const state = run([{ t: "reapply" }], conflicted);
    expect(state.entries.map((item) => item.text)).toEqual(["mine"]);
    expect(savePayload(state).rev).toBe(7);
    expect(state.conflict).toBe(false);
    expect(state.dirty).toBe(true);
    expect(state.pending).toBeNull();
  });

  it("can keep the server copy instead", () => {
    const state = run([{ t: "discard" }], conflicted);
    expect(state.entries.map((item) => item.text)).toEqual(["theirs", "new one"]);
    expect(state.conflict).toBe(false);
    expect(state.dirty).toBe(false);
  });

  it("clears dirty and bumps the revision on a good save", () => {
    const state = run([{ t: "saved", doc: doc({ rev: 5 }) }], edited);
    expect(state).toMatchObject({ rev: 5, dirty: false, saving: false, conflict: false });
  });

  it("keeps the local edit when the save fails for another reason", () => {
    const state = run([{ t: "error", message: "500: wrapper failed" }], edited);
    expect(state.entries[0]!.text).toBe("mine");
    expect(state.dirty).toBe(true);
    expect(state.saving).toBe(false);
    expect(state.error).toBe("500: wrapper failed");
  });
});

describe("grouping and the mirror", () => {
  const entries = [
    entry({ id: "t1", kind: "truth", text: "Prices in MXN." }),
    entry({ id: "a1", kind: "assumption", text: "Mexico only.", confirmed: false, source: "dh-44" }),
    entry({ id: "c1", kind: "constraint", text: "DECISIONS.md wins." }),
  ];

  it("groups in a fixed kind order and skips empty kinds", () => {
    expect(groupByKind(entries).map((group) => group.kind)).toEqual(["truth", "assumption", "constraint"]);
  });

  it("renders a plain markdown mirror with the unconfirmed marker", () => {
    const markdown = truthsMarkdown("fintrack", entries);
    expect(markdown).toContain("# Truths: fintrack");
    expect(markdown).toContain("## Assumption");
    expect(markdown).toContain("- Mexico only. (unconfirmed; source: dh-44)");
    expect(markdown).not.toContain("<");
  });
});
