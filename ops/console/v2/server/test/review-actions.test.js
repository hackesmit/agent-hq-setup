// Adversarial review probes (hq-px56): action bodies reach the wrapper as
// argv elements, never a shell; op ids replay idempotently.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startTestApp, tmpDir } from "./helpers.js";

function recordingRunner(calls, code = 0) {
  return async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { code, stdout: "ok\n", stderr: "" };
  };
}

test("rid with spaces or shell metacharacters is rejected before any process starts", async () => {
  const calls = [];
  const t = await startTestApp({ runner: recordingRunner(calls) });
  try {
    for (const rid of ["r 1", "r;id", "$(id)", "`id`", "r|x", "r&&x", "../x", "r\nx", "", "a".repeat(65), "r'x", 'r"x']) {
      const r = await t.request("POST", "/api/done", { headers: { "x-console-key": t.key }, body: { rid } });
      assert.equal(r.status, 400, `rid ${JSON.stringify(rid)} must be a 400, got ${r.status}`);
    }
    assert.equal(calls.length, 0);
  } finally {
    await t.close();
  }
});

test("free text with metacharacters, newlines and quotes reaches the wrapper as ONE argv element under bash/sudo, never sh -c", async () => {
  const calls = [];
  const t = await startTestApp({ runner: recordingRunner(calls) });
  try {
    const nasty = "yes; rm -rf / && $(curl evil) `id` | tee x > y\n\"quoted\" 'single' \\ $HOME ${HOME} %s";
    let r = await t.request("POST", "/api/answer", { headers: { "x-console-key": t.key }, body: { rid: "hq-abc", text: nasty } });
    assert.equal(r.status, 202, r.text);
    r = await t.request("POST", "/api/session/s-1/name", { headers: { "x-console-key": t.key }, body: { name: nasty.slice(0, 100) } });
    assert.equal(r.status, 202, r.text);
    r = await t.request("POST", "/api/phase", { headers: { "x-console-key": t.key }, body: { bead: "hq-abc", phase: nasty.slice(0, 100) } });
    assert.equal(r.status, 202, r.text);
    r = await t.request("POST", "/api/capture", { headers: { "x-console-key": t.key }, body: { rig: "hq", title: "plain title", body: nasty } });
    assert.equal(r.status, 202, r.text);
    r = await t.request("POST", "/api/skip", { headers: { "x-console-key": t.key }, body: { rid: "hq-abc", reason: nasty } });
    assert.equal(r.status, 202, r.text);
    assert.equal(calls.length, 5);
    for (const c of calls) {
      assert.ok(c.cmd === "bash" || c.cmd === "sudo", `cmd ${c.cmd}`);
      assert.ok(!c.args.some((a) => /(^|\s)-c(\s|$)/.test(a) && a.length < 3), "no shell -c");
      assert.ok(!c.args.some((a) => a === "sh" || a === "-c"), `shell in argv: ${JSON.stringify(c.args)}`);
      // the wrapper script is the first non-sudo argument
      const i = c.cmd === "sudo" ? 4 : 1;
      assert.match(c.args[i - 1], /spawn-as-owner\.sh$/);
      // exactly one argv element carries the nasty payload, unchanged
      const carriers = c.args.filter((a) => a.includes("rm -rf /"));
      assert.equal(carriers.length, 1, JSON.stringify(c.args));
      assert.ok(carriers[0].includes("\n") || carriers[0].length <= 100, "payload must be passed verbatim, newline included");
    }
    // the answer text is verbatim
    assert.equal(calls[0].args.at(-1), nasty);
    // review note (MINOR): Ops.start runs the argv directly, so unlike
    // Wrapper.call it passes no HQ_ROOT; the wrapper then falls back to its
    // built-in default. Nothing beyond HQ_ROOT may ever be injected.
    const envKeys = Object.keys((calls[0].opts && calls[0].opts.env) || {});
    assert.ok(envKeys.every((k) => k === "HQ_ROOT"), envKeys.join(","));
  } finally {
    await t.close();
  }
});

