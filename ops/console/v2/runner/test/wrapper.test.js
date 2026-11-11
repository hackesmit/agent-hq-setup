// The real spawn-as-owner.sh, exercised as the security surface it is.
//
// This is the one file in the console that turns a string from a browser into
// a process running as owner, so every refusal here is a test, not a comment.
// The tmux verbs that would actually call tmux are covered by their refusals
// only; the adapter itself is tested against a fake wrapper in tmux.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanup, testEnv } from "./helpers.js";

const WRAPPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "spawn-as-owner.sh");

function run(args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      "bash",
      [WRAPPER, ...args],
      { timeout: 10000, env: { ...process.env, HQ_ROOT: opts.hqRoot || "/home/owner/hq", ...(opts.env || {}) } },
      (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

test("the wrapper is syntactically valid", async () => {
  const r = await new Promise((res) => execFile("bash", ["-n", WRAPPER], (e) => res(e)));
  assert.equal(r, null);
});

test("pty-spawn refuses a cwd outside hq", async () => {
  const env = testEnv();
  const r = await run(["pty-spawn", "/etc", "--", "bash"], { hqRoot: env.hq });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cwd must be an existing directory/);
  cleanup(env.dir);
});

test("pty-spawn refuses an argv0 that is not on the list", async () => {
  const env = testEnv();
  for (const argv0 of ["/bin/sh", "python3", "curl", "sudo"]) {
    const r = await run(["pty-spawn", env.hq, "--", argv0], { hqRoot: env.hq });
    assert.equal(r.code, 2, `${argv0} should be refused`);
    assert.match(r.stderr, /argv0 not allowed/);
  }
  cleanup(env.dir);
});

test("pty-spawn refuses an argv with no -- separator and an empty argv", async () => {
  const env = testEnv();
  const a = await run(["pty-spawn", env.hq, "bash"], { hqRoot: env.hq });
  assert.equal(a.code, 2);
  assert.match(a.stderr, /wants -- before the argv/);
  const b = await run(["pty-spawn", env.hq, "--"], { hqRoot: env.hq });
  assert.equal(b.code, 2);
  assert.match(b.stderr, /empty argv/);
  cleanup(env.dir);
});

test("pty-spawn refuses environment that decides where code comes from", async () => {
  const env = testEnv();
  for (const kv of ["PATH=/evil/bin", "LD_PRELOAD=/evil.so", "NODE_OPTIONS=--require=/evil.js", "SUDO_ASKPASS=/evil"]) {
    const r = await run(["pty-spawn", env.hq, "--env", kv, "--", "bash"], { hqRoot: env.hq });
    assert.equal(r.code, 2, `${kv} should be refused`);
    assert.match(r.stderr, /env not allowed/);
  }
  cleanup(env.dir);
});

test("pty-spawn runs an allowlisted argv in the requested directory with the allowed env", async () => {
  const env = testEnv();
  const sub = path.join(env.hq, "rigs", "demo");
  fs.mkdirSync(sub, { recursive: true });
  const r = await run(
    [
      "pty-spawn",
      sub,
      "--env",
      "HQ_BEAD=hq-njiu",
      "--env",
      "TERM=xterm-256color",
      "--",
      "bash",
      "-c",
      "pwd; echo bead=$HQ_BEAD; echo term=$TERM; echo home=$HOME",
    ],
    { hqRoot: env.hq },
  );
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^${fs.realpathSync(sub)}`, "m"));
  assert.match(r.stdout, /bead=hq-njiu/);
  assert.match(r.stdout, /term=xterm-256color/);
  assert.match(r.stdout, /home=\/home\/owner/);
  cleanup(env.dir);
});

test("the tmux verbs refuse anything that is not a pane id", async () => {
  for (const bad of ["7", "%7; rm -rf /", "$(whoami)", "-t", ""]) {
    for (const verb of ["tmux-capture", "tmux-unpipe", "tmux-send"]) {
      const r = await run([verb, bad]);
      assert.equal(r.code, 2, `${verb} ${bad} should be refused`);
      assert.match(r.stderr, /bad pane id/);
    }
  }
});

test("tmux-pipe only accepts an existing FIFO under a runner-owned root", async () => {
  const cases = [
    ["/tmp/not-a-runner-dir/x.fifo", /not a runner FIFO/],
    ["/etc/passwd", /not a runner FIFO/],
    ["", /not a runner FIFO/],
  ];
  for (const [p, re] of cases) {
    const r = await run(["tmux-pipe", "%7", p]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, re);
  }
  // a regular file inside an allowed root is still not a FIFO
  const dir = "/tmp/hqconsole-panes";
  fs.mkdirSync(dir, { recursive: true, mode: 0o711 });
  const plain = path.join(dir, `plain-${process.pid}.fifo`);
  fs.writeFileSync(plain, "");
  const r = await run(["tmux-pipe", "%7", plain]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not a runner FIFO/);
  fs.unlinkSync(plain);
});

test("an unknown verb is still refused, and claude-meta is gated (see wrapper-meta.test.js)", async () => {
  const a = await run(["pty-spawn-please"]);
  assert.equal(a.code, 2);
  assert.match(a.stderr, /verb not allowed/);
  // no sid: refused at the argv gate; a sid on an unprovisioned box: refused by meta-check
  const b = await run(["claude-meta"]);
  assert.equal(b.code, 2);
  assert.match(b.stderr, /wants exactly one sid/);
  // Point the meta dir at a path that does not exist, so the case is independent of
  // whether THIS box has a provisioned /var/lib/hqconsole/meta (on a provisioned box
  // meta-check passes and the verb would really exec claude).
  const c = await run(["claude-meta", "s1abc"], { hqRoot: "/home/owner/hq", env: { HQ_META_DIR: "/nonexistent-hqconsole-meta" } });
  assert.equal(c.code, 2);
  assert.match(c.stderr, /refused by meta-check|meta-check failed/);
});

test("term-fg takes exactly one term name and nothing else", async () => {
  for (const args of [[], ["bash"], ["hqt-a;id"], ["%1"], ["hqt-abc", "extra"], ["hqt-"]]) {
    const r = await run(["term-fg", ...args]);
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.match(r.stderr, /term-fg wants one term name/);
  }
});
