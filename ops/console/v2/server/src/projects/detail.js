// ProjectDetail: the drill-down behind a project card (design 4.2, bead hq-tf37).
//
// One bd call per project gets every bead including closed ones, so the counts,
// the label histogram, the epic rollup, the bead listing and the timeline
// projection all read the same snapshot. Commits come from the git-log wrapper
// verb; doc availability from a vault-read probe plus the rig's own
// DECISIONS.md; session-eval rows from ops/metrics/session-eval.log.

import fs from "node:fs";
import { bdJson, isAuditBead, normalizeBeads } from "./bd.js";
import { parseGitLog } from "./collectors.js";

export const DETAIL_COMMITS = 20;

/** Every bead in the project's db, closed included. */
export function allBeadArgs() {
  return ["list", "--json", "--all", "--limit", "0", "--no-pager"];
}

/**
 * @param {import("../../../shared/api.js").Bead[]} beads
 * @returns {import("../../../shared/api.js").ProjectDetail["beads"]}
 */
export function beadCounts(beads) {
  const out = { open: 0, inProgress: 0, blocked: 0, closed: 0, byLabel: {} };
  for (const b of beads) {
    if (b.status === "closed") out.closed += 1;
    else if (b.status === "in_progress") out.inProgress += 1;
    else if (b.status === "blocked") out.blocked += 1;
    else out.open += 1; // open and deferred both read as open work
    for (const l of b.labels) out.byLabel[l] = (out.byLabel[l] || 0) + 1;
  }
  return out;
}

/**
 * Epics with their child rollup. A milestone is an epic with a due date; the
 * web decides which of these to draw on the calendar.
 * @param {import("../../../shared/api.js").Bead[]} beads
 */
export function epicRollup(beads) {
  const kidsOf = new Map();
  for (const b of beads) {
    if (!b.parent) continue;
    if (!kidsOf.has(b.parent)) kidsOf.set(b.parent, []);
    kidsOf.get(b.parent).push(b);
  }
  return beads
    .filter((b) => b.type === "epic")
    .map((e) => {
      const kids = kidsOf.get(e.id) || [];
      return {
        id: e.id,
        title: e.title,
        due: e.due,
        children: kids.length,
        closed: kids.filter((k) => k.status === "closed").length,
      };
    })
    .sort((a, b) => String(a.due || "9999").localeCompare(String(b.due || "9999")) || a.id.localeCompare(b.id));
}

/**
 * ops/metrics/session-eval.log is tab separated:
 *   <iso>\tsid=<id>\tmodel=<m>\tverdict=<v>\tconf=<c>\t<summary>
 * Some rows carry rig= or cwd=; a row with neither is not attributed to any
 * project rather than guessed at.
 * @param {string} text
 */
export function parseSessionEval(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const at = parts[0].trim();
    const row = { at, session: "", verdict: "", summary: "", rig: null, cwd: null, model: null, conf: null };
    const rest = [];
    for (const p of parts.slice(1)) {
      const m = p.match(/^([a-z_]+)=(.*)$/);
      if (!m) {
        rest.push(p);
        continue;
      }
      const [, k, v] = m;
      if (k === "sid" || k === "session") row.session = v;
      else if (k === "verdict") row.verdict = v;
      else if (k === "rig" || k === "project") row.rig = v;
      else if (k === "cwd") row.cwd = v;
      else if (k === "model") row.model = v;
      else if (k === "conf") row.conf = v;
      else rest.push(p);
    }
    row.summary = rest.join(" ").trim();
    if (!row.verdict && !row.session) continue;
    out.push(row);
  }
  return out;
}

/** Rows attributable to this project, newest first. */
export function sessionEvalFor(rows, project, limit = 20) {
  const hits = rows.filter((r) => {
    if (r.rig) return r.rig === project.id;
    if (r.cwd && project.path) return r.cwd === project.path || r.cwd.startsWith(project.path + "/");
    return false;
  });
  return hits
    .slice()
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit)
    .map((r) => ({ at: r.at, session: r.session, verdict: r.verdict, summary: r.summary }));
}

