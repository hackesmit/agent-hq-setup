// Flow graph for one project or one epic (bead hq-c4pl0.1).
//
// The project page draws a dependency flow chart colored by state, derived
// live from the ledger and never hand-maintained. Project scope is the idea
// level: epics plus unparented beads, an epic's state rolled up from its
// children. Epic scope is that epic's direct children and the deps among
// them; a dep on a bead outside the epic shows as a stub node so the chart
// says what it waits on without pulling the rest of the project in.
//
// flowGraph() is pure: beads, open requests and a clock in, FlowGraph out.
// FlowSource is the read side, stricter than DetailSource on purpose: a bd
// failure or an unparseable list is an error (the route answers 502), never
// an empty or partial graph.

import { bdArgv, isAuditBead, normalizeBeads } from "./bd.js";
import { allBeadArgs } from "./detail.js";

export class FlowError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Bead ids an open or snoozed console request (an ask) names: those beads wait on the owner.
 * A snoozed ask is only out of his way, the bead still waits for the answer.
 * @param {any[]} requests the requests slice (shared/api.ts Request[])
 * @returns {Set<string>}
 */
export function waitingIds(requests) {
  const out = new Set();
  for (const r of Array.isArray(requests) ? requests : []) {
    if (r && (r.state === "open" || r.state === "snoozed") && typeof r.bead === "string" && r.bead) out.add(r.bead);
  }
  return out;
}

/**
 * One bead's own state, before any rollup.
 * @param {import("../../../shared/api.js").Bead} b
 * @param {Set<string>} waiting
 * @param {number} nowMs
 * @returns {import("../../../shared/api.js").FlowState}
 */
export function beadState(b, waiting, nowMs) {
  if (b.status === "closed") return "done";
  if (waiting.has(b.id)) return "waiting";
  if (b.status === "blocked") return "blocked";
  if (b.status === "in_progress") return "active";
  if (b.status === "deferred") return "deferred";
  if (b.deferUntil && Date.parse(b.deferUntil) > nowMs) return "deferred";
  return "upcoming";
}

/**
 * Pure graph builder.
 * @param {import("../../../shared/api.js").Bead[]} beads already filtered to the project
 * @param {{epic?: string|null, requests?: any[], now?: number}} [opts]
 * @returns {import("../../../shared/api.js").FlowGraph}
 */
export function flowGraph(beads, opts = {}) {
  const list = (Array.isArray(beads) ? beads : []).filter((b) => b && b.id);
  const nowMs = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const waiting = waitingIds(opts.requests);
  const byId = new Map(list.map((b) => [b.id, b]));
  const kidsOf = new Map();
  for (const b of list) {
    if (!b.parent || !byId.has(b.parent) || b.parent === b.id) continue;
    if (!kidsOf.has(b.parent)) kidsOf.set(b.parent, []);
    kidsOf.get(b.parent).push(b);
  }
  const isGroup = (b) => b.type === "epic" || kidsOf.has(b.id);

  // Rolled state, memoised; `visiting` breaks a parent cycle so it cannot recurse forever.
  const rolled = new Map();
  const visiting = new Set();
  const stateOf = (id) => {
    if (rolled.has(id)) return rolled.get(id);
    const b = byId.get(id);
    const own = beadState(b, waiting, nowMs);
    const kids = kidsOf.get(id) || [];
    if (!kids.length || visiting.has(id)) {
      if (!visiting.has(id)) rolled.set(id, own);
      return own;
    }
    visiting.add(id);
    const states = kids.map((k) => stateOf(k.id));
    visiting.delete(id);
    let s;
    if (states.every((x) => x === "done")) s = "done";
    // a closed epic with unfinished children is not done: it reads active (work remains)
    else if (own === "done") s = states.includes("blocked") ? "blocked" : states.includes("waiting") ? "waiting" : "active";
    else if (own === "blocked" || states.includes("blocked")) s = "blocked";
    else if (own === "waiting" || states.includes("waiting")) s = "waiting";
    else if (own === "active" || states.includes("active")) s = "active";
    else if (own === "deferred" || states.every((x) => x === "done" || x === "deferred")) s = "deferred";
    else s = "upcoming";
    rolled.set(id, s);
    return s;
  };

  const node = (b, kind) => {
    const kids = kidsOf.get(b.id) || [];
    return {
      id: b.id,
      title: b.title,
      kind,
      status: b.status,
      state: stateOf(b.id),
      parent: b.parent,
      childCount: kids.length,
      doneCount: kids.filter((k) => k.status === "closed").length,
    };
  };

  const epic = opts.epic || null;
  // The scope's visible members, and for every bead the member that stands
  // for it (itself, or its ancestor at the scope level).
  // A parent cycle has no root, so without help every bead in it would vanish.
  const inCycle = (b) => {
    const seen = new Set();
    let cur = b;
    while (cur && cur.parent && byId.has(cur.parent) && cur.parent !== cur.id) {
      cur = byId.get(cur.parent);
      if (cur.id === b.id) return true;
      if (seen.has(cur.id)) return false;
      seen.add(cur.id);
    }
    return false;
  };
  const members = epic
    ? kidsOf.get(epic) || []
    : list.filter((b) => !b.parent || !byId.has(b.parent) || b.parent === b.id || inCycle(b));
  const memberIds = new Set(members.map((b) => b.id));
  const repOf = (id) => {
    const seen = new Set();
    let cur = id;
    while (cur && !seen.has(cur)) {
      if (memberIds.has(cur)) return cur;
      seen.add(cur);
      const b = byId.get(cur);
      cur = b ? b.parent : null;
    }
    return null;
  };

  const nodes = members.map((b) => node(b, isGroup(b) ? "epic" : "bead"));
  const stubs = new Map();
  const edges = [];
  const edgeKeys = new Set();
  const addEdge = (from, to) => {
    if (from === to) return;
    const k = `${from}\u0000${to}`;
    if (edgeKeys.has(k)) return;
    edgeKeys.add(k);
    edges.push({ from, to });
  };
  const stubFor = (id) => {
    if (stubs.has(id)) return id;
    const b = byId.get(id);
    stubs.set(id, {
      id,
      title: b ? b.title : id,
      kind: "stub",
      status: b ? b.status : "open",
      // a bead outside the project is not ours to judge; it reads as upcoming
      state: b ? stateOf(id) : "upcoming",
      parent: b ? b.parent : null,
      childCount: (kidsOf.get(id) || []).length,
      doneCount: (kidsOf.get(id) || []).filter((k) => k.status === "closed").length,
    });
    return id;
  };

  // Every dep of a member or of anything under it, lifted to the scope level.
  const ancestors = (id) => {
    const out = new Set();
    let cur = byId.get(id) ? byId.get(id).parent : null;
    while (cur && !out.has(cur)) {
      out.add(cur);
      cur = byId.get(cur) ? byId.get(cur).parent : null;
    }
    return out;
  };
  for (const b of list) {
    const to = repOf(b.id);
    if (!to) continue;
    const up = ancestors(b.id);
    for (const d of b.deps) {
      // a dep on its own ancestor is the parent link, not a flow edge
      if (up.has(d)) continue;
      const from = repOf(d);
      if (from) addEdge(from, to);
      else addEdge(stubFor(d), to);
    }
  }

  return {
    epic,
    epicTitle: epic && byId.has(epic) ? byId.get(epic).title : null,
    nodes: [...nodes, ...stubs.values()],
    edges: edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
  };
}

