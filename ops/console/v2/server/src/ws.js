// WebSocket layer: one-use tokens, upgrade validation, state pushes.
//
// Browsers cannot set headers on an upgrade, so the page fetches a short-lived
// single-use token over the authenticated HTTPS origin (POST /api/ws-token,
// which is CSRF-checked and only reachable from an authorized connection) and
// presents it in Sec-WebSocket-Protocol. The token is bound to the address+port
// tuple of the connection that minted it, so a token observed elsewhere is
// useless. Origin is matched exactly.
//
// Terminals arrive in P1.3 (the hq-runner daemon). Until then every term.*
// message is answered with term.error "runner not connected", keeping the
// message shapes from shared/api.ts stable for the web client.

import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { Auth } from "./auth.js";
import { WS_PROTOCOL } from "./protocol.js";

const TOK_PREFIX = "tok.";

/**
 * A connection key is "address:port". The address half identifies the peer
 * device (already whois-gated to the owner on another node); the port half
 * identifies the exact TCP connection.
 *
 * A browser opens its WebSocket on a NEW connection, so the port cannot match
 * the one that minted the token; enforcing it would make every handshake fail.
 * The token is therefore bound to the peer ADDRESS by default (a token leaked
 * to any other device or process is useless), and the full tuple is enforced
 * only when CONSOLE_WS_TOKEN_STRICT_PORT=1, for a client that does reuse its
 * connection. Contract note filed for shared/api.ts, whose comment says "same
 * TLS connection origin".
 */
export function sameConn(a, b, strictPort) {
  const [aa, ap] = String(a || "").split(":");
  const [ba, bp] = String(b || "").split(":");
  if (!aa || !ba) return false;
  if (aa !== ba) return false;
  return strictPort ? ap === bp : true;
}

export function createTokens(opts = {}) {
  const ttlMs = opts.ttlMs || 30000;
  const now = opts.now || (() => Date.now());
  const strictPort = Boolean(opts.strictPort);
  const gen = opts.randomToken || (() => crypto.randomBytes(32).toString("base64url"));
  /** @type {Map<string, {connKey: string, expires: number}>} */
  const store = new Map();

  function sweep() {
    const t = now();
    for (const [k, v] of store) if (v.expires <= t) store.delete(k);
  }

  return {
    /** @param {string} connKey address:port of the requesting connection */
    mint(connKey) {
      sweep();
      const token = gen();
      store.set(token, { connKey: String(connKey || ""), expires: now() + ttlMs });
      return { token, expiresInS: Math.round(ttlMs / 1000) };
    },
    /** One-use: a successful redeem removes the token. */
    redeem(token, connKey) {
      sweep();
      const rec = store.get(String(token || ""));
      if (!rec) return { ok: false, reason: "unknown or used token" };
      store.delete(token);
      if (rec.expires <= now()) return { ok: false, reason: "token expired" };
      if (!sameConn(rec.connKey, connKey, strictPort)) {
        return { ok: false, reason: "token bound to another connection" };
      }
      return { ok: true };
    },
    get size() {
      sweep();
      return store.size;
    },
  };
}

