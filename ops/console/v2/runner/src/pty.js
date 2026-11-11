// The PTY factory. One thin interface so the whole daemon can be driven by a
// fake in tests:
//
//   factory.spawn({file, args, cwd, env, cols, rows, name}) -> handle
//   handle: {pid, onData(cb), onExit(cb), write(s), resize(c,r), kill(sig)}
//
// node-pty is a native module. It is built by release/build.sh on the box that
// ships the release and is deliberately NOT built on this laptop (no
// compiler), so every test injects the fake and the daemon degrades honestly:
// if the native module will not load, tmux sessions still work and pty spawns
// fail with `pty unavailable` instead of the process dying at import time.

/** @returns {Promise<{ok: true, pty: any} | {ok: false, error: string}>} */
export async function loadNodePty() {
  try {
    const mod = await import("node-pty");
    const pty = mod && (mod.default && mod.default.spawn ? mod.default : mod);
    if (!pty || typeof pty.spawn !== "function") return { ok: false, error: "node-pty has no spawn()" };
    return { ok: true, pty };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).split("\n")[0] };
  }
}

/** Wrap a loaded node-pty module in the factory interface above. */
export function nodePtyFactory(pty) {
  return {
    name: "node-pty",
    spawn(spec) {
      const p = pty.spawn(spec.file, spec.args || [], {
        name: spec.name || "xterm-256color",
        cols: spec.cols || 80,
        rows: spec.rows || 24,
        cwd: spec.cwd || "/",
        env: spec.env || {},
      });
      return {
        pid: p.pid,
        onData: (cb) => p.onData(cb),
        onExit: (cb) => p.onExit(({ exitCode, signal }) => cb({ code: exitCode, signal: signal || null })),
        write: (d) => p.write(d),
        resize: (c, r) => p.resize(c, r),
        kill: (sig) => p.kill(sig),
      };
    },
  };
}

/** A factory that refuses to spawn, used when the native module is missing. */
export function unavailableFactory(reason) {
  return {
    name: "unavailable",
    reason,
    spawn() {
      throw new Error(reason || "pty unavailable");
    },
  };
}
