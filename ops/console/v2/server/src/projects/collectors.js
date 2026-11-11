// The `projects` collector: real ProjectSummary rows (design 4.2, bead hq-wdiz).
//
// Replaces the placeholder mapProjects() slice built from ctl.sh's 30-cap task
// cache. Sources, all through the one owner-context wrapper:
//   counts     bd list --json --limit 0            (open / in_progress / blocked)
//   closed7d   bd list --json --status closed --closed-after <30d>
//   activity30d git-log <dir> N, bucketed per UTC day (or the closed rows, for a
//              project with no checkout: see activityOf)
//   lastMergeAt the newest of those same commits
//   needsYou   the `requests` slice (open requests for this project)
//   nextUp     the `ready` slice (top bd ready item for this project)
//
// Per-project caching with a per-project error slot: one rig whose beads db is
// broken shows a stale card, it never blanks the other nine.

import { allClosedArgs, bdJson, isAuditBead, normalizeBeads, openBeadArgs } from "./bd.js";
import { buildBoardRow, sortBoard } from "./board.js";
import { Registry, terminalDir } from "./registry.js";
import { adoptionSnippet, discoverRigs, missingProjects } from "./discover.js";

const DAY_MS = 86400000;
export const ACTIVITY_DAYS = 30;
// git-log takes a COUNT, not a date, so the window is cut client-side out of a
// generous slice. hq alone ran 413 commits in the 30 days to 2026-08-24, so the
// headroom is deliberate rather than round: 2000 lines is 124 KB and 50 ms against
// an 8 MB exec buffer, and a scan that is merely "usually enough" would go wrong
// exactly during the busy month somebody wanted to look at. Where it is still not
// enough, truncation is detected and declared rather than reading as idle days.
export const COMMIT_SCAN = 2000;

/** UTC day key, so a card looks the same from any timezone. */
export function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The `days` UTC day keys ending today, mapped to their slot, oldest first. */
function dayIndex(nowMs, days) {
  const index = new Map();
  for (let i = days - 1; i >= 0; i--) index.set(dayKey(nowMs - i * DAY_MS), days - 1 - i);
  return index;
}

/**
 * Midnight UTC opening the oldest day the chart shows.
 *
 * The window has to be a calendar boundary, not `now - 30 days`, because the buckets
 * are calendar days: at 18:00 UTC those two differ by eighteen hours, which is enough
 * to call a scan short that in fact reached the first drawn day.
 */
export function windowStartMs(nowMs, days = ACTIVITY_DAYS) {
  return Date.parse(`${dayKey(nowMs - (days - 1) * DAY_MS)}T00:00:00.000Z`);
}

/**
 * Count per UTC day for the last `days` days, oldest first, `days` entries, the last
 * being today. Per day rather than cumulative: this is a rate, and a running total
 * can only rise, which drew a finished project and an abandoned one identically.
 *
 * Every stamp is PARSED rather than string-sliced. Today every caller hands this
 * already-normalised Z stamps, so slicing happened to work, but the function's
 * contract is "ISO timestamp" and an offset stamp like 2026-08-18T00:30:00+02:00 is
 * the 17th in UTC: slicing would file it under the 18th and quietly move a bar.
 * @param {(string|null)[]} stamps ISO timestamps, one per event
 * @param {number} nowMs
 */
export function perDay(stamps, nowMs, days = ACTIVITY_DAYS) {
  const index = dayIndex(nowMs, days);
  const out = new Array(days).fill(0);
  for (const at of stamps) {
    if (!at) continue;
    const ms = Date.parse(String(at));
    if (!Number.isFinite(ms)) continue;
    const i = index.get(dayKey(ms));
    if (i === undefined) continue;
    out[i] += 1;
  }
  return out;
}

/**
 * What the card's graph plots, and what it is counting.
 *
 * Commits wherever the project has a checkout: that is the question "has anything
 * been built", and on this box git log IS the GitHub history for main, because the
 * checkout is fed from the mirror. A project with no repo (a client, an n8n service)
 * would otherwise show a permanently dead strip, so it falls back to closed ledger
 * items, the only movement it has. The source travels with the numbers because the
 * caption has to say which of the two you are reading.
 */
