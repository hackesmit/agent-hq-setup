// Project truths: git-versioned ops/projects/<id>/truths.json (design 4.2,
// bead hq-5mja).
//
// Rules this module implements:
//  - the console is the SINGLE writer; workers never edit the file directly
//  - every write carries the revision the client read; a stale revision is a
//    409 and the UI reloads and re-applies (optimistic concurrency)
//  - the file is written atomically (temp + rename) and committed with
//    `git commit --only -- ops/projects/<id>/truths.json`
//  - the commit carries a git trailer `Hq-Truths-Rev: <rev> <hmac>` where the
//    HMAC key is readable only by hqconsole, so a commit made by any other
//    path (worker, meta terminal, manual shell) is detectable regardless of
//    author, and a copied trailer fails because the MAC binds the parent
//    commit and the file bytes
//  - a read-only Truths.md mirror is rendered into the vault outbox
//
// hqconsole cannot write into ~/hq, so the write itself happens in the
// owner-context wrapper. This module is the CLIENT of a wrapper verb
// `write-truths` (spec in the bead summary): it validates, canonicalises,
// computes the MAC, and hands the wrapper the exact bytes to land.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

export const KINDS = new Set(["term", "truth", "assumption", "constraint"]);
export const TRAILER_KEY = "Hq-Truths-Rev";
const MAX_ENTRIES = 500;
const MAX_TEXT = 2000;
const MAX_SOURCE = 200;
const ENTRY_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export class TruthsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export class StaleRevision extends TruthsError {
  constructor(expected, got) {
    super(`stale revision: the file is at rev ${expected}, the write carried rev ${got}`, 409);
    this.expected = expected;
    this.got = got;
  }
}

// ---------- canonical form ----------

/** Stable key order at every level, so the bytes are a function of the value. */
function sortValue(v) {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortValue(v[k]);
    return out;
  }
  return v;
}

/**
 * The exact bytes that land on disk: sorted keys, two-space indent, one
 * trailing newline. Readable in a diff and byte-stable across writers.
 * @param {import("../../../shared/api.js").TruthsDoc} doc
 * @returns {Buffer}
 */
export function canonicalBytes(doc) {
  return Buffer.from(JSON.stringify(sortValue(doc), null, 2) + "\n", "utf8");
}

export function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ---------- the HMAC trailer ----------

/**
 * The MAC message. Design: the HMAC covers
 *   project-id || path || revision || parent-commit || sha256(canonical bytes)
 * Joined with newlines so no field can be shifted into another (a project id
 * containing a slash could otherwise fake a path).
 */
export function trailerMessage({ projectId, repoPath, revision, parentCommit, contentSha256 }) {
  return [String(projectId), String(repoPath), String(revision), String(parentCommit || ""), String(contentSha256)].join("\n");
}

/** @param {Buffer} key */
export function trailerMac(key, fields) {
  return crypto.createHmac("sha256", key).update(trailerMessage(fields), "utf8").digest("hex");
}

/** The full trailer line for the commit message. */
export function trailerLine(key, fields) {
  return `${TRAILER_KEY}: ${fields.revision} ${trailerMac(key, fields)}`;
}

/** Pull `<rev> <hmac>` out of a commit message's trailers. Last one wins. */
export function parseTrailer(commitMessage) {
  const re = new RegExp(`^${TRAILER_KEY}:\\s*(\\d+)\\s+([0-9a-f]{64})\\s*$`, "i");
  let found = null;
  for (const line of String(commitMessage || "").split(/\r?\n/)) {
    const m = line.trim().match(re);
    if (m) found = { revision: Number(m[1]), mac: m[2].toLowerCase() };
  }
  return found;
}

/**
 * Verify a commit's truths trailer against the blob it committed.
 * A commit with no trailer, a trailer that does not verify, or a revision that
 * did not advance is an out-of-band edit and becomes a Needs-you card.
 *
 * @param {string} commitMessage full commit message (subject + body)
 * @param {{key: Buffer, projectId: string, repoPath: string, parentCommit: string,
 *          contentSha256: string, previousRevision?: number}} args
 * @returns {{ok: boolean, reason: string|null, revision: number|null}}
 */
