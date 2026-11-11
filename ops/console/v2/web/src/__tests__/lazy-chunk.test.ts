// hq-aukwy: a chunk from the previous release 404s after a deploy; without recovery the
// lazy tab rejects and the whole page goes blank. It must reload once, never loop.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHUNK_RELOAD_KEY, importOrReload, RELOAD_GUARD_MS, reloadForChunk, SERVER_POLL_MS } from "../app/lazyChunk";

let store: Map<string, string>;
const reload = vi.fn();

beforeEach(() => {
  store = new Map();
  reload.mockReset();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  vi.stubGlobal("window", { location: { reload } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("lazy chunk recovery", () => {
  it("reloads once on a failed chunk and keeps Suspense waiting", async () => {
    const load = importOrReload(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module")));
    let settled = false;
    void load().then(() => (settled = true), () => (settled = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
  });

  it("rethrows instead of looping when it already reloaded within the guard", async () => {
    store.set(CHUNK_RELOAD_KEY, String(Date.now() - 1000));
    const load = importOrReload(() => Promise.reject(new Error("broken build")));
    await expect(load()).rejects.toThrow("broken build");
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads again once the guard window has passed", () => {
    const now = 10_000_000;
    store.set(CHUNK_RELOAD_KEY, String(now - RELOAD_GUARD_MS - 1));
    expect(reloadForChunk(now)).toBe(true);
    expect(store.get(CHUNK_RELOAD_KEY)).toBe(String(now));
  });

  it("waits for the server to answer before reloading (a reload mid-restart lands on the browser error page)", async () => {
    vi.useFakeTimers();
    let up = false;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (!up) throw new TypeError("Failed to fetch");
      return new Response("ok", { status: 200 });
    }));
    const load = importOrReload(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module")));
    void load();
    await vi.advanceTimersByTimeAsync(SERVER_POLL_MS * 4);
    expect(reload).not.toHaveBeenCalled();
    up = true;
    await vi.advanceTimersByTimeAsync(SERVER_POLL_MS * 2);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("passes a good chunk straight through", async () => {
    const load = importOrReload(() => Promise.resolve({ default: 1 }));
    await expect(load()).resolves.toEqual({ default: 1 });
    expect(reload).not.toHaveBeenCalled();
  });
});