export function activityOf(project, facts, nowMs, days = ACTIVITY_DAYS) {
  if (!project.gitDir) {
    return {
      values: perDay(facts.closed.map((b) => b.closedAt), nowMs, days),
      source: "beads",
      truncated: false,
    };
  }
  const stamps = facts.commits.map((c) => c.at).filter(Boolean);
  // The scan is a fixed count, so a repo busier than the scan would draw its early
  // days as idle. Detecting that needs a SENTINEL, not a guess: the fetch asks for
  // one more commit than it means to use, so a full-length reply is proof that at
  // least one was left out rather than merely consistent with it. A repo holding
  // exactly COMMIT_SCAN commits used to trip the old test and report truncation
  // that had not happened.
  //
  // The boundary row is the one asked about, not the minimum timestamp: git walks
  // by commit date but does not promise a monotonic sequence, and one backdated
  // commit in the middle of the reply was enough to make min() declare the window
  // complete when it was not.
  const start = windowStartMs(nowMs, days);
  const boundary = facts.commits.length > COMMIT_SCAN ? facts.commits[facts.commits.length - 1] : null;
  const boundaryMs = boundary && boundary.at ? Date.parse(boundary.at) : null;
  const truncated = boundaryMs !== null && Number.isFinite(boundaryMs) && boundaryMs >= start;
  return { values: perDay(stamps, nowMs, days), source: "commits", truncated };
}

/**
 * Attention ranking (design 4.2: "sorted by attention, blocked and needs-you
 * first"). `late` is an overdue open bead; `quiet` is a project with no live
 * work at all.
 */
export function attentionOf({ needsYou, counts, late, status }) {
  if (needsYou > 0) return "needs-you";
  if (counts.blocked > 0) return "blocked";
  if (late) return "late";
  if (status !== "active") return "quiet";
  if (counts.open + counts.inProgress > 0) return "ok";
  return "quiet";
}

export const ATTENTION_RANK = { "needs-you": 0, blocked: 1, late: 2, ok: 3, quiet: 4 };

/** git-log's `%H\t%ct\t%an\t%s` lines to Commit[]. */
export function parseGitLog(stdout) {
  const out = [];
  for (const line of String(stdout || "").split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const at = Number(parts[1]);
    out.push({
      sha: parts[0],
      at: Number.isFinite(at) ? new Date(at * 1000).toISOString() : null,
      author: parts[2],
      subject: parts.slice(3).join("\t"),
    });
  }
  return out;
}

/**
 * Everything the summary and the detail page both need, fetched once.
 * @param {import("../wrapper.js").Wrapper} wrapper
 * @param {any} project
 * @param {number} nowMs
 */
export async function fetchProjectFacts(wrapper, project, nowMs, opts = {}) {
  // The card needs a month of commits for its graph, not just the newest one for the
  // "merge" line, so the default scan is the graph's. A caller wanting only the tip
  // (the detail page's recent list) still asks for a small count.
  // One more than the graph uses: the extra row is the sentinel that tells a full
  // reply ("there was more") from a repo that simply has exactly this many commits.
  const commitCount = opts.commits || COMMIT_SCAN + 1;
  const errors = [];
  let live = [];
  let closed = [];
  let commits = [];

  try {
    live = normalizeBeads(await bdJson(wrapper, project, openBeadArgs()));
  } catch (e) {
    errors.push(String((e && e.message) || e));
  }
  try {
    // All-time closed, not a 30-day window: the bd invocation costs the same
    // (startup dominates) and completion needs the full denominator. The
    // 7-day and 30-day figures are cut from this by date below.
    closed = normalizeBeads(await bdJson(wrapper, project, allClosedArgs()));
  } catch (e) {
    errors.push(String((e && e.message) || e));
  }
  if (project.gitDir) {
    try {
      const r = await wrapper.call("git-log", [project.gitDir, String(commitCount)], { timeout: 20000 });
      if (r.code === 0) commits = parseGitLog(r.stdout);
      else errors.push(`git-log failed for ${project.id} (exit ${r.code})`);
    } catch (e) {
      errors.push(String((e && e.message) || e));
    }
  }
  // Audit records (egress ledger, session evals) are a paper trail, not work:
  // they were drowning every count and plan view (see isAuditBead).
  live = live.filter((b) => !isAuditBead(b));
  closed = closed.filter((b) => !isAuditBead(b));
  // A label-scoped project (its beads live in the hq db) sees only its slice.
  if (project.beadLabel) {
    live = live.filter((b) => b.labels.includes(project.beadLabel));
    closed = closed.filter((b) => b.labels.includes(project.beadLabel));
  }
  return { live, closed, commits, error: errors.length ? errors.join("; ") : null };
}

