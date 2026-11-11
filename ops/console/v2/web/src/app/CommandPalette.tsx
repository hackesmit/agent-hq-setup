// Cmd-K palette: it jumps to tabs, projects and sessions, and it runs the verbs.
//
// Every action row shows the command it is about to fire, because a keyboard surface
// that dispatches work without showing what it dispatched is one you stop trusting. The
// two verbs that merge or end work are listed and refused with the reason: they take two
// deliberate steps in a panel, and this is one. The rules live in paletteVerbs.ts.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ConsoleState } from "@shared/api";
import { navigate } from "./router";
import { projectPath, TAB_LABELS, TABS } from "./routes";
import { Chip, cx, inputClass, RigSigil } from "../ui/primitives";
import { api } from "../data/client";
import { useOpRunner } from "../now/ops";
import { termPath } from "../now/popout";
import { toastInfo } from "../now/toast";
import { filterVerbs, isAnswerQuery, modelLabel, nextModel, verbsFor, type Model, type PaletteVerb } from "./paletteVerbs";

export interface PaletteItem {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

export function paletteItems(state: ConsoleState | null): PaletteItem[] {
  const items: PaletteItem[] = TABS.map((tab, index) => ({
    id: `tab:${tab}`,
    label: TAB_LABELS[tab],
    hint: `tab, key ${index + 1}`,
    run: () => navigate(`/${tab}`),
  }));

  for (const project of state?.projects ?? []) {
    items.push({
      id: `project:${project.id}`,
      label: project.name,
      hint: `project, ${project.counts.open} open`,
      run: () => navigate(projectPath(project.id)),
    });
  }

  for (const session of state?.sessions ?? []) {
    items.push({
      id: `session:${session.id}`,
      label: session.id,
      hint: `session, ${session.rig ?? "no rig"} ${session.state}`,
      run: () => navigate("/now"),
    });
  }

  return items;
}

export function filterItems(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter(
    (item) => item.label.toLowerCase().includes(needle) || item.hint.toLowerCase().includes(needle),
  );
}

export function CommandPalette({
  open,
  state,
  onClose,
}: {
  open: boolean;
  state: ConsoleState | null;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [models, setModels] = useState<Record<string, Model>>({});
  const inputRef = useRef<HTMLInputElement | null>(null);
  const run = useOpRunner();

  // Jump items and verbs are one list, so the arrows and Enter behave identically for
  // both. With an empty box the jump list leads, as it always has; once something is
  // typed the verbs lead, because that is usually what the typing was for.
  const items = useMemo(() => {
    const jumps: PaletteVerb[] = filterItems(paletteItems(state), query).map((item) => ({
      id: item.id,
      kind: "jump" as const,
      label: item.label,
      hint: item.hint,
      cmd: null,
      run: item.run,
    }));
    const verbs = filterVerbs(
      verbsFor(
        state,
        query,
        {
          navigate,
          dispatch: (bead, model) => {
            void run(`dispatch ${bead.id}`, () => api.dispatch(bead.rig, bead.id, model));
            toastInfo(`dispatching ${bead.id} to ${bead.rig}`);
          },
          answer: (request, text) => {
            void run(`answer ${request.id}`, () => api.answer(request.id, text));
            toastInfo(`answered ${request.id}`);
          },
          openTerminal: (session) => navigate(termPath(session.id)),
          snooze: (request) => {
            void run(`snooze ${request.id}`, () => api.reqSnooze(request.id, "tomorrow"));
          },
        },
        models,
      ),
      query,
    );
    if (isAnswerQuery(query)) return verbs;
    return query.trim() ? [...verbs, ...jumps] : [...jumps, ...verbs];
  }, [state, query, models, run]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  if (!open) return null;

  function choose(index: number): void {
    const item = items[index];
    if (!item || item.kind === "refused" || !item.run) return;
    item.run();
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh]"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-xl overflow-hidden rounded-card border border-line bg-panel shadow-card"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-line p-2.5">
          <label className="sr-only" htmlFor="palette-input">
            Search tabs, projects and sessions, or type an answer after a greater-than sign
          </label>
          <input
            id="palette-input"
            ref={inputRef}
            className={inputClass}
            value={query}
            placeholder="Jump, dispatch, snooze, or type &gt; to answer"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setCursor((current) => (items.length === 0 ? 0 : (current + 1) % items.length));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setCursor((current) => (items.length === 0 ? 0 : (current - 1 + items.length) % items.length));
              } else if (event.key === "Tab" && items[cursor]?.kind === "dispatch") {
                // Tab re-targets the model on the highlighted dispatch row rather than
                // moving focus: the routing choice is part of the command being shown.
                event.preventDefault();
                const row = items[cursor];
                if (row.bead && row.model) {
                  const next = nextModel(row.model);
                  setModels((current) => ({ ...current, [row.bead!.id]: next }));
                }
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(cursor);
              }
            }}
          />
        </div>
        <ul className="hq-scroll m-0 max-h-[46vh] list-none overflow-y-auto p-1.5">
          {items.length === 0 ? (
            <li className="px-2.5 py-2 text-[13px] text-mute">Nothing matches.</li>
          ) : (
            items.map((item, index) => (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={item.kind === "refused"}
                  title={item.refused}
                  className={cx(
                    "flex w-full items-center justify-between gap-3 rounded-sub px-2.5 py-1.5 text-left text-[13px]",
                    item.kind === "refused" ? "cursor-not-allowed text-faint" : "text-ink",
                    index === cursor && item.kind !== "refused" ? "bg-panel2" : "hover:bg-panel2",
                  )}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => choose(index)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {item.kind === "refused" ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="shrink-0">
                        <rect x="4" y="11" width="16" height="9" rx="1.5" />
                        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                      </svg>
                    ) : null}
                    {item.bead ? <RigSigil id={item.bead.rig} size={12} /> : null}
                    <span className="truncate">{item.label}</span>
                    {item.model ? <Chip tone="accent">{modelLabel(item.model)}</Chip> : null}
                  </span>
                  <span className="shrink-0 text-[11px] text-mute">
                    {item.kind === "refused" ? item.hint : item.model && index === cursor ? `${item.hint}, Tab` : item.hint}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
        <p className="m-0 truncate border-t border-line bg-code px-3 py-2 font-mono text-[11px] text-mute" title={items[cursor]?.cmd ?? undefined}>
          {items[cursor]?.cmd ??
            (items[cursor]?.refused ? items[cursor]?.refused : "arrows to move, Enter to run, Escape to close")}
        </p>
      </div>
    </div>
  );
}
