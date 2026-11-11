import { describe, expect, it, vi } from "vitest";
import { CAPRI_LISTEN_MS, CAPRI_TYPING_MS, createCapri, type CapriTimers } from "./capri";

function fakeTimers() {
  let pending: { fn: () => void; ms: number } | null = null;
  const timers: CapriTimers = {
    set: (fn, ms) => (pending = { fn, ms }),
    clear: () => (pending = null),
  };
  return { timers, fire: () => pending?.fn(), pending: () => pending };
}

describe("capri", () => {
  it("a wake focuses the orchestrator input and shows listening", () => {
    const t = fakeTimers();
    const c = createCapri(t.timers);
    const focus = vi.fn();
    c.register(focus);
    expect(c.receive("wake")).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(c.listening()).toBe(true);
    expect(t.pending()?.ms).toBe(CAPRI_LISTEN_MS);
  });

  it("a hidden page does not focus and reports no target", () => {
    const c = createCapri(fakeTimers().timers, { visible: () => false, now: () => 0 });
    const focus = vi.fn();
    c.register(focus);
    expect(c.receive("wake")).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(c.listening()).toBe(false);
  });

  it("a keystroke on the page in the last 3 s blocks the focus, an older one does not", () => {
    let now = 10_000;
    const c = createCapri(fakeTimers().timers, { visible: () => true, now: () => now });
    const focus = vi.fn();
    c.register(focus);
    c.typed();
    now += CAPRI_TYPING_MS - 1;
    expect(c.receive("wake")).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    now += 2;
    expect(c.receive("wake")).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("done clears listening", () => {
    const c = createCapri(fakeTimers().timers);
    c.register(() => {});
    c.receive("wake");
    expect(c.receive("done")).toBe(true);
    expect(c.listening()).toBe(false);
  });

  it("listening clears itself after 30 s with no done", () => {
    const t = fakeTimers();
    const c = createCapri(t.timers);
    c.register(() => {});
    c.receive("wake");
    t.fire();
    expect(c.listening()).toBe(false);
  });

  it("a page with no orchestrator input ignores the event", () => {
    const c = createCapri(fakeTimers().timers);
    const changed = vi.fn();
    c.subscribe(changed);
    expect(c.receive("wake")).toBe(false);
    expect(c.listening()).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });

  it("an unknown event does nothing", () => {
    const c = createCapri(fakeTimers().timers);
    const focus = vi.fn();
    c.register(focus);
    expect(c.receive("submit")).toBe(false);
    expect(c.receive({ event: "wake" })).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it("the latest input wins, and unmounting the last one stops listening", () => {
    const c = createCapri(fakeTimers().timers);
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = c.register(first);
    const offSecond = c.register(second);
    c.receive("wake");
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    offSecond();
    expect(c.listening()).toBe(true);
    c.receive("wake");
    expect(first).toHaveBeenCalledTimes(1);
    offFirst();
    expect(c.listening()).toBe(false);
  });
});
