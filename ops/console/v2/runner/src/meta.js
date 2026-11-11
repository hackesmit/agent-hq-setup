// Capri, the meta terminal (proposal 19), runner side.
//
// A meta session is an interactive PTY with extra rules that the RUNNER enforces,
// not the console: a one-use capability minted here must accompany the spawn, the
// wrapper's meta-check must pass, only one may be live, the PTY stream is never
// written to disk, idle and cap timers and the last detach stop the transient scope,
// and closing always reconciles (diff the persistence snapshot, auto-revert what the
// session added, run the integrity check) and records the result. The owner side of
// every step is a verb of spawn-as-owner.sh backed by meta-verbs.py; this file only
// decides when to call which and what to do with the answer.
//
// Design: docs/superpowers/specs/2026-08-17-console-v2-design.md section 3b;
// ops/proposals/19-meta-terminal.md (runner rules, reconciliation); PROTOCOL.md.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PtySession } from "./sessions.js";
import { RunnerError, ERR } from "./protocol.js";

export const MUTATING_TOOLS = Object.freeze(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** One-use start capabilities: the console asks for one, then spends it on spawn. */
export class Capabilities {
  constructor({ ttlMs = 60000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.store = new Map();
  }
  mint() {
    this.sweep();
    const ticket = crypto.randomBytes(32).toString("hex");
    this.store.set(ticket, this.now() + this.ttlMs);
    return { capability: ticket, expiresInS: Math.round(this.ttlMs / 1000) };
  }
  /** Spend a capability. True exactly once per ticket, and only before it expires. */
  spend(ticket) {
    this.sweep();
    const t = String(ticket || "");
    if (!t || !this.store.has(t)) return false;
    this.store.delete(t);
    return true;
  }
  sweep() {
    const now = this.now();
    for (const [t, exp] of this.store) if (exp <= now) this.store.delete(t);
  }
  get size() {
    this.sweep();
    return this.store.size;
  }
}

/** Parse the one JSON object a meta verb prints; a non-JSON answer is a failure. */
export function parseVerb(r, what) {
  if (!r || r.code !== 0) {
    const msg = String((r && (r.stderr || r.stdout)) || "").trim().slice(-400);
    throw new RunnerError(ERR.metaRefused, `${what}: ${msg || `exit ${r && r.code}`}`);
  }
  try {
    const j = JSON.parse(String(r.stdout || "").trim().split("\n").pop());
    if (!j || typeof j !== "object") throw new Error("not an object");
    return j;
  } catch (e) {
    throw new RunnerError(ERR.metaRefused, `${what}: unparseable answer (${e && e.message})`);
  }
}

/**
 * Scopes that hold terminals, never the session's own persistence: the hqterm
 * tmux server and the per-pane scopes tmux creates (tmux-spawn-<uuid>.scope).
 * meta-verbs.py refuses to stop the same names (TERMINAL_SCOPE_RE).
 */
export const TERMINAL_SCOPE_RE = /^(tmux-spawn-[A-Za-z0-9-]+|hq-term-tmux)\.scope$/;
export function isTerminalScope(name) {
  return TERMINAL_SCOPE_RE.test(String(name));
}

/**
 * Diff two meta-snapshot documents into what to auto-revert (did not exist before)
 * and what to show as a Revert / Keep card (existed and changed, or disappeared).
 * Pure: the caller performs the reverts through the wrapper.
 * @returns {{autoRevert: {kind: string, name: string}[], changed: {kind: string, name: string, from: any, to: any, revert: string[]|null}[]}}
 */
export function diffSnapshots(before, after, { ownScope = null } = {}) {
  const b = before || {};
  const a = after || {};
  const autoRevert = [];
  const changed = [];
  const bu = (b.units && b.units.files) || {};
  const au = (a.units && a.units.files) || {};
  for (const [rel, sha] of Object.entries(au)) {
    if (!(rel in bu)) autoRevert.push({ kind: "unit", name: rel });
    else if (bu[rel] !== sha) changed.push({ kind: "unit-file", name: rel, from: bu[rel], to: sha, revert: ["restore", `units/${rel}`] });
  }
  for (const rel of Object.keys(bu)) {
    if (!(rel in au)) changed.push({ kind: "unit-file", name: rel, from: bu[rel], to: null, revert: ["restore", `units/${rel}`] });
  }
  const buf = (b.units && b.units.unitFiles) || {};
  const auf = (a.units && a.units.unitFiles) || {};
  for (const [name, state] of Object.entries(auf)) {
    if (name in buf && buf[name] !== state) changed.push({ kind: "unit-state", name, from: buf[name], to: state, revert: null });
  }
  const bun = (b.units && b.units.units) || {};
  const aun = (a.units && a.units.units) || {};
  for (const [name, state] of Object.entries(aun)) {
    if (ownScope && name === ownScope) continue;
    const active = /^active\//.test(String(state));
    if (!(name in bun)) {
      // A tmux pane scope is a terminal: every pane tmux opens anywhere on the box
      // (a console terminal, a worker, the orchestrator) gets one, so a new one
      // proves nothing about this session, and stopping it kills that terminal
      // (2026-11-04: a restart reconcile stopped two console terminals, hq-4npjr.20).
      // It is carded with no revert; the owner ends a pane from its own terminal.
      if (isTerminalScope(name)) {
        if (active) changed.push({ kind: "unit", name, from: null, to: state, revert: null });
        continue;
      }
      // a unit that did not exist before and is running now was started by the
      // session (systemd-run, or a new unit file already auto-reverted above)
      if (active) autoRevert.push({ kind: "stop", name });
      else changed.push({ kind: "unit", name, from: null, to: state, revert: null });
    } else if (bun[name] !== state) {
      // a unit that existed but was not running before and is running now MAY have
      // been started by the session (systemctl --user start on a disabled unit), or
      // by its own timer, a socket, or another shell of the owner's: two snapshots
      // cannot tell those apart, so it is never auto-stopped. The card carries the
      // one-click stop (meta-revert stop refuses units that were running before), and
      // the owner decides. activating/reloading count as running at snapshot time.
      const wasRunning = /^(active|activating|reloading)\//.test(String(bun[name]));
      changed.push({ kind: "unit", name, from: bun[name], to: state, revert: active && !wasRunning ? ["stop", name] : null });
    }
  }
  // a pre-existing unit whose state row vanished (masked/removed) is surfaced too
  for (const [name, state] of Object.entries(bun)) {
    if (ownScope && name === ownScope) continue;
    if (!(name in aun)) changed.push({ kind: "unit", name, from: state, to: null, revert: null });
  }
  const bc = new Set(((b.crontab && b.crontab.lines) || []).map(String));
  const ac = ((a.crontab && a.crontab.lines) || []).map(String);
  for (const line of ac) if (!bc.has(line)) autoRevert.push({ kind: "cron", name: line });
  for (const line of bc) if (!ac.includes(line)) changed.push({ kind: "cron", name: line, from: line, to: null, revert: null });
  const bat = new Set(((b.at && b.at.lines) || []).map(String));
  for (const line of ((a.at && a.at.lines) || []).map(String)) {
    if (bat.has(line)) continue;
    const job = String(line).trim().split(/\s+/)[0];
    if (/^[0-9]{1,9}$/.test(job)) autoRevert.push({ kind: "at", name: job });
  }
  const bf = (b.files) || {};
  const af = (a.files) || {};
  for (const [rel, sha] of Object.entries(af)) {
    const had = rel in bf && bf[rel] !== null;
    if (!had && sha !== null) {
      if (rel.startsWith(".config/autostart/")) autoRevert.push({ kind: "autostart", name: path.basename(rel) });
      else changed.push({ kind: "file", name: rel, from: null, to: sha, revert: null });
    } else if (had && sha !== bf[rel]) {
      changed.push({ kind: "file", name: rel, from: bf[rel], to: sha, revert: ["restore", `home/${rel}`] });
    }
  }
  for (const [rel, sha] of Object.entries(bf)) {
    if (sha !== null && !(rel in af)) changed.push({ kind: "file", name: rel, from: sha, to: null, revert: ["restore", `home/${rel}`] });
  }
  return { autoRevert, changed };
}

/** The uncaged, prompted, audited session. Output lives in the ring only. */
export class MetaSession extends PtySession {
  /**
   * @param {{cfg: any, sid: string, cols: number, rows: number, factory: any, wrapper: any,
   *          snapshot: any, log?: Function, now?: Function, setTimer?: Function, clearTimer?: Function,
   *          onTimeout: (sid: string, reason: string) => void}} o
   */
  constructor(o) {
    super({ ...o, kind: "meta", argv: ["claude-meta", o.sid], cwd: o.cfg.hqRoot, wantLog: false, env: {} });
    this.writable = true;
    this.logPath = null;
    this.snapshot = o.snapshot || null;
    this.now = o.now || (() => Date.now());
    this.setTimer = o.setTimer || setTimeout;
    this.clearTimer = o.clearTimer || clearTimeout;
    this.onTimeout = o.onTimeout || (() => {});
    this.idleTimer = null;
    this.capTimer = null;
    this.lastInputAt = this.now();
    this.closedAt = null;
    this.reconcile = null;
    this.integrity = null;
    this.integrityFailed = null;
  }
  start() {
    // The wrapper pins the argv: `claude-meta SID` is everything the runner may say.
    const { cmd, args } = this.wrapper.argvFor("claude-meta", [this.sid]);
    let handle;
    try {
      handle = this.factory.spawn({
        file: cmd,
        args,
        cwd: this.cfg.wrapperPath ? "/" : this.cwd,
        env: this.childEnv(),
        cols: this.cols,
        rows: this.rows,
        name: "xterm-256color",
      });
    } catch (e) {
      throw new RunnerError(ERR.ptyUnavailable, String((e && e.message) || e));
    }
    this.handle = handle;
    this.pid = handle.pid || null;
    this.alive = true;
    handle.onData((d) => this.onData(String(d)));
    handle.onExit((r) => this.onExit(r));
    this.armTimers();
    return this;
  }
  armTimers() {
    this.clearTimers();
    const cap = this.cfg.metaCapMs;
    const idle = this.cfg.metaIdleMs;
    if (cap > 0) {
      this.capTimer = this.setTimer(() => this.onTimeout(this.sid, "cap"), cap);
      if (this.capTimer && this.capTimer.unref) this.capTimer.unref();
    }
    if (idle > 0) this.armIdle();
  }
  armIdle() {
    if (this.idleTimer) this.clearTimer(this.idleTimer);
    const idle = this.cfg.metaIdleMs;
    if (!(idle > 0)) return;
    this.idleTimer = this.setTimer(() => this.onTimeout(this.sid, "idle"), idle);
    if (this.idleTimer && this.idleTimer.unref) this.idleTimer.unref();
  }
  clearTimers() {
    if (this.idleTimer) this.clearTimer(this.idleTimer);
    if (this.capTimer) this.clearTimer(this.capTimer);
    this.idleTimer = null;
    this.capTimer = null;
  }
  write(data) {
    super.write(data);
    this.lastInputAt = this.now();
    this.armIdle();
  }
  onExit(r) {
    this.clearTimers();
    super.onExit(r);
  }
  dispose() {
    this.clearTimers();
    super.dispose();
  }
  record() {
    return {
      ...super.record(),
      log: null,
      meta: {
        closedAt: this.closedAt,
        lastInputAt: new Date(this.lastInputAt).toISOString(),
        reconcile: this.reconcile,
        integrity: this.integrity,
        integrityFailed: this.integrityFailed,
      },
    };
  }
}

/**
 * Look for the integrity hook's marker under the meta state dir: any
 * flags/INTEGRITY_FAILED file newer than `sinceMs`. The hook writes it as owner in
 * the per-claude-session dir, whose id the runner does not know, so the scan is by
 * time, and it is tolerant of dirs it cannot read.
 */
export function findIntegrityMarker(stateDir, sinceMs) {
  let entries;
  try {
    entries = fs.readdirSync(stateDir);
  } catch {
    return null;
  }
  for (const name of entries) {
    const marker = path.join(stateDir, name, "flags", "INTEGRITY_FAILED");
    try {
      // lstat, not stat: a marker that is a symlink is treated as present-and-tripped
      // but never followed or read (a hostile session could point it at another file).
      const st = fs.lstatSync(marker);
      if (st.mtimeMs >= sinceMs - 1000) {
        let reason = "";
        if (st.isFile()) {
          try {
            const fd = fs.openSync(marker, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try {
              reason = fs.readFileSync(fd, "utf8").slice(0, 500);
            } finally {
              fs.closeSync(fd);
            }
          } catch {
            reason = "(unreadable)";
          }
        } else {
          reason = "INTEGRITY_FAILED (marker is not a regular file)";
        }
        return { path: marker, reason: reason.trim() || "INTEGRITY_FAILED", sessionDir: name };
      }
    } catch {
      /* no marker here */
    }
  }
  return null;
}
