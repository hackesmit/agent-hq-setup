// Which terminals are open, remembered across navigation and reload.
//
// The panes used to be component state on the Now tab, so leaving the tab
// unmounted it and the terminal was simply gone when you came back. That reads as
// the terminal having died, which is worse than it sounds: the session is still
// running on the box, so the interface was telling you something untrue about the
// state of your work. The sticky notes persist and the contrast made it obvious.
//
// Stored in localStorage rather than on the server, deliberately. Which panes are
// open is a property of THIS screen: the desktop showing four terminals and the
// phone showing one is correct, and syncing them would make each device fight the
// other. The sessions themselves are server state and always were.

const KEY = "hq.console.open-panes";

/** Read the remembered panes. Anything unparseable is no panes, never a crash. */
export function readOpenPanes(raw?: string | null): string[] {
  let text = raw;
  if (text === undefined) {
    if (typeof window === "undefined") return [];
    try {
      text = window.localStorage.getItem(KEY);
    } catch {
      return []; // private mode, or storage blocked
    }
  }
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    // Session ids only, deduplicated, bounded. A stored list is whatever was last
    // written there, including by an older version of this app or by hand.
    const out: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "string" || !entry || entry.length > 64) continue;
      if (!out.includes(entry)) out.push(entry);
      if (out.length >= 8) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function saveOpenPanes(ids: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(ids.slice(0, 8)));
  } catch {
    // Storage being unavailable costs the memory of which panes were open, which
    // is a smaller loss than failing the interaction that opened one.
  }
}

/**
 * Restore only panes whose session is still live.
 *
 * A remembered id whose session has finished must NOT be reopened: attaching to
 * it would fail, and a pane that cannot attach is more confusing than an absent
 * one. The live list is the authority; the memory is only a preference.
 */
export function restorable(remembered: string[], liveIds: readonly string[]): string[] {
  return remembered.filter((id) => liveIds.includes(id));
}
