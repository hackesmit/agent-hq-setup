// Adversarial review tests for bead hq-on93 (console v2 web shell).
//
// Added by a fresh-context reviewer, not by the author of the shell. Everything here is
// pure: no browser, no jsdom, no network. Two groups:
//
//   1. wsMachine edge cases the existing suite does not pin: the token fetch failing
//      before a socket exists, a socket that closes while hello is in flight, polling
//      that must stop the instant the socket recovers, and backoff that must stay
//      monotonic and capped.
//   2. The REST client's two security-relevant behaviours: every POST carries the CSRF
//      header and every request URL stays relative, and a 403 {reload:true} reloads the
//      page at most once per page life rather than in a loop.
//
// The client tests import the module dynamically, after installing a fake window, because
// client.ts reads window at import time and keeps the reload latch in module scope.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleState, Request, Severity } from "@shared/api";
import {
  BACKOFF_MAX_MS,
  initialWsState,
  linkStatus,
  POLL_AFTER_MS,
  wsReduce,
  type WsMachineState,
} from "../data/wsMachine";
import { compareRequests, sortRequests } from "../now/lanes";
import { deriveBadges, tabBadges } from "../app/badges";

// ---------------------------------------------------------------- wsMachine

/** Replay a list of events from the initial state. */
function replay(events: { t: "start" | "open" | "closed" | "stop" | "tick"; now: number }[]): WsMachineState {
  let state = initialWsState;
  for (const event of events) state = wsReduce(state, event);
  return state;
}

describe("wsMachine, reviewer edge cases", () => {
  it("treats a token fetch failure as a close: backoff, a retry time, and no instant poll", () => {
    // ws.ts openSocket() catch path: the POST /api/ws-token rejected, so no socket was
    // ever constructed and the only event the reducer sees is "closed".
    const state = replay([
      { t: "start", now: 1_000 },
      { t: "closed", now: 1_050 },
    ]);
    expect(state.phase).toBe("backoff");
    expect(state.attempts).toBe(1);
    expect(state.retryAt).not.toBeNull();
    expect(state.retryAt! > 1_050).toBe(true);
    // A failed token fetch 50 ms in is a blip, not an outage: no REST burst yet.
    expect(state.polling).toBe(false);
    expect(linkStatus(state)).toBe("connecting");
  });

  it("keeps the original downSince when the token fetch fails repeatedly", () => {
    const state = replay([
      { t: "start", now: 1_000 },
      { t: "closed", now: 1_100 },
      { t: "tick", now: 1_600 },
      { t: "closed", now: 2_000 },
      { t: "closed", now: 3_000 },
    ]);
    expect(state.downSince).toBe(1_000);
    // Down for POLL_AFTER_MS from the FIRST loss, not from the latest attempt.
    const later = wsReduce(state, { t: "tick", now: 1_000 + POLL_AFTER_MS });
    expect(later.polling).toBe(true);
  });

  it("survives a socket that closes while hello is still in flight", () => {
    // onopen fired (the machine is "open" and polling is off) but the server never sent
    // hello before the socket dropped. The reducer must go back to backoff with a fresh
    // downSince rather than staying "open" with a dead socket.
    const open = replay([
      { t: "start", now: 1_000 },
      { t: "open", now: 1_200 },
    ]);
    expect(open.downSince).toBeNull();
    const dropped = wsReduce(open, { t: "closed", now: 1_250 });
    expect(dropped.phase).toBe("backoff");
    expect(dropped.downSince).toBe(1_250);
    expect(dropped.attempts).toBe(1);
    expect(linkStatus(dropped)).toBe("connecting");
  });

  it("stops polling the instant the socket recovers, however long the outage was", () => {
    let state = replay([
      { t: "start", now: 0 },
      { t: "closed", now: 100 },
    ]);
    for (let now = 1_000; now <= 120_000; now += 1_000) state = wsReduce(state, { t: "tick", now });
    expect(state.polling).toBe(true);
    expect(linkStatus(state)).toBe("polling");

    const back = wsReduce(state, { t: "open", now: 120_500 });
    expect(back.polling).toBe(false);
    expect(back.downSince).toBeNull();
    expect(back.attempts).toBe(0);
    expect(linkStatus(back)).toBe("live");

    // And a later tick must not switch polling back on while the socket is open.
    expect(wsReduce(back, { t: "tick", now: 200_000 }).polling).toBe(false);
  });

  it("never lets the retry delay shrink and caps it", () => {
    let state = wsReduce(initialWsState, { t: "start", now: 0 });
    let previous = -1;
    for (let i = 0; i < 40; i += 1) {
      const now = i * 100_000;
      state = wsReduce(state, { t: "closed", now });
      const delay = state.retryAt! - now;
      expect(delay).toBeGreaterThanOrEqual(previous);
      expect(delay).toBeLessThanOrEqual(BACKOFF_MAX_MS);
      previous = delay;
    }
    expect(previous).toBe(BACKOFF_MAX_MS);
  });

  it("a due tick moves backoff to connecting and clears the retry time exactly once", () => {
    const backoff = replay([
      { t: "start", now: 0 },
      { t: "closed", now: 100 },
    ]);
    const due = backoff.retryAt!;
    expect(wsReduce(backoff, { t: "tick", now: due - 1 }).phase).toBe("backoff");
    const connecting = wsReduce(backoff, { t: "tick", now: due });
    expect(connecting.phase).toBe("connecting");
    expect(connecting.retryAt).toBeNull();
    // A second tick must not re-fire a connect (retryAt is gone, phase is not backoff).
    expect(wsReduce(connecting, { t: "tick", now: due + 10 }).phase).toBe("connecting");
  });

  it("stop resets everything from every phase", () => {
    for (const phase of [
      replay([{ t: "start", now: 0 }]),
      replay([{ t: "start", now: 0 }, { t: "open", now: 1 }]),
      replay([{ t: "start", now: 0 }, { t: "closed", now: 1 }]),
    ]) {
      const stopped = wsReduce(phase, { t: "stop", now: 99 });
      expect(stopped).toEqual(initialWsState);
      expect(linkStatus(stopped)).toBe("offline");
    }
  });

  it("ignores a close that arrives while idle, so a late socket event cannot fake an outage", () => {
    const idle = wsReduce(initialWsState, { t: "stop", now: 5 });
    expect(wsReduce(idle, { t: "closed", now: 10 })).toBe(idle);
  });
});

