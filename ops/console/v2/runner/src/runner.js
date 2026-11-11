// hq-runner: the daemon that owns terminal sessions.
//
// Why it is separate from the console server: the server is redeployed often
// (release/activate.sh) and a restart must never hang up a running worker. So
// the PTYs live here, the console connects over /run/hqconsole/runner.sock,
// and activation deliberately does not restart this unit.
//
// How it is updated instead (the drain protocol):
//   1. the console sends `drain`; the runner answers state "draining" and
//      refuses every new spawn;
//   2. the runner exits 0 by itself once its session count reaches zero;
//   3. systemd's socket activation starts the new release on the next connect,
//      and a spawn that arrives mid-restart waits in the socket backlog.
//
// Honest limit, stated once here and enforced nowhere else: a PTY master is a
// file descriptor of THIS process. When the runner exits, every master closes
// and every child gets its terminal hung up, so it dies. RUNNER_KILL_ON_STOP=1
// only decides whether the runner signals them first and waits; it is not the
// difference between sessions surviving and not. Draining is the only way to
// replace the runner without ending a session, which is why the units set
// Restart=on-failure (a clean drain exit stays down until the next connect)
// and why activation leaves this unit alone.

import { loadRunnerConfig } from "./config.js";
import { WrapperClient } from "./wrapper.js";
import { Manager } from "./manager.js";
import { RunnerServer } from "./server.js";
import { loadNodePty, nodePtyFactory, unavailableFactory } from "./pty.js";

export function stderrLog(msg) {
  process.stderr.write(`hq-runner: ${msg}\n`);
}

/**
 * Build everything, listen, and return the handles. Exported so a test can
 * drive the real daemon over a temp socket with an injected PTY factory.
 * @param {{cfg?: any, factory?: any, wrapper?: any, log?: Function, exec?: Function}} [opts]
 */
export async function startRunner(opts = {}) {
  const cfg = opts.cfg || loadRunnerConfig();
  const log = opts.log || stderrLog;

  let factory = opts.factory;
  if (!factory) {
    const loaded = await loadNodePty();
    if (loaded.ok) {
      factory = nodePtyFactory(loaded.pty);
    } else {
      // Degrade honestly: tmux sessions still work, pty spawns fail with a
      // clear error, and the operator sees why in the journal.
      log(`node-pty did not load (${loaded.error}); pty sessions are unavailable`);
      factory = unavailableFactory(`node-pty did not load: ${loaded.error}`);
    }
  }
  if (!cfg.wrapperPath) {
    log("RUNNER_WRAPPER is empty: sessions run as this process's own user, not owner. Development only.");
  }

  const wrapper = opts.wrapper || new WrapperClient(cfg, { exec: opts.exec });
  const manager = new Manager({ cfg, factory, wrapper, log, exec: opts.exec });
  manager.init();
  // Persistent console terminals come back BEFORE the socket serves, so the
  // console's first list already shows them alive and its corpse sweep never
  // marks a surviving terminal done. Never fatal.
  if (opts.sweep !== false) {
    try {
      const rt = await manager.restoreTerms();
      if (rt.attached.length || rt.resumed.length || rt.dropped.length) {
        log(`terms: re-attached ${rt.attached.join(",") || "none"}; resumed ${rt.resumed.join(",") || "none"}; dropped ${rt.dropped.join(",") || "none"}`);
      }
    } catch (e) {
      log(`term restore failed: ${e && e.message}`);
    }
    manager.startWakeTimer();
  }
  const server = new RunnerServer({ cfg, manager, log });
  const bound = await server.listen();
  log(
    `serving release ${cfg.release} protocol ${cfg.protocol} on ${bound.mode === "systemd" ? "the activated socket" : bound.path} (pty: ${factory.name})`,
  );
  // Capri (proposal 19) rule 5: stop lingering hq-meta-* scopes and reconcile any
  // meta record that has no close event, before serving. Never fatal.
  if (opts.sweep !== false) {
    try {
      const sw = await manager.startSweep();
      if ((sw.scopes && sw.scopes.length) || (sw.reconciled && sw.reconciled.length)) {
        log(`meta sweep: scopes ${sw.scopes.join(",") || "none"}; reconciled ${sw.reconciled.join(",") || "none"}`);
      }
    } catch (e) {
      log(`meta sweep failed: ${e && e.message}`);
    }
  }

  let stopping = false;
  const stop = async ({ kill = false, reason = "stop" } = {}) => {
    if (stopping) return;
    stopping = true;
    log(`${reason}: closing the socket and persisting ${manager.list().length} session record(s)`);
    await server.close();
    await manager.shutdown({ kill });
    return 0;
  };

  manager.on("drained", () => {
    log("drained: no sessions left, exiting so socket activation starts the new release");
    stop({ reason: "drained" }).then(() => {
      if (opts.exitOnDrain !== false) process.exit(0);
    });
  });

  return { cfg, manager, server, factory, wrapper, stop, log };
}

/** Entry point: only when executed, never on import. */
export async function main() {
  const app = await startRunner();
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      if (app.manager.blockingCount && !app.cfg.killOnStop) {
        app.log(
          `${sig} with ${app.manager.blockingCount} live non-persistent session(s): not signalling them, but they end anyway when this process closes their PTY (persistent console terminals live on in tmux and are re-attached on start). Use drain to replace the runner without that.`,
        );
      }
      app.stop({ kill: app.cfg.killOnStop, reason: sig }).then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
  process.on("uncaughtException", (e) => {
    app.log(`uncaught: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
  });
  return app;
}

const invoked = process.argv[1] && process.argv[1].endsWith("runner.js");
if (invoked) {
  main().catch((e) => {
    stderrLog(`failed to start: ${(e && e.message) || e}`);
    process.exit(1);
  });
}
