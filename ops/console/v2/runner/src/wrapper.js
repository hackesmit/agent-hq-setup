// The runner's owner-context adapter, the same trust boundary the server has
// (server/src/wrapper.js): the runner runs as hqconsole and never execs a
// free-form command. Every verb is allowlisted in spawn-as-owner.sh, which is
// the one command the sudoers drop-in permits.
//
// Two use shapes:
//   argvFor(verb, args)   the argument vector for node-pty (pty-spawn)
//   call(verb, args)      a short-lived helper, buffered (tmux-list, capture,
//                         pipe, unpipe, send)

import { execFile } from "node:child_process";

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
// Names the wrapper is willing to carry into a owner session. Anything that
// changes how a program finds code or credentials (PATH, LD_*, NODE_OPTIONS,
// SUDO_*) is deliberately absent; the wrapper sets PATH and HOME itself.
const ENV_ALLOW_EXACT = new Set(["TERM", "LANG", "LC_ALL", "COLUMNS", "LINES", "HQ_BEAD", "HQ_RIG"]);
const ENV_ALLOW_PREFIX = ["HQ_CONSOLE_", "CLAUDE_"];

export function envAllowed(name) {
  if (!ENV_NAME.test(name)) return false;
  if (ENV_ALLOW_EXACT.has(name)) return true;
  return ENV_ALLOW_PREFIX.some((p) => name.startsWith(p) && name.length > p.length);
}

export class WrapperClient {
  /** @param {import("./config.js").RunnerConfig} cfg @param {{exec?: Function}} [deps] */
  constructor(cfg, deps = {}) {
    this.cfg = cfg;
    this.exec = deps.exec || execFile;
  }

  /**
   * The exact process invocation for a verb. Argument arrays only: nothing
   * here is concatenated into a shell string.
   * @returns {{cmd: string, args: string[]}}
   */
  argvFor(verb, args = []) {
    const tail = [String(verb), ...args.map(String)];
    if (!this.cfg.wrapperPath) {
      // Development and tests: no wrapper, no sudo. runner.js logs this loudly
      // at start because it means sessions run as the runner's own user.
      const [cmd, ...rest] = tail;
      return { cmd, args: rest };
    }
    if (this.cfg.wrapperSudo) {
      return { cmd: "sudo", args: ["-n", "-u", this.cfg.wrapperUser, this.cfg.wrapperPath, ...tail] };
    }
    return { cmd: "bash", args: [this.cfg.wrapperPath, ...tail] };
  }

  /**
   * pty-spawn argv: `<cwd> [--env K=V ...] -- <argv...>`. The env pairs are
   * filtered here and again in the wrapper.
   * @param {{cwd: string, argv: string[], env?: Record<string,string>}} spec
   */
  ptyArgv(spec) {
    const pairs = [];
    for (const [k, v] of Object.entries(spec.env || {})) {
      if (!envAllowed(k)) continue;
      const val = String(v);
      if (val.includes("\n") || val.length > 4096) continue;
      pairs.push("--env", `${k}=${val}`);
    }
    if (!this.cfg.wrapperPath) {
      // No wrapper: the argv is executed as-is, cwd handled by node-pty.
      const [cmd, ...rest] = spec.argv;
      return { cmd: String(cmd), args: rest.map(String) };
    }
    return this.argvFor("pty-spawn", [spec.cwd, ...pairs, "--", ...spec.argv.map(String)]);
  }

  /**
   * @param {string} verb
   * @param {string[]} args
   * @param {{input?: string|Buffer, timeout?: number, maxBuffer?: number}} [opts]
   * @returns {Promise<{code: number, stdout: string, stderr: string}>}
   */
  call(verb, args = [], opts = {}) {
    const { cmd, args: argv } = this.argvFor(verb, args);
    return new Promise((resolve) => {
      const child = this.exec(
        cmd,
        argv,
        {
          timeout: opts.timeout || this.cfg.wrapperTimeoutMs,
          maxBuffer: opts.maxBuffer || 8 * 1024 * 1024,
          env: { ...process.env, HQ_ROOT: this.cfg.hqRoot, RUNNER_FIFO_DIR: this.cfg.fifoDir },
        },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
          resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || "") });
        },
      );
      if (opts.input !== undefined && child && child.stdin) {
        child.stdin.on("error", () => {
          /* the child may have exited before we finished writing */
        });
        child.stdin.end(opts.input);
      }
    });
  }
}
