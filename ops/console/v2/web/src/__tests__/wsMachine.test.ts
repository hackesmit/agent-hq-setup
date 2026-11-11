import { describe, expect, it } from "vitest";
import {
  BACKOFF_MAX_MS,
  backoffDelay,
  initialWsState,
  linkStatus,
  POLL_AFTER_MS,
  SILENT_DEAD_MS,
  socketDead,
  WAKE_PROBE_MS,
  wsReduce,
  type WsMachineState,
} from "../data/wsMachine";

const T0 = 1_000_000;

function feed(state: WsMachineState, events: Parameters<typeof wsReduce>[1][]): WsMachineState {
  return events.reduce((current, event) => wsReduce(current, event), state);
}

describe("backoffDelay", () => {
  it("doubles and then caps", () => {
    expect(backoffDelay(0)).toBe(500);
    expect(backoffDelay(1)).toBe(1000);
    expect(backoffDelay(2)).toBe(2000);
    expect(backoffDelay(99)).toBe(BACKOFF_MAX_MS);
  });
});

describe("wsReduce", () => {
  it("starts connecting and records when the link went down", () => {
    const state = wsReduce(initialWsState, { t: "start", now: T0 });
    expect(state.phase).toBe("connecting");
    expect(state.downSince).toBe(T0);
    expect(state.polling).toBe(false);
  });

  it("clears everything on open", () => {
    const state = feed(initialWsState, [
      { t: "start", now: T0 },
      { t: "closed", now: T0 + 100 },
      { t: "open", now: T0 + 200 },
    ]);
    expect(state).toEqual({ phase: "open", attempts: 0, downSince: null, polling: false, retryAt: null });
    expect(linkStatus(state)).toBe("live");
  });

  it("does not poll for a short blip", () => {
    const state = feed(initialWsState, [
      { t: "start", now: T0 },
      { t: "closed", now: T0 + 200 },
      { t: "tick", now: T0 + 1_000 },
    ]);
    expect(state.polling).toBe(false);
    expect(linkStatus(state)).toBe("connecting");
  });

  it("turns polling on once the socket has been down longer than 5 s", () => {
    const down = feed(initialWsState, [
      { t: "start", now: T0 },
      { t: "closed", now: T0 + 200 },
    ]);
    const justBefore = wsReduce(down, { t: "tick", now: T0 + POLL_AFTER_MS - 1 });
    expect(justBefore.polling).toBe(false);

    const after = wsReduce(down, { t: "tick", now: T0 + POLL_AFTER_MS + 1 });
    expect(after.polling).toBe(true);
    expect(linkStatus(after)).toBe("polling");
  });

  it("stops polling as soon as the socket is back", () => {
    const polling = feed(initialWsState, [
      { t: "start", now: T0 },
      { t: "closed", now: T0 + 200 },
      { t: "tick", now: T0 + 9_000 },
    ]);
    expect(polling.polling).toBe(true);
    const live = wsReduce(polling, { t: "open", now: T0 + 9_500 });
    expect(live.polling).toBe(false);
    expect(live.attempts).toBe(0);
  });

  it("retries on the backoff schedule and grows the delay per failure", () => {
    const first = feed(initialWsState, [
      { t: "start", now: T0 },
      { t: "closed", now: T0 },
    ]);
    expect(first.retryAt).toBe(T0 + 500);
    expect(wsReduce(first, { t: "tick", now: T0 + 400 }).phase).toBe("backoff");
    const retry = wsReduce(first, { t: "tick", now: T0 + 500 });
    expect(retry.phase).toBe("connecting");

    const second = wsReduce(retry, { t: "closed", now: T0 + 600 });
    expect(second.attempts).toBe(2);
    expect(second.retryAt).toBe(T0 + 600 + 1000);
  });

  it("keeps the original down timestamp across repeated failures", () => {
    const state = feed(initialWsState, [
      { t: "start", now: T0 },
      { t: "closed", now: T0 + 100 },
      { t: "tick", now: T0 + 700 },
      { t: "closed", now: T0 + 900 },
    ]);
    expect(state.downSince).toBe(T0);
  });

  it("resets on stop and reports offline", () => {
    const state = feed(initialWsState, [
      { t: "start", now: T0 },
      { t: "closed", now: T0 + 100 },
      { t: "stop", now: T0 + 200 },
    ]);
    expect(state).toEqual(initialWsState);
    expect(linkStatus(state)).toBe("offline");
  });

  it("returns the same object when a tick changes nothing", () => {
    const open = feed(initialWsState, [
      { t: "start", now: T0 },
      { t: "open", now: T0 + 10 },
    ]);
    expect(wsReduce(open, { t: "tick", now: T0 + 60_000 })).toBe(open);
  });
});

describe("hq-aukwy: recovery within 5 s", () => {
  it("caps the retry delay at 4 s", () => {
    expect(BACKOFF_MAX_MS).toBeLessThanOrEqual(4000);
    expect(backoffDelay(3)).toBe(4000);
  });

  it("a wake in backoff makes the retry due now", () => {
    const backoff = feed(initialWsState, [
      { t: "start", now: T0 },
      { t: "closed", now: T0 },
      { t: "closed", now: T0 + 10 },
      { t: "closed", now: T0 + 20 },
    ]);
    expect(backoff.retryAt! - (T0 + 20)).toBe(2000);
    const woke = wsReduce(backoff, { t: "wake", now: T0 + 30 });
    expect(wsReduce(woke, { t: "tick", now: T0 + 30 }).phase).toBe("connecting");
  });

  it("a wake outside backoff changes nothing", () => {
    const open = feed(initialWsState, [{ t: "start", now: T0 }, { t: "open", now: T0 }]);
    expect(wsReduce(open, { t: "wake", now: T0 + 1 })).toBe(open);
  });

  it("socketDead: silence past the limit, or an unanswered wake probe", () => {
    expect(socketDead(T0, null, T0 + SILENT_DEAD_MS - 1)).toBe(false);
    expect(socketDead(T0, null, T0 + SILENT_DEAD_MS)).toBe(true);
    const sentAt = T0 + 1000;
    const deadline = sentAt + WAKE_PROBE_MS;
    expect(socketDead(T0, deadline, deadline - 1)).toBe(false);
    expect(socketDead(T0, deadline, deadline)).toBe(true);
    // anything received after the probe went out proves the socket alive
    expect(socketDead(sentAt + 5, deadline, deadline)).toBe(false);
  });
});
