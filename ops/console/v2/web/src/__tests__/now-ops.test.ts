// Op settling (beads hq-tsom, hq-uyes): an action POST answers 202 with a queued op, so
// "it worked" is only known after GET /api/op/:id settles. Everything here runs on an
// injected clock and fetcher, so the suite stays instant and has no network.

import { describe, expect, it } from "vitest";
import type { Op } from "@shared/api";
import { errorText, isOp, isSettledOp, opFailureText, settleOp } from "../now/ops";
import { ApiError } from "../data/client";
import { parseBeadId } from "../now/capture";

function op(over: Partial<Op> = {}): Op {
  return {
    id: "op-1",
    verb: "dispatch",
    state: "queued",
    startedAt: "2026-08-18T12:00:00.000Z",
    finishedAt: null,
    output: null,
    error: null,
    ...over,
  };
}

/** A clock that only moves when the code under test sleeps. */
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

describe("isOp", () => {
  it("recognises an op and rejects other shapes", () => {
    expect(isOp(op())).toBe(true);
    expect(isOp({ ok: true })).toBe(false);
    expect(isOp(null)).toBe(false);
    expect(isOp("op-1")).toBe(false);
  });
});

describe("settleOp", () => {
  it("returns at once when the op is already settled", async () => {
    let calls = 0;
    const done = op({ state: "done" });
    const result = await settleOp(done, {
      fetchOp: async () => {
        calls += 1;
        return done;
      },
    });
    expect(result.state).toBe("done");
    expect(calls).toBe(0);
  });

  it("polls until the op finishes", async () => {
    const clock = fakeClock();
    const states: Op["state"][] = ["running", "running", "done"];
    let calls = 0;
    const result = await settleOp(op(), {
      fetchOp: async () => {
        const state = states[calls] ?? "done";
        calls += 1;
        return op({ state, output: "merged" });
      },
      intervalMs: 100,
      timeoutMs: 10_000,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(calls).toBe(3);
    expect(result.state).toBe("done");
    expect(isSettledOp(result)).toBe(true);
  });

  it("surfaces a failed op rather than retrying it forever", async () => {
    const clock = fakeClock();
    const result = await settleOp(op(), {
      fetchOp: async () => op({ state: "failed", error: "finish gate refused: branch moved" }),
      intervalMs: 100,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result.state).toBe("failed");
    expect(opFailureText(result)).toMatch(/branch moved/);
  });

  it("gives up at the deadline and reports the op as still running", async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await settleOp(op(), {
      fetchOp: async () => {
        calls += 1;
        return op({ state: "running" });
      },
      intervalMs: 1_000,
      timeoutMs: 5_000,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result.state).toBe("running");
    expect(calls).toBe(5);
  });

  it("survives a poll that throws", async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await settleOp(op(), {
      fetchOp: async () => {
        calls += 1;
        if (calls < 3) throw new Error("socket hiccup");
        return op({ state: "done" });
      },
      intervalMs: 100,
      timeoutMs: 10_000,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result.state).toBe("done");
  });
});

describe("opFailureText", () => {
  it("prefers the error, then the output, then says there was none", () => {
    expect(opFailureText(op({ state: "failed", error: "boom" }))).toBe("boom");
    expect(opFailureText(op({ state: "failed", output: "stderr tail" }))).toBe("stderr tail");
    expect(opFailureText(op({ state: "failed" }))).toBe("no output");
  });
});

describe("errorText", () => {
  it("turns a 404 into something that names the real cause", () => {
    expect(errorText(new ApiError(404, "not found"))).toMatch(/endpoint/);
    expect(errorText(new ApiError(403, "forbidden"))).toMatch(/boot key/);
    expect(errorText(new ApiError(500, "kaboom"))).toMatch(/500/);
    expect(errorText(new Error("offline"))).toBe("offline");
    expect(errorText("weird")).toBe("unknown error");
  });
});

describe("parseBeadId", () => {
  it("reads the id bd printed", () => {
    expect(parseBeadId("created xd-212")).toBe("xd-212");
    expect(parseBeadId("Created: HQ-9AB2\n")).toBe("hq-9ab2");
    expect(parseBeadId("ok\nxd-212 queued")).toBe("xd-212");
  });

  it("returns null rather than inventing one", () => {
    expect(parseBeadId("")).toBeNull();
    expect(parseBeadId(null)).toBeNull();
    expect(parseBeadId("nothing useful here")).toBeNull();
  });
});
