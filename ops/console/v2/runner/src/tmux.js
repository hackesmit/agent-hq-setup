// The tmux adapter: attach to a pane that spawn.sh created, without owning it.
//
// Everything tmux happens through the owner wrapper (the tmux server socket
// belongs to owner and hqconsole cannot touch it):
//   tmux-list                 one line per pane, tab separated
//   tmux-capture <pane>       screen plus scrollback, the attach seed
//   tmux-pipe <pane> <fifo>   pipe-pane -o into a FIFO the RUNNER created
//   tmux-unpipe <pane>        stop the pipe
//   tmux-send <pane>          send-keys -l with bytes read from stdin
//
// The FIFO is created by the runner in a runner-owned directory and only then
// handed to the wrapper, which refuses anything that is not already a FIFO
// under an allowed root. Doing it the other way round (owner creates it)
// would let a compromised owner process swap the path for a symlink and make
// the runner open a file as hqconsole.
//
// Pane death is not observable through the pipe (a dead pane simply stops
// producing), so the adapter polls tmux-list every RUNNER_TMUX_POLL_MS.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { Ring } from "./ring.js";
import { RunnerError, ERR } from "./protocol.js";

export const PANE_RE = /^%[0-9]+$/;

/** tmux-list output: pane, session, window, index, dead, cmd, width, height, title. */
export function parsePanes(stdout) {
  const out = [];
  for (const line of String(stdout || "").split("\n")) {
    if (!line.trim()) continue;
    const f = line.split("\t");
    if (!f[0] || !PANE_RE.test(f[0])) continue;
    out.push({
      pane: f[0],
      session: f[1] || "",
      window: f[2] || "",
      index: f[3] || "",
      dead: f[4] === "1",
      cmd: f[5] || "",
      cols: Number(f[6]) || 80,
      rows: Number(f[7]) || 24,
      title: f[8] || "",
    });
  }
  return out;
}

export class TmuxSession extends EventEmitter {
  /**
   * @param {{cfg: any, wrapper: any, sid: string, writable?: boolean, rig?: string|null,
   *          bead?: string|null, label?: string|null, log?: Function, exec?: Function}} o
   */
  constructor(o) {
    super();
    this.cfg = o.cfg;
    this.wrapper = o.wrapper;
    this.sid = o.sid;
    this.pane = o.sid;
    this.kind = "tmux";
    this.argv = [];
    this.argv0 = "tmux";
    this.cwd = null;
    this.rig = o.rig || null;
    this.bead = o.bead || null;
    this.label = o.label || null;
    this.writable = Boolean(o.writable);
    this.log = o.log || (() => {});
    this.exec = o.exec || execFile;
    this.ring = new Ring(this.cfg.ringBytes);
    this.startedAt = new Date().toISOString();
    this.alive = false;
    this.exitCode = null;
    this.exitSignal = null;
    this.endedBy = null;
    this.pid = null;
    this.cols = 80;
    this.rows = 24;
    this.logPath = null;
    this.fifo = null;
    this.fd = null;
    this.stream = null;
    this.poll = null;
  }

  async listPanes() {
    const r = await this.wrapper.call("tmux-list");
    if (r.code !== 0) throw new RunnerError("tmux unavailable", tail(r.stderr || r.stdout));
    return parsePanes(r.stdout);
  }

  async start() {
    if (!PANE_RE.test(this.pane)) throw new RunnerError("bad pane id", this.pane);
    const panes = await this.listPanes();
    const me = panes.find((p) => p.pane === this.pane);
    if (!me || me.dead) throw new RunnerError(ERR.noSession, `pane ${this.pane} is not alive`);
    this.cols = me.cols;
    this.rows = me.rows;
    this.argv0 = me.cmd || "tmux";
    this.label = this.label || `${me.session}:${me.window}.${me.index}`;
    this.alive = true;
    const cap = await this.wrapper.call("tmux-capture", [this.pane]);
    if (cap.code === 0 && cap.stdout) this.ring.push(cap.stdout);
    this.startPoll();
    return this;
  }

  startPoll() {
    if (this.poll) return;
    this.poll = setInterval(() => {
      this.checkAlive().catch((e) => this.log(`tmux poll failed: ${e && e.message}`));
    }, this.cfg.tmuxPollMs);
    if (this.poll.unref) this.poll.unref();
  }

  async checkAlive() {
    if (!this.alive) return;
    const panes = await this.listPanes().catch(() => null);
    if (!panes) return; // a transient tmux hiccup is not a death certificate
    const me = panes.find((p) => p.pane === this.pane);
    if (me && !me.dead) {
      this.cols = me.cols;
      this.rows = me.rows;
      return;
    }
    this.endedBy = "pane gone";
    this.onExit({ code: null, signal: null });
  }

