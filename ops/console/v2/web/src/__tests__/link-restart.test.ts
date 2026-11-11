// hq-aukwy: the console "kept going offline" because every merge to hq main restarts
// the server (52 restarts in 48 h), and each restart made every open page do a FULL
// reload (stale boot key -> 403 {reload:true} -> window.location.reload), with the
// transport errors painted in the red error bar meanwhile. These tests drive the real
// ConsoleLink through a server restart with fake timers, a fake socket and a fake
// server, and pin the new behavior:
//   - the page re-keys in place: no reload, the next request carries the new key,
//   - the link is live again within 5 s of the drop,
//   - the red error bar stays empty through it,
//   - a socket that is open on paper but silent is dropped and reopened,
//   - a wake (tab visible again) retries a link in backoff at once,
//   - a new release on the server sets updateReady instead of reloading.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = ((ev?: unknown) => void) | null;

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  onopen: Handler = null;
  onclose: Handler = null;
  onerror: Handler = null;
  onmessage: Handler = null;
  sent: string[] = [];
  closed = false;
  constructor(public url: string, public protocols: string[]) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  // test side
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

/** A fake console server: a boot key, an up/down switch and a release name. */
const server = { up: true, key: "key-1", release: "rel-a", tokenCalls: [] as string[], indexFetches: 0 };

function state(release: string) {
  return { generatedAt: new Date().toISOString(), version: { release, protocol: 1 }, sessions: [], alerts: [] };
}

function html(key: string) {
  return `<!doctype html><html><head><meta name="console-boot-key" content="${key}" /></head><body></body></html>`;
}

