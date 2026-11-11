// The stale-boot-key recovery path (2026-08-26: "New terminal" failed with nothing on
// screen). Three properties, each of which was broken:
//   1. a healthy response resets the reload budget, so restarts spread over a tab's
//      life never add up to the fatal state,
//   2. postJson (the path now/http.ts delegates to) triggers the re-key reload on a
//      403 {reload:true} instead of only throwing,
//   3. exhausting the budget surfaces the fatal state through onFatal, which the
//      Shell's banner renders.
//
// The suite runs in the node environment (no DOM on purpose), so the browser globals
// client.ts touches (sessionStorage, window.location.reload) are stubbed by hand.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, bootKey, getFatal, noteHealthyResponse, onFatal, parseBootKey, postJson, reloadOnce, resetRekeyForTest } from "../data/client";

const RELOAD_KEY = "hq-console-reloads";

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

let storage: Storage;
let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  storage = fakeStorage();
  reload = vi.fn();
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("window", { location: { reload } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

describe("boot key re-key path", () => {
  it("a healthy response resets the reload budget", async () => {
    storage.setItem(RELOAD_KEY, "1");
    stubFetch(200, { ok: true });
    await postJson("/api/session/new", { kind: "interactive" });
    expect(storage.getItem(RELOAD_KEY)).toBeNull();
  });

  // Runs before the reload-triggering test: reloadOnce latches a module-level
  // "reloading" flag once it has fired, as a real page would be navigating away.
  it("an exhausted budget surfaces the fatal state through onFatal", () => {
    storage.setItem(RELOAD_KEY, "2");
    const seen: unknown[] = [];
    const off = onFatal((f) => seen.push(f));
    expect(reloadOnce()).toBe(false);
    off();
    expect(getFatal()).not.toBeNull();
    expect(seen.length).toBe(1);
    expect(reload).not.toHaveBeenCalled();
    // and the banner's reload button clears the budget so the next boot starts fresh
    noteHealthyResponse();
    expect(storage.getItem(RELOAD_KEY)).toBeNull();
  });

  it("postJson reloads on 403 {reload:true} rather than only throwing", async () => {
    stubFetch(403, { error: "stale page key", reload: true });
    await expect(postJson("/api/session/new", { kind: "interactive" })).rejects.toBeInstanceOf(ApiError);
    expect(reload).toHaveBeenCalled();
    expect(storage.getItem(RELOAD_KEY)).toBe("1");
  });
});

// hq-aukwy: re-key in place instead of reloading the page on every server restart.
describe("in-place re-key", () => {
  afterEach(() => resetRekeyForTest());

  it("parseBootKey reads the served meta tag and ignores the raw placeholder", () => {
    expect(parseBootKey('<meta name="console-boot-key" content="abc123" />')).toBe("abc123");
    expect(parseBootKey('<meta name="console-boot-key" content="__CONSOLE_BOOT_KEY__" />')).toBeNull();
    expect(parseBootKey("<html></html>")).toBeNull();
  });

  it("a stale key fetches the fresh index, retries once with the new key, and does not reload", async () => {
    const seen: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/") return new Response('<meta name="console-boot-key" content="fresh" />', { status: 200 });
        const key = (init?.headers as Record<string, string> | undefined)?.["X-Console-Key"];
        seen.push(key);
        if (key !== "fresh") return new Response(JSON.stringify({ error: "stale page key", reload: true }), { status: 403 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    await expect(postJson("/api/notes", { text: "x" })).resolves.toEqual({ ok: true });
    expect(seen).toEqual(["", "fresh"]);
    expect(reload).not.toHaveBeenCalled();
    expect(bootKey()).toBe("fresh");
  });
});
