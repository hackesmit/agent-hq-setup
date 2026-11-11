// The console server's side of the hq-runner link.
//
// Three things live here and nothing else in the server knows about the
// runner:
//   RunnerClient        a reconnecting JSON-lines client for
//                       /run/hqconsole/runner.sock (runner/PROTOCOL.md)
//   attachTermHandlers  turns the browser's term.* WebSocket messages into
//                       runner requests, and runner data/exit events back into
//                       term.data / term.exit for the sockets that asked
//   sessionsFromRunner  the attachable/writable half of a Session, for the
//                       sessions collector to merge onto the ctl registry rows
//
// It attaches to the WsLayer instance from the outside (it overrides
// `onMessage` for term.* and delegates everything else to the original), so
// ws.js keeps its shape and its stub, and a server built without a runner
// behaves exactly as before.
//
// The framing decoder is a local copy rather than an import from
// runner/src/protocol.js on purpose: a release that shipped without a runner
// tree (build.sh warns and continues) must still start the server.

import net from "node:net";
import { EventEmitter } from "node:events";

export const RUNNER_PROTOCOL = 1;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
// runner/src/protocol.js ERR.notTerm, copied for the same reason as the decoder.
const ERR_NOT_TERM = "not a console terminal";

/** Newline-delimited JSON reader. */
function lineReader(onLine, onError) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
    for (;;) {
      const i = buf.indexOf(0x0a);
      if (i < 0) break;
      const line = buf.subarray(0, i);
      buf = buf.subarray(i + 1);
      if (!line.length) continue;
      try {
        const obj = JSON.parse(line.toString("utf8"));
        if (obj && typeof obj === "object") onLine(obj);
      } catch {
        onError("bad json from the runner");
      }
    }
    if (buf.length > MAX_LINE_BYTES) {
      buf = Buffer.alloc(0);
      onError("runner sent an overlong line");
    }
  };
}

export class RunnerError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : String(code));
    this.code = String(code);
    this.detail = detail || null;
  }
}

/**
 * A reconnecting client. It is always "trying": start() connects, every drop
 * schedules another attempt with backoff, and requests made while down fail
 * fast with `runner not connected` instead of queueing forever.
 *
 * Events: ready {release, state, sessions} | close {reason} | mismatch
 *         {runnerProtocol} | data {sid, data} | exit {sid, code, signal}
 */
