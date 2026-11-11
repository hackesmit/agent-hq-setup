// The unix socket layer: framing, request dispatch, event fan-out.
//
// Listening is either systemd socket activation (LISTEN_FDS=1 with LISTEN_PID
// naming us, the listening socket is fd 3) or a plain bind of RUNNER_SOCKET,
// which is what tests and a dev run use. The socket is 0660 hqconsole so a
// worker running as owner cannot open it at all: that is the trust boundary,
// not an ACL inside the protocol.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createLineDecoder, encodeLine, RunnerError, ERR } from "./protocol.js";

const SD_LISTEN_FDS_START = 3;

export class RunnerServer {
  /** @param {{cfg: any, manager: any, log?: Function}} o */
  constructor(o) {
    this.cfg = o.cfg;
    this.manager = o.manager;
    this.log = o.log || (() => {});
    /** @type {Set<{socket: any, attached: Set<string>}>} */
    this.conns = new Set();
    this.server = net.createServer((s) => this.handleConn(s));
    this.server.on("error", (e) => this.log(`socket server error: ${e && e.message}`));
    this.boundPath = null;

    this.onData = (ev) => this.fanout(ev.sid, { event: "data", sid: ev.sid, data: ev.data });
    this.onSize = (ev) => this.fanout(ev.sid, { event: "size", sid: ev.sid, cols: ev.cols, rows: ev.rows });
    this.onExit = (ev) => this.fanout(ev.sid, { event: "exit", sid: ev.sid, code: ev.code, signal: ev.signal, ...(ev.snoozed ? { snoozed: true } : {}) });
    this.onRemoved = (ev) => {
      for (const c of this.conns) c.attached.delete(ev.sid);
    };
    this.manager.on("data", this.onData);
    this.manager.on("exit", this.onExit);
    this.manager.on("size", this.onSize);
    this.manager.on("removed", this.onRemoved);
    // Capri close events go to every console connection, attached or not: the
    // console turns them into cards and alerts for whoever is looking.
    this.onMetaReconcile = (ev) => this.broadcast({ event: "meta.reconcile", ...ev });
    this.onMetaIntegrity = (ev) => this.broadcast({ event: "meta.integrity", ...ev });
    this.manager.on("meta.reconcile", this.onMetaReconcile);
    this.manager.on("meta.integrity", this.onMetaIntegrity);
  }

