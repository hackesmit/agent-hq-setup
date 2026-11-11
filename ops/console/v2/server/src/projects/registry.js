// ops/projects.json: the project registry (design section 4.2).
//
// The registry replaces protocol.js RIGS as the card list. It is a checked-in
// file owned by owner, so the server only ever reads it; every derived path is
// resolved against cfg.hqRoot and refused when it escapes.
//
// Derived per entry, because three different callers need the same answers:
//   beadSource  how to reach bd for this project ("hq" | "rig" | "none")
//   gitDir      the repo dir the git-log wrapper verb accepts, or null
//   vaultDir    the vault folder the hub lives in, for Knowledge/Truths
//   truthsPath  ops/projects/<id>/truths.json under hqRoot

import fs from "node:fs";
import path from "node:path";

export class RegistryError extends Error {}

const KINDS = new Set(["rig", "service", "client", "other"]);
const STATUSES = new Set(["active", "paused", "done"]);
const SPHERES = new Set(["work", "personal"]);
export const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const str = (v) => (typeof v === "string" ? v : "");
const arrOf = (v) => (Array.isArray(v) ? v : []);
const objOf = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/** Is `p` inside `root` (or root itself)? Both must be absolute. */
export function inside(root, p) {
  const r = path.resolve(root);
  const q = path.resolve(p);
  return q === r || q.startsWith(r + path.sep);
}

/**
 * Normalise one registry entry. Throws RegistryError on a shape the console
 * cannot act on; tolerates every optional field being absent or null.
 * @param {any} raw
 * @param {{hqRoot: string, rigsDir: string}} cfg
 */
export function normalizeProject(raw, cfg) {
  const e = objOf(raw);
  const id = str(e.id).trim();
  if (!ID_RE.test(id)) throw new RegistryError(`project id is not a safe slug: ${JSON.stringify(e.id)}`);

  const kind = str(e.kind) || "other";
  if (!KINDS.has(kind)) throw new RegistryError(`${id}: kind must be one of rig|service|client|other, got ${JSON.stringify(e.kind)}`);
  const status = str(e.status) || "active";
  if (!STATUSES.has(status)) throw new RegistryError(`${id}: status must be one of active|paused|done, got ${JSON.stringify(e.status)}`);

  // Work/personal split, so the console can show the two lives separately.
  // Optional on purpose: an unclassified project is null, never a guessed bucket.
  const sphere = e.sphere == null ? null : str(e.sphere);
  if (sphere !== null && !SPHERES.has(sphere)) {
    throw new RegistryError(`${id}: sphere must be work|personal, got ${JSON.stringify(e.sphere)}`);
  }
  // Who the project is for ("Orbit Acme"), free text; groups sibling projects
  // under one client on the console.
  const client = e.client == null ? null : str(e.client).trim() || null;

  let projPath = e.path == null ? null : str(e.path);
  if (projPath) {
    projPath = path.resolve(projPath);
    if (!inside(cfg.hqRoot, projPath)) {
      throw new RegistryError(`${id}: path is outside HQ_ROOT: ${projPath}`);
    }
  } else {
    projPath = null;
  }

  const beadPrefix = e.beadPrefix == null ? null : str(e.beadPrefix) || null;

  // How to reach bd. `bd` runs in the hq repo; `bd-rig <rig>` runs in
  // rigs/<rig>. Anything else (a client with no checkout, a service inside the
  // hq tree) has no beads db of its own: zero counts, never an error.
  let beadSource = { mode: "none", rig: null };
  if (projPath && projPath === path.resolve(cfg.hqRoot)) {
    beadSource = { mode: "hq", rig: null };
  } else if (projPath && inside(cfg.rigsDir, projPath)) {
    const rel = path.relative(cfg.rigsDir, projPath);
    if (rel && !rel.includes(path.sep) && ID_RE.test(rel)) beadSource = { mode: "rig", rig: rel };
  }

  // A project without a db of its own may still claim its slice of the hq
  // ledger by label (nonprofit-a lives as hq beads labeled
  // nonprofit-a). The facts fetch then reads the hq db and keeps
  // only beads carrying this label, so the card counts real work instead of
  // a hollow zero.
  const beadLabel = e.beadLabel == null ? null : str(e.beadLabel).trim() || null;
  if (beadLabel && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(beadLabel)) {
    throw new RegistryError(`${id}: beadLabel is not a safe label: ${JSON.stringify(e.beadLabel)}`);
  }
  if (beadLabel && beadSource.mode === "none") beadSource = { mode: "hq", rig: null };
  // A rig checkout whose beads live in the hq ledger (acme-avance, lodgeco-system)
  // says so with "ledger": "hq"; without it the rig's own db is assumed.
  if (e.ledger != null && e.ledger !== "hq") throw new RegistryError(`${id}: ledger must be "hq" when set`);
  if (e.ledger === "hq") beadSource = { mode: "hq", rig: null };

  // git-log takes a repo dir: the hq root or a rig checkout. A service that
  // lives in a subdirectory of hq has no repo of its own, so it gets no
  // commits rather than a wrapper refusal on every tick.
  const gitDir = beadSource.mode === "none" ? null : projPath;

  const hub = str(e.hub) || null;
  const vaultDir = hub ? path.posix.dirname(hub.split(path.sep).join("/")) : null;
  // Two projects may share a hub (hq-mail and minecraft both point at hq's).
  // The mirror must not collide, so a shared folder gets a suffixed file.
  const ownFolder = vaultDir ? vaultDir.split("/").pop() === id : false;
  const truthsMirror = vaultDir ? `${vaultDir}/${ownFolder ? "Truths.md" : `Truths-${id}.md`}` : null;

  return {
    id,
    name: str(e.name) || id,
    kind,
    status,
    sphere,
    client,
    path: projPath,
    beadPrefix,
    hub,
    goal: e.goal == null ? null : str(e.goal) || null,
    // What the project is worth to the owner, free text ("$120,000 MXN", "keeps
    // the gym honest"): a valuation is a judgment, not a computation, so the
    // registry stores his words and the tile shows them verbatim.
    worth: e.worth == null ? null : str(e.worth) || null,
    beadLabel,
    targetDate: e.targetDate == null ? null : str(e.targetDate) || null,
    milestones: arrOf(e.milestones).map((m) => str(m)).filter(Boolean),
    deploys: arrOf(e.deploys)
      .map((d) => objOf(d))
      .map((d) => ({ provider: str(d.provider) || "unknown", project: str(d.project) || null, url: str(d.url) || null })),
    links: objOf(e.links),
    beadSource,
    gitDir,
    vaultDir,
    knowledgePath: vaultDir ? `${vaultDir}/Knowledge.md` : null,
    hubPath: hub,
    decisionsPath: projPath ? path.join(projPath, "DECISIONS.md") : null,
    truthsPath: path.join(cfg.hqRoot, "ops", "projects", id, "truths.json"),
    truthsRepoPath: `ops/projects/${id}/truths.json`,
    truthsMirrorPath: truthsMirror ? path.join(cfg.hqRoot, "outbox", "vault", truthsMirror) : null,
    truthsMirrorRel: truthsMirror,
  };
}