export class RunnerClient extends EventEmitter {
  /**
   * @param {{socketPath: string, protocol?: number, log?: Function, connect?: Function,
   *          backoffMs?: number[]|Function, requestTimeoutMs?: number, mismatchDelayMs?: number}} o
   */
  constructor(o) {
    super();
    this.socketPath = o.socketPath;
    this.protocol = o.protocol || RUNNER_PROTOCOL;
    this.log = o.log || (() => {});
    this.connectFn = o.connect || ((p) => net.connect(p));
    this.requestTimeoutMs = o.requestTimeoutMs || 15000;
    this.mismatchDelayMs = o.mismatchDelayMs || 30000;
    const b = o.backoffMs;
    this.backoffFor =
      typeof b === "function"
        ? b
        : Array.isArray(b)
          ? (n) => b[Math.min(n, b.length - 1)]
          : (n) => Math.min(250 * 2 ** n, 10000);

    this.socket = null;
    this.connected = false;
    this.state = null; // "serving" | "draining"
    this.release = null;
    this.updatePending = false;
    this.attempts = 0;
    this.stopped = true;
    this.timer = null;
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function, timer: any}>} */
    this.pending = new Map();
    this.lastSessions = [];
  }

  start() {
    this.stopped = false;
    this.connect();
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.failPending("runner client stopped");
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        /* already gone */
      }
    }
    this.socket = null;
    this.connected = false;
  }

  connect() {
    if (this.stopped || this.socket) return;
    let sock;
    try {
      sock = this.connectFn(this.socketPath);
    } catch (e) {
      this.scheduleReconnect(`connect failed: ${e && e.message}`);
      return;
    }
    this.socket = sock;
    const read = lineReader(
      (obj) => this.onLine(obj),
      (reason) => {
        this.log(reason);
        try {
          sock.destroy();
        } catch {
          /* already gone */
        }
      },
    );
    let greeted = false;
    const greet = () => {
      if (greeted || this.socket !== sock) return;
      greeted = true;
      this.hello();
    };
    sock.on("data", read);
    sock.on("connect", greet);
    // net.connect sets `connecting` until the handshake lands. A duplex handed
    // in by a test (or an already-open fd) never emits "connect", so greet on
    // the next tick instead of waiting forever.
    if (sock.connecting !== true) setImmediate(greet);
    sock.on("error", (e) => this.log(`runner socket error: ${e && e.message}`));
    sock.on("close", () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.socket = null;
      this.failPending("runner disconnected");
      if (wasConnected) this.emit("close", { reason: "socket closed" });
      this.scheduleReconnect("socket closed");
    });
  }

  async hello() {
    try {
      const r = await this.send("hello", { protocol: this.protocol });
      this.connected = true;
      this.attempts = 0;
      this.updatePending = false;
      this.state = r.state || "serving";
      this.release = r.release || null;
      this.lastSessions = Array.isArray(r.sessions) ? r.sessions : [];
      this.emit("ready", { release: this.release, state: this.state, sessions: this.lastSessions });
    } catch (e) {
      if (e && e.code === "protocol") {
        // The runner is never restarted by activation, so an older runner and
        // a newer console is a normal state, not a fault. Back off hard and
        // let the console show "runner update pending".
        this.updatePending = true;
        this.attempts = 99;
        this.emit("mismatch", { detail: e.detail || null });
        this.log(`runner protocol mismatch (${e.detail || "unknown"}); update pending`);
      }
      if (this.socket) {
        try {
          this.socket.destroy();
        } catch {
          /* already gone */
        }
      }
    }
  }

  scheduleReconnect(reason) {
    if (this.stopped || this.timer) return;
    const wait = this.updatePending ? this.mismatchDelayMs : this.backoffFor(this.attempts);
    this.attempts += 1;
    this.log(`runner link down (${reason}); retrying in ${wait} ms`);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, wait);
    if (this.timer.unref) this.timer.unref();
  }

  failPending(reason) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RunnerError("runner not connected", reason));
    }
    this.pending.clear();
  }

  /** Low level: write a request even before the handshake finished. */
  send(op, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.socket.writable) {
        reject(new RunnerError("runner not connected", "no socket"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RunnerError("runner timeout", op));
      }, this.requestTimeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(JSON.stringify({ id, op, ...payload }) + "\n");
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new RunnerError("runner not connected", String(e && e.message)));
      }
    });
  }

  /** Normal path: refuses before the handshake so callers see one error type. */
  request(op, payload = {}) {
    if (!this.connected) return Promise.reject(new RunnerError("runner not connected", this.socketPath));
    return this.send(op, payload);
  }

  onLine(obj) {
    if (obj.id !== undefined) {
      const p = this.pending.get(obj.id);
      if (!p) return;
      this.pending.delete(obj.id);
      clearTimeout(p.timer);
      if (obj.ok) p.resolve(obj);
      else p.reject(new RunnerError(obj.error || "runner error", obj.detail || null));
      return;
    }
    // Events carry sid and no id. `event` is the discriminator; the fallback
    // keeps working if a runner omits it.
    const ev = obj.event || (obj.data !== undefined ? "data" : obj.code !== undefined ? "exit" : null);
    if (ev === "data") this.emit("data", { sid: String(obj.sid || ""), data: String(obj.data || "") });
    else if (ev === "exit")
      this.emit("exit", {
        sid: String(obj.sid || ""),
        code: obj.code === undefined ? null : obj.code,
        signal: obj.signal || null,
        snoozed: obj.snoozed === true,
      });
    else if (ev === "size") this.emit("size", { sid: String(obj.sid || ""), cols: Number(obj.cols) || 0, rows: Number(obj.rows) || 0 });
    // Capri close events (proposal 19): the runner broadcasts these to every
    // console connection; the server turns them into alerts and a status refresh.
    else if (ev === "meta.reconcile") this.emit("meta.reconcile", obj);
    else if (ev === "meta.integrity") this.emit("meta.integrity", obj);
  }

  /** Spawn a session through the runner; resolves the reply ({sid}). */
  spawn(payload) {
    return this.request("spawn", payload);
  }
  /** Kill a session the RUNNER owns. A registry session goes through ctl instead,
   *  which also tears down its tmux pane and closes the bookkeeping. */
  kill(sid, signal) {
    return this.request("kill", signal ? { sid, signal } : { sid });
  }
  /** Capri: mint a one-start capability (the runner refuses meta spawn without it). */
  metaCapability() {
    return this.request("meta.capability");
  }
  /** Capri: the runner's view of the meta session (enabled, live, last close). */
  metaStatus() {
    return this.request("meta.status");
  }

  /** Refresh and cache the session list (the collector calls this). */
  async list() {
    const r = await this.request("list");
    this.lastSessions = Array.isArray(r.sessions) ? r.sessions : [];
    return this.lastSessions;
  }
}

