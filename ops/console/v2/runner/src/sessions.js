// PTY-backed sessions: `worker` and `interactive`.
//
// worker      headless job (spawn.sh's `claude -p ...`, or any allowlisted
//             argv). Keyboard is never accepted. Output is streamed to
//             attachers AND appended to <RUNNER_TERM_DIR>/<sid>.log (0640),
//             because a worker's transcript is the audit trail nobody typed
//             into.
// interactive real PTY, keyboard accepted, NEVER written to disk: the stream
//             echoes keystrokes, so a pasted token would land in the file
//             (design section 3).
//
// Both spawn as `owner` by running the wrapper's pty-spawn verb inside the
// PTY: the master fd belongs to the runner (hqconsole), the process belongs to
// owner. That is the whole trust arrangement in one line.

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Ring } from "./ring.js";
import { RunnerError, ERR } from "./protocol.js";

export class PtySession extends EventEmitter {
  /**
   * @param {{cfg: any, sid: string, kind: "worker"|"interactive", argv: string[], cwd: string,
   *          rig?: string|null, bead?: string|null, label?: string|null, cols: number, rows: number,
   *          wantLog?: boolean, factory: any, wrapper: any, env?: Record<string,string>, log?: Function}} o
   */
  constructor(o) {
    super();
    this.cfg = o.cfg;
    this.sid = o.sid;
    this.kind = o.kind;
    this.argv = o.argv.map(String);
    this.argv0 = this.argv[0] || "";
    this.cwd = o.cwd;
    this.rig = o.rig || null;
    this.bead = o.bead || null;
    this.label = o.label || null;
    this.cols = o.cols;
    this.rows = o.rows;
    this.env = o.env || {};
    this.factory = o.factory;
    this.wrapper = o.wrapper;
    this.log = o.log || (() => {});
    this.writable = this.kind === "interactive";
    this.ring = new Ring(this.kind === "interactive" ? this.cfg.interactiveRingBytes : this.cfg.ringBytes);
    this.startedAt = new Date().toISOString();
    this.alive = false;
    this.exitCode = null;
    this.exitSignal = null;
    this.endedBy = null;
    this.pid = null;
    // Only workers get a file. `log:false` on the spawn request turns even
    // that off for a job whose output is sensitive.
    this.logPath =
      this.kind === "worker" && o.wantLog !== false ? path.join(this.cfg.termDir, `${this.sid}.log`) : null;
    this.logFd = null;
    // A persistent console terminal: the PTY runs a tmux CLIENT (wrapper verb
    // term-attach) and the real argv lives in the hqterm tmux server, so this
    // PTY dying (runner restart) does not end the program behind it.
    this.attachSpec = o.attach || null;
    if (o.startedAt) this.startedAt = o.startedAt;
  }

  start() {
    if (this.logPath) this.openLog();
    // TERM is passed through the wrapper explicitly: sudo resets the
    // environment, so an inherited TERM would not survive the boundary and the
    // session would come up with a dumb terminal.
    const { cmd, args } = this.attachSpec
      ? this.wrapper.argvFor(this.attachSpec.verb, this.attachSpec.args || [])
      : this.wrapper.ptyArgv({
      cwd: this.cwd,
      argv: this.argv,
      // Interactive sessions get their own sid as HQ_CONSOLE_SID: `ctl whoami`
      // resolves it where there is no tmux pane, which is what lets the session
      // name its console card and file ctl ask requests with a return
      // address. Workers keep their spawn.sh-issued identity instead.
      env: {
        TERM: "xterm-256color",
        ...(this.kind === "interactive" ? { HQ_CONSOLE_SID: this.sid } : {}),
        ...this.env,
      },
    });
    let handle;
    try {
      handle = this.factory.spawn({
        file: cmd,
        args,
        // With the wrapper in play the working directory is set by pty-spawn
        // as owner; the runner's own cwd for the child is deliberately "/"
        // because hqconsole may not be able to enter a worktree.
        cwd: this.cfg.wrapperPath ? "/" : this.cwd,
        env: this.childEnv(),
        cols: this.cols,
        rows: this.rows,
        name: "xterm-256color",
      });
    } catch (e) {
      this.closeLog();
      throw new RunnerError(ERR.ptyUnavailable, String((e && e.message) || e));
    }
    this.handle = handle;
    this.pid = handle.pid || null;
    this.alive = true;
    handle.onData((d) => this.onData(String(d)));
    handle.onExit((r) => this.onExit(r));
    return this;
  }

  childEnv() {
    // The wrapper resets PATH and HOME itself, so this is only what a terminal
    // needs before the wrapper takes over.
    return {
      TERM: "xterm-256color",
      LANG: process.env.LANG || "C.UTF-8",
      HQ_ROOT: this.cfg.hqRoot,
      ...(this.kind === "interactive" ? { HQ_CONSOLE_SID: this.sid } : {}),
      ...(this.cfg.wrapperPath ? {} : { PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || "/tmp" }),
    };
  }

  openLog() {
    try {
      fs.mkdirSync(this.cfg.termDir, { recursive: true, mode: 0o750 });
      this.logFd = fs.openSync(this.logPath, "a", 0o640);
    } catch (e) {
      this.log(`worker log unavailable (${this.logPath}): ${e && e.message}`);
      this.logFd = null;
      this.logPath = null;
    }
  }

  closeLog() {
    if (this.logFd === null) return;
    try {
      fs.closeSync(this.logFd);
    } catch {
      /* already gone */
    }
    this.logFd = null;
  }

  onData(d) {
    this.ring.push(d);
    if (this.logFd !== null) {
      try {
        fs.writeSync(this.logFd, d);
      } catch (e) {
        this.log(`worker log write failed, dropping the file: ${e && e.message}`);
        this.closeLog();
      }
    }
    this.emit("data", d);
  }

  onExit(r) {
    if (!this.alive) return;
    this.alive = false;
    this.exitCode = typeof r.code === "number" ? r.code : null;
    this.exitSignal = r.signal || null;
    this.endedBy = this.endedBy || "exit";
    this.closeLog();
    this.emit("exit", { code: this.exitCode, signal: this.exitSignal });
  }

  write(data) {
    if (!this.writable) throw new RunnerError(ERR.readOnly);
    if (!this.alive) throw new RunnerError(ERR.noSession, "session has exited");
    this.handle.write(data);
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    if (this.alive) {
      try {
        this.handle.resize(cols, rows);
      } catch (e) {
        this.log(`resize failed for ${this.sid}: ${e && e.message}`);
      }
    }
    return { cols, rows };
  }

  kill(signal) {
    if (!this.alive) return;
    this.endedBy = "kill";
    try {
      this.handle.kill(signal || "SIGTERM");
    } catch (e) {
      this.log(`kill failed for ${this.sid}: ${e && e.message}`);
    }
  }

  /** No lazy stream: a PTY is always being read, or its output is lost. */
  wake() {}
  idle() {}

  dispose() {
    this.closeLog();
  }

  record() {
    return {
      sid: this.sid,
      kind: this.kind,
      runner: "pty",
      argv0: this.argv0,
      argv: this.argv,
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
      pid: this.pid,
      cols: this.cols,
      rows: this.rows,
      log: this.logPath,
      persistent: Boolean(this.attachSpec),
    };
  }
}
