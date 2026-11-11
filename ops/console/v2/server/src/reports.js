// The report store, read side (hq-o6wn.4). Every HQ report (the [HQ-*] mails, the
// stack usage and retro files) lands as one JSON file under state/reports/YYYY/MM/<id>.json,
// written by ops/reports/publish.py; read.json next to them lists the ids the owner has read.
//
// This module lists and serves those files and marks them read. Two rules matter:
//
// - Marking read goes THROUGH publish.py, never a direct write. publish.py holds an
//   flock on state/reports/.lock around every read.json update, and node has no flock,
//   so a second writer here would race the mail daemon and could drop a read mark.
// - body_html came from a mail body. It is rebuilt from an allowlist before it leaves
//   the server: the console is tailnet-only, but a script in a report would run with
//   the console's origin and its boot key.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const KINDS = ["error", "digest", "fixed", "logged", "escalate", "reply", "security", "stack", "retro"];
// Machine mail (the owner 2026-11-03): one error, a digest of fingerprints, a fix or a
// log line is not a report for a human. It lives on the Errors tab, so the Reports
// tab never lists it, even the older copies still on disk.
export const MACHINE_KINDS = ["error", "digest", "fixed", "logged"];
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const YEAR_RE = /^\d{4}$/;
const MONTH_RE = /^\d{2}$/;
const MAX_LIMIT = 200;

export class ReportsError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

const str = (v) => (typeof v === "string" ? v : "");

export class Reports {
  /** @param {{dir: string, publishScript: string, python?: string, readOnly?: boolean, log?: Function}} o */
  constructor(o) {
    this.dir = o.dir;
    this.publishScript = o.publishScript;
    this.python = o.python || "python3";
    this.readOnly = Boolean(o.readOnly);
    this.log = o.log || (() => {});
    /** path -> {sig, rec}; a file is parsed again only when it changes */
    this.cache = new Map();
    this.readCache = { sig: null, ids: new Set() };
    this.warned = new Set();
  }

