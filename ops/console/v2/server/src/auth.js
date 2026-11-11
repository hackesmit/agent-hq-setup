// Auth: who may open a TCP connection to this console at all.
//
// Design section 3: no header-based identity anywhere. In production the server
// binds only the box's tailnet address, terminates TLS with the tailscale cert,
// and asks the local tailscaled who the peer is for every new connection. It
// accepts only when the peer's login equals CONSOLE_OWNER AND the peer node is
// not this node (a process on hqbox reaching the box's own 100.x address whois
// as the same login, so self-peer is refused outright). Refusal happens at the
// socket layer, before any HTTP bytes are parsed.
//
// Every external dependency (tailscale ip, tailscale status, whois, fs) is
// injectable, so the tests exercise the real decision logic with no network.

import fs from "node:fs";
import http from "node:http";
import { X509Certificate } from "node:crypto";
import path from "node:path";
import { allowedOrigins, hostAllowed } from "./config.js";
import { run, firstJson } from "./exec.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
// How long a failed self-lookup is remembered. Short enough that a box that
// recovers is serving again quickly, long enough that a connection flood cannot
// turn every accept into a subprocess spawn.
const SELF_FAIL_TTL_MS = 5000;

/** Strip the IPv4-mapped IPv6 prefix so comparisons are on one form. */
export function normalizeIp(ip) {
  const s = String(ip || "");
  return s.startsWith("::ffff:") ? s.slice(7) : s;
}

/** Default whois: Tailscale LocalAPI over the tailscaled unix socket. */
export function localApiWhois(socketPath, timeoutMs = 3000) {
  return (ip, port) =>
    new Promise((resolve, reject) => {
      const addr = `${ip}:${port}`;
      const req = http.request(
        {
          socketPath,
          method: "GET",
          path: `/localapi/v0/whois?addr=${encodeURIComponent(addr)}`,
          headers: { Host: "local-tailscaled.sock" },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => {
            body += c;
            if (body.length > 256 * 1024) req.destroy(new Error("whois response too large"));
          });
          res.on("end", () => {
            if (res.statusCode !== 200) {
              reject(new Error(`whois ${res.statusCode}: ${body.slice(0, 200)}`));
              return;
            }
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(new Error(`whois returned non-JSON: ${String(e.message)}`));
            }
          });
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error("whois timeout")));
      req.on("error", reject);
      req.end();
    });
}

/** Default self info: `tailscale status --self --json`. */
export function tailscaleSelfInfo() {
  return async () => {
    const r = await run("tailscale", ["status", "--self", "--json"], { timeout: 10000 });
    const j = firstJson(r.stdout, null);
    const self = (j && j.Self) || {};
    return {
      ips: (self.TailscaleIPs || []).map(normalizeIp),
      nodeId: self.ID || self.StableID || "",
    };
  };
}

/** Default tailnet address: first IPv4 from `tailscale ip -4`. */
export function tailscaleIpv4() {
  return async () => {
    const r = await run("tailscale", ["ip", "-4"], { timeout: 10000 });
    const line = r.stdout.split("\n").map((s) => s.trim()).find(Boolean);
    if (!line) throw new Error("tailscale ip -4 returned nothing");
    return line;
  };
}

/**
 * Cert lifecycle decision (design section 3): expired is unusable by any
 * browser, so the server exits non-zero; inside the warning window it starts
 * and pins a P0-style alert.
 * @returns {"expired"|"warn"|"ok"|"unknown"}
 */
export function certVerdict(daysLeft, warnDays = 7) {
  if (daysLeft === null || daysLeft === undefined || Number.isNaN(daysLeft)) return "unknown";
  if (daysLeft <= 0) return "expired";
  if (daysLeft < warnDays) return "warn";
  return "ok";
}

const AUTH = Symbol("hq.console.auth");