  /** First attacher: own the pipe. A second attach reuses this stream. */
  async wake() {
    if (this.stream || !this.alive) return;
    const name = `pane-${this.pane.slice(1)}-${crypto.randomBytes(4).toString("hex")}.fifo`;
    const fifo = path.join(this.cfg.fifoDir, name);
    try {
      checkFifoDir(this.cfg.fifoDir);
      await this.mkfifo(fifo);
    } catch (e) {
      this.log(`could not create the pane FIFO: ${e && e.message}`);
      return;
    }
    try {
      // Open BEFORE asking tmux to pipe: a writer that opens a FIFO with no
      // reader blocks, and pipe-pane's command would hang. O_RDWR also keeps a
      // writer on the pipe at all times, so the read stream never sees EOF
      // between pipe-pane restarts, and O_NONBLOCK keeps the open itself off
      // the thread pool.
      this.fd = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
    } catch (e) {
      this.log(`could not open the pane FIFO: ${e && e.message}`);
      safeUnlink(fifo);
      return;
    }
    const r = await this.wrapper.call("tmux-pipe", [this.pane, fifo]);
    if (r.code !== 0) {
      this.log(`tmux-pipe refused for ${this.pane}: ${tail(r.stderr || r.stdout)}`);
      try {
        fs.closeSync(this.fd);
      } catch {
        /* already closed */
      }
      this.fd = null;
      safeUnlink(fifo);
      return;
    }
    this.fifo = fifo;
    const decoder = new StringDecoder("utf8");
    // A libuv pipe handle, not fs.createReadStream: the fd is O_NONBLOCK, and an
    // fs stream reads it on the thread pool, so the first read that finds the
    // FIFO empty (a pane that is quiet for a moment) failed with EAGAIN and the
    // stream died. The attach then showed the capture-pane seed and never
    // another byte. A net.Socket waits for readability instead. It owns the fd
    // from here on, so idle() must not close it a second time.
    this.stream = new net.Socket({ fd: this.fd, readable: true, writable: false });
    // The runner's own listener keeps the process up; a watched pane alone must not.
    this.stream.unref();
    this.fd = null;
    this.stream.on("data", (chunk) => {
      const s = decoder.write(chunk);
      if (!s) return;
      this.ring.push(s);
      this.emit("data", s);
    });
    this.stream.on("error", (e) => this.log(`pane stream error on ${this.pane}: ${e && e.message}`));
  }

  mkfifo(p) {
    // Node has no mkfifo(2). This runs as the runner's own user in the
    // runner's own directory, so it is not a owner-context action and does
    // not belong behind the wrapper. 0620: we read, the directory's group
    // (owner, inherited through the setgid dir) writes, other gets nothing.
    return new Promise((resolve, reject) => {
      this.exec("mkfifo", ["-m", "0620", p], { timeout: 5000 }, (err) => {
        if (err) reject(new Error(`mkfifo ${p}: ${String(err.message || err).split("\n")[0]}`));
        else resolve();
      });
    });
  }

  /** Last attacher left: stop owning the pane's output. */
  async idle() {
    if (!this.stream && !this.fifo) return;
    if (this.stream) {
      try {
        this.stream.destroy();
      } catch {
        /* already closed */
      }
      this.stream = null;
    }
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* already closed */
      }
      this.fd = null;
    }
    if (this.alive) await this.wrapper.call("tmux-unpipe", [this.pane]);
    if (this.fifo) safeUnlink(this.fifo);
    this.fifo = null;
  }

  async write(data) {
    if (!this.writable) throw new RunnerError(ERR.readOnly);
    if (!this.alive) throw new RunnerError(ERR.noSession, "pane has gone");
    const r = await this.wrapper.call("tmux-send", [this.pane], { input: data });
    if (r.code !== 0) throw new RunnerError("send failed", tail(r.stderr || r.stdout));
  }

  /**
   * A tmux pane is sized by tmux and shared with whatever else is attached.
   * Resizing it from the console would resize the owner's real terminal, so the
   * adapter reports the pane's own geometry and changes nothing.
   */
  resize() {
    return { cols: this.cols, rows: this.rows };
  }

  kill() {
    throw new RunnerError("kill not supported for tmux panes", "use ctl kill or finish.sh");
  }

  onExit(r) {
    if (!this.alive) return;
    this.alive = false;
    this.exitCode = typeof r.code === "number" ? r.code : null;
    this.exitSignal = r.signal || null;
    this.endedBy = this.endedBy || "exit";
    this.emit("exit", { code: this.exitCode, signal: this.exitSignal });
  }

  dispose() {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    return this.idle();
  }

  record() {
    return {
      sid: this.sid,
      kind: "tmux",
      runner: "tmux",
      argv0: this.argv0,
      argv: [],
      cwd: this.cwd,
      rig: this.rig,
      bead: this.bead,
      label: this.label,
      startedAt: this.startedAt,
      alive: this.alive,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      endedBy: this.endedBy,
      writable: this.writable && this.alive,
      pid: null,
      cols: this.cols,
      rows: this.rows,
      log: null,
    };
  }
}

function safeUnlink(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    /* gone already */
  }
}

function tail(s) {
  return String(s || "").split("\n").slice(-3).join(" ").slice(0, 300);
}

/**
 * The pane FIFO directory must be a real directory the runner owns that grants
 * "other" nothing (hq-an7jw.24): a third local account must not traverse to a
 * FIFO or write into it. Provisioning makes it 2710 hqconsole:owner, so each
 * FIFO inherits owner's group. The runner never chmods it: hqconsole is not in
 * owner's group, so Linux would clear the setgid bit on its chmod. A missing
 * directory (dev and tests, where the runner is owner) is created 0700.
 */
export function checkFifoDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    if (!e || e.code !== "EEXIST") throw e;
  }
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`FIFO dir ${dir} is not a directory (symlink or file)`);
  const uid = typeof process.getuid === "function" ? process.getuid() : st.uid;
  if (st.uid !== uid) throw new Error(`FIFO dir ${dir} is owned by uid ${st.uid}, not the runner (${uid})`);
  if (st.mode & 0o007) {
    throw new Error(`FIFO dir ${dir} grants other access (mode ${(st.mode & 0o7777).toString(8)}); want no other bits, e.g. 2710`);
  }
}