  warn(key, msg) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log(msg);
  }

  /** Every valid report, newest first. A garbled file is skipped, never served. */
  all() {
    const seen = new Set();
    const out = [];
    for (const y of listDir(this.dir).filter((n) => YEAR_RE.test(n))) {
      for (const m of listDir(path.join(this.dir, y)).filter((n) => MONTH_RE.test(n))) {
        const dir = path.join(this.dir, y, m);
        for (const name of listDir(dir)) {
          if (!name.endsWith(".json") || name.startsWith(".")) continue;
          const file = path.join(dir, name);
          seen.add(file);
          const rec = this.load(file, name.slice(0, -5));
          if (rec && !MACHINE_KINDS.includes(rec.kind)) out.push(rec);
        }
      }
    }
    for (const k of this.cache.keys()) if (!seen.has(k)) this.cache.delete(k);
    out.sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    return out;
  }

  load(file, expectId) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
    const hit = this.cache.get(file);
    if (hit && hit.sig === sig) return hit.rec;
    let rec = null;
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      // a read failure (permissions, I/O) is not cached: a chmod changes only
      // ctime, so a cached miss would hide the report until a restart
      this.warn(file, `reports: cannot read ${file}: ${String(e && e.message)}`);
      return null;
    }
    try {
      rec = normalize(JSON.parse(text), expectId);
      if (!rec) this.warn(file, `reports: skipping malformed ${file}`);
    } catch (e) {
      this.warn(file, `reports: cannot parse ${file}: ${String(e && e.message)}`);
    }
    this.cache.set(file, { sig, rec });
    return rec;
  }

  /** The read set. A corrupt read.json is an error, not "nothing read": a badge of 400 is a lie. */
  readSet() {
    const file = path.join(this.dir, "read.json");
    let st;
    try {
      st = fs.statSync(file);
    } catch (e) {
      if (e && e.code === "ENOENT") return new Set();
      throw new ReportsError(`cannot read the read marks: ${String(e && e.message)}`);
    }
    const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
    if (this.readCache.sig === sig) return this.readCache.ids;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      throw new ReportsError(`read.json is unreadable: ${String(e && e.message)}`);
    }
    if (!data || typeof data !== "object" || !Array.isArray(data.read ?? [])) throw new ReportsError("read.json is malformed");
    const ids = new Set((data.read || []).filter((x) => typeof x === "string"));
    this.readCache = { sig, ids };
    return ids;
  }

  summary() {
    const read = this.readSet();
    const all = this.all();
    return { total: all.length, unread: all.filter((r) => !read.has(r.id)).length };
  }

  /** @param {{kind?: string|null, unread?: string|null, limit?: string|null, offset?: string|null}} q */
  list(q = {}) {
    const kind = q.kind || null;
    if (kind && !KINDS.includes(kind)) throw new ReportsError(`unknown kind ${JSON.stringify(String(kind).slice(0, 40))}`, 400);
    const unreadOnly = q.unread === "1" || q.unread === "true";
    const limit = clampInt(q.limit, 50, 1, MAX_LIMIT);
    const offset = clampInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const read = this.readSet();
    const all = this.all();
    const rows = all.filter((r) => (!kind || r.kind === kind) && (!unreadOnly || !read.has(r.id)));
    return {
      total: rows.length,
      unread: all.filter((r) => !read.has(r.id)).length,
      offset,
      limit,
      items: rows.slice(offset, offset + limit).map((r) => header(r, read)),
    };
  }

  get(id) {
    if (!ID_RE.test(String(id))) throw new ReportsError("no such report", 404);
    const rec = this.all().find((r) => r.id === id);
    if (!rec) throw new ReportsError("no such report", 404);
    const read = this.readSet();
    return { ...header(rec, read), body_md: rec.body_md, body_html: rec.body_html ? sanitizeHtml(rec.body_html) : null };
  }

  async markRead(id) {
    if (!ID_RE.test(String(id)) || !this.all().some((r) => r.id === id)) throw new ReportsError("no such report", 404);
    await this.write([id]);
    return { ok: true, ...this.summary() };
  }

  /** Mark every report read, or every report of one kind. */
  async markAll(kind) {
    if (kind && !KINDS.includes(kind)) throw new ReportsError("unknown kind", 400);
    const read = this.readSet();
    const ids = this.all()
      .filter((r) => (!kind || r.kind === kind) && !read.has(r.id))
      .map((r) => r.id);
    if (ids.length) await this.write(ids);
    return { ok: true, marked: ids.length, ...this.summary() };
  }

  /** Hand the ids to publish.mark_read on stdin, so the store's lock covers the write. */
  write(ids) {
    if (this.readOnly) return Promise.reject(new ReportsError("the console is read-only", 409));
    const code = [
      "import json, pathlib, sys",
      "sys.path.insert(0, sys.argv[1])",
      "import publish",
      "publish.mark_read(json.load(sys.stdin), base=pathlib.Path(sys.argv[2]))",
    ].join("\n");
    const args = ["-I", "-c", code, path.dirname(this.publishScript), this.dir];
    return new Promise((resolve, reject) => {
      const child = execFile(this.python, args, { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, _out, stderr) => {
        if (!err) return resolve();
        const tail = String(stderr || "").trim().split("\n").slice(-2).join(" ").slice(0, 300);
        this.log(`reports: mark read failed: ${tail || String(err.message)}`);
        reject(new ReportsError(`could not save the read marks: ${tail || "publish failed"}`));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(ids));
    });
  }
}

// Only a missing directory is empty. A permission or I/O error must surface,
// or the unread count would read zero while reports are actually unreadable.
function listDir(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return [];
    throw new ReportsError(`cannot list ${path.basename(dir)}: ${String(e && e.code)}`);
  }
}

function clampInt(v, dflt, lo, hi) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function normalize(j, expectId) {
  if (!j || typeof j !== "object") return null;
  if (!ID_RE.test(str(j.id)) || j.id !== expectId) return null;
  if (!KINDS.includes(j.kind)) return null;
  const ts = Date.parse(str(j.created));
  if (!Number.isFinite(ts) || !str(j.title).trim()) return null;
  return {
    id: j.id,
    kind: j.kind,
    title: str(j.title),
    project: str(j.project),
    created: j.created,
    ts,
    severity: str(j.severity) || "info",
    source: str(j.source),
    body_md: str(j.body_md),
    body_html: typeof j.body_html === "string" && j.body_html ? j.body_html : null,
  };
}

function header(r, read) {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    project: r.project,
    created: r.created,
    severity: r.severity,
    source: r.source,
    hasHtml: Boolean(r.body_html),
    read: read.has(r.id),
  };
}

// ---- HTML sanitizing ------------------------------------------------------------
//
// The output is REBUILT from tokens, never passed through: text is re-escaped, an
// allowed tag is re-emitted with only its allowed attributes, and everything else
// (unknown tags, comments, doctypes, processing instructions) is dropped. Whatever the
// tokenizer misreads therefore comes out as escaped text, not markup. Inline styles and
// images are dropped too: CSS can load remote urls and overlay the page, and an image
// in a mail is a tracking pixel. A report reads as plain structure, and that is enough.