/** Which of the three docs exist. A probe failure reads as "not available". */
export async function docAvailability(wrapper, project, deps = {}) {
  const exists = deps.exists || ((p) => fs.existsSync(p));
  const probe = async (rel) => {
    if (!rel) return false;
    try {
      const r = await wrapper.call("vault-read", [rel], { timeout: 15000 });
      return r.code === 0 && String(r.stdout || "").length > 0;
    } catch {
      return false;
    }
  };
  const [knowledge, hub] = await Promise.all([probe(project.knowledgePath), probe(project.hubPath)]);
  let decisions = false;
  try {
    decisions = Boolean(project.decisionsPath && exists(project.decisionsPath));
  } catch {
    decisions = false;
  }
  return { knowledge, hub, decisions };
}

export const DOC_NAMES = new Set(["knowledge", "hub", "decisions"]);

/**
 * Raw markdown for one doc. Nothing is stripped here: the web sanitises when
 * it renders (design rev 1 round 2, "unsanitized markdown").
 * @returns {Promise<{name: string, markdown: string, path: string, updatedAt: string|null}|null>}
 */
export async function readDoc(wrapper, project, name, deps = {}) {
  const statFile = deps.stat || ((p) => fs.statSync(p));
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, "utf8"));
  if (name === "decisions") {
    if (!project.decisionsPath) return null;
    try {
      const md = readFile(project.decisionsPath);
      let updatedAt = null;
      try {
        updatedAt = new Date(statFile(project.decisionsPath).mtimeMs).toISOString();
      } catch {
        updatedAt = null;
      }
      return { name, markdown: md, path: project.decisionsPath, updatedAt };
    } catch {
      return null;
    }
  }
  const rel = name === "knowledge" ? project.knowledgePath : project.hubPath;
  if (!rel) return null;
  const r = await wrapper.call("vault-read", [rel], { timeout: 15000 });
  if (r.code !== 0) return null;
  // vault-read is the only path to the mirror and it has no stat verb, so the
  // page shows the content without a modified time rather than a wrong one.
  return { name, markdown: String(r.stdout || ""), path: rel, updatedAt: null };
}

// Authored process charts (bead hq-c4pl0.4): Mermaid files a person writes in the
// project's vault folder, <vaultDir>/flows/<name>.mmd, first line "%% title: ...".
// Read on request only; nothing here generates or refreshes a chart.
export const FLOW_NAME_RE = /^[a-z0-9-]+$/;

/**
 * The vault folder holding a project's flows/: its hub folder, else the
 * conventional 01 Projects/<id> (a discovered rig has no hub in projects.json).
 */
export function flowVaultDir(project) {
  return project.vaultDir || `01 Projects/${project.id}`;
}

/**
 * The project's charts, newest first. No flows folder: an empty list (the wrapper
 * prints nothing).
 * @returns {Promise<{name: string, title: string, updatedAt: string|null}[]>}
 */
export async function listFlows(wrapper, project) {
  const r = await wrapper.call("vault-flows", [flowVaultDir(project)], { timeout: 15000 });
  if (r.code !== 0) {
    const e = new Error(`vault-flows failed for ${project.id} (exit ${r.code})`);
    e.status = 502;
    throw e;
  }
  const out = [];
  for (const line of String(r.stdout || "").split("\n")) {
    const [name, mtime, title] = line.split("\t");
    if (!name || !FLOW_NAME_RE.test(name)) continue;
    const secs = Number(mtime);
    out.push({
      name,
      title: (title || "").trim() || name,
      updatedAt: Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000).toISOString() : null,
    });
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.name.localeCompare(b.name));
}

/**
 * One chart's Mermaid source, or null when there is no such chart. The caller
 * has already checked the name against FLOW_NAME_RE.
 * @returns {Promise<{name: string, source: string}|null>}
 */