export function verifyTrailer(commitMessage, args) {
  const found = parseTrailer(commitMessage);
  if (!found) return { ok: false, reason: "no Hq-Truths-Rev trailer", revision: null };
  const expect = trailerMac(args.key, {
    projectId: args.projectId,
    repoPath: args.repoPath,
    revision: found.revision,
    parentCommit: args.parentCommit,
    contentSha256: args.contentSha256,
  });
  const a = Buffer.from(expect, "hex");
  const b = Buffer.from(found.mac, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "trailer does not verify against this commit", revision: found.revision };
  }
  if (args.previousRevision != null && !(found.revision > args.previousRevision)) {
    return {
      ok: false,
      reason: `revision did not advance (${args.previousRevision} to ${found.revision})`,
      revision: found.revision,
    };
  }
  return { ok: true, reason: null, revision: found.revision };
}

// ---------- the key ----------

// The meta dir itself is root-owned (Capri needs the hooks and settings under it to
// be unwritable by owner AND by hqconsole), so a key the server creates on first use
// goes in the hqconsole-owned subdir. An install that already has the key at the old
// path keeps using it: this only changes where a NEW key is created.
export const DEFAULT_KEY_PATH = "/var/lib/hqconsole/meta/keys/truths.key";
export const LEGACY_KEY_PATH = "/var/lib/hqconsole/meta/truths.key";

/**
 * Load the MAC key, or create it on first use. Production generates 32 random
 * bytes at 0600 under a directory only hqconsole can read; dev, where that
 * directory does not exist, falls back to a fixed non-secret test key so the
 * console runs on the laptop without provisioning.
 * @param {{env?: Record<string,string|undefined>, devNoAuth?: boolean, log?: Function}} [opts]
 */
export function loadTruthsKey(opts = {}) {
  const env = opts.env || process.env;
  // an existing key at the pre-Capri path wins, so an upgraded box keeps its MAC key
  let file = env.CONSOLE_TRUTHS_KEY || DEFAULT_KEY_PATH;
  if (!env.CONSOLE_TRUTHS_KEY) {
    try {
      if (!fs.existsSync(file) && fs.existsSync(LEGACY_KEY_PATH)) file = LEGACY_KEY_PATH;
    } catch {
      /* stat failure falls through to the normal read path below */
    }
  }
  try {
    const raw = fs.readFileSync(file);
    const hex = raw.toString("utf8").trim();
    if (/^[0-9a-fA-F]{64,}$/.test(hex)) return Buffer.from(hex, "hex");
    if (raw.length >= 16) return raw;
    throw new Error("key file is too short");
  } catch (e) {
    if (e && e.code !== "ENOENT") {
      if (opts.devNoAuth) return devKey();
      throw new TruthsError(`cannot read ${file}: ${String(e.message)}`, 500);
    }
  }
  const key = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, key.toString("hex") + "\n", { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return key;
  } catch (e) {
    if (opts.devNoAuth) {
      if (opts.log) opts.log(`truths key not persisted (${String(e && e.message)}); using the dev key`);
      return devKey();
    }
    throw new TruthsError(`cannot create ${file}: ${String(e && e.message)}`, 500);
  }
}

/** Deterministic, non-secret, dev only. Never reached when the key file exists. */
function devKey() {
  return crypto.createHash("sha256").update("hq-console-v2 dev truths key, not a secret").digest();
}

// ---------- documents ----------

export function emptyDoc(projectId) {
  return { project: projectId, rev: 0, updatedAt: null, entries: [] };
}

/**
 * Validate and normalise the entries a client submitted.
 * @param {any} raw
 * @param {{now: string, existing?: import("../../../shared/api.js").TruthEntry[]}} ctx
 * @returns {import("../../../shared/api.js").TruthEntry[]}
 */
export function normalizeEntries(raw, ctx) {
  if (!Array.isArray(raw)) throw new TruthsError("entries must be an array");
  if (raw.length > MAX_ENTRIES) throw new TruthsError(`too many entries (max ${MAX_ENTRIES})`);
  const prior = new Map((ctx.existing || []).map((e) => [e.id, e]));
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const e = item && typeof item === "object" && !Array.isArray(item) ? item : null;
    if (!e) throw new TruthsError("every entry must be an object");
    const kind = String(e.kind || "");
    if (!KINDS.has(kind)) throw new TruthsError(`entry kind must be one of term|truth|assumption|constraint, got ${JSON.stringify(e.kind)}`);
    const text = String(e.text == null ? "" : e.text).trim();
    if (!text) throw new TruthsError("entry text must not be empty");
    if (text.length > MAX_TEXT) throw new TruthsError(`entry text is longer than ${MAX_TEXT} characters`);
    let id = e.id == null ? "" : String(e.id);
    if (!id) id = crypto.randomBytes(6).toString("hex");
    if (!ENTRY_ID_RE.test(id)) throw new TruthsError(`entry id is not a safe slug: ${JSON.stringify(e.id)}`);
    if (seen.has(id)) throw new TruthsError(`duplicate entry id: ${id}`);
    seen.add(id);
    const source = e.source == null || e.source === "" ? null : String(e.source).slice(0, MAX_SOURCE);
    // `added` is set by the server on first sight and preserved afterwards, so
    // a client cannot backdate an entry.
    const was = prior.get(id);
    out.push({
      id,
      kind,
      text,
      confirmed: Boolean(e.confirmed),
      added: was ? was.added : ctx.now,
      source,
    });
  }
  return out;
}

