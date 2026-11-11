// The tmux adapter, driven through a fake wrapper script that emulates the
// five verbs the real spawn-as-owner.sh gained: list, capture, pipe, unpipe,
// send. The FIFO, the pipe ownership and the death poll are all real.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Manager } from "../src/manager.js";
import { WrapperClient } from "../src/wrapper.js";
import { parsePanes, TmuxSession } from "../src/tmux.js";
import { cleanup, fakeFactory, testEnv, wait, writeFakeWrapper, writePanes } from "./helpers.js";

function rig(over = {}) {
  const env = testEnv(over);
  const wrapperPath = writeFakeWrapper(env.dir);
  const cfg = { ...env.cfg, wrapperPath, wrapperSudo: false };
  writePanes(env.dir, [{ pane: "%7", cmd: "claude", cols: 120, rows: 40 }, { pane: "%8" }]);
  const wrapper = new WrapperClient(cfg);
  const manager = new Manager({ cfg, factory: fakeFactory(), wrapper, log: () => {} }).init();
  return { ...env, cfg, wrapper, manager, done: () => cleanup(env.dir) };
}

test("parsePanes reads the wrapper's tab-separated inventory", () => {
  const rows = parsePanes("%3\twork\t1\t0\t0\tclaude\t120\t40\tworker\n\nnot a pane\n%4\twork\t1\t1\t1\tbash\t80\t24\t\n");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    pane: "%3",
    session: "work",
    window: "1",
    index: "0",
    dead: false,
    cmd: "claude",
    cols: 120,
    rows: 40,
    title: "worker",
  });
  assert.equal(rows[1].dead, true);
});

test("attaching to a pane id adopts it, seeds from capture-pane and streams the FIFO", async () => {
  const t = rig();
  const a = await t.manager.attach("%7", { cols: 80, rows: 24 });
  assert.match(a.replay, /seed for %7/);
  assert.equal(a.kind, "tmux");
  assert.equal(a.cols, 120, "a tmux pane reports its own geometry, the console does not resize it");
  assert.equal(a.writable, false, "adopted read-only by default");

  const streamed = new Promise((r) => t.manager.once("data", r));
  const ev = await streamed;
  assert.equal(ev.sid, "%7");
  assert.match(ev.data, /live from %7/);

  // the pipe is owned while somebody is attached
  assert.equal(fs.existsSync(path.join(t.dir, "piped")), true);
  const fifo = fs.readFileSync(path.join(t.dir, "piped"), "utf8").trim();
  assert.ok(fifo.startsWith(t.cfg.fifoDir), "the FIFO lives in the runner's own directory");
  // hq-an7jw.24: neither the directory nor the FIFO grants "other" anything,
  // so a third local account can neither reach nor write the pipe.
  assert.equal(fs.statSync(t.cfg.fifoDir).mode & 0o007, 0, "the FIFO dir grants other nothing");
  assert.equal(fs.statSync(fifo).mode & 0o007, 0, "the FIFO grants other nothing");
  assert.equal(fs.statSync(fifo).mode & 0o777, 0o620, "owner reads, the group (owner) writes");

  // a second attach reuses the same stream
  await t.manager.attach("%7", { cols: 80, rows: 24 });
  assert.equal(fs.readFileSync(path.join(t.dir, "piped"), "utf8").trim(), fifo);

  await t.manager.detach("%7");
  assert.equal(fs.existsSync(path.join(t.dir, "piped")), true, "still one attacher left");
  await t.manager.detach("%7");
  assert.equal(fs.existsSync(path.join(t.dir, "piped")), false, "last one out stops the pipe");
  assert.equal(fs.existsSync(fifo), false, "and removes the FIFO");
  t.done();
});

for (const [label, prep] of [
  ["grants other access", (dir) => fs.mkdirSync(dir, { mode: 0o755 }) || fs.chmodSync(dir, 0o711)],
  ["is a symlink", (dir) => fs.mkdirSync(dir + "-real", { mode: 0o700 }) || fs.symlinkSync(dir + "-real", dir)],
]) {
  test(`a FIFO dir that ${label} is refused, not repaired`, async () => {
    const logs = [];
    const env = testEnv();
    prep(env.cfg.fifoDir);
    const before = fs.lstatSync(env.cfg.fifoDir).mode;
    const wrapperPath = writeFakeWrapper(env.dir);
    const cfg = { ...env.cfg, wrapperPath, wrapperSudo: false };
    writePanes(env.dir, [{ pane: "%7", cmd: "claude", cols: 120, rows: 40 }]);
    const wrapper = new WrapperClient(cfg);
    const manager = new Manager({ cfg, factory: fakeFactory(), wrapper, log: (m) => logs.push(String(m)) }).init();
    const a = await manager.attach("%7", { cols: 80, rows: 24 });
    assert.match(a.replay, /seed for %7/, "the attach still seeds from capture-pane");
    assert.equal(fs.existsSync(path.join(env.dir, "piped")), false, "no pipe into an unsafe dir");
    assert.equal(fs.lstatSync(env.cfg.fifoDir).mode, before, "the runner does not chmod the dir");
    assert.ok(logs.some((m) => /FIFO dir/.test(m)), `refusal is logged: ${logs.join(" | ")}`);
    await manager.detach("%7");
    cleanup(env.dir);
  });
}

test("a read-only pane refuses input, a writable one sends keys", async () => {
  const t = rig();
  await t.manager.attach("%7", { cols: 80, rows: 24 });
  await assert.rejects(() => t.manager.input("%7", "ls\r"), (e) => e.code === "read-only");

  await t.manager.spawn({ kind: "tmux", pane: "%8", writable: true });
  await t.manager.input("%8", "ls\r");
  assert.equal(fs.readFileSync(path.join(t.dir, "sent"), "utf8"), "ls\r");
  t.done();
});

test("a pane that disappears ends the session", async () => {
  const t = rig();
  await t.manager.attach("%7", { cols: 80, rows: 24 });
  const exited = new Promise((r) => t.manager.once("exit", r));
  writePanes(t.dir, [{ pane: "%8" }]);
  const ev = await exited;
  assert.equal(ev.sid, "%7");
  assert.equal(ev.code, null);
  assert.equal(t.manager.list()[0].endedBy, "pane gone");
  t.done();
});

test("a dead pane cannot be adopted at all", async () => {
  const t = rig();
  writePanes(t.dir, [{ pane: "%9", dead: true }]);
  await assert.rejects(() => t.manager.attach("%9", {}), (e) => e.code === "no such session");
  await assert.rejects(() => t.manager.attach("%404", {}), (e) => e.code === "no such session");
  t.done();
});

test("kill is refused for a pane the runner does not own", async () => {
  const t = rig();
  await t.manager.attach("%7", {});
  assert.throws(() => t.manager.kill("%7"), (e) => e.code === "kill not supported for tmux panes");
  t.done();
});

test("a bad pane id never reaches a tmux command line", async () => {
  const t = rig();
  await assert.rejects(() => t.manager.spawn({ kind: "tmux", pane: "%7; rm -rf /" }), (e) => e.code === "bad pane id");
  const s = new TmuxSession({ cfg: t.cfg, wrapper: t.wrapper, sid: "$(whoami)" });
  await assert.rejects(() => s.start(), (e) => e.code === "bad pane id");
  t.done();
});

test("an adopted hq:work pane is never redrawn by term.redraw", async () => {
  const t = rig();
  await t.manager.attach("%7", { cols: 80, rows: 24 });
  assert.throws(() => t.manager.redrawTerm("%7"), (e) => e.code === "not a console terminal");
  await t.manager.detach("%7");
  t.done();
});
