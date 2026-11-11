// Code-split chunks across a deploy (hq-aukwy).
//
// Vite names every chunk by content hash, and a deploy swaps releases/current, so a page
// built from the previous release asks for chunk files the server no longer has. The
// dynamic import rejects, React.lazy has no error boundary above it, and the whole tree
// unmounts: a blank page that never comes back (reproduced 2026-11-05: open a page,
// restart the server on a new release, open the Terminals tab, body text length 0).
//
// The page needs the new release's code anyway, so a failed chunk load reloads the page
// once, but only after the server answers again: the chunk usually fails BECAUSE the
// server is mid-restart, and a reload in that half second lands on the browser's own
// "site can't be reached" page, which never comes back by itself (seen in the same
// repro). A guard stops a loop: if a reload for a missing chunk already happened in the
// last RELOAD_GUARD_MS, the error is rethrown instead of reloading again (a broken build,
// not a deploy).

export const CHUNK_RELOAD_KEY = "hq-console-chunk-reload";
export const RELOAD_GUARD_MS = 30_000;

/** Reload the page for a missing chunk unless one already did so recently. */
export function reloadForChunk(now: number = Date.now()): boolean {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) || "0");
  } catch {
    last = 0;
  }
  if (Number.isFinite(last) && now - last < RELOAD_GUARD_MS) return false;
  try {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(now));
  } catch {
    // no storage: still reload once; the next boot has no memory of it either way
  }
  window.location.reload();
  return true;
}

export const SERVER_POLL_MS = 500;
/** Give up waiting after this and reload anyway; the page is broken without the chunk. */
export const SERVER_WAIT_MAX_MS = 120_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolve once the console answers a plain GET of its index (or the wait runs out). */
export async function waitForServer(): Promise<void> {
  const until = Date.now() + SERVER_WAIT_MAX_MS;
  while (Date.now() < until) {
    try {
      const res = await fetch("/", { method: "GET", cache: "no-store", credentials: "same-origin" });
      if (res.ok) return;
    } catch {
      // still restarting
    }
    await sleep(SERVER_POLL_MS);
  }
}

/** True when a chunk reload is allowed now (outside the loop guard). */
function reloadAllowed(now: number): boolean {
  try {
    const last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) || "0");
    return !(Number.isFinite(last) && now - last < RELOAD_GUARD_MS);
  } catch {
    return true;
  }
}

/**
 * Wrap a dynamic import for React.lazy. On failure it waits for the server, reloads the
 * page and returns a promise that never settles, so Suspense keeps showing its fallback
 * meanwhile; when the loop guard refuses, the original error propagates.
 */
export function importOrReload<T>(load: () => Promise<T>): () => Promise<T> {
  return () =>
    load().catch(async (err: unknown) => {
      if (!reloadAllowed(Date.now())) throw err;
      await waitForServer();
      if (reloadForChunk()) return new Promise<T>(() => {});
      throw err;
    });
}
