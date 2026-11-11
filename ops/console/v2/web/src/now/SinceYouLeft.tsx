// The ribbon at the top of Now: what happened while you were gone, in one line of chips.
//
// It renders only when you were actually away and something actually happened, and it
// goes away when you press Mark seen. Nothing else moves the marker: not opening the
// tab, not a socket push. That rule is the whole feature, because a count you cannot
// trust is worse than no count.
import { useCallback, useEffect, useState } from "react";
import type { ConsoleState } from "@shared/api";
import { api } from "../data/client";
import { Button, Chip } from "../ui/primitives";
import { awayLabel, sinceLabel, summarize } from "./sinceYouLeft";
import { toastError } from "./toast";
import { TOUCH_SM } from "./ui";

/** The marker, fetched once and refreshed when it changes. */
export function useSeen(): { at: string | null; ready: boolean; mark: (at?: string) => void } {
  const [at, setAt] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .seen()
      .then((r) => live && setAt(r.at))
      .catch(() => {
        /* the link being down is already reported in the top strip */
      })
      .finally(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, []);
  const mark = useCallback((stamp?: string) => {
    const optimistic = stamp ?? new Date().toISOString();
    setAt(optimistic);
    api
      .markSeen(stamp)
      .then((r) => setAt(r.at))
      .catch(() => toastError("could not save the read marker"));
  }, []);
  return { at, ready, mark };
}

export function SinceYouLeft({
  state,
  now,
  since,
  onMarkSeen,
}: {
  state: ConsoleState | null;
  now: number;
  since: string | null;
  onMarkSeen: (at?: string) => void;
}) {
  const summary = summarize(state, since, now);
  if (!summary.show) return null;

  const c = summary.counts;
  const atLeast = summary.truncated ? "at least " : "";
  // The marker is set to the newest event actually on screen, not to "now": anything
  // that lands between this render and the click stays unread.
  const newest = state?.activity?.[0]?.ts;

  const chips: { key: string; label: string; tone: "mute" | "ok" | "bad" | "warn" | "accent" }[] = [];
  if (c.commits) chips.push({ key: "commits", label: `${atLeast}${c.commits} commit${c.commits === 1 ? "" : "s"}`, tone: "mute" });
  if (c.merges) chips.push({ key: "merges", label: `${c.merges} merge${c.merges === 1 ? "" : "s"}`, tone: "ok" });
  if (c.errors) chips.push({ key: "errors", label: `${c.errors} error${c.errors === 1 ? "" : "s"}`, tone: "bad" });
  if (c.asks) {
    chips.push({
      key: "asks",
      label: c.asksOpen ? `${c.asks} asked, ${c.asksOpen} still open` : `${c.asks} asked, all answered`,
      tone: c.asksOpen ? "warn" : "mute",
    });
  }
  if (c.dispatches) chips.push({ key: "dispatch", label: `${c.dispatches} dispatched`, tone: "mute" });
  if (c.finishes) chips.push({ key: "finishes", label: `${c.finishes} finished`, tone: "ok" });

  return (
    <div className="rounded-card border border-line border-l-2 border-l-accent bg-panel px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-mute">
          Away {awayLabel(summary.awayMs)}, since {sinceLabel(since)}
        </span>
        <span className="ml-auto">
          <Button size="sm" className={TOUCH_SM} onClick={() => onMarkSeen(newest)}>
            Mark seen
          </Button>
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <Chip key={chip.key} tone={chip.tone}>
            {chip.label}
          </Chip>
        ))}
      </div>
      {summary.truncated ? (
        <p className="m-0 mt-2 text-[11px] text-faint">
          the stream is capped, so these are floors rather than totals
        </p>
      ) : null}
    </div>
  );
}
