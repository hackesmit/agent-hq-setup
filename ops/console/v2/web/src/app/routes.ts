// Client-side routes, parsed by hand (History API only, no router dependency).
//
//   /                      -> Now
//   /now?req=<rid>         -> Now, deep-linked to one request card (ntfy pushes use this)
//   /board                 -> every project as a checklist
//   /projects              -> project overview
//   /projects/<id>         -> one project
//   /projects/<id>/beads/<bead> -> one project with that bead open in its beads list
//   /projects/<id>/flow[/<epic>][?focus=<bead>] -> the project's flow chart, full width;
//                          focus alone opens the chart that bead sits on, ringed
//   /projects/<id>/flow?chart=<name> -> one authored process chart (vault flows/<name>.mmd)
//   /stack /machines /money /errors
//   /reports               -> every HQ report, newest first
//   /reports/<id>          -> one report open in the reading view
//
// Anything unrecognised falls back to Now rather than rendering a not-found page: this is
// a single-operator console, and a bad link should still land somewhere useful.

// Terminals sits after Now on purpose: Now is where you CONTROL sessions, and
// this is where you watch them. Adding it as a tab rather than growing the Now
// tab keeps that split honest.
export const TABS = ["now", "terminals", "board", "projects", "stack", "machines", "money", "errors", "reports"] as const;

export type TabId = (typeof TABS)[number];

export const TAB_LABELS: Record<TabId, string> = {
  now: "Now",
  terminals: "Terminals",
  board: "Board",
  projects: "Projects",
  stack: "Stack",
  machines: "Machines",
  money: "Money",
  errors: "Errors",
  reports: "Reports",
};

export interface Route {
  tab: TabId;
  projectId: string | null;
  requestId: string | null;
  /** /term/<sid>: one terminal, no chrome (pop-out window) */
  termSid: string | null;
  /** /reports/<id>: the report open in the reading view. Absent on every other route. */
  reportId?: string;
  /** /projects/<id>/beads/<bead>: the bead to open in the project's list. Absent elsewhere. */
  beadId?: string;
  /** /projects/<id>/flow...: the flow chart view. Absent elsewhere. */
  flow?: { epic: string | null; focus: string | null; chart: string | null };
}

export const HOME: Route = { tab: "now", projectId: null, requestId: null, termSid: null };

function isTab(value: string): value is TabId {
  return (TABS as readonly string[]).includes(value);
}

function readRequestId(search: string): string | null {
  return readParam(search, "req");
}

function readParam(search: string, name: string): string | null {
  if (!search) return null;
  const query = search.startsWith("?") ? search.slice(1) : search;
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (decodeURIComponent(key) !== name) continue;
    const value = eq === -1 ? "" : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
    return value || null;
  }
  return null;
}

/** Accepts "/projects/fintrack?req=r-1", "projects/fintrack", or a full URL. */
export function parseRoute(input: string): Route {
  let path = input ?? "";
  const schemeAt = path.indexOf("://");
  if (schemeAt !== -1) {
    const afterHost = path.indexOf("/", schemeAt + 3);
    path = afterHost === -1 ? "/" : path.slice(afterHost);
  }
  const hashAt = path.indexOf("#");
  if (hashAt !== -1) path = path.slice(0, hashAt);

  const queryAt = path.indexOf("?");
  const search = queryAt === -1 ? "" : path.slice(queryAt);
  if (queryAt !== -1) path = path.slice(0, queryAt);

  const requestId = readRequestId(search);
  const segments = path.split("/").filter((segment) => segment.length > 0);

  if (segments.length === 0) return { ...HOME, requestId };

  const first = decodeURIComponent(segments[0]!).toLowerCase();
  if (first === "term" && segments.length > 1) {
    const sid = decodeURIComponent(segments[1]!);
    return { tab: "now", projectId: null, requestId, termSid: sid || null };
  }
  if (!isTab(first)) return { ...HOME, requestId };

  if (first === "reports" && segments.length > 1) {
    const reportId = decodeURIComponent(segments[1]!);
    if (reportId) return { tab: "reports", projectId: null, requestId, termSid: null, reportId };
  }
  if (first === "projects" && segments.length > 1) {
    const projectId = decodeURIComponent(segments[1]!);
    if (projectId && segments[2]?.toLowerCase() === "beads" && segments.length > 3) {
      const beadId = decodeURIComponent(segments[3]!);
      if (beadId) return { tab: "projects", projectId, requestId, termSid: null, beadId };
    }
    if (projectId && segments[2]?.toLowerCase() === "flow") {
      const epic = segments[3] ? decodeURIComponent(segments[3]) || null : null;
      const flow = { epic, focus: readParam(search, "focus"), chart: readParam(search, "chart") };
      return { tab: "projects", projectId, requestId, termSid: null, flow };
    }
    return { tab: "projects", projectId: projectId || null, requestId, termSid: null };
  }
  return { tab: first, projectId: null, requestId, termSid: null };
}