const ALLOWED = new Set([
  "a", "abbr", "b", "blockquote", "br", "caption", "code", "col", "colgroup", "dd", "del", "div", "dl", "dt",
  "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "s",
  "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
]);
const VOID = new Set(["br", "hr", "col"]);
// Elements whose whole content goes with them, not just the tags.
const DROP_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "applet", "noscript", "noembed", "noframes", "template",
  "textarea", "title", "xmp", "plaintext", "svg", "math", "select", "head", "frameset", "frame", "audio", "video",
]);
const NUMERIC_ATTRS = { td: ["colspan", "rowspan"], th: ["colspan", "rowspan"], col: ["span"], colgroup: ["span"], ol: ["start"] };
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", tab: "\t", newline: "\n", nbsp: " " };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (all, ent) => {
    const e = ent.toLowerCase();
    if (e[0] === "#") {
      const cp = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    }
    return Object.prototype.hasOwnProperty.call(NAMED, e) ? NAMED[e] : all;
  });
}

const escText = (s) => s.replace(/&(?!(?:#\d{1,7}|#x[0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function safeHref(raw) {
  // eslint-disable-next-line no-control-regex
  const v = decodeEntities(raw).replace(/[\u0000- \u007f-\u009f]/g, "");
  return /^(?:https?:\/\/|mailto:)/i.test(v) ? v : null;
}

const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(src) {
  const out = {};
  for (const m of src.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

function openTag(name, attrSrc) {
  const attrs = parseAttrs(attrSrc);
  let out = `<${name}`;
  if (name === "a") {
    const href = attrs.href !== undefined ? safeHref(attrs.href) : null;
    if (href) out += ` href="${escAttr(href)}" rel="noopener noreferrer nofollow" target="_blank"`;
  }
  for (const a of NUMERIC_ATTRS[name] || []) {
    if (attrs[a] !== undefined && /^\d{1,4}$/.test(attrs[a].trim())) out += ` ${a}="${attrs[a].trim()}"`;
  }
  return out + ">";
}

/** Rebuild untrusted HTML from an allowlist. Always returns balanced, inert markup. */
const TAG_WINDOW = 1024;
const MAX_DEPTH = 64;

export function sanitizeHtml(input) {
  const html = String(input || "");
  const out = [];
  const stack = [];
  const lastGt = html.lastIndexOf(">");
  let i = 0;
  const text = (s) => {
    if (s) out.push(escText(s));
  };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      text(html.slice(i));
      break;
    }
    text(html.slice(i, lt));
    i = lt;
    if (lt > lastGt) {
      // no ">" left anywhere, so nothing after this point can be a tag
      text(html.slice(i));
      break;
    }
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      const end = html.indexOf(">", i);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    // The tag match looks at a bounded window, so a run of "<" that never
    // closes costs linear time, not quadratic. A tag longer than the window
    // comes out as escaped text, which is safe.
    const m = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/.exec(html.slice(i, i + TAG_WINDOW));
    if (!m) {
      // a lone "<" that opens no tag is text
      text("<");
      i += 1;
      continue;
    }
    i += m[0].length;
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    if (DROP_CONTENT.has(name)) {
      if (closing) continue;
      if (/\/\s*$/.test(m[3]) && (name === "svg" || name === "math")) continue;
      // skip to the matching close, counting nested opens of the same element
      const re = new RegExp(`<(/?)${name}(?=[\\s/>])`, "gi");
      re.lastIndex = i;
      let depth = 1;
      let hit;
      while (depth > 0 && (hit = re.exec(html))) depth += hit[1] ? -1 : 1;
      if (!hit) {
        i = html.length;
        continue;
      }
      const close = html.indexOf(">", re.lastIndex);
      i = close < 0 ? html.length : close + 1;
      continue;
    }
    if (!ALLOWED.has(name)) continue;
    if (closing) {
      const at = stack.lastIndexOf(name);
      if (at < 0) continue; // a stray close tag must not close the page around it
      while (stack.length > at) out.push(`</${stack.pop()}>`);
      continue;
    }
    // nesting is capped, so a stray close tag scans at most MAX_DEPTH entries;
    // an element past the cap is dropped (its text stays, escaped)
    if (!VOID.has(name) && stack.length >= MAX_DEPTH) continue;
    out.push(openTag(name, m[3]));
    if (!VOID.has(name)) stack.push(name);
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join("");
}
