// Session bookkeeping: the part of the runner that owns terminals.
//
// The socket layer parses lines and this decides what they mean, so the whole
// state machine (spawn rules, attach refcounts, drain, reaping) is testable
// without a socket and without a real PTY.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { RunnerError, ERR, SESSION_KINDS } from "./protocol.js";
import { PtySession } from "./sessions.js";
import { TmuxSession, PANE_RE } from "./tmux.js";
import { Store, pinRelease, unpinRelease } from "./store.js";
import { envAllowed } from "./wrapper.js";
import { Capabilities, MetaSession, diffSnapshots, parseVerb, findIntegrityMarker } from "./meta.js";

const HISTORY_MAX = 100;

export class Manager extends EventEmitter {
  /**
   * @param {{cfg: any, factory: any, wrapper: any, store?: Store, log?: Function, exec?: Function}} o
   */
  constructor(o) {
    super();
    this.cfg = o.cfg;
    this.factory = o.factory;
    this.wrapper = o.wrapper;
    this.store = o.store || new Store({ file: o.cfg.stateFile, log: o.log });
    this.log = o.log || (() => {});
    this.exec = o.exec;
    // injectable clock and timers so the meta idle/cap/detach rules are testable
    this.now = o.now || (() => Date.now());
    this.setTimer = o.setTimer || setTimeout;
    this.clearTimer = o.clearTimer || clearTimeout;
    /** @type {Map<string, {session: any, attachers: number, reap: any, grace?: any}>} */
    this.entries = new Map();
    this.history = [];
    this.state = "serving";
    this.startedAt = Date.now();
    this.pinned = false;
    // Capri (proposal 19): one-use start capabilities, the close records that
    // survive a restart (so a crash cannot skip reconciliation), the marker poll
    this.caps = new Capabilities({ ttlMs: this.cfg.metaCapabilityTtlMs, now: this.now });
    this.metaRecords = [];
    this.metaPoll = null;
    this.metaStarting = false;
    /** @type {Map<string, any>} persistent console terminals by sid (see spawnTerm) */
    this.terms = new Map();
    this.shuttingDown = false;
    // A runner restart asked for while a blocking session lives (see restart())
    this.restartPending = false;
    this.restartTimer = null;
    /** sids whose meta close (reconcile, reverts, integrity) is running right now */
    this.metaClosingNow = new Set();
    this.drainedSent = false;
  }