export async function readFlow(wrapper, project, name) {
  if (!FLOW_NAME_RE.test(name)) return null;
  const r = await wrapper.call("vault-read", [`${flowVaultDir(project)}/flows/${name}.mmd`], { timeout: 15000 });
  if (r.code !== 0) {
    // vault-read dies with "no such vault file" for a missing chart; any other failure is the reader's
    if (/no such vault file/i.test(String(r.stderr || "") + String(r.stdout || ""))) return null;
    const e = new Error(`vault-read failed for ${project.id}/${name} (exit ${r.code})`);
    e.status = 502;
    throw e;
  }
  return { name, source: String(r.stdout || "") };
}

/**
 * Beads plus commits for one project, cached with a TTL.
 */
export class DetailSource {
  /** @param {{wrapper: any, cfg: any, ttlS?: number, now?: () => number, readFile?: Function}} opts */
  constructor(opts) {
    this.wrapper = opts.wrapper;
    this.cfg = opts.cfg;
    this.ttlMs = (opts.ttlS == null ? 30 : opts.ttlS) * 1000;
    this.now = opts.now || (() => Date.now());
    this.readFile = opts.readFile || ((f) => fs.readFileSync(f, "utf8"));
    this.cache = new Map();
  }

  /** @returns {Promise<{beads: import("../../../shared/api.js").Bead[], commits: any[], error: string|null}>} */
  async get(project, opts = {}) {
    const hit = this.cache.get(project.id);
    const now = this.now();
    if (hit && !opts.force && now - hit.at < this.ttlMs) return hit.value;
    const errors = [];
    let beads = [];
    let commits = [];
    try {
      // audit records (egress ledger, session evals) stay out of the drill-down:
      // they are the retro's paper trail, not this project's plan. A
      // label-scoped project (beads living in the hq db) sees only its slice.
      beads = normalizeBeads(await bdJson(this.wrapper, project, allBeadArgs(), { timeout: 45000 })).filter(
        (b) => !isAuditBead(b) && (!project.beadLabel || b.labels.includes(project.beadLabel)),
      );
    } catch (e) {
      errors.push(String((e && e.message) || e));
    }
    if (project.gitDir) {
      try {
        const r = await this.wrapper.call("git-log", [project.gitDir, String(DETAIL_COMMITS)], { timeout: 20000 });
        if (r.code === 0) commits = parseGitLog(r.stdout);
        else errors.push(`git-log failed for ${project.id} (exit ${r.code})`);
      } catch (e) {
        errors.push(String((e && e.message) || e));
      }
    }
    const value = { beads, commits, error: errors.length ? errors.join("; ") : null };
    if (value.error && hit) {
      const kept = { ...hit.value, error: value.error };
      this.cache.set(project.id, { at: now, value: kept });
      return kept;
    }
    this.cache.set(project.id, { at: now, value });
    return value;
  }

  sessionEvalRows() {
    try {
      return parseSessionEval(this.readFile(`${this.cfg.hqRoot}/ops/metrics/session-eval.log`));
    } catch {
      return [];
    }
  }
}

/**
 * Assemble the ProjectDetail.
 * @returns {Promise<import("../../../shared/api.js").ProjectDetail & {error: string|null}>}
 */
export async function buildDetail({ project, summary, source, wrapper, truths, deps }) {
  const { beads, commits, error } = await source.get(project);
  const docs = await docAvailability(wrapper, project, deps || {});
  let truthsRev = 0;
  try {
    truthsRev = truths ? truths.read(project).rev : 0;
  } catch {
    truthsRev = 0;
  }
  return {
    summary,
    beads: beadCounts(beads),
    epics: epicRollup(beads),
    commits,
    docs,
    sessionEval: sessionEvalFor(source.sessionEvalRows(), project),
    truthsRev,
    error,
  };
}