test("idempotent op replay: the same op id runs the wrapper once and returns the stored record (200) the second time", async () => {
  const calls = [];
  const state = tmpDir();
  const t = await startTestApp({ stateDir: state, runner: recordingRunner(calls) });
  try {
    const body = { rid: "hq-abc", op: "op-review-1" };
    const r1 = await t.request("POST", "/api/done", { headers: { "x-console-key": t.key }, body });
    assert.equal(r1.status, 202);
    assert.equal(r1.json.id, "op-review-1");
    // wait for the op to settle
    await t.app.ops.pending;
    const r2 = await t.request("POST", "/api/done", { headers: { "x-console-key": t.key }, body });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.id, "op-review-1");
    assert.equal(r2.json.state, "done");
    // replay under a DIFFERENT verb with the same op id must not run either
    const r3 = await t.request("POST", "/api/resolve", { headers: { "x-console-key": t.key }, body });
    assert.equal(r3.status, 200);
    assert.equal(r3.json.verb, "done");
    assert.equal(calls.length, 1);
    // and the record is on disk
    const rec = JSON.parse(fs.readFileSync(path.join(t.cfg.opsDir, "op-review-1.json"), "utf8"));
    assert.equal(rec.state, "done");
    // a bad op id is refused, not used as a filename
    const r4 = await t.request("POST", "/api/done", { headers: { "x-console-key": t.key }, body: { rid: "hq-abc", op: "../../etc/x" } });
    assert.equal(r4.status, 400);
    assert.equal(fs.existsSync(path.join(t.cfg.opsDir, "..", "..", "etc", "x.json")), false);
    // GET /api/op/<traversal> is a 404, never a file read outside ops/
    const r5 = await t.request("GET", "/api/op/..%2F..%2Fetc%2Fx");
    assert.equal(r5.status, 404);
  } finally {
    await t.close();
  }
});

test("CSRF: POST without the key, with a wrong key, or with a wrong-length key is 403 and runs nothing; GET needs no key", async () => {
  const calls = [];
  const t = await startTestApp({ runner: recordingRunner(calls) });
  try {
    for (const headers of [{}, { "x-console-key": "nope" }, { "x-console-key": t.key + "x" }, { "x-console-key": t.key.slice(1) }]) {
      const r = await t.request("POST", "/api/done", { headers, body: { rid: "hq-abc" } });
      assert.equal(r.status, 403);
      assert.equal(r.json.reload, true);
    }
    const w = await t.request("POST", "/api/ws-token", { headers: {}, body: {} });
    assert.equal(w.status, 403);
    assert.equal(calls.length, 0);
    assert.equal(t.app.tokens.size, 0, "no token minted without the CSRF key");
    // origin present but foreign is refused even with the key
    const o = await t.request("POST", "/api/ws-token", { headers: { "x-console-key": t.key, origin: "https://evil.example.com" }, body: {} });
    assert.equal(o.status, 403);
    assert.equal(t.app.tokens.size, 0);
  } finally {
    await t.close();
  }
});

test("dispatch: unknown rig, unknown model, and a bead id with a space are all refused before the wrapper", async () => {
  const calls = [];
  const t = await startTestApp({ runner: recordingRunner(calls) });
  try {
    const H = { "x-console-key": t.key };
    assert.equal((await t.request("POST", "/api/dispatch", { headers: H, body: { bead: "hq-1", rig: "notarig", model: "claude-opus-4-8" } })).status, 400);
    assert.equal((await t.request("POST", "/api/dispatch", { headers: H, body: { bead: "hq-1", rig: "hq", model: "gpt-9" } })).status, 400);
    assert.equal((await t.request("POST", "/api/dispatch", { headers: H, body: { bead: "hq 1", rig: "hq", model: "claude-opus-4-8" } })).status, 400);
    assert.equal((await t.request("POST", "/api/dispatch-batch", { headers: H, body: { beads: "a,b,c,d,e,f,g,h,i", rig: "hq", model: "claude-opus-4-8" } })).status, 400);
    assert.equal(calls.length, 0);
  } finally {
    await t.close();
  }
});

test("op records are a replay guard, not an archive: old ones are swept from disk too", async () => {
  const { Ops } = await import("../src/actions.js");
  const dir = tmpDir();
  let clock = Date.parse("2026-08-20T12:00:00Z");
  const ops = new Ops({ dir, now: () => clock, runner: async () => ({ code: 0, stdout: "", stderr: "" }) });

  const day = 24 * 60 * 60 * 1000;
  const write = (id, finishedAt, state = "done") =>
    ops.write({ id, verb: "focus", state, startedAt: finishedAt, finishedAt, output: null });

  write("op-old", new Date(clock - 30 * day).toISOString());
  write("op-recent", new Date(clock - 1 * day).toISOString());
  write("op-running", new Date(clock - 30 * day).toISOString(), "running");

  // the sweep must reach files this process never read back, so forget everything
  ops.mem.clear();
  const removed = ops.prune();

  assert.equal(removed, 1, "exactly the expired record went");
  assert.equal(fs.existsSync(path.join(dir, "op-old.json")), false, "the old record is off disk");
  assert.ok(fs.existsSync(path.join(dir, "op-recent.json")), "a record inside the window stays");
  // A running op is never swept however old it is: losing its record is exactly
  // the double-execution the record exists to prevent.
  assert.ok(fs.existsSync(path.join(dir, "op-running.json")), "a running op is kept");

  // and the replay guard still works for what survived
  assert.ok(ops.read("op-recent"), "a surviving record still reads back");
  assert.equal(ops.read("op-old"), null);
});

