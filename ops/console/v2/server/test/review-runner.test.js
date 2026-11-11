// Adversarial review probes for the runner bridge (hq-njiu): the console's
// half of the link, exercised against a real unix socket that speaks the
// wire protocol. Only the daemon behind the socket is fake.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { RunnerClient } from "../src/runner-client.js";
import { startTestApp } from "./helpers.js";

// The term handlers refuse a sid no session source can account for (a cache miss
// used to be read as "not the meta session", which let an attach to the uncaged
// terminal skip the passkey). These tests are about framing and references, not
// about the gate, so they declare the sessions they drive rather than leaving the
// handler with nothing to resolve against.
const KNOWN = (sid) => ({ id: sid, kind: sid === "worker1" ? "worker" : "interactive", attachable: true, writable: sid !== "worker1" });


const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeRunner(socketPath, handlers = {}) {
  const requests = [];
  const sockets = new Set();
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
        let reply;
        if (handlers[msg.op]) reply = handlers[msg.op](msg, sock);
        else if (msg.op === "hello") reply = { ok: true, protocol: 1, release: "r", state: "serving", sessions: [] };
        else if (msg.op === "list") reply = { ok: true, sessions: [] };
        else if (msg.op === "spawn") reply = { ok: true, sid: "sNEW" };
        else reply = { ok: true };
        if (reply) sock.write(JSON.stringify({ id: msg.id, ...reply }) + "\n");
      }
    });
  });
  return {
    requests,
    sockets,
    listen: () => new Promise((r) => server.listen(socketPath, r)),
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

test("review: POST /api/session/new spawns claude interactive with the console seed prompt through the runner", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-review-runner-"));
  const sockPath = path.join(dir, "runner.sock");
  // the rig checkout must exist on disk: the route refuses a name with no directory
  const hqRoot = path.join(dir, "hq");
  fs.mkdirSync(path.join(hqRoot, "rigs", "demo"), { recursive: true });
  const runner = fakeRunner(sockPath);
  await runner.listen();
  const t = await startTestApp({ hqRoot, env: { CONSOLE_RUNNER_SOCKET: sockPath } });
  try {
    for (let i = 0; i < 50 && !t.app.runnerClient.connected; i++) await wait(20);
    assert.equal(t.app.runnerClient.connected, true, "client should be connected to the fake runner");
    const r = await t.request("POST", "/api/session/new", { body: { rig: "demo" }, headers: { "x-console-key": t.key } });
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${r.text}`);
    assert.equal(r.json && r.json.sid, "sNEW");
    const spawn = runner.requests.find((m) => m.op === "spawn");
    assert.ok(spawn, "the runner should have received a spawn");
    assert.equal(spawn.kind, "interactive");
    // argv0 stays exactly `claude`; the flag puts the terminal in bypass
    // permissions (never auto, which would stall it on a prompt), and the last
    // argument is the seed prompt that makes the terminal name its console card
    // and ask the owner in its own terminal (ctl ask, then answer --here).
    // The Claude conversation id is pinned (--session-id) so the runner can
    // resume it after a reboot with the matching resumeArgv; persist asks the
    // runner to host the terminal in the hqterm tmux server.
    assert.equal(spawn.argv.length, 7);
    assert.equal(spawn.argv[0], "claude");
    assert.equal(spawn.argv[1], "--dangerously-skip-permissions");
    // console terminals start on Opus 5.5 (the owner, 2026-10-12)
    assert.deepEqual(spawn.argv.slice(2, 4), ["--model", "claude-opus-5-5"]);
    assert.equal(spawn.argv[4], "--session-id");
    assert.match(spawn.argv[5], /^[0-9a-f-]{36}$/);
    assert.match(spawn.argv[6], /name your console card/);
    assert.match(spawn.argv[6], /ask it here in this terminal/);
    assert.match(spawn.argv[6], /answer <req-id> --here/);
    assert.doesNotMatch(spawn.argv[6], /Needs-you/);
    assert.match(spawn.argv[6], /Knowledge\.md/); // rig terminals get the KB prime
    assert.equal(spawn.persist, true);
    assert.deepEqual(spawn.resumeArgv, ["claude", "--dangerously-skip-permissions", "--model", "claude-opus-5-5", "--resume", spawn.argv[5]]);
    assert.equal(spawn.cwd, path.join(t.cfg.hqRoot, "rigs", "demo"));
  } finally {
    await t.close();
    await runner.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review: /api/session/new refuses a project with no checkout on this box, before the runner is asked", async () => {
  // The bug this pins down: a registered project with no directory (a service
  // with path null, e.g. acme-financial) was offered by the picker, the spawn
  // returned 201, and claude died inside the runner on the cd (exit 2) with no
  // error the browser ever saw. The refusal must happen here, with words.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-review-runner-"));
  const sockPath = path.join(dir, "runner.sock");
  const hqRoot = path.join(dir, "hq");
  fs.mkdirSync(path.join(hqRoot, "rigs"), { recursive: true });
  const runner = fakeRunner(sockPath);
  await runner.listen();
  const t = await startTestApp({ hqRoot, env: { CONSOLE_RUNNER_SOCKET: sockPath } });
  try {
    for (let i = 0; i < 50 && !t.app.runnerClient.connected; i++) await wait(20);
    const r = await t.request("POST", "/api/session/new", { body: { rig: "acme-financial" }, headers: { "x-console-key": t.key } });
    assert.equal(r.status, 400, `expected 400, got ${r.status}: ${r.text}`);
    assert.match(String(r.json && r.json.error), /no working directory/);
    assert.equal(runner.requests.filter((m) => m.op === "spawn").length, 0, "the runner must never see the doomed spawn");
  } finally {
    await t.close();
    await runner.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review: /api/session/new resolves a registered project's declared path, and refuses a declared path that is gone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-review-runner-"));
  const sockPath = path.join(dir, "runner.sock");
  const hqRoot = path.join(dir, "hq");
  fs.mkdirSync(path.join(hqRoot, "rigs"), { recursive: true });
  fs.mkdirSync(path.join(hqRoot, "ops", "mail"), { recursive: true });
  fs.writeFileSync(
    path.join(hqRoot, "ops", "projects.json"),
    JSON.stringify({
      version: 1,
      projects: [
        // a service living inside the hq tree: no rigs/ checkout, path declared
        { id: "hq-mail", name: "mail", kind: "service", path: path.join(hqRoot, "ops", "mail") },
        // a declared path that is not on disk any more
        { id: "gone", name: "gone", kind: "service", path: path.join(hqRoot, "ops", "gone") },
        // the shape that started this: a registered project with no path at all
        { id: "acme-financial", name: "xf", kind: "service", path: null },
      ],
    }),
  );
  const runner = fakeRunner(sockPath);
  await runner.listen();
  const t = await startTestApp({ hqRoot, projects: true, env: { CONSOLE_RUNNER_SOCKET: sockPath } });
  try {
    for (let i = 0; i < 50 && !t.app.runnerClient.connected; i++) await wait(20);
    const ok = await t.request("POST", "/api/session/new", { body: { rig: "hq-mail" }, headers: { "x-console-key": t.key } });
    assert.equal(ok.status, 201, `expected 201, got ${ok.status}: ${ok.text}`);
    const spawn = runner.requests.find((m) => m.op === "spawn");
    assert.equal(spawn && spawn.cwd, path.join(hqRoot, "ops", "mail"), "the declared path wins over rigs/<id>");
    for (const rig of ["gone", "acme-financial"]) {
      const r = await t.request("POST", "/api/session/new", { body: { rig }, headers: { "x-console-key": t.key } });
      assert.equal(r.status, 400, `rig ${rig} should be a 400, got ${r.status}: ${r.text}`);
      assert.match(String(r.json && r.json.error), /no working directory/);
    }
    assert.equal(runner.requests.filter((m) => m.op === "spawn").length, 1, "only the real directory reached the runner");
  } finally {
    await t.close();
    await runner.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review: /api/session/new refuses a rig name that could leave rigs/", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-review-runner-"));
  const sockPath = path.join(dir, "runner.sock");
  const runner = fakeRunner(sockPath);
  await runner.listen();
  const t = await startTestApp({ env: { CONSOLE_RUNNER_SOCKET: sockPath } });
  try {
    for (let i = 0; i < 50 && !t.app.runnerClient.connected; i++) await wait(20);
    for (const rig of ["../..", "a/b", "rig;x", "$(id)", "x".repeat(65)]) {
      const r = await t.request("POST", "/api/session/new", { body: { rig }, headers: { "x-console-key": t.key } });
      assert.equal(r.status, 400, `rig ${JSON.stringify(rig)} should be a 400, got ${r.status}: ${r.text}`);
    }
    assert.equal(runner.requests.filter((m) => m.op === "spawn").length, 0);
  } finally {
    await t.close();
    await runner.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("review: term.data that arrives in the same chunk as the attach reply still reaches the browser", async () => {
  // The runner writes the attach reply and then data events on one stream; a
  // busy session lands both in one TCP read. The bridge registers the socket
  // only after the attach promise resolves (a microtask later), so a data
  // line decoded in the same loop iteration finds no attachment.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-review-runner-"));
  const sockPath = path.join(dir, "runner.sock");
  const runner = fakeRunner(sockPath, {
    attach: (msg, sock) => {
      sock.write(
        JSON.stringify({ id: msg.id, ok: true, replay: "", writable: true, cols: 80, rows: 24 }) +
          "\n" +
          JSON.stringify({ event: "data", sid: msg.sid, data: "FIRST" }) +
          "\n",
      );
      return null;
    },
  });
  await runner.listen();
  const { WsLayer, createTokens } = await import("../src/ws.js");
  const { attachTermHandlers } = await import("../src/runner-client.js");
  const client = new RunnerClient({ socketPath: sockPath, backoffMs: [10] }).start();
  for (let i = 0; i < 50 && !client.connected; i++) await wait(20);
  const cfg = { protocol: 1, owner: "x", wsPingMs: 60000, wsTokenTtlMs: 60000 };
  const ws = new WsLayer({ cfg, auth: null, tokens: createTokens({ ttlMs: 60000 }), getHello: async () => ({}), log: () => {} });
  attachTermHandlers({ ws, runner: client, sessions: KNOWN, log: () => {} });
  const sent = [];
  const fakeWs = Object.assign(new (await import("node:events")).EventEmitter(), {
    readyState: 1,
    OPEN: 1,
    send: (s) => sent.push(JSON.parse(s)),
  });
  ws.onMessage(fakeWs, JSON.stringify({ t: "term.attach", sid: "s1", cols: 80, rows: 24 }));
  await wait(200);
  try {
    assert.ok(sent.some((m) => m.t === "term.open"), "term.open expected");
    assert.ok(
      sent.some((m) => m.t === "term.data" && m.data === "FIRST"),
      `the first data frame was lost; got ${JSON.stringify(sent.map((m) => m.t))}`,
    );
  } finally {
    client.stop();
    await runner.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
