// /api/projects/* (design 4.2; shared/api.ts "Phase 1 additions").
//
//   GET  /api/projects                       -> ProjectSummary[]
//   GET  /api/projects/:id                   -> ProjectDetail
//   GET  /api/projects/:id/beads?status=...  -> Bead[]
//   POST /api/projects/:id/beads/:bead {due} -> Bead   (drag-to-set-due)
//   GET  /api/projects/:id/timeline          -> TimelineItem[]
//   GET  /api/projects/:id/flow?epic=<id>&focus=<bead> -> FlowGraph (no epic: the focus bead's epic, else the idea level)
//   GET  /api/projects/:id/truths            -> TruthsDoc
//   POST /api/projects/:id/truths {rev, entries} -> TruthsDoc, 409 on a stale rev
//   GET  /api/projects/:id/doc?name=knowledge|hub|decisions -> {name, markdown, path, updatedAt}
//   GET  /api/projects/:id/flows             -> [{name, title, updatedAt}] (authored Mermaid charts)
//   GET  /api/projects/:id/flows/:name       -> {name, source}
//
// projectRoutes() returns a matcher the lead mounts in server.js: it returns
// true when it owns the URL (and has taken over the response), false otherwise.
// Auth, the Host pin, Origin and the CSRF key are all enforced by server.js
// before this ever runs; nothing here re-implements them.

import { redactText, sanitizeError } from "../redact.js";
import { DetailSource, DOC_NAMES, FLOW_NAME_RE, buildDetail, listFlows, readDoc, readFlow } from "./detail.js";
import { ProjectFacts, summarize } from "./collectors.js";
import { Registry, ID_RE } from "./registry.js";
import { StaleRevision, TruthsError, TruthsStore } from "./truths.js";
import { projectTimeline } from "./timeline.js";
import { bdArgv, normalizeBeads } from "./bd.js";
import { FlowSource, epicOf, flowGraph } from "./flow.js";

const BODY_LIMIT = 256 * 1024;
const STATUSES = new Set(["open", "in_progress", "blocked", "closed", "deferred"]);
// bd ids: a short prefix, a base36 suffix, and a dot for hierarchical children.
const BEAD_ID_RE = /^[a-z]{1,6}-[A-Za-z0-9]{1,16}(?:\.[0-9]{1,4})*$/;
// The design allows exactly one persisted edit from the Gantt: the due date.
// A date, or empty to clear it. Nothing relative, nothing bd could reinterpret.
const DUE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function sendJson(res, code, body) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function query(req) {
  const raw = String(req.url || "");
  const i = raw.indexOf("?");
  return new URLSearchParams(i < 0 ? "" : raw.slice(i + 1));
}

function readBody(req) {
  if (req.body !== undefined) return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > BODY_LIMIT) {
        const e = new TruthsError("body too large", 413);
        reject(e);
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new TruthsError("bad json", 400));
      }
    });
    req.on("error", reject);
  });
}

/**
 * @param {{wrapper: any, cfg: any, truths?: TruthsStore, registry?: Registry,
 *          facts?: ProjectFacts, detail?: DetailSource, collectors?: any,
 *          now?: () => number, timelineOptions?: any, log?: Function}} opts
 * @returns {(req: any, res: any, url: string) => boolean}
 */