/**
 * Fold the facts into a ProjectSummary.
 * @returns {import("../../../shared/api.js").ProjectSummary & {error: string|null}}
 */
export function summarize(project, facts, ctx) {
  const nowMs = ctx.nowMs;
  const counts = { open: 0, inProgress: 0, blocked: 0, closed7d: 0 };
  let late = false;
  for (const b of facts.live) {
    if (b.status === "open" || b.status === "deferred") counts.open += 1;
    else if (b.status === "in_progress") counts.inProgress += 1;
    else if (b.status === "blocked") counts.blocked += 1;
    if (b.due && Date.parse(b.due) < nowMs) late = true;
  }
  const weekAgo = nowMs - 7 * DAY_MS;
  for (const b of facts.closed) {
    if (b.closedAt && Date.parse(b.closedAt) >= weekAgo) counts.closed7d += 1;
  }
  const needsYou = (ctx.requests || []).filter((r) => r && r.rig === project.id && r.state === "open").length;
  const next = (ctx.ready || []).find((b) => b && b.rig === project.id) || null;
  const lastCommit = facts.commits[0] || null;
  const activity = activityOf(project, facts, nowMs);
  const deploy = project.deploys[0] || null;

  // Honest completion: closed over everything ever scoped (audit records are
  // already out). Null when the project has no beads at all, so a project
  // tracked outside bd shows nothing rather than a fake 0%.
  const closedTotal = facts.closed.length;
  const scoped = closedTotal + counts.open + counts.inProgress + counts.blocked;
  const completion = scoped > 0 ? closedTotal / scoped : null;

  // The phase in motion: the epic of the first in-progress bead, else of the
  // next ready one. Progress counts its children on both sides of closed.
  const all = facts.live.concat(facts.closed);
  const parentOf = (id) => {
    const bead = all.find((b) => b.id === id);
    return bead && bead.parent ? all.find((e) => e.id === bead.parent && e.type === "epic") || null : null;
  };
  const moving = facts.live.find((b) => b.status === "in_progress");
  const epic = (moving ? parentOf(moving.id) : null) || (next ? parentOf(String(next.id)) : null);

  // When work on this actually began: the earliest bead ever filed. Commits
  // would be earlier for pre-ledger projects, but the scan window is capped,
  // so the bead date is the one that is always honest about what it is.
  // Compared as epoch ms, not strings: "00:00:00.100Z" sorts before
  // "00:00:00Z" lexicographically (lucy).
  let startedAt = null;
  let startedMs = Infinity;
  for (const b of all) {
    const ms = b.createdAt ? Date.parse(b.createdAt) : NaN;
    if (Number.isFinite(ms) && ms < startedMs) {
      startedMs = ms;
      startedAt = b.createdAt;
    }
  }
  const activeEpic = epic
    ? {
        id: epic.id,
        title: epic.title,
        done: facts.closed.filter((b) => b.parent === epic.id).length,
        total: all.filter((b) => b.parent === epic.id).length,
      }
    : null;

  return {
    id: project.id,
    name: project.name,
    kind: project.kind,
    status: project.status,
    sphere: project.sphere ?? null,
    client: project.client ?? null,
    // Whether a new interactive terminal could actually start here: the picker
    // must not offer a project whose spawn would die on a missing directory.
    spawnable: ctx.cfg ? Boolean(terminalDir(project, ctx.cfg)) : project.path != null,
    completion,
    activeEpic,
    worth: project.worth ?? null,
    earned: ctx.earned === undefined ? null : ctx.earned,
    // What agents spent here in the last 30 days. `usage` is a lookup, not a
    // number, so a project the usage slice simply never saw reads 0 while a
    // dead usage collector reads null: "nothing was spent" and "nobody
    // counted" are different answers and the tile says which one it has.
    tokens30d: ctx.usage ? ctx.usage(project.id).tokens : null,
    costUsd30d: ctx.usage ? ctx.usage(project.id).costUsd : null,
    startedAt,
    goal: project.goal,
    targetDate: project.targetDate,
    counts,
    activity30d: activity.values,
    activitySource: activity.source,
    activityTruncated: activity.truncated,
    lastMergeAt: lastCommit ? lastCommit.at : null,
    // Deploy collectors land in phase 2; a declared target shows as unknown so
    // the card has a slot, an undeclared one shows nothing at all.
    lastDeploy: deploy ? { state: "unknown", at: null, url: deploy.url } : null,
    needsYou,
    nextUp: next ? { id: String(next.id), title: String(next.title || "") } : null,
    attention: attentionOf({ needsYou, counts, late, status: project.status }),
    error: facts.error,
  };
}

