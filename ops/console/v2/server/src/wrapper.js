// The one owner-context exec adapter.
//
// Design section 3 (trust boundary): the server runs as `hqconsole`, which
// cannot write into ~/hq and must not read `owner`'s private paths. Every
// shell-out (ctl.sh, bd, hw.py, usage.py, spawn/finish/snooze, git log) goes
// through ops/console/v2/runner/spawn-as-owner.sh, an allowlisted verb table,
// run as `owner` through one sudoers rule. Nothing else in this server may
// spawn a process: if a verb is missing from the wrapper, that is a wrapper
// change, not a bypass.
//
// Production: sudo -n -u owner <release>/runner/spawn-as-owner.sh <verb> ...
// Development (CONSOLE_DEV_NOAUTH=1): bash <hq>/ops/console/v2/runner/spawn-as-owner.sh <verb> ...

import { run } from "./exec.js";

export class Wrapper {
  /** @param {import("./config.js").Config} cfg @param {{runner?: Function}} [deps] */
  constructor(cfg, deps = {}) {
    this.cfg = cfg;
    this.run = deps.runner || run;
  }

  /**
   * The exact process invocation for a wrapper verb. Argument arrays only:
   * nothing here is ever concatenated into a shell string.
   * @param {string} verb
   * @param {string[]} [args]
   * @returns {{cmd: string, args: string[]}}
   */
  argv(verb, args = []) {
    const tail = [String(verb), ...args.map(String)];
    if (this.cfg.wrapperSudo) {
      return { cmd: "sudo", args: ["-n", "-u", this.cfg.wrapperUser, this.cfg.wrapperPath, ...tail] };
    }
    return { cmd: "bash", args: [this.cfg.wrapperPath, ...tail] };
  }

  /**
   * @param {string} verb
   * @param {string[]} args
   * @param {{timeout?: number}} [opts]
   */
  call(verb, args = [], opts = {}) {
    const { cmd, args: argv } = this.argv(verb, args);
    // HQ_ROOT is the one variable the wrapper reads; it resets PATH and HOME
    // itself, so nothing else of this process's environment matters to it.
    return this.run(cmd, argv, { timeout: opts.timeout || 30000, env: { HQ_ROOT: this.cfg.hqRoot } });
  }
}