/** Parse whatever is on disk into a TruthsDoc, tolerating an absent file. */
export function parseDoc(projectId, raw) {
  if (raw == null || raw === "") return emptyDoc(projectId);
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new TruthsError(`ops/projects/${projectId}/truths.json is not valid JSON: ${String(e && e.message)}`, 500);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new TruthsError(`truths.json for ${projectId} is not an object`, 500);
  const rev = Number(doc.rev);
  return {
    project: String(doc.project || projectId),
    rev: Number.isInteger(rev) && rev >= 0 ? rev : 0,
    updatedAt: doc.updatedAt == null ? null : String(doc.updatedAt),
    entries: Array.isArray(doc.entries)
      ? doc.entries.map((e) => ({
          id: String((e && e.id) || ""),
          kind: KINDS.has(String(e && e.kind)) ? String(e.kind) : "truth",
          text: String((e && e.text) || ""),
          confirmed: Boolean(e && e.confirmed),
          added: e && e.added ? String(e.added) : null,
          source: e && e.source ? String(e.source) : null,
        }))
      : [],
  };
}

// ---------- the vault mirror ----------

const HEADINGS = [
  ["term", "Terms"],
  ["truth", "Truths"],
  ["assumption", "Assumptions"],
  ["constraint", "Constraints"],
];

/**
 * Read-only Truths.md for the vault hub. An Obsidian-side edit is never read
 * back: a change from that side goes through the inbox as a proposal.
 * @param {import("../../../shared/api.js").TruthsDoc} doc
 * @param {{name?: string}} [opts]
 */
export function renderTruthsMarkdown(doc, opts = {}) {
  const name = opts.name || doc.project;
  const lines = [];
  lines.push(`# Truths: ${name}`);
  lines.push("");
  lines.push(`Rev ${doc.rev}, updated ${doc.updatedAt || "never"}.`);
  lines.push("");
  lines.push(`Read-only mirror. The console is the single writer; the source of truth is \`ops/projects/${doc.project}/truths.json\`.`);
  lines.push("An edit made here is not read back: propose the change through the vault inbox instead.");
  lines.push("");
  for (const [kind, heading] of HEADINGS) {
    const rows = doc.entries.filter((e) => e.kind === kind);
    if (!rows.length) continue;
    lines.push(`## ${heading}`);
    lines.push("");
    for (const e of rows) {
      const marks = [];
      marks.push(e.confirmed ? "confirmed" : "unconfirmed");
      if (e.source) marks.push(`source: ${e.source}`);
      if (e.added) marks.push(`added ${String(e.added).slice(0, 10)}`);
      lines.push(`- ${e.text} (${marks.join(", ")})`);
    }
    lines.push("");
  }
  if (!doc.entries.length) {
    lines.push("No entries yet.");
    lines.push("");
  }
  return lines.join("\n");
}

// ---------- the out-of-band commit detector ----------