/**
 * Per-project TTL cache. Keeps the last good facts so a bd failure degrades to
 * a stale card with an error chip.
 */
export class ProjectFacts {
  /** @param {{wrapper: any, ttlS?: number, now?: () => number}} opts */
  constructor(opts) {
    this.wrapper = opts.wrapper;
    this.ttlMs = (opts.ttlS == null ? 60 : opts.ttlS) * 1000;
    this.now = opts.now || (() => Date.now());
    /** @type {Map<string, {at: number, facts: any}>} */
    this.cache = new Map();
  }

  async get(project, opts = {}) {
    const key = `${project.id}:${opts.commits || COMMIT_SCAN + 1}`;
    const hit = this.cache.get(key);
    const now = this.now();
    if (hit && !opts.force && now - hit.at < this.ttlMs) return hit.facts;
    const facts = await fetchProjectFacts(this.wrapper, project, now, opts);
    if (facts.error && hit) {
      // keep the last good numbers, surface the error alongside them
      this.cache.set(key, { at: now, facts: { ...hit.facts, error: facts.error } });
      return this.cache.get(key).facts;
    }
    this.cache.set(key, { at: now, facts });
    return facts;
  }

  invalidate(id) {
    for (const k of [...this.cache.keys()]) if (k.startsWith(`${id}:`)) this.cache.delete(k);
  }
}

/**
 * Register the real `projects` collector, replacing the placeholder registered
 * by src/collectors.js registerAll(). Call AFTER registerAll.
 *
 * @param {{collectors: any, wrapper: any, cfg: any, registry?: Registry, facts?: ProjectFacts,
 *          now?: () => number, requests?: () => Promise<any[]>, ready?: () => Promise<any[]>}} opts
 * @returns {{registry: Registry, facts: ProjectFacts}}
 */
