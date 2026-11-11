// Runner configuration: environment only, resolved once and frozen.
//
// Production values come from release/units/hq-runner.service; every one of
// them has a RUNNER_* override so a test (or a laptop dev run) can point the
// daemon at a temp dir and at `bash` instead of `sudo`.

import fs from "node:fs";
import path from "node:path";

const DEFAULTS = {
  socketPath: "/run/hqconsole/runner.sock",
  stateDir: "/var/lib/hqconsole/state",
  termDir: "/var/lib/hqconsole/term",
  releaseCurrent: "/var/lib/hqconsole/releases/current",
  hqRoot: "/home/owner/hq",
  wrapperUser: "owner",
  // FIFO home for the tmux adapter. It must be traversable by `owner` (the
  // tmux server writes into the pipe) and the pipe itself writable by owner,
  // and grant other accounts nothing (hq-an7jw.24). Production gets
  // /run/hqconsole-panes (tmpfiles.d 2710 hqconsole:owner, 0620 pipes)
  // through RUNNER_FIFO_DIR. The runner never chmods the directory and refuses
  // one that grants other access; this /tmp default, created 0700, only works
  // where the runner and the wrapper user are the same account (dev, tests).
  fifoDir: "/tmp/hqconsole-panes",
};

function intOr(v, d) {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}

function boolOr(v, d) {
  if (v === undefined || v === "") return d;
  return v === "1" || v === "true";
}

/** The sha of the release this process is running, for the pin file and hello. */
export function readReleaseSha(releaseCurrent) {
  try {
    const raw = fs.readFileSync(path.join(releaseCurrent, "RELEASE.json"), "utf8");
    const j = JSON.parse(raw);
    if (j && typeof j.sha === "string" && j.sha) return j.sha;
  } catch {
    /* not a release tree (dev run, or first boot) */
  }
  return "dev";
}

