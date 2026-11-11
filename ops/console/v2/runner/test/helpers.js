// Test rig for the runner: a temp tree, a fake PTY factory, a fake wrapper
// script, and a minimal protocol client.
//
// node-pty is native and is not built on the laptop that writes these tests
// (no compiler), so every test here injects the fake factory. The one test
// that uses the real thing (pty-native.test.js) skips itself when the module
// will not load. That is the deal: the daemon's logic is covered without a
// compiler, and the native path is covered wherever one exists.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { loadRunnerConfig } from "../src/config.js";

let seq = 0;

/** A PTY handle with the same surface node-pty gives us. */
export class FakePty {
  constructor(spec) {
    this.spec = spec;
    this.pid = 4000 + ++seq;
    this.writes = [];
    this.size = { cols: spec.cols, rows: spec.rows };
    this.killed = null;
    this.dataCbs = [];
    this.exitCbs = [];
    this.exited = false;
  }
  onData(cb) {
    this.dataCbs.push(cb);
  }
  onExit(cb) {
    this.exitCbs.push(cb);
  }
  write(d) {
    this.writes.push(d);
  }
  resize(cols, rows) {
    this.size = { cols, rows };
  }
  kill(sig) {
    this.killed = sig;
    this.finish(0, sig);
  }
  /** Test drives output. */
  say(d) {
    for (const cb of this.dataCbs) cb(d);
  }
  /** Test drives exit. */
  finish(code = 0, signal = null) {
    if (this.exited) return;
    this.exited = true;
    for (const cb of this.exitCbs) cb({ code, signal });
  }
}

export function fakeFactory(opts = {}) {
  const spawned = [];
  return {
    name: "fake",
    spawned,
    last: () => spawned[spawned.length - 1],
    spawn(spec) {
      if (opts.throws) throw new Error(opts.throws);
      const h = new FakePty(spec);
      spawned.push(h);
      return h;
    },
  };
}

/** A temp tree plus a frozen config pointing entirely inside it. */
export function testEnv(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-runner-"));
  const hq = path.join(dir, "hq");
  fs.mkdirSync(path.join(hq, "ops", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "releases", "current"), { recursive: true });
  const env = {
    RUNNER_SOCKET: path.join(dir, "runner.sock"),
    RUNNER_STATE_DIR: path.join(dir, "state"),
    RUNNER_TERM_DIR: path.join(dir, "term"),
    RUNNER_FIFO_DIR: path.join(dir, "fifo"),
    RUNNER_RELEASE_CURRENT: path.join(dir, "releases", "current"),
    RUNNER_RELEASE_SHA: "testsha",
    // Empty wrapper: the argv runs as this user. Production always has one.
    RUNNER_WRAPPER: "",
    RUNNER_WRAPPER_SUDO: "0",
    HQ_ROOT: hq,
    RUNNER_REAP_MS: "60",
    RUNNER_TMUX_POLL_MS: "40",
    RUNNER_ARGV0_ALLOW: "node,echo,fakejob",
    LISTEN_FDS: "",
    LISTEN_PID: "",
    ...over,
  };
  return { dir, hq, env, cfg: loadRunnerConfig(env) };
}

export function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * The fake owner wrapper for tmux tests: it emulates list, capture, pipe
 * (by writing into the FIFO the runner created), unpipe and send.
 * State lives in <dir>/panes.txt so a test can kill a pane mid-run.
 */
export function writeFakeWrapper(dir) {
  const p = path.join(dir, "fake-wrapper.sh");
  fs.writeFileSync(
    p,
    `#!/usr/bin/env bash
set -uo pipefail
D=${JSON.stringify(dir)}
verb="\${1:-}"; shift 2>/dev/null || true
case "$verb" in
  tmux-list) cat "$D/panes.txt" 2>/dev/null; exit 0;;
  tmux-capture) printf 'seed for %s\\n' "\${1:-}"; exit 0;;
  tmux-pipe)
    printf '%s\\n' "\${2:-}" > "$D/piped"
    printf 'live from %s\\n' "\${1:-}" > "\${2:-}"
    exit 0;;
  tmux-unpipe) rm -f "$D/piped"; exit 0;;
  tmux-send) cat >> "$D/sent"; exit 0;;
  *) echo "fake wrapper: no verb $verb" >&2; exit 2;;
esac
`,
    { mode: 0o755 },
  );
  return p;
}

export function writePanes(dir, panes) {
  fs.writeFileSync(
    path.join(dir, "panes.txt"),
    panes.map((p) => [p.pane, p.session || "work", p.window || "0", p.index || "0", p.dead ? "1" : "0", p.cmd || "bash", p.cols || 120, p.rows || 40, p.title || ""].join("\t")).join("\n") + "\n",
  );
}

/** Minimal protocol client: request/reply by id plus an event log. */
export function connectClient(socketPath) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    const pending = new Map();
    const events = [];
    let id = 0;
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const obj = JSON.parse(line);
        if (obj.id !== undefined && pending.has(obj.id)) {
          const p = pending.get(obj.id);
          pending.delete(obj.id);
          p(obj);
        } else {
          events.push(obj);
        }
      }
    });
    sock.on("error", reject);
    sock.on("connect", () =>
      resolve({
        sock,
        events,
        send(op, payload = {}) {
          const myId = ++id;
          return new Promise((res) => {
            pending.set(myId, res);
            sock.write(JSON.stringify({ id: myId, op, ...payload }) + "\n");
          });
        },
        raw(text) {
          sock.write(text);
        },
        /** Wait until `pred` matches one of the events received so far. */
        waitFor(pred, timeoutMs = 2000) {
          return new Promise((res, rej) => {
            const deadline = Date.now() + timeoutMs;
            const check = () => {
              const hit = events.find(pred);
              if (hit) return res(hit);
              if (Date.now() > deadline) return rej(new Error("timed out waiting for an event"));
              setTimeout(check, 10);
            };
            check();
          });
        },
        close() {
          sock.destroy();
        },
      }),
    );
  });
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
