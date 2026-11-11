// Lane and fade behaviour for the Needs-you panel (bead hq-tsom).
//
// The fade is the part worth pinning: a settled card has to leave its lane at once, stay
// visible and dimming for 2 minutes keyed on settledAt, and then disappear. Getting that
// wrong either loses an accidental Skip or pins a dead card to the tab forever.

import { describe, expect, it } from "vitest";
import type { Request } from "@shared/api";
import { sanitizeUrl } from "../projects/markdown";
import {
  FADE_FLOOR,
  FADE_MS,
  fadeOpacity,
  fadingRequests,
  isFading,
  isSettled,
  liveAgeSeconds,
  orderedOpen,
  safeLink,
  settledMs,
  snoozedRequests,
} from "../now/lanes";

const BASE = Date.parse("2026-08-18T12:00:00.000Z");

function req(over: Partial<Request> & { id: string }): Request {
  return {
    kind: "decide",
    severity: "P1",
    state: "open",
    rig: null,
    bead: null,
    session: null,
    createdAt: new Date(BASE - 60_000).toISOString(),
    ageSeconds: 60,
    question: over.id,
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

describe("settled cards", () => {
  it("counts the four settled states and no others", () => {
    expect(isSettled(req({ id: "a", state: "answered" }))).toBe(true);
    expect(isSettled(req({ id: "b", state: "resolved" }))).toBe(true);
    expect(isSettled(req({ id: "c", state: "cancelled" }))).toBe(true);
    expect(isSettled(req({ id: "d", state: "delivered" }))).toBe(true);
    expect(isSettled(req({ id: "e", state: "open" }))).toBe(false);
    expect(isSettled(req({ id: "f", state: "snoozed" }))).toBe(false);
    expect(isSettled(req({ id: "g", state: "revival_claimed" }))).toBe(false);
  });

  it("keys the fade on settledAt, not on createdAt", () => {
    // Created hours ago, settled one minute ago: it must still be on screen.
    const card = req({
      id: "old-but-fresh",
      state: "answered",
      createdAt: new Date(BASE - 6 * 3_600_000).toISOString(),
      settledAt: new Date(BASE - 60_000).toISOString(),
    });
    expect(isFading(card, BASE)).toBe(true);
    expect(settledMs(card)).toBe(BASE - 60_000);
  });

  it("drops the card once the 2-minute window has passed", () => {
    const card = req({ id: "gone", state: "resolved", settledAt: new Date(BASE - FADE_MS - 1000).toISOString() });
    expect(isFading(card, BASE)).toBe(false);
  });

  it("keeps the card exactly at the window edge", () => {
    const card = req({ id: "edge", state: "resolved", settledAt: new Date(BASE - FADE_MS).toISOString() });
    expect(isFading(card, BASE)).toBe(true);
  });

  it("tolerates a settledAt in the future (clock skew between hqbox and the browser)", () => {
    const card = req({ id: "skew", state: "answered", settledAt: new Date(BASE + 30_000).toISOString() });
    expect(isFading(card, BASE)).toBe(true);
  });

  it("falls back to createdAt when the server has not filled settledAt yet", () => {
    const fresh = req({ id: "fresh", state: "answered", createdAt: new Date(BASE - 60_000).toISOString() });
    const stale = req({ id: "stale", state: "answered", createdAt: new Date(BASE - 3_600_000).toISOString() });
    expect(isFading(fresh, BASE)).toBe(true);
    expect(isFading(stale, BASE)).toBe(false);
  });

  it("never fades an open card", () => {
    expect(isFading(req({ id: "open", state: "open" }), BASE)).toBe(false);
  });

  it("dims from full to the floor across the window", () => {
    const at = (ms: number): Request =>
      req({ id: `x${ms}`, state: "answered", settledAt: new Date(BASE - ms).toISOString() });
    expect(fadeOpacity(at(0), BASE)).toBe(1);
    expect(fadeOpacity(at(FADE_MS / 2), BASE)).toBeCloseTo(1 - (1 - FADE_FLOOR) / 2, 2);
    expect(fadeOpacity(at(FADE_MS), BASE)).toBeCloseTo(FADE_FLOOR, 2);
    // Past the window the value is clamped, never negative.
    expect(fadeOpacity(at(FADE_MS * 3), BASE)).toBeCloseTo(FADE_FLOOR, 2);
  });

  it("lists the fading cards most recently settled first", () => {
    const cards = [
      req({ id: "old", state: "answered", settledAt: new Date(BASE - FADE_MS / 2).toISOString() }),
      req({ id: "new", state: "resolved", settledAt: new Date(BASE - FADE_MS / 10).toISOString() }),
      req({ id: "expired", state: "resolved", settledAt: new Date(BASE - FADE_MS * 3).toISOString() }),
      req({ id: "open" }),
    ];
    expect(fadingRequests(cards, BASE).map((card) => card.id)).toEqual(["new", "old"]);
  });
});

describe("orderedOpen", () => {
  it("flattens the lanes into the order j and k walk", () => {
    const cards = [
      req({ id: "p2", severity: "P2", createdAt: new Date(BASE - 900_000).toISOString() }),
      req({ id: "p0-new", severity: "P0", createdAt: new Date(BASE - 60_000).toISOString() }),
      req({ id: "p0-old", severity: "P0", createdAt: new Date(BASE - 600_000).toISOString() }),
      req({ id: "settled", severity: "P0", state: "answered" }),
      req({ id: "p1", severity: "P1", createdAt: new Date(BASE - 120_000).toISOString() }),
    ];
    expect(orderedOpen(cards).map((card) => card.id)).toEqual(["p0-old", "p0-new", "p1", "p2"]);
  });
});

describe("liveAgeSeconds", () => {
  it("ticks from createdAt rather than waiting for the next state push", () => {
    const card = req({ id: "a", createdAt: new Date(BASE - 120_000).toISOString(), ageSeconds: 60 });
    expect(liveAgeSeconds(card, BASE)).toBe(120);
    expect(liveAgeSeconds(card, BASE + 60_000)).toBe(180);
  });

  it("falls back to the server age when createdAt is unusable", () => {
    const card = req({ id: "b", createdAt: "not a date", ageSeconds: 42 });
    expect(liveAgeSeconds(card, BASE)).toBe(42);
  });
});

describe("snoozedRequests", () => {
  it("orders by wake time, with an unknown wake time last", () => {
    const cards = [
      req({ id: "late", state: "snoozed", snoozedUntil: new Date(BASE + 7_200_000).toISOString() }),
      req({ id: "unknown", state: "snoozed", snoozedUntil: null }),
      req({ id: "soon", state: "snoozed", snoozedUntil: new Date(BASE + 600_000).toISOString() }),
      req({ id: "open" }),
    ];
    expect(snoozedRequests(cards).map((card) => card.id)).toEqual(["soon", "late", "unknown"]);
  });
});

describe("safeLink", () => {
  it("passes http and https and rejects everything else", () => {
    expect(safeLink("https://vercel.com/x")).toBe("https://vercel.com/x");
    expect(safeLink("http://hqbox:8787/x")).toBe("http://hqbox:8787/x");
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink("data:text/html,<script>")).toBeNull();
    expect(safeLink("file:///etc/passwd")).toBeNull();
    expect(safeLink(null)).toBeNull();
    expect(safeLink("   ")).toBeNull();
  });
});

describe("markdown links from agent-written notes", () => {
  it("refuses a protocol-relative url that reads like an internal link", () => {
    // "//host/x" starts with a slash, so the relative-link branch used to wave it
    // through; it leaves the tailnet while looking like a console path.
    expect(sanitizeUrl("//evil.example/hq")).toBe(null);
    expect(sanitizeUrl("  //evil.example/hq  ")).toBe(null);
    expect(sanitizeUrl("//evil.example")).toBe(null);
    // genuinely relative links still work
    expect(sanitizeUrl("/projects/x")).toBe("/projects/x");
    expect(sanitizeUrl("#anchor")).toBe("#anchor");
    expect(sanitizeUrl("https://example.com/x")).toBe("https://example.com/x");
  });
});

describe("a protocol-relative url wearing a different coat", () => {
  it("treats backslashes as the slashes a browser resolves them to", () => {
    // A browser resolving an href for a special scheme reads \ as /, so these all
    // navigate off the tailnet from an https page even though none starts with //.
    expect(sanitizeUrl("\\\\evil.example/hq")).toBe(null);
    expect(sanitizeUrl("/\\evil.example/hq")).toBe(null);
    expect(sanitizeUrl("\\/evil.example/hq")).toBe(null);
    expect(sanitizeUrl("&#47;&#47;evil.example/hq")).toBe(null);
    // a single backslash that is not leading is still an ordinary relative path
    expect(sanitizeUrl("/projects/a-b")).toBe("/projects/a-b");
  });
});
