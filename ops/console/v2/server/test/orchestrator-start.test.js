// POST /api/session/new {role: "orchestrator"} (bead hq-4npjr.11): one click on Now
// starts the orchestrator chat terminal in ~/hq on the decide model from
// ops/config/orchestrator.json, names its card orchestrator, and refuses a second.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startTestApp } from "./helpers.js";
import { chatModel, orchestratorSeed } from "../src/orchestrator.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeRunner(socketPath) {
  const requests = [];
  const sockets = new Set();
  let n = 0;
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        requests.push(msg);
        let reply = { ok: true };
        if (msg.op === "hello") reply = { ok: true, protocol: 1, release: "r", state: "serving", sessions: [] };
        else if (msg.op === "list") reply = { ok: true, sessions: [] };
        else if (msg.op === "spawn") reply = { ok: true, sid: `sN${++n}` };
        sock.write(JSON.stringify({ id: msg.id, ...reply }) + "\n");
      }
    });
  });
  return {
    requests,
    listen: () => new Promise((r) => server.listen(socketPath, r)),
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

function fakeWrapper() {
  const calls = [];
  return { calls, call: async (verb, args) => (calls.push([verb, ...args]), { code: 0, stdout: "", stderr: "" }) };
}

async function setup({ config = { models: { decide: "claude-fable-5-1", triage: "claude-sonnet-5-5" } }, terminals = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-orch-start-"));
  const sockPath = path.join(dir, "runner.sock");
  const hqRoot = path.join(dir, "hq");
  fs.mkdirSync(path.join(hqRoot, "ops", "config"), { recursive: true });
  if (config !== null) fs.writeFileSync(path.join(hqRoot, "ops", "config", "orchestrator.json"), JSON.stringify(config));
  const runner = fakeRunner(sockPath);
  await runner.listen();
  const wrapper = fakeWrapper();
  const ctlState = async () => ({ terminals, requests: [], snoozed: [], phases: {}, tasks: {}, usage: {} });
  const t = await startTestApp({ hqRoot, wrapper, sources: { ctlState }, env: { CONSOLE_RUNNER_SOCKET: sockPath } });
  for (let i = 0; i < 50 && !t.app.runnerClient.connected; i++) await wait(20);
  const post = (body) => t.request("POST", "/api/session/new", { body, headers: { "x-console-key": t.key } });
  return {
    t,
    runner,
    wrapper,
    hqRoot,
    post,
    spawns: () => runner.requests.filter((m) => m.op === "spawn"),
    async close() {
      await t.close();
      await runner.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("orchestrator start: spawns claude in ~/hq on the decide model with the orchestrator seed, and names the card", async () => {
  const s = await setup();
  try {
    const r = await s.post({ kind: "interactive", role: "orchestrator", rig: "acme-dashboard" });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.role, "orchestrator");
    assert.equal(r.json.model, "claude-fable-5-1");
    const [spawn] = s.spawns();
    assert.equal(spawn.cwd, s.hqRoot, "the orchestrator lives in ~/hq whatever rig the page had open");
    assert.deepEqual(spawn.argv.slice(0, 4), ["claude", "--dangerously-skip-permissions", "--model", "claude-fable-5-1"]);
    // Remote Control named like the card, so the app and the console agree (hq-7fs2u).
    assert.deepEqual(spawn.argv.slice(4, 7), ["--remote-control", "orchestrator", "--session-id"]);
    assert.match(spawn.argv[7], /^[0-9a-f-]{36}$/);
    assert.equal(spawn.argv.length, 9);
    assert.match(spawn.argv[8], /ops\/templates\/orchestrator\.md/);
    assert.match(spawn.argv[8], /Chat terminal form/);
    assert.doesNotMatch(spawn.argv[8], /short label for what you are working on/, "the generic seed would rename the card");
    assert.deepEqual(spawn.resumeArgv, [
      "claude", "--dangerously-skip-permissions", "--model", "claude-fable-5-1",
      "--remote-control", "orchestrator", "--resume", spawn.argv[7],
    ]);
    assert.equal(spawn.rig ?? null, null);
    assert.deepEqual(spawn.env, { HQ_CONSOLE_ROLE: "orchestrator" }, "the delegate hook keys on this (hq-4npjr.26)");
    for (let i = 0; i < 50 && s.wrapper.calls.length < 2; i++) await wait(10);
    assert.deepEqual(s.wrapper.calls[0], ["ctl", "register-term", r.json.sid]);
    assert.deepEqual(s.wrapper.calls[1], ["ctl", "name", r.json.sid, "orchestrator"]);
  } finally {
    await s.close();
  }
});

test("orchestrator start: a second click while the first is starting is refused, no second spawn", async () => {
  const s = await setup();
  try {
    assert.equal((await s.post({ role: "orchestrator" })).status, 201);
    const again = await s.post({ role: "orchestrator" });
    assert.equal(again.status, 409, again.text);
    assert.match(again.json.error, /starting/);
    assert.equal(s.spawns().length, 1);
    // a plain terminal is not held up by it
    assert.equal((await s.post({ kind: "interactive" })).status, 201);
  } finally {
    await s.close();
  }
});

test("orchestrator start: refused while a live session is named orchestrator; a dead one does not block", async () => {
  const live = await setup({ terminals: [{ id: "s-0001", kind: "console-term", status: "active", name: "orchestrator", pane_live: true, last_seen: new Date().toISOString() }] });
  try {
    const r = await live.post({ role: "orchestrator" });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.sid, "s-0001");
    assert.equal(live.spawns().length, 0);
  } finally {
    await live.close();
  }
  const dead = await setup({ terminals: [{ id: "s-0002", kind: "console-term", status: "done", name: "orchestrator" }] });
  try {
    const r = await dead.post({ role: "orchestrator" });
    assert.equal(r.status, 201, `a crashed or ended orchestrator restarts with one click: ${r.text}`);
  } finally {
    await dead.close();
  }
});

test("orchestrator start: no valid decide model refuses, never falls back to a silent Opus", async () => {
  for (const config of [null, { models: {} }, { models: { decide: "fable; rm -rf /" } }]) {
    const s = await setup({ config });
    try {
      const r = await s.post({ role: "orchestrator" });
      assert.equal(r.status, 500, r.text);
      assert.match(r.json.error, /models\.decide/);
      assert.equal(s.spawns().length, 0);
    } finally {
      await s.close();
    }
  }
});

test("session/new: an unknown role is a 400; no role keeps the Opus console terminal", async () => {
  const s = await setup();
  try {
    assert.equal((await s.post({ role: "admin" })).status, 400);
    assert.equal((await s.post({ kind: "interactive" })).status, 201);
    assert.deepEqual(s.spawns()[0].argv.slice(2, 4), ["--model", "claude-opus-5-5"]);
    assert.equal(s.spawns()[0].env, undefined, "a plain terminal carries no orchestrator role");
    assert.ok(!s.spawns()[0].argv.includes("--remote-control"), "only the orchestrator terminal gets Remote Control");
    assert.ok(!s.spawns()[0].resumeArgv.includes("--remote-control"), "nor on resume");
    assert.equal(s.spawns()[0].argv[4], "--session-id");
    for (let i = 0; i < 50 && s.wrapper.calls.length < 1; i++) await wait(10);
    await wait(30);
    assert.equal(s.wrapper.calls.filter((c) => c[1] === "name").length, 0);
  } finally {
    await s.close();
  }
});

test("chatModel and orchestratorSeed read the real repo config and template paths", () => {
  const hq = path.resolve(import.meta.dirname, "../../../../..");
  assert.match(chatModel(hq) || "", /^claude-/);
  assert.ok(fs.existsSync(path.join(hq, "ops", "templates", "orchestrator.md")));
  assert.match(orchestratorSeed("/x/hq"), /\/x\/hq\/ops\/templates\/orchestrator\.md/);
});