// ---------------------------------------------------------------- lane sorting

function req(id: string, severity: Severity, createdAt: string, ageSeconds = 0): Request {
  return {
    id,
    kind: "decide",
    severity,
    state: "open",
    rig: null,
    bead: null,
    session: null,
    createdAt,
    ageSeconds,
    question: "q",
    command: null,
    link: null,
    why: null,
    answer: null,
    settledAt: null,
    snoozedUntil: null,
    meta: {},
  };
}

describe("request lane sorting, reviewer edge cases", () => {
  const sample: Request[] = [
    req("c", "P1", "2026-08-18T10:00:00Z"),
    req("a", "P0", "2026-08-18T10:05:00Z"),
    req("b", "P0", "2026-08-18T10:05:00Z"),
    req("e", "P2", "2026-08-18T09:00:00Z"),
    req("d", "P0", "2026-08-18T09:59:00Z"),
    req("f", "P1", "2026-08-18T10:00:00Z"),
  ];

  it("is a total order: antisymmetric, and equal only for the same id", () => {
    for (const x of sample) {
      for (const y of sample) {
        const forward = compareRequests(x, y);
        const backward = compareRequests(y, x);
        expect(Math.sign(forward) + Math.sign(backward)).toBe(0);
        if (x.id !== y.id) expect(forward).not.toBe(0);
      }
    }
  });

  it("is transitive across the sample", () => {
    const sorted = sortRequests(sample);
    for (let i = 0; i < sorted.length - 1; i += 1) {
      expect(compareRequests(sorted[i]!, sorted[i + 1]!)).toBeLessThan(0);
    }
  });

  it("gives the same order for every input permutation", () => {
    const expected = sortRequests(sample).map((r) => r.id);
    // Deterministic shuffles, so a failure is reproducible.
    for (let seed = 1; seed <= 60; seed += 1) {
      const shuffled = [...sample];
      let state = seed;
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        state = (state * 1103515245 + 12345) % 2147483648;
        const j = state % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      expect(sortRequests(shuffled).map((r) => r.id)).toEqual(expected);
    }
  });

  it("puts every P0 ahead of every P1, regardless of age", () => {
    const order = sortRequests(sample).map((r) => r.severity);
    const lastP0 = order.lastIndexOf("P0");
    const firstP1 = order.indexOf("P1");
    expect(lastP0).toBeLessThan(firstP1);
  });
});

// ---------------------------------------------------------------- badges

describe("badge computation, reviewer edge cases", () => {
  it("shows no tone at zero even when a P0 severity is attached", () => {
    const badges = tabBadges({
      badges: { now: 0, nowSeverity: "P0", projects: 0, stack: 0, machines: 0 },
    } as unknown as ConsoleState);
    expect(badges.now).toEqual({ count: 0, tone: "none" });
    expect(badges.machines).toEqual({ count: 0, tone: "none" });
    expect(badges.money).toEqual({ count: 0, tone: "none" });
  });

  it("tones a non-zero machines badge as P1 and a non-zero projects badge as neutral", () => {
    const badges = tabBadges({
      badges: { now: 0, nowSeverity: null, projects: 2, stack: 0, machines: 3 },
    } as unknown as ConsoleState);
    expect(badges.machines.tone).toBe("p1");
    expect(badges.projects.tone).toBe("neutral");
  });

  it("derives all zeros, not a crash, from a state with every slice missing", () => {
    expect(deriveBadges({} as unknown as ConsoleState)).toEqual({
      now: 0,
      nowSeverity: null,
      projects: 0,
      stack: 0,
      machines: 0,
    });
    expect(deriveBadges(null)).toEqual({
      now: 0,
      nowSeverity: null,
      projects: 0,
      stack: 0,
      machines: 0,
    });
  });
});