export function routePath(route: Route): string {
  if (route.termSid) return `/term/${encodeURIComponent(route.termSid)}`;
  const base =
    route.tab === "projects" && route.projectId
      ? route.flow
        ? flowPath(route.projectId, route.flow)
        : route.beadId
          ? beadPath(route.projectId, route.beadId)
          : `/projects/${encodeURIComponent(route.projectId)}`
      : route.tab === "reports" && route.reportId
        ? reportPath(route.reportId)
        : `/${route.tab}`;
  if (!route.requestId) return base;
  return `${base}${base.includes("?") ? "&" : "?"}req=${encodeURIComponent(route.requestId)}`;
}

export function tabPath(tab: TabId): string {
  return `/${tab}`;
}

export function projectPath(id: string): string {
  return `/projects/${encodeURIComponent(id)}`;
}

export function beadPath(projectId: string, beadId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/beads/${encodeURIComponent(beadId)}`;
}

/** The flow chart of a project, optionally one epic, optionally ringing one bead. */
export function flowPath(
  projectId: string,
  opts: { epic?: string | null; focus?: string | null; chart?: string | null } = {},
): string {
  const base = `/projects/${encodeURIComponent(projectId)}/flow`;
  const withEpic = opts.epic ? `${base}/${encodeURIComponent(opts.epic)}` : base;
  const query = [
    opts.focus ? `focus=${encodeURIComponent(opts.focus)}` : "",
    opts.chart ? `chart=${encodeURIComponent(opts.chart)}` : "",
  ].filter(Boolean);
  return query.length ? `${withEpic}?${query.join("&")}` : withEpic;
}

/**
 * Where the Flow button on a session row, terminal or request card goes: the
 * bead's chart in its project, or null (no button) when either is unknown. The
 * project is the rig, which sessions and requests carry as a project id; it must
 * be a project the console knows; with no rig, a project named like the bead's
 * prefix ("hq-..." is hq). The server resolves the bead's epic.
 */
export function flowPathFor(
  projectIds: readonly string[],
  rig: string | null | undefined,
  bead: string | null | undefined,
): string | null {
  if (!bead) return null;
  // no rig (a meta terminal, an hq request): a project named like the bead's prefix
  const project = rig ? (projectIds.includes(rig) ? rig : null) : (projectIds.find((id) => bead.startsWith(`${id}-`)) ?? null);
  return project ? flowPath(project, { focus: bead }) : null;
}

export function reportPath(id: string): string {
  return `/reports/${encodeURIComponent(id)}`;
}

/** Number keys 1-9 switch tabs. */
export function tabForKey(key: string): TabId | null {
  const index = Number.parseInt(key, 10);
  if (!Number.isInteger(index) || index < 1 || index > TABS.length) return null;
  return TABS[index - 1] ?? null;
}
