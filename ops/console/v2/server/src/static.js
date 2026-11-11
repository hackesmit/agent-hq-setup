// Static file serving for the release's web/ directory.
//
// Design section 3/frontend: the server resolves releases/current/web once at
// (re)load to its canonical root, then resolves the real path of every
// requested file and refuses anything outside that root. That is what stops a
// planted symlink (or a swapped `current` link) from serving a file from
// outside the release. No directory listing; index.html is the SPA fallback.

import fs from "node:fs";
import path from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
  ".ttf": "font/ttf",
};

/** Vite emits assets/name-<hash>.ext; those are safe to cache forever. */
export function isHashedAsset(rel) {
  return /(^|\/)assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(rel);
}

export function contentType(file) {
  return TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
}

export class StaticServer {
  /**
   * @param {{root: string, csrf?: import("./csrf.js").Csrf, origins?: string[],
   *          fsp?: any, log?: Function}} opts
   *   root is the directory that CONTAINS web/ (CONSOLE_RELEASE_ROOT).
   *   origins are this install's own origins, used to pin connect-src.
   */
  constructor(opts) {
    this.releaseRoot = opts.root;
    this.csrf = opts.csrf || null;
    this.origins = Array.isArray(opts.origins) ? opts.origins : [];
    this.fsp = opts.fsp || fs.promises;
    this.log = opts.log || (() => {});
    this.root = null; // canonical web/ root, resolved by reload()
    this.release = "dev";
  }

  /** Resolve the canonical root once. Absent is fine on first boot. */
  async reload() {
    const webDir = path.join(this.releaseRoot, "web");
    try {
      this.root = await this.fsp.realpath(webDir);
      const real = await this.fsp.realpath(this.releaseRoot);
      this.release = path.basename(real) || "dev";
      return true;
    } catch (e) {
      this.root = null;
      this.release = "dev";
      this.log(`static root unavailable: ${String(e && e.message)}`);
      return false;
    }
  }

  get available() {
    return Boolean(this.root);
  }

  /**
   * Map a URL path to a real file inside the root, or null.
   * @returns {Promise<{file: string, rel: string, fallback: boolean}|null>}
   */
  async resolve(urlPath) {
    if (!this.root) return null;
    let decoded;
    try {
      decoded = decodeURIComponent(String(urlPath || "/").split("?")[0].split("#")[0]);
    } catch {
      return null;
    }
    if (decoded.includes("\0")) return null;
    const rel = path.posix.normalize(decoded).replace(/^\/+/, "");
    // normalize collapses ".." inside the path; a leading one leaves the root
    if (rel.startsWith("..")) return null;

    const wanted = rel === "" ? "index.html" : rel;
    const hit = await this.realIn(wanted);
    // A containment breach is a hard refusal: it must never fall through to the
    // SPA index, or a symlinked directory would answer 200 for any route under
    // it and hide the escape attempt.
    if (hit.refused) return null;
    if (hit.real) {
      const st = await this.fsp.stat(hit.real).catch(() => null);
      if (st && st.isDirectory()) {
        const idx = await this.realIn(path.posix.join(wanted, "index.html"));
        return idx.real ? { file: idx.real, rel: path.posix.join(wanted, "index.html"), fallback: false } : null;
      }
      if (st && st.isFile()) return { file: hit.real, rel: wanted, fallback: false };
      return null;
    }
    // SPA routes (/now, /projects/xd, /projects/hq/beads/hq-o6wn.7) fall back to
    // index.html; a missing asset (a known file type) must stay a 404 so a bad
    // bundle reference is visible. A dotted bead id is not a file type.
    if (TYPES[path.extname(wanted).toLowerCase()]) return null;
    const idx = await this.realIn("index.html");
    return idx.real ? { file: idx.real, rel: "index.html", fallback: true } : null;
  }

  /**
   * realpath the candidate and refuse anything that escapes the root.
   * @returns {Promise<{real: string|null, refused: boolean}>}
   */
  async realIn(rel) {
    const candidate = path.join(this.root, rel);
    let real;
    try {
      real = await this.fsp.realpath(candidate);
    } catch {
      // An intermediate symlink that points outside the root shows up as an
      // ENOENT on the full path, so check the parent chain too.
      const parent = path.dirname(candidate);
      if (parent !== candidate && parent.startsWith(this.root)) {
        try {
          const realParent = await this.fsp.realpath(parent);
          if (realParent !== this.root && !realParent.startsWith(this.root + path.sep)) {
            this.log(`static: refusing ${rel} (parent resolves outside the release root)`);
            return { real: null, refused: true };
          }
        } catch {
          /* parent missing too: an ordinary 404 */
        }
      }
      return { real: null, refused: false };
    }
    if (real !== this.root && !real.startsWith(this.root + path.sep)) {
      this.log(`static: refusing ${rel} (resolves outside the release root)`);
      return { real: null, refused: true };
    }
    return { real, refused: false };
  }

  /**
   * The policy is the backstop for the one threat this app is actually built
   * around: agent-written text reaching a browser. Nothing here is load-bearing
   * on its own (untrusted text never becomes markup), which is exactly why it
   * should be tight -- it is what would contain a bug that has not happened yet.
   *
   * connect-src is pinned to this install's own websocket origins rather than a
   * bare `wss:`, which allowed a socket to ANY host and so would have handed a
   * future script-execution bug a ready exfiltration channel. frame-ancestors,
   * base-uri and form-action have no fallback to default-src, so they are stated
   * explicitly or they are simply absent.
   */
  csp() {
    const ws = this.origins
      .map((o) => String(o).replace(/^http:/, "ws:").replace(/^https:/, "wss:"))
      .filter((o) => o.startsWith("ws"));
    const connect = ["'self'", ...new Set(ws)].join(" ");
    return [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      `connect-src ${connect}`,
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; ");
  }

  headers(rel) {
    const h = { "content-type": contentType(rel) };
    if (rel === "index.html") {
      h["cache-control"] = "no-store";
      h["content-security-policy"] = this.csp();
    } else if (isHashedAsset(rel)) {
      h["cache-control"] = "public, max-age=31536000, immutable";
    } else {
      h["cache-control"] = "no-cache";
    }
    h["x-content-type-options"] = "nosniff";
    return h;
  }

  /** @returns {Promise<boolean>} true when the request was served. */
  async serve(req, res, urlPath) {
    const hit = await this.resolve(urlPath);
    if (!hit) return false;
    let body;
    try {
      body = await this.fsp.readFile(hit.file);
    } catch {
      return false;
    }
    // the CSRF key is per boot, so index.html is rendered, never sent raw
    if (hit.rel === "index.html" && this.csrf) body = Buffer.from(this.csrf.inject(body.toString("utf8")), "utf8");
    const headers = this.headers(hit.rel);
    headers["content-length"] = String(body.length);
    res.writeHead(200, headers);
    if (req.method === "HEAD") res.end();
    else res.end(body);
    return true;
  }
}
