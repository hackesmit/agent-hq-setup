// The one test that uses a real PTY. It skips itself when node-pty's native
// module is not built, which is the normal state on a machine without a
// compiler (this laptop). release/build.sh builds it on the box that ships the
// release and refuses to publish a runner whose pty.node is missing, so this
// test is the same check from the runner's side: spawn, read, write, exit.

import test from "node:test";
import assert from "node:assert/strict";
import { Manager } from "../src/manager.js";
import { WrapperClient } from "../src/wrapper.js";
import { loadNodePty, nodePtyFactory } from "../src/pty.js";
import { cleanup, testEnv, wait } from "./helpers.js";

const loaded = await loadNodePty();

test(
  "a real pty echoes what is typed and reports its exit code",
  { skip: loaded.ok ? false : `node-pty did not load: ${loaded.error}` },
  async () => {
    const env = testEnv({ RUNNER_ARGV0_ALLOW: "bash" });
    const m = new Manager({
      cfg: env.cfg,
      factory: nodePtyFactory(loaded.pty),
      wrapper: new WrapperClient(env.cfg),
      log: () => {},
    }).init();

    const out = [];
    m.on("data", (ev) => out.push(ev.data));
    const exited = new Promise((r) => m.once("exit", r));
    const { sid } = await m.spawn({
      kind: "interactive",
      argv: ["bash", "--norc", "-i"],
      cwd: env.hq,
      cols: 80,
      rows: 24,
    });
    await wait(300);
    await m.input(sid, "echo hq-runner-alive\r");
    await wait(300);
    assert.match(out.join(""), /hq-runner-alive/);
    await m.input(sid, "exit 4\r");
    const ev = await exited;
    assert.equal(ev.sid, sid);
    assert.equal(ev.code, 4);
    cleanup(env.dir);
  },
);
