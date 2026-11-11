import { describe, expect, it } from "vitest";
import {
  CAPRI_ECHO_MS, CAPRI_LISTEN_MS, CAPRI_SPEAK_MS, CAPRI_THINK_MIN_MS, CAPRI_THINK_MS,
  capriLift, capriLine, createCapri, createCapriMood, type CapriTimers,
} from "./capri";

function rig() {
  let clock = 0;
  let pending: { fn: () => void; ms: number } | null = null;
  const timers: CapriTimers = {
    set: (fn, ms) => (pending = { fn, ms }),
    clear: () => (pending = null),
  };
  const noTimers: CapriTimers = { set: () => null, clear: () => {} };
  const capri = createCapri(noTimers);
  const mood = createCapriMood(capri, timers, () => clock);
  return {
    capri, mood,
    advance: (ms: number) => (clock += ms),
    fire: () => { const p = pending; pending = null; p?.fn(); },
    pending: () => pending,
  };
}

describe("capri mood", () => {
  it("starts idle with no timer", () => {
    const r = rig();
    expect(r.mood.mood()).toBe("idle");
    expect(r.pending()).toBeNull();
  });

  it("a wake means listening even on a page with no input", () => {
    const r = rig();
    expect(r.capri.receive("wake")).toBe(false);
    expect(r.mood.mood()).toBe("listening");
    expect(r.pending()?.ms).toBe(CAPRI_LISTEN_MS);
  });

  it("listening times out to idle", () => {
    const r = rig();
    r.capri.receive("wake");
    r.fire();
    expect(r.mood.mood()).toBe("idle");
    expect(r.pending()).toBeNull();
  });

  it("done after a wake means thinking, capped", () => {
    const r = rig();
    r.capri.receive("wake");
    r.capri.receive("done");
    expect(r.mood.mood()).toBe("thinking");
    expect(r.pending()?.ms).toBe(CAPRI_THINK_MS);
    r.fire();
    expect(r.mood.mood()).toBe("idle");
  });

  it("done with no wake does nothing", () => {
    const r = rig();
    r.capri.receive("done");
    expect(r.mood.mood()).toBe("idle");
  });

  it("an orchestrator line after thinking means speaking for 4 s", () => {
    const r = rig();
    r.capri.receive("wake");
    r.capri.receive("done");
    r.advance(CAPRI_THINK_MIN_MS);
    r.mood.heard("Two merges done.\r\n");
    expect(r.mood.mood()).toBe("speaking");
    expect(r.pending()?.ms).toBe(CAPRI_SPEAK_MS);
    r.fire();
    expect(r.mood.mood()).toBe("idle");
  });

  it("the submit echo right after done is not an answer", () => {
    const r = rig();
    r.capri.receive("wake");
    r.capri.receive("done");
    r.advance(CAPRI_THINK_MIN_MS - 1);
    r.mood.heard("\r\n");
    expect(r.mood.mood()).toBe("thinking");
  });

  it("output while listening is the dictation pasting, not speech", () => {
    const r = rig();
    r.capri.receive("wake");
    r.mood.heard("hello\r\n");
    expect(r.mood.mood()).toBe("listening");
  });

  it("a line out of the blue speaks, more lines keep it speaking", () => {
    const r = rig();
    r.mood.heard("one\n");
    expect(r.mood.mood()).toBe("speaking");
    r.advance(3000);
    r.mood.heard("two\n");
    expect(r.pending()?.ms).toBe(CAPRI_SPEAK_MS);
  });

  it("output with no new line, or right after a keystroke, is echo", () => {
    const r = rig();
    r.mood.heard("spinner frame");
    expect(r.mood.mood()).toBe("idle");
    r.mood.typed();
    r.advance(CAPRI_ECHO_MS - 1);
    r.mood.heard("\r\n");
    expect(r.mood.mood()).toBe("idle");
    r.advance(1);
    r.mood.heard("\r\n");
    expect(r.mood.mood()).toBe("speaking");
  });

  it("notifies only on a change", () => {
    const r = rig();
    let n = 0;
    r.mood.subscribe(() => n++);
    r.mood.heard("a\n");
    r.mood.heard("b\n");
    expect(n).toBe(1);
  });
});

describe("capri focus", () => {
  it("focuses the latest input, false with none", () => {
    const c = createCapri({ set: () => null, clear: () => {} });
    expect(c.focus()).toBe(false);
    let hit = 0;
    c.register(() => hit++);
    expect(c.focus()).toBe(true);
    expect(hit).toBe(1);
    expect(c.listening()).toBe(false);
  });
});

describe("capri lines", () => {
  it("one short line per state", () => {
    expect(capriLine("idle", 0)).toBe("Capri. Standing by.");
    expect(capriLine("listening", 3)).toBe("Listening.");
    expect(capriLine("thinking", 0)).toBe("Routing it.");
  });
  it("speaking says what waits on the owner", () => {
    expect(capriLine("speaking", 0)).toBe("Orchestrator answered. Nothing needs you.");
    expect(capriLine("speaking", 1)).toBe("One question waiting. It is yours.");
    expect(capriLine("speaking", 3)).toBe("3 questions waiting. They are yours.");
  });
});

describe("capri lift", () => {
  const corner = { left: 900, top: 620, right: 1000, bottom: 700 };
  it("no lift when the input is far away", () => {
    expect(capriLift(corner, { left: 0, top: 650, right: 400, bottom: 690 })).toBe(0);
    expect(capriLift(corner, { left: 900, top: 100, right: 1000, bottom: 140 })).toBe(0);
  });
  it("lifts above an input under the corner", () => {
    expect(capriLift(corner, { left: 500, top: 660, right: 980, bottom: 690 })).toBe(700 - 660 + 12);
  });
  it("lifts above an input just below it", () => {
    expect(capriLift(corner, { left: 950, top: 705, right: 990, bottom: 720 })).toBe(7);
  });
});
