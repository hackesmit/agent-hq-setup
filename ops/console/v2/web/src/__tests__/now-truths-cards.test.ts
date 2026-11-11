// Unconfirmed-assumption cards in Now (bead hq-5mja): detection, the
// confirm read-modify-write with its one conflict retry, and the card
// rendering ctl-free actions.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Request, TruthsDoc } from "@shared/api";
import { ApiError } from "../data/client";
import { RequestCard } from "../now/RequestCard";
import { confirmAssumption, truthsCard, type TruthsApi } from "../now/truthsCards";

const NOW = Date.parse("2026-08-18T12:00:00Z");

function req(over: Partial<Request> = {}): Request {
  return {
    id: "truths-demo-a1",
    kind: "decide",
    severity: "P2",
    state: "open",
    rig: "demo",
    bead: null,
    session: null,
    createdAt: "2026-08-18T11:00:00Z",
    ageSeconds: 3600,
    question: "Unconfirmed assumption: the feed is daily",
    command: null,
    link: "/projects/demo",
    why: "source: xd-3",
    answer: null,
    settledAt: null,
    snoozedUntil: null,
    meta: { truths: true, project: "demo", entryId: "a1", rev: 4 },
    ...over,
  };
}

function doc(rev: number, confirmed: boolean): TruthsDoc {
  return {
    project: "demo",
    rev,
    updatedAt: "2026-08-18T10:00:00Z",
    entries: [
      { id: "a1", kind: "assumption", text: "the feed is daily", confirmed, added: "2026-08-17T10:00:00Z", source: "xd-3" },
      { id: "t1", kind: "truth", text: "left alone", confirmed: true, added: "2026-08-16T10:00:00Z", source: null },
    ],
  };
}

describe("truthsCard detection", () => {
  it("recognises the server's marker and nothing else", () => {
    expect(truthsCard(req())).toEqual({ project: "demo", entryId: "a1" });
    expect(truthsCard(req({ meta: {} }))).toBeNull();
    expect(truthsCard(req({ meta: { truths: true } }))).toBeNull();
    expect(truthsCard(req({ meta: { truths: "yes", project: "demo", entryId: "a1" } }))).toBeNull();
  });
});

describe("confirmAssumption", () => {
  it("flips only the target entry and saves with the read revision", async () => {
    const saves: Array<{ rev: number; entries: TruthsDoc["entries"] }> = [];
    const api: TruthsApi = {
      truths: async () => doc(4, false),
      saveTruths: async (_p, rev, entries) => {
        saves.push({ rev, entries });
        return doc(5, true);
      },
    };
    expect(await confirmAssumption("demo", "a1", api)).toBe("confirmed");
    expect(saves).toHaveLength(1);
    expect(saves[0]!.rev).toBe(4);
    expect(saves[0]!.entries.find((e) => e.id === "a1")!.confirmed).toBe(true);
    expect(saves[0]!.entries.find((e) => e.id === "t1")).toEqual(doc(4, false).entries[1]);
  });

  it("does not save when the entry is already confirmed or already gone", async () => {
    let saved = 0;
    const confirmedApi: TruthsApi = {
      truths: async () => doc(4, true),
      saveTruths: async () => ((saved += 1), doc(5, true)),
    };
    expect(await confirmAssumption("demo", "a1", confirmedApi)).toBe("confirmed");
    const goneApi: TruthsApi = {
      truths: async () => ({ ...doc(4, true), entries: [] }),
      saveTruths: async () => ((saved += 1), doc(5, true)),
    };
    expect(await confirmAssumption("demo", "a1", goneApi)).toBe("gone");
    expect(saved).toBe(0);
  });

  it("retries exactly once on a 409 and rethrows anything else", async () => {
    let reads = 0;
    let saves = 0;
    const conflict = new ApiError(409, "stale revision", null);
    const api: TruthsApi = {
      truths: async () => (reads += 1, doc(4 + reads, false)),
      saveTruths: async () => {
        saves += 1;
        if (saves === 1) throw conflict;
        return doc(9, true);
      },
    };
    expect(await confirmAssumption("demo", "a1", api)).toBe("confirmed");
    expect(reads).toBe(2);
    expect(saves).toBe(2);

    const broken: TruthsApi = {
      truths: async () => doc(4, false),
      saveTruths: async () => {
        throw new Error("boom");
      },
    };
    await expect(confirmAssumption("demo", "a1", broken)).rejects.toThrow("boom");
  });
});

describe("the card", () => {
  it("shows Confirm and Open Truths, and none of the ctl verbs", () => {
    const html = renderToStaticMarkup(createElement(RequestCard, { request: req(), now: NOW }));
    expect(html).toContain("Confirm");
    expect(html).toContain("Open Truths");
    expect(html).toContain("/projects/demo");
    expect(html).not.toContain(">Answer<");
    expect(html).not.toContain(">Skip<");
    expect(html).not.toContain(">Snooze<");
    expect(html).not.toContain(">Sink<");
  });

  it("an ordinary decide card keeps its ctl actions", () => {
    const plain = req({ id: "r-9", meta: {}, link: null });
    const html = renderToStaticMarkup(createElement(RequestCard, { request: plain, now: NOW }));
    expect(html).toContain("Send");
    expect(html).toContain(">Snooze<");
    expect(html).not.toContain("Open Truths");
  });
});