/** The head line the audit verb prints first ({"head": sha, "truncated"}), or null. */
export function parseAuditHead(stdout) {
  for (const line of String(stdout || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === "object" && typeof e.head === "string") {
        return { head: e.head, truncated: Boolean(e.truncated) };
      }
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Parse the truths-audit verb's JSON lines, tolerating junk. */
export function parseAuditLines(stdout) {
  const out = [];
  for (const line of String(stdout || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === "object" && e.sha && e.path && e.project) out.push(e);
    } catch {
      /* not a record */
    }
  }
  return out;
}

/**
 * Verify every audited commit's trailer. Entries arrive newest-first (git
 * log order); monotonicity is enforced walking each path oldest-first, seeded
 * from the oldest entry in the window so a partial window never false-flags.
 *
 * @param {any[]} entries parseAuditLines output
 * @param {{key: Buffer}} opts
 * @returns {{sha: string, project: string, path: string, reason: string}[]}
 */
export function auditTruths(entries, opts) {
  const byPath = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    let list = byPath.get(e.path);
    if (!list) byPath.set(e.path, (list = []));
    list.push(e);
  }
  const violations = [];
  for (const [, list] of byPath) {
    list.reverse(); // oldest first
    let prev = null;
    for (const e of list) {
      if (!e.contentSha256) {
        violations.push({ sha: e.sha, project: e.project, path: e.path, reason: "truths file deleted in this commit" });
        continue;
      }
      const v = verifyTrailer(e.message, {
        key: opts.key,
        projectId: e.project,
        repoPath: e.path,
        parentCommit: e.parent || "",
        contentSha256: e.contentSha256,
        previousRevision: prev,
      });
      if (!v.ok) violations.push({ sha: e.sha, project: e.project, path: e.path, reason: v.reason });
      // Only a VERIFIED commit advances the baseline: a forged trailer claiming
      // a huge revision must not make later honest writes look non-monotonic,
      // and an out-of-band rollback IS worth a second flag on the next write.
      else if (v.revision != null) prev = v.revision;
    }
  }
  return violations;
}

// ---------- unconfirmed-assumption cards ----------

/**
 * Design 4.2 / P1.7c: an unconfirmed assumption is surfaced as a Needs-you
 * decide card until confirmed or deleted. These are synthetic Requests (no
 * worker waits on them): the id is stable per entry, settling happens by
 * editing the entry, and the card disappears when the collector re-reads the
 * file. The web must not send ctl verbs at these ids; meta.truths marks them.
 *
 * @param {any[]} projects registry entries (registry.list())
 * @param {{readFile?: Function, now?: number}} [opts]
 * @returns {import("../../../shared/api.js").Request[]}
 */
export function assumptionCards(projects, opts = {}) {
  const readFile = opts.readFile || ((f) => fs.readFileSync(f, "utf8"));
  const nowMs = opts.now == null ? Date.now() : opts.now;
  const out = [];
  for (const p of Array.isArray(projects) ? projects : []) {
    let doc;
    try {
      doc = parseDoc(p.id, readFile(p.truthsPath));
    } catch (e) {
      if (!e || e.code !== "ENOENT") continue; // unreadable file: the editor shows the error, not this stream
      doc = emptyDoc(p.id);
    }
    for (const entry of doc.entries) {
      if (entry.kind !== "assumption" || entry.confirmed || !entry.id) continue;
      const createdAt = entry.added || doc.updatedAt || new Date(0).toISOString();
      const ageMs = nowMs - Date.parse(createdAt);
      out.push({
        id: `truths-${p.id}-${entry.id}`,
        kind: "decide",
        severity: "P2",
        state: "open",
        rig: p.id,
        bead: null,
        session: null,
        createdAt,
        ageSeconds: Number.isFinite(ageMs) ? Math.max(0, Math.round(ageMs / 1000)) : 0,
        question: `Unconfirmed assumption: ${entry.text}`,
        command: null,
        link: `/projects/${p.id}`,
        why: entry.source ? `source: ${entry.source}` : "Confirm it or delete it in the project's Truths.",
        answer: null,
        settledAt: null,
        snoozedUntil: null,
        meta: { truths: true, project: p.id, entryId: entry.id, rev: doc.rev },
      });
    }
  }
  return out;
}

// ---------- the wrapper client ----------

/** execFile with a stdin payload. Argument arrays only, never a shell string. */
export function runWithInput(cmd, args, input, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout: opts.timeout || 30000, maxBuffer: 4 * 1024 * 1024, env: opts.env ? { ...process.env, ...opts.env } : process.env },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || "") });
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/**
 * Read and write ops/projects/<id>/truths.json.
 *
 * Reads happen in-process (hqconsole may read ~/hq, it may only not write it).
 * Writes go to the wrapper verb `write-truths`, which is the only thing that
 * can land bytes in the repo as owner.
 */
export class TruthsStore {
  /**
   * @param {{cfg: any, wrapper: any, key?: Buffer, now?: () => number,
   *          readFile?: Function, exec?: Function, log?: Function}} opts
   */
  constructor(opts) {
    this.cfg = opts.cfg;
    this.wrapper = opts.wrapper;
    this.now = opts.now || (() => Date.now());
    this.log = opts.log || (() => {});
    this._key = opts.key || null;
    this.readFile = opts.readFile || ((f) => fs.readFileSync(f, "utf8"));
    this.exec = opts.exec || runWithInput;
    // The design serialises repo mutations under /run/lock/hq-git.lock, taken
    // by the console around each wrapper call. Until provisioning creates it,
    // this in-process chain at least guarantees this server never runs two
    // truths writes concurrently.
    this.chain = Promise.resolve();
    this.gitLock = opts.gitLock || null;
  }

