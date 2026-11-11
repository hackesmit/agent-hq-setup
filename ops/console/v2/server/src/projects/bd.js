// bd access for the projects tab: one place that knows the wrapper verbs and
// the exact shape `bd list --json` emits, so the collectors, the detail page
// and the timeline all read the same normalised Bead (shared/api.ts).
//
// Verified against bd on this box (2026-08-18):
//   id, title, status, priority, issue_type, owner, assignee, labels[],
//   created_at, updated_at, started_at, closed_at, close_reason, notes,
//   estimated_minutes, due_at, defer_until, parent,
//   dependencies[{issue_id, depends_on_id, type}], dependency_count,
//   dependent_count, comment_count
// Null-ish fields are omitted rather than emitted as null, so every read is
// defensive and every alias a real bd build has used is accepted.

import { firstJson } from "../exec.js";

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);

const STATUSES = new Set(["open", "in_progress", "blocked", "closed", "deferred"]);

/** ISO string or null; tolerates bd's `Z` stamps and epoch seconds. */
export function iso(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return new Date(v * (v > 1e11 ? 1 : 1000)).toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function firstOf(o, names) {
  for (const n of names) {
    if (o[n] !== undefined && o[n] !== null && o[n] !== "") return o[n];
  }
  return undefined;
}

/**
 * bd's issue JSON to the shared Bead type.
 * @param {any} raw
 * @returns {import("../../../shared/api.js").Bead}
 */
export function normalizeBead(raw) {
  const b = raw && typeof raw === "object" ? raw : {};
  const status = str(b.status).toLowerCase();
  const deps = [];
  let parent = firstOf(b, ["parent", "parent_id", "parentId"]);
  for (const d of arr(b.dependencies)) {
    const dd = d && typeof d === "object" ? d : {};
    const from = str(dd.issue_id || dd.issueId);
    const to = str(dd.depends_on_id || dd.dependsOnId);
    const type = str(dd.type);
    if (!to) continue;
    // Rows are emitted on both sides of an edge; only the ones where this bead
    // is the dependent describe what must close before it can start.
    if (from && from !== str(b.id)) continue;
    if (type === "parent-child") {
      if (!parent) parent = to;
      continue;
    }
    deps.push(to);
  }
  for (const d of arr(firstOf(b, ["deps"]))) {
    const s = str(d);
    if (s && !deps.includes(s)) deps.push(s);
  }
  const est = firstOf(b, ["estimated_minutes", "estimate_minutes", "estimate", "estimateMin"]);
  return {
    id: str(b.id),
    title: str(b.title),
    status: STATUSES.has(status) ? status : "open",
    priority: Number.isFinite(Number(b.priority)) ? Number(b.priority) : 3,
    labels: arr(b.labels).map((l) => str(l)).filter(Boolean),
    type: str(firstOf(b, ["issue_type", "issueType", "type"])) || "task",
    parent: parent ? str(parent) : null,
    deps,
    due: iso(firstOf(b, ["due_at", "due"])),
    deferUntil: iso(firstOf(b, ["defer_until", "deferUntil", "defer"])),
    estimateMin: Number.isFinite(Number(est)) && Number(est) > 0 ? Number(est) : null,
    createdAt: iso(firstOf(b, ["created_at", "createdAt"])) || null,
    closedAt: iso(firstOf(b, ["closed_at", "closedAt"])),
    assignee: str(firstOf(b, ["assignee", "owner"])) || null,
  };
}

/** @param {any[]} rows */
export function normalizeBeads(rows) {
  return arr(rows).map(normalizeBead).filter((b) => b.id);
}

/**
 * The wrapper argv for a bd call against one registry entry.
 * @param {{beadSource: {mode: string, rig: string|null}}} project
 * @param {string[]} args bd arguments, first element must be an allowlisted verb
 * @returns {{verb: string, args: string[]}|null} null when the project has no beads db
 */
export function bdArgv(project, args) {
  const src = project && project.beadSource ? project.beadSource : { mode: "none" };
  if (src.mode === "hq") return { verb: "bd", args: [...args] };
  if (src.mode === "rig" && src.rig) return { verb: "bd-rig", args: [src.rig, ...args] };
  return null;
}

export class BdError extends Error {}

/**
 * Run a bd command for a project and parse its JSON array.
 * @param {import("../wrapper.js").Wrapper} wrapper
 * @param {any} project
 * @param {string[]} args
 * @param {{timeout?: number}} [opts]
 * @returns {Promise<any[]>} [] when the project has no beads db
 */
export async function bdJson(wrapper, project, args, opts = {}) {
  const argv = bdArgv(project, args);
  if (!argv) return [];
  const r = await wrapper.call(argv.verb, argv.args, { timeout: opts.timeout || 30000 });
  const j = firstJson(r.stdout, null);
  if (Array.isArray(j)) return j;
  if (j && typeof j === "object" && Array.isArray(j.issues)) return j.issues;
  if (r.code !== 0) {
    const tail = String(r.stderr || r.stdout || "").trim().split("\n").slice(-2).join(" ").slice(-200);
    throw new BdError(`bd ${args.join(" ")} failed for ${project.id} (exit ${r.code}${tail ? ": " + tail : ""})`);
  }
  // exit 0 with no JSON is an empty result in some bd builds
  return [];
}

/** Every bead that is not closed, in one call. */
export function openBeadArgs() {
  return ["list", "--json", "--limit", "0", "--no-pager"];
}

/** Closed beads with a closed_at at or after `sinceIso`. */
export function closedBeadArgs(sinceIso) {
  return ["list", "--json", "--limit", "0", "--no-pager", "--status", "closed", "--closed-after", String(sinceIso).slice(0, 10)];
}

/**
 * Every closed bead, all time. Costs the same bd invocation as a windowed
 * list (startup dominates), and all-time closed counts are what an honest
 * completion percentage needs.
 */
export function allClosedArgs() {
  return ["list", "--json", "--limit", "0", "--no-pager", "--status", "closed"];
}

/**
 * Auto-filed audit records, not work: the egress ledger and the session evals
 * are written by hooks as a paper trail for the weekly retro (CLAUDE.md calls
 * them "an audit trail, not dispatchable work"). On 2026-08-27 they were 444
 * of hq's 597 open beads, which is what made the Plan page read as a hundred
 * plans. Every project view filters them; their own review flow is the retro.
 * @param {import("../../../shared/api.js").Bead} b
 */
export function isAuditBead(b) {
  return b.labels.includes("egress-ledger") || b.labels.includes("session-eval");
}
