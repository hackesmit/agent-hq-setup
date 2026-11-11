// Workspaces: the Now tab seen through one client at a time (the owner, 2026-10-12).
//
// A working day usually belongs to one client. The Now tab mixes every project, which
// is right for "what is going on" and wrong for "I am doing acme today". Picking a
// workspace filters the tab's cards to that client's rigs and tints the page with its
// hue. Only the Now tab reads this. Board, Projects, Stack, Machines and Money are not
// scoped.
//
// The list is the owner's, in his order, and it is fixed: these are the lives he switches
// between, not whatever the registry happens to hold. A rig lands in a workspace by the
// first word of its id or by its registry client, so a new acme rig or a worktree
// joins acme with no edit here. Everything else is Personal.

import type { ActivityEvent, ProjectSummary, ReadyBead, Request, Session } from "@shared/api";

export interface Workspace {
  /** Stable key, stored per device. */
  id: string;
  label: string;
  /** Every rig id seen on this box that belongs here. */
  rigs: string[];
  /** 1-based index into the sigil ramp (tokens.css --sigil-N). */
  hue: number;
}

/** The unscoped view. An empty id so a missing or stale stored value means everything. */
export const EVERYTHING = "";

const KEY = "hq.console.now-workspace";

interface Def {
  id: string;
  label: string;
  hue: number;
  /** First words of a rig id ("acme-dashboard" starts with "acme"). */
  heads: string[];
  /** Registry client names, lower case. */
  clients: string[];
}

const PERSONAL = "personal";

const DEFS: Def[] = [
  { id: "agencyco", label: "agencyco", hue: 9, heads: ["agencyco"], clients: ["agencyco"] },
  { id: "orbit-acme", label: "Orbit Acme", hue: 7, heads: ["acme"], clients: ["Orbit Acme", "acme"] },
  { id: "lodgeco", label: "Lodgeco", hue: 3, heads: ["lodgeco", "lodgeco"], clients: ["lodgeco", "lodgeco", "Lodgeco"] },
  { id: "nonprofit-a", label: "Nonprofit A", hue: 5, heads: ["nonprofit"], clients: ["Nonprofit A"] },
  { id: "studioco", label: "studioco", hue: 6, heads: ["studioco"], clients: ["studioco", "studioco digital"] },
  { id: PERSONAL, label: "Personal", hue: 1, heads: [], clients: [] },
];

function head(rig: string): string {
  return rig.toLowerCase().split("-")[0] ?? "";
}

/** Which workspace a rig belongs to. Never null: what matches nothing is Personal. */
export function workspaceOf(rig: string, client?: string | null): string {
  const first = head(rig);
  const who = (client ?? "").trim().toLowerCase();
  for (const def of DEFS) {
    if (def.heads.includes(first) || (who && def.clients.includes(who))) return def.id;
  }
  return PERSONAL;
}

/**
 * The six workspaces, always all of them and always in this order, each with the rigs
 * this box currently knows for it. `extraRigs` are ids the registry does not list (a
 * worktree, a bunker, a rig that lives on another machine).
 */
export function buildWorkspaces(
  projects: readonly ProjectSummary[],
  extraRigs: readonly (string | null | undefined)[] = [],
): Workspace[] {
  const out: Workspace[] = DEFS.map((def) => ({ id: def.id, label: def.label, rigs: [], hue: def.hue }));
  const place = (rig: string, client?: string | null): void => {
    const home = out.find((workspace) => workspace.id === workspaceOf(rig, client));
    if (home && !home.rigs.includes(rig)) home.rigs.push(rig);
  };
  const known = new Set<string>();
  for (const project of projects) {
    if (!project.id) continue;
    known.add(project.id);
    place(project.id, project.client);
  }
  const extras = [...new Set(extraRigs.filter((rig): rig is string => Boolean(rig)))].sort((a, b) => a.localeCompare(b));
  for (const rig of extras) if (!known.has(rig)) place(rig);
  return out;
}

export function findWorkspace(workspaces: readonly Workspace[], id: string | null | undefined): Workspace | null {
  if (!id) return null;
  return workspaces.find((workspace) => workspace.id === id) ?? null;
}

export function rigIn(workspace: Workspace | null, rig: string | null | undefined): boolean {
  if (!workspace) return true;
  return Boolean(rig) && workspace.rigs.includes(rig as string);
}

export interface Scoped {
  sessions: Session[];
  requests: Request[];
  ready: ReadyBead[];
  activity: ActivityEvent[];
}

/** The four rig-keyed slices, narrowed to one workspace. Null returns them untouched. */
export function scopeTo(workspace: Workspace | null, all: Scoped): Scoped {
  if (!workspace) return all;
  const rigOfSession = new Map(all.sessions.map((session) => [session.id, session.rig]));
  return {
    sessions: all.sessions.filter((session) => rigIn(workspace, session.rig)),
    // A request with no rig of its own belongs to the session that asked it.
    requests: all.requests.filter((request) =>
      rigIn(workspace, request.rig ?? (request.session ? rigOfSession.get(request.session) : null)),
    ),
    ready: all.ready.filter((bead) => rigIn(workspace, bead.rig)),
    activity: all.activity.filter((event) => rigIn(workspace, event.rig)),
  };
}

/** What a tab shows beside its name: open questions, and sessions that are alive. */
export function workspaceCounts(workspace: Workspace | null, all: Scoped): { asks: number; live: number } {
  const scoped = scopeTo(workspace, all);
  return {
    asks: scoped.requests.filter((request) => request.state === "open").length,
    live: scoped.sessions.filter((session) => session.state !== "closed" && session.state !== "snoozed").length,
  };
}

/** Which workspace this screen was last in. Per device, like the open panes. */
export function readWorkspace(): string {
  if (typeof window === "undefined") return EVERYTHING;
  try {
    const stored = window.localStorage.getItem(KEY);
    return stored && stored.length <= 120 ? stored : EVERYTHING;
  } catch {
    return EVERYTHING;
  }
}

export function saveWorkspace(id: string): void {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(KEY, id);
    else window.localStorage.removeItem(KEY);
  } catch {
    // storage blocked: the choice lasts for this page load only
  }
}