/**
 * Runner list entries -> the terminal half of a Session, for the sessions
 * collector to merge onto the ctl registry rows it already builds.
 *
 * Merge key: `id` for pty sessions (the runner's sid, which is what the
 * console spawned through the runner), `pane` for tmux ones (the registry row
 * carries the pane in `tmux_window`; the runner only knows the pane id).
 * Nothing here overwrites a kind or a state: the registry stays the source of
 * truth for those, and this adds what only the runner knows.
 *
 * @param {any[]} list
 * @returns {{id: string, pane: string|null, runner: "pty"|"tmux", attachable: boolean,
 *            writable: boolean, alive: boolean, exitCode: number|null, kind: string|null,
 *            rig: string|null, bead: string|null, startedAt: string|null, log: string|null, snoozedUntil: string|null}[]}
 */
export function sessionsFromRunner(list) {
  const rows = Array.isArray(list) ? list : [];
  return rows
    .filter((e) => e && e.sid)
    .map((e) => {
      const kind = String(e.kind || "");
      const alive = Boolean(e.alive);
      const snoozedUntil = typeof e.snoozedUntil === "string" && Number.isFinite(Date.parse(e.snoozedUntil)) ? e.snoozedUntil : null;
      return {
        id: String(e.sid),
        pane: kind === "tmux" ? String(e.sid) : null,
        runner: kind === "tmux" ? "tmux" : "pty",
        // A dead session is still worth opening for its replay until the
        // runner reaps it, which is why attachable does not require alive.
        // A snoozed console terminal has no PTY at all until it wakes.
        attachable: !snoozedUntil,
        writable: Boolean(e.writable) && alive,
        snoozedUntil,
        alive,
        exitCode: e.exitCode === undefined ? null : e.exitCode,
        kind: kind === "worker" || kind === "interactive" || kind === "meta" ? kind : null,
        rig: e.rig || null,
        bead: e.bead || null,
        startedAt: e.startedAt || null,
        log: e.log || null,
      };
    });
}

/**
 * Wire the browser's term.* messages to the runner.
 *
 * @param {{ws: any, runner: RunnerClient, sessions?: any, log?: Function}} o
 *   ws       the WsLayer instance (not modified in place beyond onMessage)
 *   runner   a RunnerClient
 *   sessions a session lookup: a function (sid) => record, an array of Session
 *            objects, or a Map. Used only to refuse input early for a
 *            non-writable session; the runner is the authority.
 * @returns {{stop: Function}}
 */
