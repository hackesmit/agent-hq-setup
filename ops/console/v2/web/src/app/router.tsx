// History API navigation: no router library, one external store over popstate.

import { useCallback, useSyncExternalStore } from "react";
import { HOME, parseRoute, type Route } from "./routes";

const NAV_EVENT = "hq:navigate";

const listeners = new Set<() => void>();

let current = "/";
let snapshot: Route = HOME;

function readLocation(): string {
  if (typeof window === "undefined") return "/";
  return window.location.pathname + window.location.search;
}

function refresh(): void {
  const next = readLocation();
  if (next === current) return;
  current = next;
  snapshot = parseRoute(next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") {
    current = readLocation();
    snapshot = parseRoute(current);
    window.addEventListener("popstate", refresh);
    window.addEventListener(NAV_EVENT, refresh);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("popstate", refresh);
      window.removeEventListener(NAV_EVENT, refresh);
    }
  };
}

function getSnapshot(): Route {
  if (typeof window !== "undefined" && readLocation() !== current) {
    current = readLocation();
    snapshot = parseRoute(current);
  }
  return snapshot;
}

export function navigate(path: string, options?: { replace?: boolean }): void {
  if (typeof window === "undefined") return;
  if (path === readLocation()) return;
  if (options?.replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(NAV_EVENT));
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getSnapshot, () => HOME);
}

/** Link handler that keeps middle-click and modified clicks native. */
export function useNavigate(): (path: string) => void {
  return useCallback((path: string) => navigate(path), []);
}