const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (!server.up) throw new TypeError("Failed to fetch");
  if (method === "GET" && url === "/") {
    server.indexFetches += 1;
    return new Response(html(server.key), { status: 200 });
  }
  if (method === "GET" && url === "/api/state") return new Response(JSON.stringify(state(server.release)), { status: 200 });
  if (method === "POST" && url === "/api/ws-token") {
    const key = (init?.headers as Record<string, string>)["X-Console-Key"];
    server.tokenCalls.push(key);
    if (key !== server.key) return new Response(JSON.stringify({ error: "stale page key", reload: true }), { status: 403 });
    return new Response(JSON.stringify({ token: "tok", expiresInS: 30 }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
});

const reload = vi.fn();
const docListeners = new Map<string, () => void>();
const doc = {
  visibilityState: "visible" as "visible" | "hidden",
  querySelector: (sel: string) => (sel.includes("console-boot-key") ? { getAttribute: () => "key-1" } : null),
  addEventListener: (t: string, fn: () => void) => docListeners.set(t, fn),
  removeEventListener: (t: string) => docListeners.delete(t),
};

function storage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let link: any;
let unsubscribe: () => void;

async function flush(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}

/** Open the link against a healthy server and complete the first hello. */
async function boot() {
  const mod = await import("../data/ws");
  link = mod.consoleLink;
  unsubscribe = link.subscribe(() => {});
  await flush(10);
  const sock = FakeSocket.all.at(-1)!;
  sock.open();
  sock.push({ t: "hello", release: server.release, protocol: 1, owner: "o", state: state(server.release) });
  expect(link.getSnapshot().status).toBe("live");
  return sock;
}

/** Restart the fake server: down for downMs, back with a NEW boot key. */
async function restart(sock: FakeSocket, downMs: number, release = server.release) {
  server.up = false;
  sock.drop();
  await flush(downMs);
  server.key = `key-${Number(server.key.split("-")[1]) + 1}`;
  server.release = release;
  server.up = true;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  FakeSocket.all = [];
  Object.assign(server, { up: true, key: "key-1", release: "rel-a", tokenCalls: [], indexFetches: 0 });
  reload.mockReset();
  docListeners.clear();
  doc.visibilityState = "visible";
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", fetchImpl);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", {
    location: { reload, href: "https://hqbox.test:8790/now", protocol: "https:", host: "hqbox.test:8790" },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal("sessionStorage", storage());
});

afterEach(() => {
  unsubscribe?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a server restart (one merge to hq main)", () => {
  it("re-keys in place and is live again within 5 s, with no reload and no red bar", async () => {
    const sock = await boot();
    const errors: (string | null)[] = [];
    const off = link.subscribe(() => errors.push(link.getSnapshot().error));

    // production measured the gap at about 0.5 s (journal, 2026-11-05)
    await restart(sock, 500);
    const backAt = Date.now();
    let live = false;
    for (let t = 0; t < 5000 && !live; t += 100) {
      await flush(100);
      const s = FakeSocket.all.at(-1)!;
      if (s !== sock && s.readyState === 0) s.open();
      live = link.getSnapshot().status === "live";
    }
    expect(live).toBe(true);
    expect(Date.now() - backAt).toBeLessThan(5000);
    expect(reload).not.toHaveBeenCalled();
    expect(server.indexFetches).toBe(1);
    // the stale key was refused once, then the retry carried the new one
    expect(server.tokenCalls.slice(-2)).toEqual(["key-1", "key-2"]);
    expect(errors.filter(Boolean)).toEqual([]);
    off();
  });

  it("falls back to a reload only when the re-key cannot find a key", async () => {
    const sock = await boot();
    await restart(sock, 500);
    // the index comes back without a usable key (say, a dev build)
    fetchImpl.mockImplementationOnce(async () => new Response(JSON.stringify({ error: "stale page key", reload: true }), { status: 403 }));
    fetchImpl.mockImplementationOnce(async () => new Response("<html></html>", { status: 200 }));
    await flush(4000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a new release sets updateReady and does not reload", async () => {
    const sock = await boot();
    expect(link.getSnapshot().updateReady).toBe(false);
    await restart(sock, 500, "rel-b");
    await flush(1500);
    const s = FakeSocket.all.at(-1)!;
    s.open();
    s.push({ t: "hello", release: "rel-b", protocol: 1, owner: "o", state: state("rel-b") });
    expect(link.getSnapshot().updateReady).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("a socket that is open on paper but dead", () => {
  it("is dropped after 25 s of silence on a visible page and a new one is opened", async () => {
    const sock = await boot();
    const before = FakeSocket.all.length;
    await flush(26_000);
    expect(sock.closed).toBe(true);
    expect(FakeSocket.all.length).toBeGreaterThan(before);
  });

  it("is not dropped while the tab is hidden (throttled timers prove nothing)", async () => {
    const sock = await boot();
    doc.visibilityState = "hidden";
    await flush(60_000);
    expect(sock.closed).toBe(false);
  });

  it("must answer a wake probe within 3 s when the tab becomes visible", async () => {
    const sock = await boot();
    doc.visibilityState = "hidden";
    await flush(5_000);
    doc.visibilityState = "visible";
    docListeners.get("visibilitychange")!();
    expect(sock.sent.some((m) => JSON.parse(m).t === "ping")).toBe(true);
    await flush(3_500);
    expect(sock.closed).toBe(true);
  });

  it("survives a wake probe that is answered", async () => {
    const sock = await boot();
    docListeners.get("visibilitychange")!();
    await flush(500);
    sock.push({ t: "pong", ts: Date.now() });
    await flush(3_500);
    expect(sock.closed).toBe(false);
  });
});

describe("a wake while the link is in backoff", () => {
  it("retries now instead of at the scheduled time", async () => {
    const sock = await boot();
    server.up = false;
    sock.drop();
    // fail a few times so the next retry is the full 4 s away
    await flush(3_600);
    server.up = true;
    const calls = server.tokenCalls.length;
    docListeners.get("visibilitychange")!();
    await flush(50);
    expect(server.tokenCalls.length).toBeGreaterThan(calls);
  });
});