export class Auth {
  /**
   * @param {import("./config.js").Config} cfg
   * @param {{whois?: Function, selfInfo?: Function, tailnetIp?: Function, readFile?: Function, watch?: Function, now?: Function}} [deps]
   */
  constructor(cfg, deps = {}) {
    this.cfg = cfg;
    this.deps = deps;
    this.whois = deps.whois || localApiWhois(cfg.tailscaleSocket);
    this.selfInfo = deps.selfInfo || tailscaleSelfInfo();
    this.tailnetIp = deps.tailnetIp || tailscaleIpv4();
    this.readFile = deps.readFile || ((p) => fs.promises.readFile(p));
    this.watch = deps.watch || fs.watch;
    this.now = deps.now || (() => Date.now());
    this._self = null;
    this._selfPromise = null;
    this._selfFailedAt = null;
    this._selfError = null;
    this._watchers = [];
  }

  /** Address to bind. Dev: loopback. Prod: the box's tailnet IPv4. */
  async resolveBindAddress() {
    if (this.cfg.devNoAuth) return "127.0.0.1";
    const ip = await this.tailnetIp();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`refusing to bind non-IPv4 address ${ip}`);
    if (LOOPBACK.has(ip)) throw new Error("tailscale reported a loopback address; refusing to bind");
    return ip;
  }

  /**
   * This box's own tailnet identity, resolved once.
   *
   * Two things go wrong if it is not memoized carefully, and both are reachable
   * from anything that can open TCP connections to us. The await used to happen
   * BEFORE the assignment, so N concurrent connections all saw an empty cache and
   * all spawned their own `tailscale` subprocess; and a failure cached nothing at
   * all, so a box where the lookup is broken spawned one subprocess per connection
   * forever. The promise is memoized now, so concurrent callers share one lookup,
   * and a failure is remembered briefly so a broken lookup costs one subprocess
   * per interval rather than one per connection.
   */
  async self() {
    if (this._self) return this._self;
    const now = this.now ? this.now() : Date.now();
    // Explicitly null, never 0: an injected clock starting at zero would make a
    // truthiness check silently skip the cached failure.
    if (this._selfFailedAt !== null && now - this._selfFailedAt < SELF_FAIL_TTL_MS) throw this._selfError;
    if (!this._selfPromise) {
      this._selfPromise = this.selfInfo().then(
        (value) => {
          this._self = value;
          this._selfPromise = null;
          this._selfFailedAt = null;
          return value;
        },
        (e) => {
          this._selfPromise = null;
          this._selfFailedAt = this.now ? this.now() : Date.now();
          this._selfError = e;
          throw e;
        },
      );
    }
    return this._selfPromise;
  }

  /**
   * The whole authorization decision for one peer.
   * @returns {Promise<{ok: boolean, reason: string, login?: string}>}
   */
  async authorizePeer(rawIp, port) {
    const ip = normalizeIp(rawIp);
    if (this.cfg.devNoAuth) {
      return LOOPBACK.has(ip)
        ? { ok: true, reason: "dev-noauth loopback", login: this.cfg.owner }
        : { ok: false, reason: `dev mode accepts loopback only, got ${ip}` };
    }
    if (!ip) return { ok: false, reason: "no peer address" };

    let info;
    try {
      info = await this.whois(ip, port);
    } catch (e) {
      return { ok: false, reason: `whois failed: ${String(e && e.message)}` };
    }
    if (!info || typeof info !== "object") return { ok: false, reason: "whois returned nothing" };

    const login = (info.UserProfile && info.UserProfile.LoginName) || "";
    if (!login) return { ok: false, reason: "whois has no login" };
    if (login !== this.cfg.owner) return { ok: false, reason: `login ${login} is not the owner` };

    // Self-peer refusal: a worker on this box connecting to the box's own
    // tailnet address whois as the same login, so identity alone is not enough.
    let self = { ips: [], nodeId: "" };
    try {
      self = await this.self();
    } catch (e) {
      return { ok: false, reason: `self identity unavailable: ${String(e && e.message)}` };
    }
    const node = info.Node || {};
    const peerNodeIds = [node.StableID, node.ID].filter(Boolean).map(String);
    const peerIps = (node.Addresses || node.TailscaleIPs || [])
      .map((a) => normalizeIp(String(a).split("/")[0]));
    if (self.nodeId && peerNodeIds.includes(String(self.nodeId))) {
      return { ok: false, reason: "self-peer refused (same node id)" };
    }
    if (self.ips.includes(ip) || peerIps.some((p) => self.ips.includes(p))) {
      return { ok: false, reason: "self-peer refused (own tailnet address)" };
    }
    return { ok: true, reason: "owner on another node", login };
  }

  /**
   * Gate one accepted socket. Refused sockets are destroyed before the HTTP
   * parser ever sees a byte; allowed ones are stamped so the request handler
   * can double-check.
   */
  async gateSocket(socket) {
    // The caller (server.js gateAndHandOff) hands the socket to the http server
    // only after this resolves, so an unauthorized peer never gets its request
    // line parsed and an authorized peer's first request cannot race the verdict.
    let verdict;
    try {
      verdict = await this.authorizePeer(socket.remoteAddress, socket.remotePort);
    } catch (e) {
      verdict = { ok: false, reason: `peer check threw: ${String(e && e.message)}` };
    }
    socket[AUTH] = { ...verdict, at: this.now() };
    if (!verdict.ok) {
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      return verdict;
    }
    return verdict;
  }

  /**
   * Belt to the socket-layer brace: has this socket passed the peer check?
   * On an https server the stamp lives on the raw net.Socket accepted in the
   * "connection" event, while req.socket and the upgrade socket are the
   * TLSSocket wrapping it; look through the wrapper (its _parent) as well.
   */
  static state(socket) {
    if (!socket) return null;
    if (socket[AUTH]) return socket[AUTH];
    const parent = socket._parent || (socket._handle && socket._handle.parent);
    if (parent && parent[AUTH]) return parent[AUTH];
    return null;
  }

  socketAllowed(socket) {
    const st = Auth.state(socket);
    return Boolean(st && st.ok);
  }

  /** Stable key for binding a WS token to the connection that asked for it. */
  static connKey(socket) {
    if (!socket) return "";
    return `${normalizeIp(socket.remoteAddress)}:${socket.remotePort}`;
  }

  hostAllowed(hostHeader) {
    return hostAllowed(this.cfg, hostHeader);
  }

  allowedOrigins() {
    return allowedOrigins(this.cfg);
  }

  originAllowed(origin) {
    return this.allowedOrigins().includes(String(origin || ""));
  }

  // ---------- TLS ----------

  certPaths() {
    return {
      cert: path.join(this.cfg.tlsDir, "cert.pem"),
      key: path.join(this.cfg.tlsDir, "key.pem"),
    };
  }

  /** @returns {Promise<{cert: Buffer, key: Buffer, notAfter: Date|null, daysLeft: number|null, expired: boolean}>} */
  async loadTls() {
    const p = this.certPaths();
    const [cert, key] = await Promise.all([this.readFile(p.cert), this.readFile(p.key)]);
    let notAfter = null;
    try {
      notAfter = new Date(new X509Certificate(cert).validTo);
    } catch {
      notAfter = null;
    }
    const daysLeft =
      notAfter && !Number.isNaN(notAfter.getTime())
        ? (notAfter.getTime() - this.now()) / 86400000
        : null;
    return { cert, key, notAfter, daysLeft, expired: daysLeft !== null && daysLeft <= 0 };
  }

  /**
   * Hot reload: the weekly `tailscale cert` renewal rewrites the files under a
   * running server, so watch them and swap the secure context in place.
   * @param {(tls: {cert: Buffer, key: Buffer}) => void} onReload
   */
  watchTls(onReload, onError) {
    const p = this.certPaths();
    let timer = null;
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          onReload(await this.loadTls());
        } catch (e) {
          if (onError) onError(e);
        }
      }, 500);
      if (timer.unref) timer.unref();
    };
    // watch the directory, not the files: a renewal that replaces cert.pem by rename
    // would leave a per-inode file watch dead after the first change
    const dirs = new Set([path.dirname(p.cert), path.dirname(p.key)]);
    for (const f of dirs) {
      try {
        const w = this.watch(f, reload);
        if (w && w.unref) w.unref();
        this._watchers.push(w);
      } catch (e) {
        if (onError) onError(e);
      }
    }
    return () => {
      clearTimeout(timer);
      for (const w of this._watchers) {
        try {
          w.close();
        } catch {
          /* ignore */
        }
      }
      this._watchers = [];
    };
  }
}
