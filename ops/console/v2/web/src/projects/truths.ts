// Truths editor state. The console is the single writer of ops/projects/<id>/truths.json
// (design 4.2), so every edit here is optimistic against a revision: the client sends the
// rev it read, and a 409 means someone (a merge, a restored backup, another tab) moved
// the file underneath. On 409 we reload the server copy, keep the user's attempt aside,
// and let them reapply it deliberately. Never silently overwrite, never silently discard.

import type { TruthEntry, TruthKind, TruthsDoc } from "@shared/api";

export const TRUTH_KINDS: TruthKind[] = ["term", "truth", "assumption", "constraint"];

export const KIND_LABELS: Record<TruthKind, string> = {
  term: "Term",
  truth: "Truth",
  assumption: "Assumption",
  constraint: "Constraint",
};

export const CONFLICT_MESSAGE = "Changed elsewhere. Reload happened; reapply your edit.";

export interface TruthsState {
  project: string;
  /** Revision the current entries are based on; what a save sends. */
  rev: number;
  updatedAt: string | null;
  entries: TruthEntry[];
  /** The local edit the server rejected as stale, kept for a deliberate reapply. */
  pending: TruthEntry[] | null;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  error: string | null;
  loaded: boolean;
}

export const EMPTY_TRUTHS: TruthsState = {
  project: "",
  rev: 0,
  updatedAt: null,
  entries: [],
  pending: null,
  dirty: false,
  saving: false,
  conflict: false,
  error: null,
  loaded: false,
};

export type TruthsAction =
  | { t: "loaded"; doc: TruthsDoc }
  | { t: "add"; kind: TruthKind; text: string; source: string | null; at: string; id?: string }
  | { t: "edit"; id: string; text?: string; kind?: TruthKind; source?: string | null }
  | { t: "confirm"; id: string; confirmed?: boolean }
  | { t: "delete"; id: string }
  | { t: "saving" }
  | { t: "saved"; doc: TruthsDoc }
  | { t: "conflict"; doc: TruthsDoc }
  | { t: "reapply" }
  | { t: "discard" }
  | { t: "error"; message: string };

/** Stable, readable ids: kind initial plus the lowest free number in that kind. */
export function makeEntryId(kind: TruthKind, entries: readonly TruthEntry[]): string {
  const prefix = kind[0]!;
  const used = new Set(entries.map((entry) => entry.id));
  for (let n = 1; n <= used.size + 1; n += 1) {
    const candidate = `${prefix}${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${prefix}${used.size + 1}`;
}

function mutate(state: TruthsState, entries: TruthEntry[]): TruthsState {
  return { ...state, entries, dirty: true, error: null };
}

export function truthsReducer(state: TruthsState, action: TruthsAction): TruthsState {
  switch (action.t) {
    case "loaded":
      return {
        ...state,
        project: action.doc.project,
        rev: action.doc.rev,
        updatedAt: action.doc.updatedAt,
        entries: action.doc.entries,
        pending: null,
        dirty: false,
        saving: false,
        conflict: false,
        error: null,
        loaded: true,
      };

    case "add": {
      const text = action.text.trim();
      if (!text) return { ...state, error: "A truth needs text." };
      const entry: TruthEntry = {
        id: action.id ?? makeEntryId(action.kind, state.entries),
        kind: action.kind,
        text,
        // Only an assumption starts unconfirmed; the other kinds are statements of fact
        // the operator is making right now.
        confirmed: action.kind !== "assumption",
        added: action.at,
        source: action.source && action.source.trim() ? action.source.trim() : null,
      };
      return mutate(state, [...state.entries, entry]);
    }

    case "edit": {
      if (action.text !== undefined && !action.text.trim()) {
        return { ...state, error: "A truth needs text." };
      }
      return mutate(
        state,
        state.entries.map((entry) =>
          entry.id === action.id
            ? {
                ...entry,
                text: action.text === undefined ? entry.text : action.text.trim(),
                kind: action.kind ?? entry.kind,
                source: action.source === undefined ? entry.source : action.source,
              }
            : entry,
        ),
      );
    }

    case "confirm":
      return mutate(
        state,
        state.entries.map((entry) =>
          entry.id === action.id ? { ...entry, confirmed: action.confirmed ?? true } : entry,
        ),
      );

    case "delete":
      return mutate(
        state,
        state.entries.filter((entry) => entry.id !== action.id),
      );

    case "saving":
      return { ...state, saving: true, error: null };

    case "saved":
      return {
        ...state,
        rev: action.doc.rev,
        updatedAt: action.doc.updatedAt,
        entries: action.doc.entries,
        pending: null,
        dirty: false,
        saving: false,
        conflict: false,
        error: null,
        loaded: true,
      };

    case "conflict":
      return {
        ...state,
        rev: action.doc.rev,
        updatedAt: action.doc.updatedAt,
        // Server wins on screen; the local attempt is parked, not applied and not lost.
        entries: action.doc.entries,
        pending: state.entries,
        dirty: false,
        saving: false,
        conflict: true,
        error: CONFLICT_MESSAGE,
        loaded: true,
      };

    case "reapply":
      if (!state.pending) return state;
      return { ...state, entries: state.pending, pending: null, dirty: true, conflict: false, error: null };

    case "discard":
      return { ...state, pending: null, conflict: false, error: null };

    case "error":
      return { ...state, saving: false, error: action.message };

    default:
      return state;
  }
}

/** Body for POST /api/projects/:id/truths. */
export function savePayload(state: TruthsState): { rev: number; entries: TruthEntry[] } {
  return { rev: state.rev, entries: state.entries };
}

export function groupByKind(entries: readonly TruthEntry[]): { kind: TruthKind; entries: TruthEntry[] }[] {
  return TRUTH_KINDS.map((kind) => ({
    kind,
    entries: entries.filter((entry) => entry.kind === kind),
  })).filter((group) => group.entries.length > 0);
}

/** Unconfirmed assumptions become decide cards in Now; the card here mirrors that. */
export function unconfirmed(entries: readonly TruthEntry[]): TruthEntry[] {
  return entries.filter((entry) => entry.kind === "assumption" && !entry.confirmed);
}

/**
 * The vault mirror as the server renders it (plain markdown, no HTML). Shown as a preview
 * so the operator can see what Obsidian will get before saving.
 */
export function truthsMarkdown(project: string, entries: readonly TruthEntry[]): string {
  const lines = [`# Truths: ${project}`, "", "Read-only mirror. Edit in the console.", ""];
  for (const group of groupByKind(entries)) {
    lines.push(`## ${KIND_LABELS[group.kind]}`, "");
    for (const entry of group.entries) {
      const marks: string[] = [];
      if (!entry.confirmed) marks.push("unconfirmed");
      if (entry.source) marks.push(`source: ${entry.source}`);
      lines.push(`- ${entry.text}${marks.length > 0 ? ` (${marks.join("; ")})` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