/**
 * Parse a whole registry document.
 * @param {any} doc parsed ops/projects.json
 * @param {{hqRoot: string, rigsDir: string}} cfg
 * @returns {ReturnType<typeof normalizeProject>[]}
 */
export function parseRegistry(doc, cfg) {
  const d = objOf(doc);
  if (!Array.isArray(d.projects)) throw new RegistryError("ops/projects.json has no `projects` array");
  const out = [];
  const seen = new Set();
  for (const raw of d.projects) {
    const p = normalizeProject(raw, cfg);
    if (seen.has(p.id)) throw new RegistryError(`duplicate project id: ${p.id}`);
    seen.add(p.id);
    out.push(p);
  }
  if (!out.length) throw new RegistryError("ops/projects.json lists no projects");
  return out;
}

/** Default registry file path for a config. */
export function registryFile(cfg) {
  return path.join(cfg.hqRoot, "ops", "projects.json");
}

/**
 * The directory a new interactive terminal for this project would start in, or
 * null when the project has no checkout on this box. A project's declared path
 * wins; a project without one may still have a conventional rig checkout under
 * rigs/<id>. Checked on disk at call time: a registry row is a claim, and the
 * runner's `cd` is where a wrong claim used to die silently (exit 2, no error
 * anywhere the owner could see it).
 * @param {{id: string, path: string|null}} project
 * @param {{rigsDir: string}} cfg
 */
export function terminalDir(project, cfg) {
  const candidate = project.path || path.join(cfg.rigsDir, project.id);
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Read and parse the registry, with a small mtime cache so the collectors and
 * the routes can both call it on every request without re-reading the file.
 */
export class Registry {
  /** @param {{hqRoot: string, rigsDir: string}} cfg @param {{file?: string, readFile?: Function, statFile?: Function}} [deps] */
  constructor(cfg, deps = {}) {
    this.cfg = cfg;
    this.file = deps.file || registryFile(cfg);
    this.readFile = deps.readFile || ((f) => fs.readFileSync(f, "utf8"));
    this.statFile = deps.statFile || ((f) => fs.statSync(f));
    this.cached = null;
    this.stamp = null;
  }

  /** @returns {ReturnType<typeof normalizeProject>[]} */
  list() {
    let stamp = null;
    try {
      const st = this.statFile(this.file);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch (e) {
      if (this.cached) return this.cached;
      throw new RegistryError(`cannot read ${this.file}: ${String(e && e.message)}`);
    }
    if (this.cached && stamp === this.stamp) return this.cached;
    let doc;
    try {
      doc = JSON.parse(this.readFile(this.file));
    } catch (e) {
      if (this.cached) return this.cached; // a half-written file must not blank the grid
      throw new RegistryError(`cannot parse ${this.file}: ${String(e && e.message)}`);
    }
    this.cached = parseRegistry(doc, this.cfg);
    this.stamp = stamp;
    return this.cached;
  }

  /** @returns {ReturnType<typeof normalizeProject>|null} */
  get(id) {
    if (!ID_RE.test(String(id || ""))) return null;
    return this.list().find((p) => p.id === id) || null;
  }
}