export function registerProjectCollectors(opts) {
  const { collectors, wrapper, cfg } = opts;
  const now = opts.now || (() => Date.now());
  const registry = opts.registry || new Registry(cfg);
  const facts = opts.facts || new ProjectFacts({ wrapper, now, ttlS: 60 });
  const slice = async (name, fallback) => {
    try {
      return (await collectors.get(name)) || fallback;
    } catch {
      return fallback;
    }
  };
  const getRequests = opts.requests || (() => slice("requests", []));
  const getReady = opts.ready || (() => slice("ready", []));
  // Token spend per project, from the usage collector's byProject slice (which
  // usage.py attributes by each transcript's cwd). Null when there is no usage
  // slice at all, so the card can say so instead of showing a confident zero.
  const getUsage = opts.usage || (() => slice("usage", null));
  const usageByProject = (usage) => {
    if (!usage || !Array.isArray(usage.byProject)) return null;
    const byProject = new Map();
    for (const row of usage.byProject) {
      if (!row || !row.project) continue;
      const tokens =
        Number(row.inputTokens || 0) +
        Number(row.outputTokens || 0) +
        Number(row.cacheReadTokens || 0) +
        Number(row.cacheWriteTokens || 0);
      const prev = byProject.get(row.project) || { tokens: 0, costUsd: 0 };
      byProject.set(row.project, { tokens: prev.tokens + tokens, costUsd: prev.costUsd + Number(row.costUsd || 0) });
    }
    return (id) => byProject.get(id) || { tokens: 0, costUsd: 0 };
  };
  // Money IN logged per project, summed all-time per currency from the ledger
  // store (the money slice is windowed; earnings are not). One pass over the
  // ledger per compile, not one per project, and only currencies the ledger
  // schema actually names: an unknown currency is skipped, never silently
  // booked as MXN (lucy). Null when no ledger is wired, so the tile can say
  // "no ledger" rather than $0.
  const earnedByProject = () => {
    const money = opts.money;
    if (!money || !money.entries) return null;
    const totals = new Map();
    for (const e of money.entries.values()) {
      if (!e || !e.project || !(e.amountCents < 0)) continue;
      if (money.deleted && money.deleted.has(e.id)) continue;
      if (e.currency !== "MXN" && e.currency !== "USD") continue;
      const t = totals.get(e.project) || { mxnCents: 0, usdCents: 0 };
      if (e.currency === "USD") t.usdCents += -e.amountCents;
      else t.mxnCents += -e.amountCents;
      totals.set(e.project, t);
    }
    return totals;
  };

  // Repos on disk the registry has not been told about, and listed projects whose
  // path has gone. Reported, never written: ops/projects.json is guard-protected
  // and adopting a repo stays the owner's keystroke, because a registry an agent can
  // edit is a registry an agent can point somewhere else.
  collectors.register("discovered", 300, async () => {
    let known = [];
    try {
      known = registry.list();
    } catch {
      // A registry that will not parse is its own problem, reported elsewhere.
      return { found: [], missing: [] };
    }
    const found = discoverRigs(cfg.rigsDir, known).map((f) => ({ ...f, snippet: adoptionSnippet(f) }));
    return { found, missing: missingProjects(known) };
  });

  collectors.register("projects", 60, async () => {
    const projects = registry.list();
    const [requests, ready, usage] = await Promise.all([getRequests(), getReady(), getUsage()]);
    const nowMs = now();
    const earned = earnedByProject();
    const usageOf = usageByProject(usage);
    const out = [];
    for (const p of projects) {
      const f = await facts.get(p);
      out.push(
        summarize(p, f, {
          nowMs,
          requests,
          ready,
          cfg,
          earned: earned === null ? null : earned.get(p.id) || { mxnCents: 0, usdCents: 0 },
          usage: usageOf,
        }),
      );
    }
    out.sort(
      (a, b) =>
        (ATTENTION_RANK[a.attention] ?? 9) - (ATTENTION_RANK[b.attention] ?? 9) ||
        b.needsYou - a.needsYou ||
        a.id.localeCompare(b.id),
    );
    return out;
  });

  // Board: the same facts read as a checklist per project (board.js). It asks the
  // projects slice for the card numbers rather than recomputing them, and the
  // facts cache answers from the projects collector's own fetch, so a board
  // refresh costs no bd call of its own.
  collectors.register("board", 60, async () => {
    const projects = registry.list();
    const [summaries, ready] = await Promise.all([slice("projects", []), getReady()]);
    const nowMs = now();
    const rows = [];
    for (const p of projects) {
      const s = (summaries || []).find((x) => x && x.id === p.id) || null;
      const f = await facts.get(p);
      rows.push(buildBoardRow(p, s, f, { nowMs, ready }));
    }
    return { generatedAt: new Date(nowMs).toISOString(), projects: sortBoard(rows) };
  });

  return { registry, facts };
}