// ---------------------------------------------------------------- REST client

interface FakeWindow {
  __CONSOLE_BOOT_KEY__?: string;
  location: { reload: () => void };
}

interface Call {
  url: string;
  init: RequestInit;
}

async function loadClient(bootKey: string | undefined, reload: () => void) {
  const fake: FakeWindow = { __CONSOLE_BOOT_KEY__: bootKey, location: { reload } };
  (globalThis as unknown as { window: FakeWindow }).window = fake;
  vi.resetModules();
  return (await import("../data/client")) as typeof import("../data/client");
}

function stubFetch(respond: (url: string) => { status: number; body: string }): Call[] {
  const calls: Call[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const { status, body } = respond(url);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      text: () => Promise.resolve(body),
    });
  };
  return calls;
}

describe("REST client, reviewer edge cases", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("sends the CSRF key on every POST and never on a GET, and keeps every URL relative", async () => {
    const client = await loadClient("BOOTKEY", () => {});
    const calls = stubFetch(() => ({ status: 200, body: "{}" }));

    // Every mutating entry point on the api surface.
    await Promise.all([
      client.api.wsToken(),
      client.api.answer("r1", "yes"),
      client.api.resolve("r1", "done"),
      client.api.done("r1"),
      client.api.skip("r1", "later"),
      client.api.reqSnooze("r1", "2026-08-18T12:00:00Z"),
      client.api.reqUnsnooze("r1"),
      client.api.sink("r1", true),
      client.api.dispatch("hq", "b1", "opus"),
      client.api.dispatchBatch("hq", ["b1", "b2"], "opus"),
      client.api.session("s1", "kill"),
      client.api.phase("b1", "review", true),
      client.api.capture("hq", "note"),
      client.api.ackAlert("a1"),
    ]);
    const posts = calls.filter((c) => c.init.method === "POST");
    expect(posts.length).toBe(14);
    for (const call of posts) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers["X-Console-Key"]).toBe("BOOTKEY");
    }

    calls.length = 0;
    await Promise.all([client.api.state(), client.api.op("o1"), client.api.uploads("2026-08-18")]);
    for (const call of calls) {
      expect(call.init.method).toBe("GET");
      expect((call.init.headers as Record<string, string> | undefined)?.["X-Console-Key"]).toBeUndefined();
    }
  });

  it("never fetches an absolute or protocol-relative URL", async () => {
    const client = await loadClient("BOOTKEY", () => {});
    const calls = stubFetch(() => ({ status: 200, body: "{}" }));
    await Promise.all([
      client.api.state(),
      client.api.wsToken(),
      client.api.session("../../evil", "kill"),
      client.api.op("../../evil"),
      client.api.uploads("../../evil"),
    ]);
    for (const call of calls) {
      expect(call.url.startsWith("/")).toBe(true);
      expect(call.url.startsWith("//")).toBe(false);
      expect(/^[a-z][a-z0-9+.-]*:/i.test(call.url)).toBe(false);
      // Path segments carrying user or server data must be encoded, never able to climb.
      expect(call.url).not.toContain("../");
    }
  });

  it("reloads at most once no matter how many 403 {reload:true} answers arrive", async () => {
    let reloads = 0;
    const client = await loadClient("STALE", () => {
      reloads += 1;
    });
    stubFetch(() => ({ status: 403, body: JSON.stringify({ error: "stale page key", reload: true }) }));

    for (let i = 0; i < 25; i += 1) {
      await expect(client.api.done(`r${i}`)).rejects.toBeInstanceOf(client.ApiError);
    }
    expect(reloads).toBe(1);
  });

  it("does not reload on a 403 that is not a stale-key answer", async () => {
    let reloads = 0;
    const client = await loadClient("BOOTKEY", () => {
      reloads += 1;
    });
    stubFetch(() => ({ status: 403, body: JSON.stringify({ error: "bad origin" }) }));
    await expect(client.api.done("r1")).rejects.toBeInstanceOf(client.ApiError);
    expect(reloads).toBe(0);
  });

  it("surfaces a non-JSON error body as the message rather than swallowing it", async () => {
    const client = await loadClient("BOOTKEY", () => {});
    stubFetch(() => ({ status: 500, body: "runner is down" }));
    await expect(client.api.done("r1")).rejects.toThrow("runner is down");
  });
});