  key() {
    if (!this._key) this._key = loadTruthsKey({ devNoAuth: this.cfg && this.cfg.devNoAuth, log: this.log });
    return this._key;
  }

  /** @param {any} project registry entry @returns {import("../../../shared/api.js").TruthsDoc} */
  read(project) {
    let raw = null;
    try {
      raw = this.readFile(project.truthsPath);
    } catch (e) {
      if (e && e.code === "ENOENT") return emptyDoc(project.id);
      throw new TruthsError(`cannot read ${project.truthsRepoPath}: ${String(e && e.message)}`, 500);
    }
    return parseDoc(project.id, raw);
  }

  /** HEAD of the hq repo, the parent the MAC binds. */
  async parentCommit() {
    const r = await this.wrapper.call("git-log", [this.cfg.hqRoot, "1"], { timeout: 20000 });
    if (r.code !== 0) throw new TruthsError(`cannot read HEAD (git-log exit ${r.code})`, 502);
    const sha = String(r.stdout || "").split("\t")[0].trim();
    if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new TruthsError("cannot read HEAD (no sha in git-log output)", 502);
    return sha;
  }

  /**
   * Apply a client write. Serialised in-process; stale revisions are rejected
   * before anything is spawned.
   * @param {any} project
   * @param {{rev: number, entries: any[]}} body
   * @returns {Promise<import("../../../shared/api.js").TruthsDoc>}
   */
  write(project, body) {
    const run = this.chain.then(
      () => this._write(project, body),
      () => this._write(project, body),
    );
    this.chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async _write(project, body) {
    const b = body && typeof body === "object" ? body : {};
    const rev = Number(b.rev);
    if (!Number.isInteger(rev) || rev < 0) throw new TruthsError("rev must be a non-negative integer");
    const current = this.read(project);
    if (rev !== current.rev) throw new StaleRevision(current.rev, rev);

    const nowIso = new Date(this.now()).toISOString();
    const entries = normalizeEntries(b.entries, { now: nowIso, existing: current.entries });
    /** @type {import("../../../shared/api.js").TruthsDoc} */
    const next = { project: project.id, rev: current.rev + 1, updatedAt: nowIso, entries };
    const bytes = canonicalBytes(next);
    const sha = sha256Hex(bytes);
    const markdown = Buffer.from(renderTruthsMarkdown(next, { name: project.name }), "utf8");

    const release = this.gitLock ? await this.gitLock.acquire() : null;
    try {
      const parent = await this.parentCommit();
      const fields = {
        projectId: project.id,
        repoPath: project.truthsRepoPath,
        revision: next.rev,
        parentCommit: parent,
        contentSha256: sha,
      };
      const mac = trailerMac(this.key(), fields);
      const payload =
        JSON.stringify({
          project: project.id,
          rev: next.rev,
          parent,
          sha256: sha,
          trailer: `${TRAILER_KEY}: ${next.rev} ${mac}`,
          truths_b64: bytes.toString("base64"),
          markdown_b64: markdown.toString("base64"),
          markdown_path: project.truthsMirrorRel,
        }) + "\n";

      const { cmd, args } = this.wrapper.argv("write-truths", [project.id, String(next.rev), parent]);
      const r = await this.exec(cmd, args, payload, { timeout: 30000, env: { HQ_ROOT: this.cfg.hqRoot } });
      if (r.code !== 0) throw wrapperError(r, project);
    } finally {
      if (release) await release();
    }
    // read back, so the caller gets exactly what landed
    return this.read(project);
  }
}

/** Map the verb's exit codes onto HTTP statuses. */
function wrapperError(r, project) {
  const tail = String(r.stderr || r.stdout || "").trim().split("\n").slice(-2).join(" ").slice(-300);
  if (r.code === 3) return new StaleRevision(-1, -1);
  if (r.code === 4) return new TruthsError(`the repo moved under the write for ${project.id}; retry`, 409);
  if (r.code === 5) return new TruthsError(`write-truths refused the payload for ${project.id}: ${tail}`, 500);
  return new TruthsError(`write-truths failed for ${project.id} (exit ${r.code})${tail ? ": " + tail : ""}`, 502);
}