/**
 * The epic a focused bead sits in: its parent, when the parent is in the project.
 * Lets a terminal or a request open "the chart this bead is on" knowing only the bead.
 * @param {import("../../../shared/api.js").Bead[]} beads
 * @param {string} focus
 * @returns {string|null}
 */
export function epicOf(beads, focus) {
  const hit = beads.find((b) => b.id === focus);
  if (!hit || !hit.parent || hit.parent === hit.id) return null;
  return beads.some((b) => b.id === hit.parent) ? hit.parent : null;
}

/**
 * Strict bd list for the flow graph, cached with a TTL. Unlike bdJson it
 * refuses output it cannot parse rather than reading it as "no beads".
 */
export class FlowSource {
  /** @param {{wrapper: any, ttlS?: number, now?: () => number}} opts */
  constructor(opts) {
    this.wrapper = opts.wrapper;
    this.ttlMs = (opts.ttlS == null ? 30 : opts.ttlS) * 1000;
    this.now = opts.now || (() => Date.now());
    this.cache = new Map();
  }

  /** @returns {Promise<import("../../../shared/api.js").Bead[]>} */
  async beads(project) {
    const hit = this.cache.get(project.id);
    const now = this.now();
    if (hit && now - hit.at < this.ttlMs) return hit.beads;
    const argv = bdArgv(project, allBeadArgs());
    if (!argv) return [];
    const r = await this.wrapper.call(argv.verb, argv.args, { timeout: 45000 });
    if (r.code !== 0) {
      // bd exits non-zero when the ledger is busy; the last good graph is whole, just older
      if (hit) return hit.beads;
      throw new FlowError(`bd list failed for ${project.id} (exit ${r.code})`, 502);
    }
    const text = String(r.stdout || "").trim();
    let rows = [];
    if (text) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new FlowError(`bd list for ${project.id} returned output that is not JSON`, 502);
      }
      if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.issues)) parsed = parsed.issues;
      if (!Array.isArray(parsed)) throw new FlowError(`bd list for ${project.id} did not return a list`, 502);
      if (parsed.some((row) => !row || typeof row !== "object" || typeof row.id !== "string" || !row.id)) {
        throw new FlowError(`bd list for ${project.id} returned a row without an id`, 502);
      }
      rows = parsed;
    }
    const beads = normalizeBeads(rows).filter(
      (b) => !isAuditBead(b) && (!project.beadLabel || b.labels.includes(project.beadLabel)),
    );
    this.cache.set(project.id, { at: now, beads });
    return beads;
  }
}