export function attachTermHandlers(o) {
  const ws = o.ws;
  const runner = o.runner;
  const log = o.log || (() => {});
  const lookup = makeLookup(o.sessions);
  // A second, awaited lookup for when the fast one misses. The sessions cache is
  // empty for the first few seconds after a console restart, and a miss must not
  // be read as "not the meta session" (see meta() below).
  const lookupFresh = o.sessionsFresh || null;
  const passkey = o.passkey || null;
  const connKeyOf = o.connKey || (() => "");
  const isMeta = o.isMeta || (() => false);
  // Told of every human keystroke batch the runner accepted (Capri, hq-ymxzt.14:
  // a lone Enter or Ctrl-C there resets an uncertain say lane).
  const onInput = o.onInput || (() => {});
  // Proposal 31: only the explicit boolean false relaxes the attach gate, so a
  // caller that never heard of the flag keeps today's passkey requirement.
  const requirePasskey = o.requirePasskey !== false;

  /** sid -> Set<socket> */
  const bySid = new Map();
  /** socket -> Set<sid> */
  const bySocket = new Map();
  // Sockets whose close handler is already installed. A browser that attaches,
  // detaches and attaches again must not stack listeners.
  const hooked = new WeakSet();

  function register(sock, sid) {
    let socks = bySid.get(sid);
    if (!socks) bySid.set(sid, (socks = new Set()));
    socks.add(sock);
    let sids = bySocket.get(sock);
    if (!sids) bySocket.set(sock, (sids = new Set()));
    if (!hooked.has(sock)) {
      hooked.add(sock);
      sock.on("close", () => forgetSocket(sock));
      sock.on("error", () => forgetSocket(sock));
    }
    sids.add(sid);
    return socks.size;
  }

  function unregister(sock, sid) {
    const socks = bySid.get(sid);
    if (socks) {
      socks.delete(sock);
      if (!socks.size) bySid.delete(sid);
    }
    const sids = bySocket.get(sock);
    if (sids) {
      sids.delete(sid);
      if (!sids.size) bySocket.delete(sock);
    }
    return socks ? socks.size : 0;
  }

  // Every browser attach took one reference from the runner, so every browser
  // that goes away returns exactly one, whether it detached politely or its
  // socket simply died.
  function forgetSocket(sock) {
    const sids = bySocket.get(sock);
    if (!sids) return;
    for (const sid of [...sids]) {
      unregister(sock, sid);
      runner.request("detach", { sid }).catch(() => {});
    }
    bySocket.delete(sock);
  }

  const err = (sock, sid, message) => ws.sendTo(sock, { t: "term.error", sid, error: message });

  /** Does THIS connection currently hold an attachment to this sid? */
  const holdsAttachment = (sock, sid) => {
    const sids = bySocket.get(sock);
    return Boolean(sids && sids.has(sid));
  };

  /**
   * Is this sid the uncaged meta terminal? Three answers, and the third is the
   * one that matters: `null` means we do not know, and not knowing is a refusal.
   *
   * The old code asked a cache and read a miss as "no". Two windows made that
   * wrong: a console restart leaves the authoritative set empty while the runner
   * keeps the session alive, and a failed `runner.list()` is swallowed by the
   * sessions collector, which then caches rows with the Capri row missing. In
   * both, a miss meant an attach to the most privileged session on the box
   * skipped the passkey entirely. So a miss now costs one awaited refresh, and
   * a sid still unaccounted for afterwards is refused rather than served.
   */
  async function meta(sid) {
    if (isMeta(sid)) return { meta: true, rec: lookup(sid) };
    let rec = lookup(sid);
    if (!rec && lookupFresh) {
      try {
        rec = (await lookupFresh(sid)) || null;
      } catch {
        rec = null;
      }
      if (isMeta(sid)) return { meta: true, rec };
    }
    if (!rec) return { meta: null, rec: null };
    return { meta: rec.kind === "meta", rec };
  }

  /**
   * term.redraw (2026-10-20): the pane's Redraw button, and a click into a pane
   * that did not have focus. Only a connection that holds an attachment may ask,
   * and the runner refuses anything but a console terminal. It is a hint, never
   * a state change, so every refusal is silent: a term.error would put the pane
   * into its error state over a redraw that simply did not apply.
   */
  async function onRedraw(sock, sid) {
    if (!sid || !runner.connected || !holdsAttachment(sock, sid)) return;
    try {
      await runner.request("term.redraw", { sid });
    } catch (e) {
      const code = (e && e.code) || "runner error";
      if (code !== ERR_NOT_TERM) log(`term.redraw for ${sid} failed: ${code}`);
    }
  }

  async function onTerm(sock, msg) {
    const sid = String(msg.sid || "");
    if (msg.t === "term.redraw") return onRedraw(sock, sid);
    if (!sid) return err(sock, "", "no session id");
    if (!runner.connected) return err(sock, sid, runner.updatePending ? "runner update pending" : "runner not connected");
    const seen = await meta(sid);
    if (seen.meta === null) return err(sock, sid, "unknown session");
    const rec = seen.rec;
    // An output-only session answers with WHY it refuses, before the attachment
    // rule below turns every refusal into the same sentence.
    if (msg.t === "term.input" && rec && rec.writable === false) return err(sock, sid, "read-only");
    // Writing to a terminal requires an attachment held by THIS connection, and
    // for Capri that attachment is the passkey: it could only have been made by
    // spending an assertion. Before this, `term.input` reached the uncaged PTY
    // with no capability and without ever attaching, so the gate protected only
    // the starting of the session, not the use of it.
    if ((msg.t === "term.input" || msg.t === "term.resize") && !holdsAttachment(sock, sid)) {
      return err(sock, sid, "not attached");
    }
    try {
      switch (msg.t) {
        case "term.attach": {
          if (rec && rec.attachable === false) return err(sock, sid, "session is not attachable");
          // Capri: attaching to the meta session needs a fresh passkey capability,
          // bound to this connection and spent here (one assertion per attach).
          // With requirePasskey off (proposal 31), holding an authenticated console
          // connection to this tailnet-only origin is the gate instead.
          if (seen.meta && requirePasskey) {
            if (!passkey || !passkey.spendCapability(msg.capability, connKeyOf(sock))) {
              return err(sock, sid, "passkey required");
            }
          }
          // Re-attaching the same browser to the same session is a refresh,
          // not a second viewer: release the old reference first so the
          // runner's attacher count stays honest.
          const sids = bySocket.get(sock);
          if (sids && sids.has(sid)) {
            unregister(sock, sid);
            await runner.request("detach", { sid }).catch(() => {});
          }
          // A busy session's runner can land the attach reply and the first
          // data/exit event in one TCP read: the decoder resolves the reply and
          // emits the event in the same synchronous loop, before this
          // continuation registers the socket. Hold that sid's events until
          // term.open is out, then replay them in order.
          const held = [];
          const holdData = (ev) => {
            if (ev.sid === sid) held.push({ t: "term.data", sid, data: ev.data });
          };
          const holdExit = (ev) => {
            if (ev.sid === sid) held.push({ t: "term.exit", sid, code: ev.code });
          };
          // A size change (another view attaching) can land in the same read too.
          const holdSize = (ev) => {
            if (ev.sid === sid && ev.cols > 0 && ev.rows > 0) held.push({ t: "term.size", sid, cols: ev.cols, rows: ev.rows });
          };
          runner.on("data", holdData);
          runner.on("exit", holdExit);
          runner.on("size", holdSize);
          let r;
          try {
            r = await runner.request("attach", { sid, cols: num(msg.cols, 80), rows: num(msg.rows, 24) });
            register(sock, sid);
          } finally {
            runner.off("data", holdData);
            runner.off("exit", holdExit);
            runner.off("size", holdSize);
          }
          ws.sendTo(sock, {
            t: "term.open",
            sid,
            replay: String(r.replay || ""),
            cols: num(r.cols, 80),
            rows: num(r.rows, 24),
            writable: Boolean(r.writable),
          });
          for (const frame of held) ws.sendTo(sock, frame);
          return;
        }
        case "term.detach": {
          const sids = bySocket.get(sock);
          // Only a client that attached may release a reference.
          if (!sids || !sids.has(sid)) return;
          unregister(sock, sid);
          await runner.request("detach", { sid });
          return;
        }
        case "term.input": {
          // Workers are output only; the runner refuses too, this just saves a
          // round trip and gives the same error either way.
          if (rec && rec.writable === false) return err(sock, sid, "read-only");
          const data = String(msg.data || "");
          await runner.request("input", { sid, data });
          try {
            onInput(sid, data);
          } catch (e) {
            log(`term.input hook: ${String(e && e.message)}`);
          }
          return;
        }
        case "term.resize": {
          await runner.request("resize", { sid, cols: num(msg.cols, 80), rows: num(msg.rows, 24) });
          return;
        }
        default:
          return;
      }
    } catch (e) {
      const code = (e && e.code) || "runner error";
      if (code !== "read-only") log(`term ${msg.t} for ${sid} failed: ${code}`);
      return err(sock, sid, String(code));
    }
  }

  // Intercept only term.*; everything else keeps going to the original handler.
  const original = ws.onMessage.bind(ws);
  ws.onMessage = (sock, raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== "string" || !msg.t.startsWith("term.")) return original(sock, raw);
    // Returned, not dropped: the resolution step below can await a refresh, and
    // a test (or any caller that wants to know when the verb finished) needs
    // something to wait on. The socket path ignores it exactly as before.
    return onTerm(sock, msg).catch((e) => log(`term handler crashed: ${e && e.message}`));
  };

  const onData = (ev) => {
    const socks = bySid.get(ev.sid);
    if (!socks) return;
    for (const sock of socks) ws.sendTo(sock, { t: "term.data", sid: ev.sid, data: ev.data });
  };
  const onExit = (ev) => {
    const socks = bySid.get(ev.sid);
    if (!socks) return;
    for (const sock of socks) ws.sendTo(sock, { t: "term.exit", sid: ev.sid, code: ev.code });
  };
  const onSize = (ev) => {
    const socks = bySid.get(ev.sid);
    if (!socks || !(ev.cols > 0) || !(ev.rows > 0)) return;
    for (const sock of socks) ws.sendTo(sock, { t: "term.size", sid: ev.sid, cols: ev.cols, rows: ev.rows });
  };
  const onClose = () => {
    for (const [sid, socks] of bySid) {
      for (const sock of socks) err(sock, sid, "runner not connected");
    }
    bySid.clear();
    bySocket.clear();
  };
  runner.on("data", onData);
  runner.on("exit", onExit);
  runner.on("size", onSize);
  runner.on("close", onClose);

  return {
    get attachments() {
      return bySid.size;
    },
    /** Does ANY connection currently hold an attachment to this sid? The
     *  meta-inject consumer gates delivery on this: an attached (passkey) tab
     *  is the proof of presence that authorizes typing into Capri. */
    hasAttachment(sid) {
      const socks = bySid.get(String(sid));
      return Boolean(socks && socks.size);
    },
    /** Send a message to every connection attached to this sid. Used to push a
     *  route-3 draft banner to the open Capri tab (proposal 25); the server
     *  never writes the PTY itself, the tab commits on the owner's click. */
    notifyAttached(sid, msg) {
      const socks = bySid.get(String(sid));
      if (!socks) return 0;
      let n = 0;
      for (const sock of socks) { ws.sendTo(sock, msg); n++; }
      return n;
    },
    stop() {
      runner.off("data", onData);
      runner.off("exit", onExit);
      runner.off("close", onClose);
      ws.onMessage = original;
      bySid.clear();
      bySocket.clear();
    },
  };
}

function makeLookup(sessions) {
  if (typeof sessions === "function") return (sid) => sessions(sid) || null;
  if (sessions && typeof sessions.get === "function") return (sid) => sessions.get(sid) || null;
  if (Array.isArray(sessions)) return (sid) => sessions.find((s) => s && String(s.id) === sid) || null;
  if (sessions && typeof sessions === "object") return (sid) => sessions[sid] || null;
  return () => null;
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : d;
}