/** @param {NodeJS.ProcessEnv} [env] */
export function loadRunnerConfig(env = process.env) {
  const hqRoot = path.resolve(env.HQ_ROOT || DEFAULTS.hqRoot);
  const releaseCurrent = path.resolve(
    env.RUNNER_RELEASE_CURRENT || env.CONSOLE_RELEASE_CURRENT || DEFAULTS.releaseCurrent,
  );
  const stateDir = path.resolve(env.RUNNER_STATE_DIR || env.CONSOLE_STATE_DIR || DEFAULTS.stateDir);
  const termDir = path.resolve(env.RUNNER_TERM_DIR || env.CONSOLE_TERM_DIR || DEFAULTS.termDir);

  // An empty RUNNER_WRAPPER means "no wrapper": the runner spawns the argv
  // directly as its own user. That is a development and test mode only; in
  // production the wrapper is what makes a session run as owner.
  const wrapperRaw =
    env.RUNNER_WRAPPER !== undefined
      ? env.RUNNER_WRAPPER
      : env.CONSOLE_SPAWN_WRAPPER !== undefined
        ? env.CONSOLE_SPAWN_WRAPPER
        : path.join(releaseCurrent, "runner", "spawn-as-owner.sh");

  const cfg = {
    socketPath: env.RUNNER_SOCKET || env.CONSOLE_RUNNER_SOCKET || DEFAULTS.socketPath,
    // systemd socket activation hands the listening fd as 3. LISTEN_PID must
    // name this process, or we inherited the variables from a parent.
    listenFds: intOr(env.LISTEN_FDS, 0),
    listenPid: intOr(env.LISTEN_PID, 0),
    hqRoot,
    stateDir,
    termDir,
    fifoDir: path.resolve(env.RUNNER_FIFO_DIR || DEFAULTS.fifoDir),
    releaseCurrent,
    releasesDir: path.dirname(releaseCurrent),
    release: env.RUNNER_RELEASE_SHA || readReleaseSha(releaseCurrent),
    wrapperPath: wrapperRaw ? path.resolve(wrapperRaw) : "",
    wrapperSudo: boolOr(env.RUNNER_WRAPPER_SUDO, true),
    wrapperUser: env.RUNNER_WRAPPER_USER || DEFAULTS.wrapperUser,
    // SIGTERM does not kill sessions by default. See runner.js: with node-pty
    // the child dies when the master closes anyway, so this only decides
    // whether the runner signals them first.
    killOnStop: boolOr(env.RUNNER_KILL_ON_STOP, false),
    ringBytes: intOr(env.RUNNER_RING_BYTES, 256 * 1024),
    interactiveRingBytes: intOr(env.RUNNER_INTERACTIVE_RING_BYTES, 1024 * 1024),
    reapMs: intOr(env.RUNNER_REAP_MS, 60000),
    tmuxPollMs: intOr(env.RUNNER_TMUX_POLL_MS, 5000),
    wrapperTimeoutMs: intOr(env.RUNNER_WRAPPER_TIMEOUT_MS, 15000),
    maxInputBytes: intOr(env.RUNNER_MAX_INPUT_BYTES, 64 * 1024),
    maxSessions: intOr(env.RUNNER_MAX_SESSIONS, 64),
    // tmux panes are somebody else's terminal. Adopting one read-only is the
    // safe default; the console asks for a writable adapter explicitly.
    tmuxWritableDefault: boolOr(env.RUNNER_TMUX_WRITABLE_DEFAULT, false),
    // Capri (proposal 19): OFF unless root flips the unit flag; every other
    // rule is enforced even when on (wrapper meta-check, capability, one live).
    metaEnabled: boolOr(env.RUNNER_META_ENABLED, false),
    metaDir: path.resolve(env.RUNNER_META_DIR || env.CONSOLE_META_DIR || "/var/lib/hqconsole/meta"),
    // Idle, cap and detach stops are OFF by default (0) since 2026-10-09:
    // the owner wants Capri to stay open like any terminal until he closes it.
    // A positive value in the unit env turns the old containment timer back on.
    metaIdleMs: intOr(env.RUNNER_META_IDLE_MS, 0),
    metaCapMs: intOr(env.RUNNER_META_CAP_MS, 0),
    metaCapabilityTtlMs: intOr(env.RUNNER_META_CAPABILITY_TTL_MS, 60 * 1000),
    metaDetachGraceMs: intOr(env.RUNNER_META_DETACH_GRACE_MS, 0),
    // While a runner restart waits (manager.restart), a meta session with no
    // input this long is closed so the new runner code can go live; it never
    // applies otherwise. 0 turns it off (the restart then waits for the owner to
    // close Capri himself). hq-4npjr.20.
    metaRestartIdleMs: intOr(env.RUNNER_META_RESTART_IDLE_MS, 60 * 60 * 1000),
    // Persistent console terminals: an interactive spawn that asks for
    // `persist` runs inside the hqterm tmux server (a owner user unit, not this
    // process), so a runner restart only drops the attached client and the
    // runner re-attaches on start. After a reboot the session is resumed from
    // its pinned Claude conversation, at most termResumeMax times per
    // termResumeWindowMs so a boot loop cannot relaunch it forever.
    persistTerms: boolOr(env.RUNNER_PERSIST_TERMS, true),
    termResumeMax: intOr(env.RUNNER_TERM_RESUME_MAX, 3),
    termResumeWindowMs: intOr(env.RUNNER_TERM_RESUME_WINDOW_MS, 10 * 60 * 1000),
    metaMarkerPollMs: intOr(env.RUNNER_META_MARKER_POLL_MS, 2000),
    protocol: 1,
    // argv0 allowlist, checked here so a bad request gets a clean protocol
    // error, and again in the wrapper, which is the one that actually matters.
    // RUNNER_ARGV0_ALLOW extends it (comma separated) for dev and tests.
    argv0Allow: [
      "claude",
      "bash",
      path.join(hqRoot, "ops", "scripts", "spawn.sh"),
      path.join(hqRoot, "ops", "scripts", "finish.sh"),
      path.join(hqRoot, "ops", "scripts", "snooze.sh"),
      ...String(env.RUNNER_ARGV0_ALLOW || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ],
  };
  cfg.stateFile = path.join(cfg.stateDir, "runner.json");
  cfg.pinFile = path.join(cfg.releasesDir, ".pinned");
  return Object.freeze(cfg);
}

/** @typedef {ReturnType<typeof loadRunnerConfig>} RunnerConfig */