  init() {
    for (const dir of [this.cfg.stateDir, this.cfg.termDir]) {
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
      } catch (e) {
        this.log(`could not create ${dir}: ${e && e.message}`);
      }
    }
    const prev = this.store.load();
    for (const t of prev.terms || []) {
      if (t && typeof t.sid === "string" && typeof t.name === "string") this.terms.set(t.sid, t);
    }
    // A PTY master cannot outlive the process that holds it, so anything the
    // previous runner recorded as alive ended when that process did. Say so
    // rather than showing a session the console can never attach to.
    this.history = prev.sessions
      .filter((s) => !(s && this.terms.has(s.sid)))
      .map((s) => (s && s.alive ? { ...s, alive: false, endedBy: s.endedBy || "runner restart" } : s))
      .filter(Boolean)
      .slice(-HISTORY_MAX);
    this.metaRecords = (prev.meta || []).filter((r) => r && typeof r.sid === "string").slice(-20);
    this.pinned = pinRelease(this.cfg.pinFile, this.cfg.release, this.log);
    this.persist();
    return this;
  }

  /**
   * The runner's first act after listening (PROTOCOL.md meta rule 5): stop any
   * lingering hq-meta-* scope a dead runner left behind, then reconcile every
   * meta record that has no close event. Never throws; a box without the
   * wrapper (dev) just logs and moves on.
   */
  async startSweep() {
    if (!this.cfg.wrapperPath && !this.exec) return { scopes: [], reconciled: [] };
    const stopped = [];
    try {
      const sc = parseVerb(await this.wrapper.call("meta-scopes", [], { timeout: 20000 }), "meta-scopes");
      for (const name of sc.scopes || []) {
        const m = /^hq-meta-(.+)\.scope$/.exec(String(name));
        if (!m) continue;
        try {
          await this.wrapper.call("meta-stop", [m[1]], { timeout: 40000 });
          stopped.push(name);
        } catch (e) {
          this.log(`meta sweep: could not stop ${name}: ${e && e.message}`);
        }
      }
    } catch (e) {
      this.log(`meta sweep: scopes unavailable: ${e && e.message}`);
    }
    if (stopped.length) this.log(`meta sweep: stopped lingering ${stopped.join(", ")}`);
    const reconciled = await this.reconcileUnclosed();
    return { scopes: stopped, reconciled };
  }

  // ---- requests ------------------------------------------------------------

  /** @param {any} req spawn request from PROTOCOL.md */
  async spawn(req) {
    if (this.state === "draining") throw new RunnerError(ERR.draining);
    const kind = String(req.kind || "");
    if (!SESSION_KINDS.includes(kind)) throw new RunnerError("bad kind", kind || "(none)");
    if (kind === "meta") return this.spawnMeta(req);
    if (this.aliveCount >= this.cfg.maxSessions) throw new RunnerError("too many sessions");
    if (kind === "tmux") return this.adoptPane(String(req.pane || req.sid || ""), req);

    const argv = Array.isArray(req.argv) ? req.argv.map(String).filter((s) => s.length) : [];
    if (!argv.length) throw new RunnerError("argv required");
    this.checkArgv0(argv[0]);
    const cwd = this.checkCwd(req.cwd);
    const { cols, rows } = geometry(req);
    if (kind === "interactive" && req.persist && this.cfg.persistTerms) return this.spawnTerm(req, argv, cwd, cols, rows);
    const sid = newSid();
    const session = new PtySession({
      cfg: this.cfg,
      sid,
      kind,
      argv,
      cwd,
      rig: str(req.rig),
      bead: str(req.bead),
      label: str(req.label),
      cols,
      rows,
      wantLog: req.log !== false,
      factory: this.factory,
      wrapper: this.wrapper,
      env: req.env && typeof req.env === "object" ? req.env : {},
      log: this.log,
    });
    session.start();
    this.track(session);
    this.persist();
    return { sid };
  }

  // ---- persistent console terminals ----------------------------------------
  //
  // The program runs in a tmux session on the hqterm server (a owner user
  // unit, outside this process's cgroup); the PTY here only holds a tmux
  // client. The record in the store is what survives: on start the runner
  // re-attaches to every session that is still alive (runner restart) and
  // resumes the pinned Claude conversation for every one that is not (reboot).
  // The sid is stable across both, so HQ_CONSOLE_SID, the card name and the
  // ctl ask return address all carry over.

  async spawnTerm(req, argv, cwd, cols, rows) {
    const sid = newSid();
    const resumeArgv = Array.isArray(req.resumeArgv) ? req.resumeArgv.map(String).filter((x) => x.length) : null;
    if (resumeArgv && resumeArgv.length) this.checkArgv0(resumeArgv[0]);
    const term = {
      sid,
      name: `hqt-${sid}`,
      argv,
      resumeArgv: resumeArgv && resumeArgv.length ? resumeArgv : null,
      cwd,
      env: req.env && typeof req.env === "object" ? req.env : {},
      rig: str(req.rig),
      bead: str(req.bead),
      label: str(req.label),
      startedAt: new Date(this.now()).toISOString(),
      resumes: [],
    };
    await this.termNew(term, argv, cols, rows);
    this.terms.set(sid, term);
    this.attachTerm(term, cols, rows);
    this.persist();
    return { sid };
  }

  async termNew(term, argv, cols = 120, rows = 32) {
    const env = { TERM: "xterm-256color", ...(term.env || {}), HQ_CONSOLE_SID: term.sid };
    const pairs = [];
    for (const [k, v] of Object.entries(env)) {
      const val = String(v);
      if (!envAllowed(k) || val.includes("\n") || val.length > 4096) continue;
      pairs.push("--env", `${k}=${val}`);
    }
    const r = await this.wrapper.call("term-new", [term.name, term.cwd, String(cols), String(rows), ...pairs, "--", ...argv], { timeout: 30000 });
    if (r.code !== 0) throw new RunnerError(ERR.ptyUnavailable, `term-new: ${String(r.stderr || r.stdout).trim().slice(-300)}`);
  }

  async termAlive(term) {
    const r = await this.wrapper.call("term-has", [term.name], { timeout: 15000 });
    return r.code === 0;
  }

  attachTerm(term, cols = 120, rows = 32) {
    const session = new PtySession({
      cfg: this.cfg,
      sid: term.sid,
      kind: "interactive",
      argv: term.argv,
      cwd: term.cwd,
      rig: term.rig,
      bead: term.bead,
      label: term.label,
      startedAt: term.startedAt,
      cols,
      rows,
      wantLog: false,
      factory: this.factory,
      wrapper: this.wrapper,
      attach: { verb: "term-attach", args: [term.name] },
      log: this.log,
    });
    session.start();
    this.track(session);
    return session;
  }

  /**
   * The tmux client of a persistent terminal exited. If the tmux session is
   * gone the program really ended (the owner quit Claude, or the card's kill):
   * that is a normal exit. If it is still there only the client died (this
   * runner is stopping, or the client crashed): keep the record and, while
   * serving, re-attach under the same sid.
   */
  async onTermClientExit(session, entry, r) {
    const term = this.terms.get(session.sid);
    let alive = false;
    if (term && !term.killed) {
      try {
        alive = await this.termAlive(term);
      } catch {
        alive = false;
      }
    }
    if (alive) {
      if (this.shuttingDown) return;
      this.entries.delete(session.sid);
      this.log(`term ${session.sid}: client exited but tmux session lives; re-attaching`);
      const retry = this.setTimer(() => {
        if (this.shuttingDown || this.entries.has(session.sid)) return;
        try {
          this.attachTerm(term, session.cols, session.rows);
        } catch (e) {
          this.log(`term ${session.sid}: re-attach failed: ${e && e.message}`);
        }
      }, 1000);
      if (retry && retry.unref) retry.unref();
      return;
    }
    if (this.shuttingDown) return; // decided on the next start, never mid-stop
    // A snoozed term ended on purpose and comes back at its wake time: the
    // session entry goes, the record (and its pinned conversation) stays.
    const snoozed = Boolean(term && term.snoozedUntil);
    if (!snoozed) this.terms.delete(session.sid);
    // The exit of a snoozed client says so: the console must not mark the
    // terminal finished (its registry row and Needs-you address stay).
    this.finishExit(session, entry, r, snoozed ? { snoozed: true } : {});
    // No replay minute for a snoozed one: the console shows it as snoozed at
    // once, and the wake must not wait on a reap timer.
    if (snoozed) this.remove(session.sid);
  }

  // ---- snooze (the owner, 2026-10-20: "snooze failed: no such session") --------
  //
  // A console terminal has no tmux window in the registry, so snooze.sh cannot
  // free it. Here it can: end the program, keep the record, and at the wake time
  // resume the pinned Claude conversation under the same sid, the way a reboot
  // does. The wake check runs from the same tick as the reboot restore.

  async snoozeTerm(sid, wakeAt) {
    const term = this.terms.get(String(sid));
    if (!term || term.snoozedUntil) throw new RunnerError(ERR.noSession, String(sid));
    if (!term.resumeArgv) throw new RunnerError("cannot snooze", "no resume argv");
    const at = Date.parse(String(wakeAt || ""));
    if (!Number.isFinite(at) || at <= this.now()) throw new RunnerError("bad wake time", String(wakeAt));
    term.snoozedUntil = new Date(at).toISOString();
    term.killed = true;
    term.wakeFailures = 0;
    this.persist();
    const r = await this.wrapper.call("term-kill", [term.name], { timeout: 15000 }).catch((e) => ({ code: 1, stderr: String(e && e.message) }));
    if (r.code !== 0 && (await this.termAlive(term).catch(() => true))) {
      // The program is still running: a card that said "snoozed" would be a lie,
      // and every wake would then fail on "duplicate session".
      delete term.snoozedUntil;
      term.killed = false;
      this.persist();
      throw new RunnerError("snooze failed", `term-kill: ${String(r.stderr || "").trim().slice(-200)}`);
    }
    const entry = this.entries.get(term.sid);
    if (entry && entry.session.alive) {
      try {
        entry.session.kill("SIGTERM");
      } catch {
        /* the client may already be gone */
      }
    }
    return { sid: term.sid, wakeAt: term.snoozedUntil };
  }

  /** A snoozed term that can no longer come back: drop the record, say it ended. */
  dropSnoozed(term, endedBy) {
    this.terms.delete(term.sid);
    this.history.push({ sid: term.sid, kind: "interactive", runner: "pty", cwd: term.cwd, rig: term.rig, startedAt: term.startedAt, alive: false, endedBy });
    if (this.history.length > HISTORY_MAX) this.history = this.history.slice(-HISTORY_MAX);
    this.persist();
    this.emit("exit", { sid: term.sid, code: null, signal: null });
  }

  /** Wake one snoozed term now, or (no sid) every one whose time has come. */
  async wakeTerms(sid) {
    if (!this.waking) this.waking = new Set();
    const woke = [];
    const now = this.now();
    for (const term of [...this.terms.values()]) {
      if (!term.snoozedUntil) continue;
      if (sid ? term.sid !== String(sid) : Date.parse(term.snoozedUntil) > now) continue;
      if (this.entries.has(term.sid) || this.waking.has(term.sid)) continue;
      this.waking.add(term.sid);
      try {
        await this.termNew(term, term.resumeArgv);
        if (this.terms.get(term.sid) !== term) {
          // killed while term-new ran: end what it started and stop here
          await this.wrapper.call("term-kill", [term.name], { timeout: 15000 }).catch(() => {});
          continue;
        }
        try {
          term.killed = false;
          this.attachTerm(term);
        } catch (e) {
          // never leave the program running with no entry and no row
          term.killed = true;
          await this.wrapper.call("term-kill", [term.name], { timeout: 15000 }).catch(() => {});
          throw e;
        }
        delete term.snoozedUntil;
        delete term.wakeFailures;
        woke.push(term.sid);
        this.log(`term ${term.sid}: woke from snooze`);
      } catch (e) {
        term.wakeFailures = (term.wakeFailures || 0) + 1;
        this.log(`term ${term.sid}: wake failed (${term.wakeFailures}): ${e && e.message}`);
        if (term.wakeFailures >= (this.cfg.termResumeMax || 3)) {
          this.log(`term ${term.sid}: giving up after ${term.wakeFailures} failed wakes`);
          this.dropSnoozed(term, "wake-failed");
        }
      } finally {
        this.waking.delete(term.sid);
      }
    }
    if (sid && !woke.includes(String(sid))) {
      const term = this.terms.get(String(sid));
      // already awake (the tick got there first) is a success, not an error
      if (term && !term.snoozedUntil && this.entries.has(term.sid)) return { woke: [term.sid] };
      if (!term || !term.snoozedUntil) throw new RunnerError(ERR.noSession, String(sid));
      throw new RunnerError("wake failed", String(sid));
    }
    if (woke.length) this.persist();
    return { woke };
  }

  startWakeTimer() {
    if (this.wakeTimer) return;
    const tick = () => {
      if (this.shuttingDown) return;
      this.wakeTerms().catch((e) => this.log(`wake tick failed: ${e && e.message}`));
    };
    this.wakeTimer = setInterval(tick, this.cfg.termWakePollMs || 30000);
    if (this.wakeTimer.unref) this.wakeTimer.unref();
  }

  /** Snoozed terms as list rows: no PTY, but the console must still show them. */
  snoozedRecords() {
    return [...this.terms.values()]
      .filter((t) => t.snoozedUntil && !this.entries.has(t.sid))
      .map((t) => ({
        sid: t.sid, kind: "interactive", runner: "pty", cwd: t.cwd, rig: t.rig, bead: t.bead, label: t.label,
        startedAt: t.startedAt, alive: false, attachable: false, writable: false, snoozedUntil: t.snoozedUntil,
      }));
  }

  /** On start, before serving: re-attach live terms, resume interrupted ones. */
  async restoreTerms() {
    const out = { attached: [], resumed: [], dropped: [] };
    if (!this.cfg.persistTerms || (!this.cfg.wrapperPath && !this.exec)) return out;
    for (const term of [...this.terms.values()]) {
      if (term.snoozedUntil) continue;
      try {
        if (await this.termAlive(term)) {
          this.attachTerm(term);
          out.attached.push(term.sid);
          continue;
        }
        const now = this.now();
        term.resumes = (term.resumes || []).filter((t) => now - t < this.cfg.termResumeWindowMs);
        if (!term.resumeArgv || term.resumes.length >= this.cfg.termResumeMax) {
          throw new Error(term.resumeArgv ? "resume limit reached (boot loop guard)" : "no resume argv");
        }
        term.resumes.push(now);
        await this.termNew(term, term.resumeArgv);
        this.attachTerm(term);
        out.resumed.push(term.sid);
      } catch (e) {
        this.log(`term ${term.sid}: not restored: ${e && e.message}`);
        this.terms.delete(term.sid);
        this.history.push({ sid: term.sid, kind: "interactive", runner: "pty", cwd: term.cwd, rig: term.rig, startedAt: term.startedAt, alive: false, endedBy: "interrupted" });
        out.dropped.push(term.sid);
      }
    }
    this.persist();
    return out;
  }

  // ---- Capri, the meta terminal (proposal 19) ------------------------------
  liveMeta() {
    for (const e of this.entries.values()) if (e.session.kind === "meta" && e.session.alive) return e.session;
    return null;
  }
  /** `meta.capability`: one-use ticket the console must present on spawn. */
  mintMetaCapability() {
    if (!this.cfg.metaEnabled) throw new RunnerError(ERR.metaDisabled);
    if (this.state === "draining") throw new RunnerError(ERR.draining);
    const live = this.liveMeta();
    if (live) throw new RunnerError(ERR.metaBusy, live.sid);
    return this.caps.mint();
  }
  /** `meta.status`: what the console shows on the Capri card. */
  metaStatus() {
    const live = this.liveMeta();
    const closed = this.metaRecords.filter((r) => r.closedAt).slice(-1)[0] || null;
    const strip = (r) => (r ? { sid: r.sid, startedAt: r.startedAt, closedAt: r.closedAt, endedBy: r.endedBy, reconcile: r.reconcile, integrity: r.integrity, integrityFailed: r.integrityFailed } : null);
    return {
      enabled: Boolean(this.cfg.metaEnabled),
      live: live ? { sid: live.sid, startedAt: live.startedAt, lastInputAt: new Date(live.lastInputAt).toISOString(), attachers: (this.entries.get(live.sid) || {}).attachers || 0 } : null,
      capabilities: this.caps.size,
      lastClose: strip(closed),
      unreconciled: this.metaRecords.filter((r) => !r.closedAt && !(live && live.sid === r.sid)).map((r) => r.sid),
      idleMs: this.cfg.metaIdleMs,
      capMs: this.cfg.metaCapMs,
    };
  }
  async spawnMeta(req) {
    if (!this.cfg.metaEnabled) throw new RunnerError(ERR.metaDisabled);
    // the capability is spent whether or not the rest succeeds: one ticket, one try
    if (!this.caps.spend(req.capability)) throw new RunnerError(ERR.metaCapability);
    // SINGLE start at a time: the check-and-set is synchronous (no await between),
    // so two concurrent spawns cannot both pass. metaStarting covers the window
    // before the session is tracked and liveMeta() would see it.
    if (this.liveMeta() || this.metaStarting) throw new RunnerError(ERR.metaBusy, (this.liveMeta() || {}).sid || "starting");
    this.metaStarting = true;
    try {
      // rule 6: an earlier record with no close event is reconciled first
      await this.reconcileUnclosed();
      const sid = newSid();
      const chk = parseVerb(await this.wrapper.call("meta-check", [sid], { timeout: 30000 }), "meta-check");
      if (!chk.ok) throw new RunnerError(ERR.metaRefused, (chk.reasons || []).join("; ") || "meta-check said no");
      const snap = parseVerb(await this.wrapper.call("meta-snapshot", [sid], { timeout: 90000 }), "meta-snapshot");
      if (snap.ok === false) throw new RunnerError(ERR.metaRefused, `meta-snapshot: ${snap.error || "not ok"}`);
      // Record and persist the snapshot BEFORE creating the scope, so a crash
      // between scope creation and bookkeeping still has a record + snapshot for
      // the start sweep to reconcile against (the on-disk snapshot.json already exists).
      const rec = { sid, startedAt: new Date(this.now()).toISOString(), closedAt: null, endedBy: null, snapshot: snap, reconcile: null, integrity: null, integrityFailed: null, closing: false };
      this.metaRecords.push(rec);
      this.metaRecords = this.metaRecords.slice(-20);
      this.persist();
      const { cols, rows } = geometry(req);
      const session = new MetaSession({
        cfg: this.cfg,
        sid,
        cols,
        rows,
        factory: this.factory,
        wrapper: this.wrapper,
        snapshot: snap,
        log: this.log,
        now: this.now,
        setTimer: this.setTimer,
        clearTimer: this.clearTimer,
        onTimeout: (s, reason) => {
          this.stopMeta(s, reason).catch((e) => this.log(`meta ${reason} stop failed: ${e && e.message}`));
        },
      });
      session.startedAt = rec.startedAt;
      session.start();
      this.track(session);
      this.startMarkerPoll(session);
      this.persist();
      return { sid };
    } finally {
      this.metaStarting = false;
    }
  }
  /** Stop the scope (idle, cap, detach, integrity, kill): the exit event does the rest. */
  async stopMeta(sid, reason) {
    const entry = this.entries.get(String(sid));
    if (!entry || !entry.session.alive) return { stopped: false };
    const session = entry.session;
    session.endedBy = session.endedBy || reason;
    this.log(`meta ${sid}: stopping (${reason})`);
    let r = null;
    try {
      r = await this.wrapper.call("meta-stop", [sid], { timeout: 40000 });
    } catch (e) {
      this.log(`meta-stop failed for ${sid}: ${e && e.message}`);
    }
    // the scope stop ends the process; the PTY child gets a SIGTERM as well so a
    // box without a user manager (dev) does not keep a zombie session
    if (session.alive) {
      try {
        session.handle.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    return { stopped: true, verb: r ? r.code : null };
  }
  startMarkerPoll(session) {
    this.stopMarkerPoll();
    const stateDir = path.join(this.cfg.metaDir, "sessions");
    const since = Date.parse(session.startedAt) || this.now();
    const tick = () => {
      if (!session.alive) return this.stopMarkerPoll();
      const m = findIntegrityMarker(stateDir, since);
      if (m) {
        session.integrityFailed = m.reason;
        this.log(`meta ${session.sid}: INTEGRITY_FAILED marker (${m.reason.slice(0, 120)}), stopping`);
        this.stopMarkerPoll();
        this.stopMeta(session.sid, "integrity").catch(() => {});
      }
    };
    this.metaPoll = setInterval(tick, this.cfg.metaMarkerPollMs);
    if (this.metaPoll.unref) this.metaPoll.unref();
  }
  stopMarkerPoll() {
    if (this.metaPoll) clearInterval(this.metaPoll);
    this.metaPoll = null;
  }
  async reconcileUnclosed() {
    const done = [];
    for (const rec of this.metaRecords) {
      if (rec.closedAt || rec.closing) continue;
      const entry = this.entries.get(rec.sid);
      if (entry && entry.session.alive) continue;
      await this.closeMeta(rec, entry ? entry.session : null, "runner restart");
      done.push(rec.sid);
    }
    return done;
  }
  /**
   * Close-time reconciliation (PROTOCOL.md meta rule 4): make sure the scope is
   * gone, diff the persistence snapshot, auto-revert what the session added,
   * run the integrity check, record everything, emit the two events.
   */
  async closeMeta(rec, session, fallbackEndedBy) {
    // Idempotent: exit, a timer stop, and the start sweep can all reach here for the
    // same record; only the first runs the reconciliation.
    if (rec.closing || rec.closedAt) return { skipped: true };
    // A close in flight blocks a drain: exiting mid-close would leave the record
    // marked closing with its reverts half done (blockingCount counts it).
    this.metaClosingNow.add(rec.sid);
    try {
      return await this.reconcileMeta(rec, session, fallbackEndedBy);
    } finally {
      this.metaClosingNow.delete(rec.sid);
      this.afterBlockingEnd();
    }
  }

  async reconcileMeta(rec, session, fallbackEndedBy) {
    rec.closing = true;
    const sid = rec.sid;
    const at = () => new Date(this.now()).toISOString();
    const errors = [];
    const endedBy = (session && session.endedBy) || rec.endedBy || fallbackEndedBy || "exit";
    let scopeGone = false;
    try {
      const st = parseVerb(await this.wrapper.call("meta-stop", [sid], { timeout: 40000 }), "meta-stop");
      scopeGone = Boolean(st.stopped);
      if (!scopeGone) errors.push(`meta-stop: scope ${st.unit || sid} still ${st.state || "alive"}`);
    } catch (e) {
      errors.push(`meta-stop: ${e && e.message}`);
    }
    let after = null;
    try {
      after = parseVerb(await this.wrapper.call("meta-snapshot", [sid, "after"], { timeout: 90000 }), "meta-snapshot after");
    } catch (e) {
      errors.push(String(e && e.message));
    }
    const before = (session && session.snapshot) || rec.snapshot || null;
    const diff = after && before ? diffSnapshots(before, after, { ownScope: `hq-meta-${sid}.scope` }) : { autoRevert: [], changed: [] };
    if (!before) errors.push("no pre-start snapshot on record: nothing auto-reverted");
    const autoReverted = [];
    for (const item of diff.autoRevert) {
      let j;
      try {
        // Hand meta-revert the runner-held baseline on stdin, never letting it
        // trust the owner-writable on-disk snapshot the session could have
        // edited to defeat its own auto-revert (bead hq-gbml).
        j = parseVerb(await this.wrapper.call("meta-revert", [sid, item.kind, item.name], { timeout: 40000, input: before ? JSON.stringify(before) : "" }), "meta-revert");
      } catch (e) {
        j = { ok: false, action: String(e && e.message) };
      }
      autoReverted.push({ ...item, ok: Boolean(j.ok), action: j.action || null });
      // an auto-revert that did not take (snapshot tampered or missing, unit that
      // would not stop) leaves session residue behind: that is a close error, and
      // the integrity result below must say not-clean rather than all-good
      if (!j.ok) errors.push(`meta-revert ${item.kind} ${item.name}: ${j.action || "failed"}`);
    }
    const reconcile = { sid, endedBy, at: at(), autoReverted, changed: diff.changed, errors, snapshotErrors: (after && after.errors) || [] };
    rec.reconcile = reconcile;
    if (session) session.reconcile = reconcile;
    this.emit("meta.reconcile", reconcile);
    let integrity;
    try {
      const rep = parseVerb(await this.wrapper.call("meta-integrity", [], { timeout: 240000 }), "meta-integrity");
      const ok = Boolean(rep.canaries && rep.canaries.ok && rep.cage && rep.cage.clean);
      integrity = { sid, ok, at: at(), report: rep, error: null };
    } catch (e) {
      integrity = { sid, ok: false, at: at(), report: null, error: String(e && e.message) };
    }
    const failed = (session && session.integrityFailed) || rec.integrityFailed || null;
    if (failed) integrity.ok = false;
    // a scope that would not stop, or a snapshot/revert error, means the close is
    // not clean: the integrity result must say so rather than report all-good
    if (!scopeGone || errors.length) integrity.ok = false;
    integrity.scopeGone = scopeGone;
    integrity.closeErrors = errors;
    integrity.integrityFailed = failed;
    rec.integrity = integrity;
    rec.integrityFailed = failed;
    rec.endedBy = endedBy;
    rec.closedAt = at();
    rec.snapshot = null; // the on-disk copy in the session state dir is the durable one
    if (session) {
      session.integrity = integrity;
      session.closedAt = rec.closedAt;
    }
    this.emit("meta.integrity", integrity);
    this.persist();
    return { reconcile, integrity };
  }

  /** tmux panes are adopted, not created: spawn.sh already made them. */
  async adoptPane(pane, req = {}) {
    if (!PANE_RE.test(pane)) throw new RunnerError("bad pane id", pane || "(none)");
    const existing = this.entries.get(pane);
    if (existing) return { sid: pane, adopted: true };
    const session = new TmuxSession({
      cfg: this.cfg,
      wrapper: this.wrapper,
      sid: pane,
      writable: req.writable === undefined ? this.cfg.tmuxWritableDefault : Boolean(req.writable),
      rig: str(req.rig),
      bead: str(req.bead),
      label: str(req.label),
      log: this.log,
      exec: this.exec,
    });
    await session.start();
    this.track(session);
    this.persist();
    return { sid: pane };
  }

  /**
   * @param {string} sid
   * @param {any} req
   * @param {{ref?: boolean}} [opts] ref:false replays without taking an
   *   attacher reference (a client re-reading its own session).
   */
  async attach(sid, req = {}, opts = {}) {
    let entry = this.entries.get(String(sid));
    if (!entry && PANE_RE.test(String(sid))) {
      // The console's session list comes from the ctl registry, which knows
      // pane ids and nothing about the runner. Attaching to one adopts it.
      await this.adoptPane(String(sid), req);
      entry = this.entries.get(String(sid));
    }
    if (!entry) throw new RunnerError(ERR.noSession, String(sid));
    const { session } = entry;
    if (req.cols && req.rows && session.alive) {
      const g = usableGeometry(req);
      if (g && (g.cols !== session.cols || g.rows !== session.rows)) {
        session.resize(g.cols, g.rows);
        this.emit("size", { sid: session.sid, cols: g.cols, rows: g.rows });
      } else if (g && this.terms.has(session.sid)) {
        // A console terminal (only those: an adopted hq:work pane shares a window
        // with the tiled panes). Same size, so tmux would not repaint, and the replay the pane just got
        // was drawn at older widths: that is the text bleeding at line starts.
        // A one-row wiggle makes tmux redraw the whole screen at this size.
        this.repaint(session);
      }
    }
    if (opts.ref !== false) {
      entry.attachers += 1;
      if (entry.grace) {
        this.clearTimer(entry.grace);
        entry.grace = null;
      }
      if (entry.attachers === 1 && session.alive) await session.wake();
    }
    return {
      replay: session.ring.toString(),
      writable: Boolean(session.writable && session.alive),
      cols: session.cols,
      rows: session.rows,
      kind: session.kind,
      alive: session.alive,
    };
  }

  async detach(sid) {
    const entry = this.entries.get(String(sid));
    if (!entry) return { detached: false };
    entry.attachers = Math.max(0, entry.attachers - 1);
    if (entry.attachers === 0) await entry.session.idle();
    // Capri: the last browser going away stops the scope, after a short grace
    // so a page refresh (detach then attach) is not a kill.
    // A grace of 0 (the default since 2026-10-09) means detach never stops Capri.
    if (entry.attachers === 0 && entry.session.kind === "meta" && entry.session.alive && !entry.grace && this.cfg.metaDetachGraceMs > 0) {
      const sid2 = entry.session.sid;
      entry.grace = this.setTimer(() => {
        entry.grace = null;
        if (entry.attachers === 0 && entry.session.alive) {
          this.stopMeta(sid2, "detach").catch((e) => this.log(`meta detach stop failed: ${e && e.message}`));
        }
      }, this.cfg.metaDetachGraceMs);
      if (entry.grace && entry.grace.unref) entry.grace.unref();
    }
    return { detached: true };
  }

  async input(sid, data) {
    const entry = this.entries.get(String(sid));
    if (!entry) throw new RunnerError(ERR.noSession, String(sid));
    const s = String(data === undefined ? "" : data);
    if (Buffer.byteLength(s, "utf8") > this.cfg.maxInputBytes) throw new RunnerError("input too large");
    await entry.session.write(s);
    return {};
  }

  resize(sid, cols, rows) {
    const entry = this.entries.get(String(sid));
    if (!entry) throw new RunnerError(ERR.noSession, String(sid));
    const g = usableGeometry({ cols, rows });
    // A minimized or hidden pane measures as a few cells. Passing that on resized
    // the live program to 2 columns, and everything it drew meanwhile stayed in
    // the scrollback as two-letter fragments. Keep the last real size instead.
    if (!g) return { cols: entry.session.cols, rows: entry.session.rows, ignored: true };
    const out = entry.session.resize(g.cols, g.rows);
    // Every viewer draws at the one size the program has; tell them all.
    this.emit("size", { sid: entry.session.sid, cols: g.cols, rows: g.rows });
    return out;
  }

  /**
   * The Redraw button and the click into an unfocused pane (2026-10-20): a garbled
   * pane (stale cells, doubled borders) gets the same one-row wiggle as a same-size
   * attach. Console terminals only: an adopted hq:work pane shares its tmux window
   * with the tiled panes, and wiggling it would reflow every one of them.
   */
  redrawTerm(sid) {
    const id = String(sid);
    const entry = this.entries.get(id);
    if (!entry) throw new RunnerError(ERR.noSession, id);
    if (!this.terms.has(id)) throw new RunnerError(ERR.notTerm, id);
    return { redrawn: this.repaint(entry.session) };
  }

  /**
   * term.fg (hq-ymxzt.3): the name of the program in the foreground of a
   * persistent console terminal's pane, as tmux reports it, or null when tmux
   * cannot tell. Capri say types only into claude, never into a shell. Console
   * terminals only: any other session is refused, so the caller fails closed.
   */
  async termForeground(sid) {
    const id = String(sid);
    const term = this.terms.get(id);
    if (!term || !this.entries.has(id)) throw new RunnerError(ERR.notTerm, id);
    const r = await this.wrapper.call("term-fg", [term.name], { timeout: 5000 });
    const command = String(r.stdout || "").trim();
    return { command: r.code === 0 && /^[\x21-\x7e]{1,64}$/.test(command) ? command : null };
  }

  /** Force a tmux-backed session to redraw its screen at its current size. */
  repaint(session) {
    if (!session.alive || session.rows < 2) return false;
    // A wiggle already under way redraws anyway; a second one on top (a quick
    // double click) would only add another pair of SIGWINCHes.
    if (session.repainting) return false;
    const { cols, rows } = session;
    try {
      session.handle.resize(cols, rows - 1);
    } catch {
      return false;
    }
    session.repainting = true;
    const t = this.setTimer(() => {
      session.repainting = false;
      if (session.alive && session.cols === cols && session.rows === rows) {
        try {
          session.handle.resize(cols, rows);
        } catch {
          /* the next resize puts it right */
        }
      }
    }, 60);
    if (t && t.unref) t.unref();
    return true;
  }

  kill(sid, signal) {
    const entry = this.entries.get(String(sid));
    const snoozed = this.terms.get(String(sid));
    if (!entry && snoozed && snoozed.snoozedUntil) {
      // Nothing is running; killing it means it must never wake.
      this.dropSnoozed(snoozed, "killed");
      return {};
    }
    if (!entry) throw new RunnerError(ERR.noSession, String(sid));
    const sig = String(signal || "SIGTERM");
    if (!/^SIG[A-Z]+$/.test(sig)) throw new RunnerError("bad signal", sig);
    const term = this.terms.get(String(sid));
    if (term) {
      // Killing the client alone would leave the program running in tmux.
      term.killed = true;
      this.wrapper.call("term-kill", [term.name], { timeout: 15000 }).catch(() => {});
    }
    entry.session.kill(sig);
    return {};
  }

  /**
   * Is this sid the uncaged meta session? Asked by the runner's own dispatch so
   * that the rules protecting Capri do not live only in the console: this is
   * the process holding the PTY, and it should not take the console's word for
   * who is allowed to type into it.
   */
  isMeta(sid) {
    const entry = this.entries.get(String(sid));
    return Boolean(entry && entry.session.kind === "meta");
  }

  list() {
    return [...this.entries.values()].map((e) => e.session.record()).concat(this.snoozedRecords());
  }

  drain() {
    if (this.state !== "draining") {
      this.state = "draining";
      this.log(`draining: ${this.blockingCount} session(s) to go`);
      this.persist();
      if (this.blockingCount === 0) setImmediate(() => this.emitDrained());
    }
    return { state: this.state, sessions: this.aliveCount };
  }

  /**
   * `restart`: replace this runner with the current release as soon as that
   * loses nothing. With no blocking session it is `drain`. Otherwise the runner
   * keeps serving (new terminals still start) and drains itself the moment the
   * last blocking session ends; a meta session with no input for
   * cfg.metaRestartIdleMs is closed for it, so one forgotten Capri window cannot
   * hold old runner code live for hours (hq-4npjr.20). Idempotent.
   */
  restart() {
    if (this.state === "draining") return { state: this.state, pending: false, blocking: this.blockingCount };
    if (this.blockingCount === 0) {
      this.restartPending = false;
      this.clearRestartTimer();
      const d = this.drain();
      return { ...d, pending: false, blocking: 0 };
    }
    if (!this.restartPending) {
      this.restartPending = true;
      this.log(`restart pending: ${this.blockingCount} blocking session(s); draining when they end`);
    }
    this.checkRestart();
    return { state: this.state, pending: this.restartPending, blocking: this.blockingCount };
  }

  /** Drain if nothing blocks; close idle meta sessions; re-check when the next one turns idle. */
  checkRestart() {
    this.clearRestartTimer();
    if (!this.restartPending || this.state === "draining") return;
    if (this.blockingCount === 0) {
      this.restartPending = false;
      this.log("restart pending: no blocking session left, draining");
      this.drain();
      return;
    }
    const limit = this.cfg.metaRestartIdleMs;
    if (!(limit > 0)) return;
    let next = Infinity;
    for (const e of this.entries.values()) {
      const s = e.session;
      if (s.kind !== "meta" || !s.alive) continue;
      const idle = this.now() - s.lastInputAt;
      if (idle >= limit) {
        if (!s.restartStopAsked) {
          s.restartStopAsked = true;
          this.stopMeta(s.sid, "runner restart").catch((err) => this.log(`meta restart stop failed: ${err && err.message}`));
        }
      } else next = Math.min(next, limit - idle);
    }
    if (next !== Infinity) {
      this.restartTimer = this.setTimer(() => this.checkRestart(), Math.max(1000, next));
      if (this.restartTimer && this.restartTimer.unref) this.restartTimer.unref();
    }
  }

  clearRestartTimer() {
    if (this.restartTimer) this.clearTimer(this.restartTimer);
    this.restartTimer = null;
  }

  status() {
    return {
      state: this.state,
      restartPending: this.restartPending,
      sessions: this.aliveCount,
      release: this.cfg.release,
      protocol: this.cfg.protocol,
      uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
      pty: this.factory.name,
    };
  }

  // ---- internals -----------------------------------------------------------

  /**
   * Sessions a drain must wait for. Persistent terms survive a runner restart
   * (tmux holds them, the runner re-attaches), and an adopted tmux pane is only
   * a pipe-pane reader of somebody else's pane (the pane lives on, and the next
   * attach re-adopts it), so neither blocks one.
   */
  get blockingCount() {
    let n = this.metaClosingNow.size;
    for (const e of this.entries.values()) if (this.blocksRestart(e.session)) n += 1;
    return n;
  }

  /** A blocking session or close just ended: finish a drain, or re-check a pending restart. */
  afterBlockingEnd() {
    if (this.state === "draining" && this.blockingCount === 0) this.emitDrained();
    else if (this.restartPending) this.checkRestart();
  }

  emitDrained() {
    if (this.drainedSent) return;
    this.drainedSent = true;
    this.emit("drained");
  }

  blocksRestart(session) {
    return Boolean(session.alive) && !this.terms.has(session.sid) && session.kind !== "tmux";
  }

  get aliveCount() {
    let n = 0;
    for (const e of this.entries.values()) if (e.session.alive) n += 1;
    return n;
  }

  track(session) {
    const entry = { session, attachers: 0, reap: null };
    this.entries.set(session.sid, entry);
    session.on("data", (d) => this.emit("data", { sid: session.sid, data: d }));
    session.on("exit", (r) => {
      if (this.terms.has(session.sid)) {
        this.onTermClientExit(session, entry, r).catch((e) => this.log(`term exit handling failed for ${session.sid}: ${e && e.message}`));
        return;
      }
      this.finishExit(session, entry, r);
    });
  }

  finishExit(session, entry, r, extra = {}) {
    {
      this.log(`session ${session.sid} exited (code ${r.code}, signal ${r.signal || "none"})`);
      this.history.push(session.record());
      if (this.history.length > HISTORY_MAX) this.history = this.history.slice(-HISTORY_MAX);
      this.persist();
      this.emit("exit", { sid: session.sid, code: r.code, signal: r.signal || null, ...extra });
      if (session.kind === "meta") {
        const rec = this.metaRecords.find((x) => x.sid === session.sid) || { sid: session.sid, startedAt: session.startedAt, snapshot: session.snapshot };
        this.closeMeta(rec, session, "exit").catch((e) => this.log(`meta close failed for ${session.sid}: ${e && e.message}`));
      }
      // Attachers keep the final replay for a minute, then the record goes.
      entry.reap = setTimeout(() => this.remove(session.sid), this.cfg.reapMs);
      if (entry.reap.unref) entry.reap.unref();
      this.afterBlockingEnd();
    }
  }

  remove(sid) {
    const entry = this.entries.get(sid);
    if (!entry) return;
    this.entries.delete(sid);
    if (entry.reap) clearTimeout(entry.reap);
    if (entry.grace) this.clearTimer(entry.grace);
    try {
      const r = entry.session.dispose();
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch {
      /* disposing a dead session is best effort */
    }
    this.emit("removed", { sid });
  }

  checkArgv0(argv0) {
    const allow = this.cfg.argv0Allow || [];
    const a = String(argv0);
    const ok = allow.includes(a) || allow.includes(path.basename(a));
    if (!ok) throw new RunnerError("argv0 not allowed", a);
    return a;
  }

  checkCwd(cwd) {
    const raw = String(cwd || "");
    if (!raw) throw new RunnerError("cwd required");
    const p = path.resolve(raw);
    const root = this.cfg.hqRoot;
    if (p !== root && !p.startsWith(root + path.sep)) throw new RunnerError("cwd outside hq", p);
    return p;
  }

  persist() {
    this.store.save({
      release: this.cfg.release,
      sessions: [...this.history, ...[...this.entries.values()].map((e) => e.session.record())].slice(-(HISTORY_MAX * 2)),
      meta: this.metaRecords.slice(-20),
      terms: [...this.terms.values()],
    });
  }

  /** Clean shutdown: stop timers, release the pin, persist. */
  async shutdown({ kill = false } = {}) {
    this.shuttingDown = true;
    this.stopMarkerPoll();
    this.clearRestartTimer();
    if (this.wakeTimer) clearInterval(this.wakeTimer);
    for (const [sid, entry] of this.entries) {
      if (entry.grace) this.clearTimer(entry.grace);
      if (kill && entry.session.alive) {
        try {
          entry.session.kill("SIGTERM");
        } catch {
          /* best effort */
        }
      }
      if (entry.reap) clearTimeout(entry.reap);
      try {
        const r = entry.session.dispose();
        if (r && typeof r.then === "function") await r.catch(() => {});
      } catch {
        /* best effort */
      }
      void sid;
    }
    if (this.pinned) unpinRelease(this.cfg.pinFile, this.cfg.release, this.log);
    this.persist();
  }
}

function geometry(req) {
  const cols = clamp(Number(req.cols) || 80, 2, 1000);
  const rows = clamp(Number(req.rows) || 24, 2, 1000);
  return { cols, rows };
}

// Below this a resize is a measurement of a hidden container, not a terminal.
export const MIN_COLS = 20;
export const MIN_ROWS = 5;

/** geometry() for a client resize, or null when the request is too small to be real. */
export function usableGeometry(req) {
  const cols = Number(req.cols);
  const rows = Number(req.rows);
  if (!(cols >= MIN_COLS) || !(rows >= MIN_ROWS)) return null;
  return geometry(req);
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

function str(v) {
  const s = v === undefined || v === null ? "" : String(v);
  return s ? s.slice(0, 200) : null;
}

/** Session ids are opaque and filename-safe: they name a worker's log file. */
export function newSid() {
  return `s${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
}