/** Parse "hq-console-v1, tok.abc" into its parts. */
export function parseProtocols(header) {
  return String(header || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export class WsLayer {
  /**
   * @param {{cfg: any, auth: Auth, tokens: ReturnType<createTokens>, getHello: Function, log?: Function}} opts
   */
  constructor(opts) {
    this.cfg = opts.cfg;
    this.auth = opts.auth;
    this.tokens = opts.tokens;
    this.getHello = opts.getHello;
    this.log = opts.log || (() => {});
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    /** @type {Map<import("ws").WebSocket, {slices: Set<string>|null}>} */
    this.clients = new Map();
  }

  /** Pure-ish validation so the tests can drive it with fake req/socket. */
  validateUpgrade(req, socket) {
    const url = String(req.url || "").split("?")[0];
    if (url !== "/ws") return { ok: false, reason: "not the ws path" };
    if (!this.auth.socketAllowed(socket)) return { ok: false, reason: "connection not authorized" };
    if (!this.auth.hostAllowed(req.headers && req.headers.host)) return { ok: false, reason: "bad host" };
    const origin = req.headers && (req.headers.origin || req.headers.Origin);
    if (!this.auth.originAllowed(origin)) return { ok: false, reason: "bad origin" };

    const protos = parseProtocols(req.headers && req.headers["sec-websocket-protocol"]);
    if (!protos.includes(WS_PROTOCOL)) return { ok: false, reason: "missing subprotocol" };
    const toks = protos.filter((p) => p.startsWith(TOK_PREFIX));
    if (toks.length !== 1) return { ok: false, reason: "expected exactly one token subprotocol" };
    const token = toks[0].slice(TOK_PREFIX.length);
    if (!token) return { ok: false, reason: "empty token" };

    const redeemed = this.tokens.redeem(token, Auth.connKey(socket));
    if (!redeemed.ok) return { ok: false, reason: redeemed.reason };
    return { ok: true, reason: "ok" };
  }

  handleUpgrade(req, socket, head) {
    const v = this.validateUpgrade(req, socket);
    if (!v.ok) {
      this.log("ws upgrade refused: " + v.reason);
      try {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      } catch {
        /* socket may already be gone */
      }
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }

  async onConnection(ws) {
    this.clients.set(ws, { slices: null });
    ws.on("message", (raw) => this.onMessage(ws, raw));
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
    try {
      const hello = await this.getHello();
      this.sendTo(ws, { t: "hello", ...hello });
    } catch (e) {
      this.sendTo(ws, { t: "hello", release: "dev", protocol: this.cfg.protocol, owner: this.cfg.owner, state: null, error: String(e && e.message) });
    }
  }

  onMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== "string") return;
    const entry = this.clients.get(ws);
    switch (msg.t) {
      case "subscribe":
        if (entry) entry.slices = Array.isArray(msg.slices) ? new Set(msg.slices.map(String)) : null;
        return;
      case "ping":
        this.sendTo(ws, { t: "pong", ts: Number(msg.ts) || Date.now() });
        return;
      case "capri.ack": {
        // Capri (hq-ymxzt.3): one ack per page per wake; a page counts once.
        const w = this.capriWaits?.get(String(msg.id || ""));
        if (w && !w.seen.has(ws)) {
          w.seen.add(ws);
          if (msg.focused === true) w.focused += 1;
          if (w.seen.size >= w.pages) w.finish();
        }
        return;
      }
      case "term.attach":
      case "term.detach":
      case "term.input":
      case "term.resize":
        // P1.3 wires the hq-runner daemon; the shape is already the final one.
        this.sendTo(ws, { t: "term.error", sid: String(msg.sid || ""), error: "runner not connected" });
        return;
      default:
        return;
    }
  }

  sendTo(ws, msg) {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* a dead client is dropped by its close handler */
    }
  }

  /**
   * Capri wake (hq-ymxzt.3): send `msg` with a fresh id to every page and wait up
   * to `ms` for their acks. Resolves {pages, focused}: focused counts the pages
   * that put the cursor in the orchestrator input.
   */
  capriWake(msg, ms = 800) {
    if (!this.capriWaits) this.capriWaits = new Map();
    const id = crypto.randomBytes(8).toString("hex");
    const pages = this.clients.size;
    return new Promise((resolve) => {
      const w = { pages, focused: 0, seen: new Set(), finish: () => {} };
      const timer = setTimeout(() => w.finish(), ms);
      w.finish = () => {
        clearTimeout(timer);
        this.capriWaits.delete(id);
        resolve({ pages, focused: w.focused });
      };
      this.capriWaits.set(id, w);
      if (pages === 0) return w.finish();
      this.broadcast({ ...msg, id });
    });
  }

  broadcast(msg) {
    for (const ws of this.clients.keys()) this.sendTo(ws, msg);
  }

  /** A collector refreshed and its slice actually changed. */
  broadcastSlice(slice, data, generatedAt) {
    const msg = { t: "state", slice, data, generatedAt: generatedAt || new Date().toISOString() };
    for (const [ws, entry] of this.clients) {
      if (entry.slices && !entry.slices.has(slice)) continue;
      this.sendTo(ws, msg);
    }
  }

  get clientCount() {
    return this.clients.size;
  }

  /** Graceful shutdown: 1001 "going away" so the page reconnects politely. */
  closeAll(code = 1001, reason = "server shutting down") {
    for (const ws of this.clients.keys()) {
      try {
        ws.close(code, reason);
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    try {
      this.wss.close();
    } catch {
      /* ignore */
    }
  }
}