export function projectRoutes(opts) {
  const cfg = opts.cfg;
  const wrapper = opts.wrapper;
  const now = opts.now || (() => Date.now());
  const log = opts.log || (() => {});
  const registry = opts.registry || new Registry(cfg);
  const facts = opts.facts || new ProjectFacts({ wrapper, now });
  const detail = opts.detail || new DetailSource({ wrapper, cfg, now });
  const truths = opts.truths || new TruthsStore({ cfg, wrapper, now, log });
  const collectors = opts.collectors || null;
  const flow = opts.flow || new FlowSource({ wrapper, now });

  const slice = async (name, fallback) => {
    if (!collectors || !collectors.has || !collectors.has(name)) return fallback;
    try {
      return (await collectors.get(name)) || fallback;
    } catch {
      return fallback;
    }
  };

  /** The same summary the card grid shows; the collector slice when it is wired. */
  async function summaryFor(project) {
    const cached = await slice("projects", null);
    if (Array.isArray(cached)) {
      const hit = cached.find((p) => p && p.id === project.id);
      if (hit) return hit;
    }
    const [requests, ready] = await Promise.all([slice("requests", []), slice("ready", [])]);
    return summarize(project, await facts.get(project), { nowMs: now(), requests, ready });
  }

  async function summaries() {
    const cached = await slice("projects", null);
    if (Array.isArray(cached)) return cached;
    const [requests, ready] = await Promise.all([slice("requests", []), slice("ready", [])]);
    const nowMs = now();
    const out = [];
    for (const p of registry.list()) out.push(summarize(p, await facts.get(p), { nowMs, requests, ready }));
    return out;
  }

  /**
   * The only bead field the Gantt persists (design 4.2: "Dragging a bar's end
   * or editing a date sets only the due date; start positions are never
   * persisted, they are re-projected"). It runs through the wrapper's own
   * `bd update` verb, so there is no new trust grant here.
   */
  async function setBeadDue(res, project, beadId, body) {
    if (!BEAD_ID_RE.test(beadId)) return sendJson(res, 400, { error: "not a bead id" });
    if (project.beadPrefix && !beadId.startsWith(`${project.beadPrefix}-`)) {
      return sendJson(res, 404, { error: `${beadId} does not belong to ${project.id}` });
    }
    const raw = body.due;
    if (raw != null && typeof raw !== "string") return sendJson(res, 400, { error: "due must be a date string or null" });
    const due = raw == null ? "" : raw.trim();
    if (due && !DUE_RE.test(due)) return sendJson(res, 400, { error: "due must be YYYY-MM-DD or an ISO timestamp" });

    const update = bdArgv(project, ["update", beadId, "--due", due]);
    if (!update) return sendJson(res, 404, { error: `${project.id} has no beads database` });
    const r = await wrapper.call(update.verb, update.args, { timeout: 30000 });
    if (r.code !== 0) {
      const tail = String(r.stderr || r.stdout || "").trim().split("\n").slice(-2).join(" ").slice(-300);
      return sendJson(res, 502, { error: `bd update failed (exit ${r.code})${tail ? ": " + tail : ""}` });
    }
    if (detail.cache && detail.cache.delete) detail.cache.delete(project.id);
    facts.invalidate(project.id);

    const show = bdArgv(project, ["show", beadId, "--json"]);
    const s = await wrapper.call(show.verb, show.args, { timeout: 20000 });
    let bead = null;
    if (s.code === 0) {
      try {
        const parsed = JSON.parse(String(s.stdout || "").trim());
        bead = normalizeBeads(Array.isArray(parsed) ? parsed : [parsed])[0] || null;
      } catch {
        bead = null;
      }
    }
    if (!bead) return sendJson(res, 200, { id: beadId, due: due || null });
    return sendJson(res, 200, bead);
  }

  async function handle(req, res, url, method) {
    if (url === "/api/projects") {
      if (method !== "GET" && method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
      return sendJson(res, 200, await summaries());
    }

    const m = url.match(/^\/api\/projects\/([^/]+)(?:\/([a-z]+))?(?:\/([^/]+))?$/);
    if (!m) return sendJson(res, 404, { error: "not found" });
    const id = decodeURIComponent(m[1]);
    const leaf = m[2] || null;
    const sub = m[3] ? decodeURIComponent(m[3]) : null;
    if (!ID_RE.test(id)) return sendJson(res, 404, { error: "no such project" });
    const project = registry.get(id);
    if (!project) return sendJson(res, 404, { error: "no such project" });

    if (method === "POST") {
      const body = await readBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return sendJson(res, 400, { error: "bad body" });
      if (leaf === "truths" && !sub) {
        const doc = await truths.write(project, body);
        facts.invalidate(project.id);
        return sendJson(res, 200, doc);
      }
      if (leaf === "beads" && sub) return setBeadDue(res, project, sub, body);
      return sendJson(res, 404, { error: "not found" });
    }
    if (leaf === "flows") {
      if (method !== "GET" && method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
      if (!sub) return sendJson(res, 200, await listFlows(wrapper, project));
      if (!FLOW_NAME_RE.test(sub)) return sendJson(res, 400, { error: "chart name must match [a-z0-9-]+" });
      const chart = await readFlow(wrapper, project, sub);
      if (!chart) return sendJson(res, 404, { error: `no chart ${sub} for ${project.id}` });
      return sendJson(res, 200, chart);
    }
    if (sub) return sendJson(res, 404, { error: "not found" });
    if (method !== "GET" && method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });

    if (!leaf) {
      return sendJson(
        res,
        200,
        await buildDetail({ project, summary: await summaryFor(project), source: detail, wrapper, truths }),
      );
    }
    if (leaf === "beads") {
      const want = query(req).get("status");
      const { beads } = await detail.get(project);
      if (!want || want === "all") return sendJson(res, 200, beads);
      const wanted = new Set(
        String(want)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      for (const s of wanted) if (!STATUSES.has(s)) return sendJson(res, 400, { error: `no such status: ${s}` });
      return sendJson(res, 200, beads.filter((b) => wanted.has(b.status)));
    }
    if (leaf === "timeline") {
      const { beads } = await detail.get(project);
      const q = query(req);
      const lanes = Number(q.get("lanes"));
      return sendJson(
        res,
        200,
        projectTimeline(beads, now(), {
          ...(opts.timelineOptions || {}),
          ...(Number.isInteger(lanes) && lanes > 0 ? { lanes } : {}),
        }),
      );
    }
    if (leaf === "flow") {
      const q = query(req);
      const focus = q.get("focus");
      let epic = q.get("epic");
      if (epic != null && !BEAD_ID_RE.test(epic)) return sendJson(res, 400, { error: "not a bead id" });
      if (focus != null && !BEAD_ID_RE.test(focus)) return sendJson(res, 400, { error: "not a bead id" });
      const beads = await flow.beads(project);
      // focus without an epic opens the chart that bead sits on; a bead with no
      // epic (or one outside this project's slice) just leaves the project scope
      if (focus && !beads.some((b) => b.id === focus)) return sendJson(res, 404, { error: `${focus} is not in ${project.id}` });
      if (!epic && focus) epic = epicOf(beads, focus);
      if (epic) {
        const hit = beads.find((b) => b.id === epic);
        if (!hit) return sendJson(res, 404, { error: `${epic} is not in ${project.id}` });
        if (hit.type !== "epic" && !beads.some((b) => b.parent === epic)) {
          return sendJson(res, 404, { error: `${epic} is not an epic` });
        }
      }
      const requests = await slice("requests", []);
      return sendJson(res, 200, { project: project.id, ...flowGraph(beads, { epic, requests, now: now() }) });
    }
    if (leaf === "truths") {
      return sendJson(res, 200, truths.read(project));
    }
    if (leaf === "doc") {
      const name = String(query(req).get("name") || "");
      if (!DOC_NAMES.has(name)) return sendJson(res, 400, { error: "name must be knowledge, hub or decisions" });
      const doc = await readDoc(wrapper, project, name);
      if (!doc) return sendJson(res, 404, { error: `no ${name} document for ${project.id}` });
      return sendJson(res, 200, doc);
    }
    return sendJson(res, 404, { error: "not found" });
  }

  /** @type {(req: any, res: any, url: string) => boolean} */
  const router = (req, res, url) => {
    if (url !== "/api/projects" && !url.startsWith("/api/projects/")) return false;
    const method = req.method || "GET";
    handle(req, res, url, method).catch((e) => {
      const status = e instanceof StaleRevision ? 409 : e instanceof URIError ? 400 : (e && e.status) || 500;
      const body = { error: sanitizeError(e) };
      if (e instanceof StaleRevision) body.rev = e.expected;
      // The log keeps the stack, because frame paths are what make a 500 diagnosable and
      // redactText leaves ordinary paths alone. It is redacted all the same: the message
      // at the top of a stack is the same string that just went into the response body.
      if (status >= 500) log(`projects route ${url} failed: ${redactText(String((e && e.stack) || e))}`);
      try {
        sendJson(res, status, body);
      } catch {
        /* the response is already gone */
      }
    });
    return true;
  };

  router.registry = registry;
  router.facts = facts;
  router.detail = detail;
  router.truths = truths;
  router.flow = flow;
  return router;
}
