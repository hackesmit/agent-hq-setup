// Questions route to the card of the terminal that asked them (hq-zqqu.1). The case that
// matters most is the orphan: a question whose asker is gone, or that was filed with no
// session at all, must still land somewhere answerable instead of vanishing with the
// Needs-you panel.

import { describe, expect, it } from "vitest";
import type { Request, Session } from "@shared/api";
import { cardMayClear, openAfterLayoutChange, routeRequests, waitingCount } from "./sessionRequests";

const session = (id: string, state: Session["state"] = "waiting") => ({ id, state }) as Session;

function req(id: string, over: Partial<Request> = {}): Request {
  return {
    id,
    kind: "decide",
    severity: "P1",
    state: "open",
    rig: null,
    bead: null,
    session: null,
    createdAt: "2026-10-20T10:00:00.000Z",
    ageSeconds: 60,
    question: `question ${id}`,
    command: null,
    link: null,
    why: null,
    answer: null,
    settledAt: null,
    snoozedUntil: null,
    meta: {},
    ...over,
  };
}

describe("routeRequests", () => {
  it("puts an open question on its asking session's card", () => {
    const routed = routeRequests([req("r1", { session: "s1" })], [session("s1")]);
    expect(routed.bySession.get("s1")?.map((r) => r.id)).toEqual(["r1"]);
    expect(routed.orphans).toEqual([]);
  });

  it("keeps questions with no session, or a gone session, as orphans", () => {
    const routed = routeRequests(
      [req("r1"), req("r2", { session: "gone" }), req("r3", { session: "s-closed" })],
      [session("s-closed", "closed")],
    );
    expect(routed.orphans.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    expect(routed.bySession.size).toBe(0);
  });

  it("drops settled questions and folds snoozed ones away", () => {
    const routed = routeRequests(
      [
        req("done", { session: "s1", state: "delivered" }),
        req("later", { session: "s1", state: "snoozed", snoozedUntil: "2026-10-21T08:00:00.000Z" }),
      ],
      [session("s1", "running")],
    );
    expect(routed.bySession.size).toBe(0);
    expect(routed.orphans).toEqual([]);
    expect(routed.snoozed.map((r) => r.id)).toEqual(["later"]);
  });

  it("orders a session's questions P0 first, then oldest", () => {
    const routed = routeRequests(
      [
        req("p2", { session: "s1", severity: "P2" }),
        req("p0-new", { session: "s1", severity: "P0", createdAt: "2026-10-20T11:00:00.000Z" }),
        req("p0-old", { session: "s1", severity: "P0", createdAt: "2026-10-20T09:00:00.000Z" }),
      ],
      [session("s1")],
    );
    expect(routed.bySession.get("s1")?.map((r) => r.id)).toEqual(["p0-old", "p0-new", "p2"]);
  });

  it("a snoozed session still shows its question on its card", () => {
    const routed = routeRequests([req("r1", { session: "s1" })], [session("s1", "snoozed")]);
    expect(routed.bySession.get("s1")?.length).toBe(1);
  });
});

describe("waitingCount", () => {
  it("counts open questions only", () => {
    expect(waitingCount([req("a"), req("b", { state: "answered" }), req("c", { state: "snoozed" })])).toBe(1);
  });
});

describe("delivering (hq-zqqu.1 round 1)", () => {
  it("keeps an answer that has not reached a live terminal on that terminal's card", () => {
    const routed = routeRequests(
      [
        req("owed", { session: "s1", state: "answered" }),
        req("claimed", { session: "s1", state: "revival_claimed" }),
        req("done", { session: "s1", state: "delivered" }),
        req("elsewhere", { session: "gone", state: "answered" }),
      ],
      [session("s1", "running")],
    );
    expect(routed.delivering.get("s1")?.map((r) => r.id)).toEqual(["owed", "claimed"]);
    expect(routed.delivering.has("gone")).toBe(false);
    expect(routed.bySession.size).toBe(0);
  });
});

describe("undelivered (hq-zqqu.1 round 3)", () => {
  it("lists an answer whose asker is not on the card list at the foot, so it never drops off", () => {
    const routed = routeRequests(
      [
        req("gone-owed", { session: "gone", state: "answered" }),
        req("unbound-owed", { session: null, state: "revival_claimed" }),
        req("live-owed", { session: "s1", state: "answered" }),
        req("gone-done", { session: "gone", state: "delivered" }),
        req("gone-cancelled", { session: "gone", state: "cancelled" }),
      ],
      [session("s1", "running")],
    );
    expect(routed.undelivered.map((r) => r.id)).toEqual(["gone-owed", "unbound-owed"]);
    expect(routed.delivering.get("s1")?.map((r) => r.id)).toEqual(["live-owed"]);
    expect(routed.orphans).toEqual([]);
  });
  it("keeps an open question from a session that looks ended open and answerable at the foot", () => {
    const routed = routeRequests([req("q", { session: "gone" })], [session("s1", "running")]);
    expect(routed.orphans.map((r) => r.id)).toEqual(["q"]);
    expect(routed.undelivered).toEqual([]);
  });
});

describe("openAfterLayoutChange", () => {
  it("stays open when the phone layout arrives with questions already waiting", () => {
    expect(openAfterLayoutChange(true, 2)).toBe(true);
  });
  it("folds on the phone with nothing waiting, and always opens on a wide screen", () => {
    expect(openAfterLayoutChange(true, 0)).toBe(false);
    expect(openAfterLayoutChange(false, 0)).toBe(true);
  });
});

describe("cardMayClear (hq-zqqu.1 round 4)", () => {
  it("never offers Clear on a running headless worker's answer it has not picked up yet", () => {
    expect(cardMayClear({ kind: "worker" })).toBe(false);
  });
  it("offers Clear on an interactive terminal's or Capri's card", () => {
    expect(cardMayClear({ kind: "interactive" })).toBe(true);
    expect(cardMayClear({ kind: "meta" })).toBe(true);
  });
});