  /** @returns {Promise<{mode: "systemd"|"path", path: string|null}>} */
  listen() {
    return new Promise((resolve, reject) => {
      const useFd = this.cfg.listenFds >= 1 && (!this.cfg.listenPid || this.cfg.listenPid === process.pid);
      const done = (info) => {
        this.server.off("error", onErr);
        resolve(info);
      };
      const onErr = (e) => {
        this.server.off("error", onErr);
        reject(e);
      };
      this.server.once("error", onErr);
      if (useFd) {
        this.server.listen({ fd: SD_LISTEN_FDS_START }, () => done({ mode: "systemd", path: null }));
        return;
      }
      const p = this.cfg.socketPath;
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o750 });
      } catch {
        /* already there */
      }
      // A leftover socket file from a killed runner would make bind fail. It
      // is safe to remove only because nothing else ever binds this path.
      try {
        const st = fs.statSync(p);
        if (st.isSocket()) fs.unlinkSync(p);
      } catch {
        /* nothing to clear */
      }
      this.server.listen(p, () => {
        try {
          fs.chmodSync(p, 0o660);
        } catch (e) {
          this.log(`could not chmod the socket: ${e && e.message}`);
        }
        this.boundPath = p;
        done({ mode: "path", path: p });
      });
    });
  }

  handleConn(socket) {
    // attached is a COUNT per sid, not a set: one console connection carries
    // every browser, so N browsers on one session are N attachers and a lost
    // connection has to release all N or a tmux pipe would never stop.
    const conn = { socket, attached: new Map(), dropped: 0 };
    this.conns.add(conn);
    socket.setNoDelay(true);
    const decoder = createLineDecoder({
      onLine: (msg) => {
        this.dispatch(conn, msg).catch((e) => this.log(`dispatch crashed: ${e && e.message}`));
      },
      onError: (reason) => {
        this.log(`bad frame from a client (${reason}), closing`);
        try {
          socket.destroy();
        } catch {
          /* already gone */
        }
      },
    });
    socket.on("data", (chunk) => decoder.push(chunk));
    socket.on("error", () => {
      /* close follows */
    });
    socket.on("close", () => {
      this.conns.delete(conn);
      for (const [sid, n] of conn.attached) {
        for (let i = 0; i < n; i++) this.manager.detach(sid).catch(() => {});
      }
      conn.attached.clear();
    });
  }

  send(conn, obj) {
    if (!conn.socket.writable) return;
    try {
      conn.socket.write(encodeLine(obj));
    } catch {
      /* a dead peer is cleaned up by its close handler */
    }
  }

  broadcast(obj) {
    for (const conn of this.conns) {
      if (!conn.hello) continue;
      if (conn.socket.writableLength > 8 * 1024 * 1024) continue;
      this.send(conn, obj);
    }
  }
  fanout(sid, obj) {
    for (const conn of this.conns) {
      if (!conn.attached.has(sid)) continue;
      // A console that stopped reading must not turn a chatty session into
      // unbounded memory here. The ring buffer still has the output, so the
      // next attach replays what these dropped frames carried.
      if (conn.socket.writableLength > 8 * 1024 * 1024) {
        conn.dropped += 1;
        if (conn.dropped % 100 === 1) this.log(`console is not draining the socket; dropped ${conn.dropped} frame(s)`);
        continue;
      }
      this.send(conn, obj);
    }
  }

  /**
   * The runner's own rule for Capri: no input, resize or kill on a meta session
   * over a connection that never attached it.
   *
   * Be precise about what this is worth, because it is easy to claim more. Every
   * browser is multiplexed through ONE console-to-runner connection, so what the
   * runner can prove is that SOME client attached, not that this particular
   * browser did. Per-browser enforcement is not available to it without a
   * per-browser runner connection, and a lease relayed by the console would be
   * only as trustworthy as the console relaying it, which is the thing this is
   * meant to backstop in the first place.
   *
   * So: this catches input with no attachment anywhere, which is exactly the hole
   * that existed before (a socket could type into Capri having never attached to
   * anything at all). It does not catch a console defect that confuses two
   * browsers. The same-connection guarantee lives in the console, one layer out.
   */
  requireAttachedForMeta(conn, sid) {
    const s = String(sid === undefined ? "" : sid);
    if (!this.manager.isMeta(s)) return;
    if (!(conn.attached.get(s) > 0)) throw new RunnerError(ERR.metaCapability, "attach first");
  }

  async dispatch(conn, msg) {
    const id = msg.id;
    const op = String(msg.op || "");
    const reply = (payload) => {
      if (id === undefined) return;
      this.send(conn, { id, ok: true, ...payload });
    };
    try {
      switch (op) {
        case "hello": {
          if (Number(msg.protocol) !== this.cfg.protocol) {
            // Never restarted by activation, so a console from a newer release
            // may meet an older runner. It says so and shows "runner update
            // pending" rather than guessing.
            throw new RunnerError(ERR.protocol, `runner speaks ${this.cfg.protocol}`);
          }
          conn.hello = true;
          return reply({
            protocol: this.cfg.protocol,
            release: this.cfg.release,
            state: this.manager.state,
            sessions: this.manager.list(),
            meta: this.manager.metaStatus(),
          });
        }
        case "spawn": {
          const r = await this.manager.spawn(msg);
          return reply(r);
        }
        case "attach": {
          const sid = String(msg.sid);
          const r = await this.manager.attach(msg.sid, msg);
          conn.attached.set(sid, (conn.attached.get(sid) || 0) + 1);
          return reply(r);
        }
        case "detach": {
          const sid = String(msg.sid);
          const n = conn.attached.get(sid) || 0;
          // A detach for something this connection never attached must not
          // release somebody else's reference.
          if (n <= 0) return reply({ detached: false });
          if (n === 1) conn.attached.delete(sid);
          else conn.attached.set(sid, n - 1);
          const r = await this.manager.detach(msg.sid);
          return reply(r);
        }
        case "input": {
          this.requireAttachedForMeta(conn, msg.sid);
          const r = await this.manager.input(msg.sid, msg.data);
          return reply(r);
        }
        case "resize": {
          this.requireAttachedForMeta(conn, msg.sid);
          const r = this.manager.resize(msg.sid, msg.cols, msg.rows);
          return reply(r);
        }
        case "kill": {
          this.requireAttachedForMeta(conn, msg.sid);
          const r = this.manager.kill(msg.sid, msg.signal);
          return reply(r);
        }
        case "term.snooze":
          return reply(await this.manager.snoozeTerm(msg.sid, msg.wakeAt));
        case "term.wake":
          return reply(await this.manager.wakeTerms(msg.sid));
        case "term.redraw":
          return reply(this.manager.redrawTerm(msg.sid));
        case "term.fg":
          return reply(await this.manager.termForeground(msg.sid));
        case "list":
          return reply({ sessions: this.manager.list() });
        case "drain":
          return reply(this.manager.drain());
        case "restart":
          return reply(this.manager.restart());
        case "status":
          return reply(this.manager.status());
        case "meta.capability":
          return reply(this.manager.mintMetaCapability());
        case "meta.status":
          return reply(this.manager.metaStatus());
        default:
          throw new RunnerError("unknown op", op || "(none)");
      }
    } catch (e) {
      if (id === undefined) return;
      const code = e instanceof RunnerError ? e.code : "internal";
      if (!(e instanceof RunnerError)) this.log(`op ${op} failed: ${e && e.message}`);
      this.send(conn, {
        id,
        ok: false,
        error: code,
        detail: e instanceof RunnerError ? e.detail : String((e && e.message) || e).slice(0, 300),
        sid: msg.sid === undefined ? undefined : String(msg.sid),
      });
    }
  }

  close() {
    this.manager.off("data", this.onData);
    this.manager.off("exit", this.onExit);
    this.manager.off("size", this.onSize);
    this.manager.off("removed", this.onRemoved);
    this.manager.off("meta.reconcile", this.onMetaReconcile);
    this.manager.off("meta.integrity", this.onMetaIntegrity);
    for (const conn of this.conns) {
      try {
        conn.socket.destroy();
      } catch {
        /* already gone */
      }
    }
    this.conns.clear();
    return new Promise((resolve) => {
      this.server.close(() => {
        // Only remove a socket file we bound ourselves; the systemd-owned one
        // belongs to the socket unit and must outlive us (that is what makes a
        // spawn during a drain restart queue instead of fail).
        if (this.boundPath) {
          try {
            fs.unlinkSync(this.boundPath);
          } catch {
            /* already gone */
          }
        }
        resolve();
      });
    });
  }
}
