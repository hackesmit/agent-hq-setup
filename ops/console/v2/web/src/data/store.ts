// React bindings over the console link. useSyncExternalStore keeps the tree consistent
// with the socket without a provider or a query cache: the link owns one snapshot object
// and replaces it wholesale, so identity comparison is enough.

import { useCallback, useSyncExternalStore } from "react";
import type { ConsoleState } from "@shared/api";
import { consoleLink, type ConsoleSnapshot } from "./ws";

const SERVER_SNAPSHOT: ConsoleSnapshot = {
  state: null,
  status: "offline",
  source: "none",
  error: null,
  lastUpdateMs: null,
  ops: [],
  updateReady: false,
};

export function useConsole(): ConsoleSnapshot {
  return useSyncExternalStore(
    consoleLink.subscribe,
    consoleLink.getSnapshot,
    () => SERVER_SNAPSHOT,
  );
}

/** Select a slice of ConsoleState; re-renders whenever the snapshot changes. */
export function useConsoleSlice<T>(select: (state: ConsoleState | null) => T): T {
  const snapshot = useConsole();
  return select(snapshot.state);
}

/** Run a POST action, then ask for fresh state so the UI does not wait for the push. */
export function useAction(): (run: () => Promise<unknown>) => Promise<void> {
  return useCallback(async (run: () => Promise<unknown>) => {
    try {
      await run();
    } finally {
      consoleLink.refresh();
    }
  }, []);
}
