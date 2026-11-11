// End to end over a real loopback socket in dev mode: the gate, healthz, the
// state routes, CSRF, ws-token minting and one action through a fake runner.

import test from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "../src/protocol.js";
import { startTestApp } from "./helpers.js";

test("healthz reports release, protocol and per-collector health", async () => {
  const t = await startTestApp();
  try {
    const r = await t.request("GET", "/healthz");
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.protocol, PROTOCOL_VERSION);
    assert.equal(r.json.release, "dev"); // no release dir in the test
    assert.equal(typeof r.json.checks.collectors, "number");
    assert.deepEqual(r.json.checks.collectorErrors, []);
    assert.equal(r.json.checks.staticRoot, false);
  } finally {
    await t.close();
  }
});

test("GET /api/state returns the contract shape with badges", async () => {
  const t = await startTestApp({
    sources: {
      ctlState: async () => ({
        terminals: [{ id: "t-1", kind: "worker", status: "active", rig: "hq", started: "2026-08-18T09:00:00Z" }],
        requests: [{ id: "r-1", question: "decide", status: "open", ts: "2026-08-18T09:00:00Z", sev: "P1" }],
        tasks: {},
      }),
    },
  });
  try {
    const r = await t.request("GET", "/api/state");
    assert.equal(r.status, 200);
    assert.equal(r.json.version.protocol, PROTOCOL_VERSION);
    assert.equal(r.json.owner, "owner@example.com");
    assert.equal(r.json.sessions.length, 1);
    assert.equal(r.json.badges.now, 1);
    assert.equal(r.json.badges.nowSeverity, "P1");
    assert.ok(Array.isArray(r.json.collectors));
    const slice = await t.request("GET", "/api/state/sessions");
    assert.equal(slice.json.slice, "sessions");
    assert.equal((await t.request("GET", "/api/state/nope")).status, 404);
  } finally {
    await t.close();
  }
});

test("a wrong Host is refused even from an authorized connection", async () => {
  const t = await startTestApp();
  try {
    const r = await t.request("GET", "/healthz", { headers: { host: "evil.example.com" } });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "bad host");
  } finally {
    await t.close();
  }
});

test("POST without the boot key is 403 with reload:true", async () => {
  const t = await startTestApp();
  try {
    const r = await t.request("POST", "/api/ws-token", { body: {} });
    assert.equal(r.status, 403);
    assert.equal(r.json.reload, true);
    const stale = await t.request("POST", "/api/ws-token", { body: {}, headers: { "x-console-key": "stale" } });
    assert.equal(stale.status, 403);
    assert.equal(stale.json.reload, true);
  } finally {
    await t.close();
  }
});

test("POST with a foreign Origin is refused before the key is even checked", async () => {
  const t = await startTestApp();
  try {
    const r = await t.request("POST", "/api/ws-token", {
      body: {},
      headers: { "x-console-key": t.key, origin: "https://evil.example.com" },
    });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, "bad origin");
  } finally {
    await t.close();
  }
});

test("ws-token mints a 30 second token over an authorized connection", async () => {
  const t = await startTestApp();
  try {
    const r = await t.request("POST", "/api/ws-token", { body: {}, headers: { "x-console-key": t.key } });
    assert.equal(r.status, 200);
    assert.equal(r.json.expiresInS, 30);
    assert.ok(r.json.token.length >= 32);
    assert.equal(t.app.tokens.size, 1);
  } finally {
    await t.close();
  }
});

test("an action shells out through the verb table and records an op", async () => {
  const calls = [];
  const t = await startTestApp({
    runner: async (cmd, args) => {
      calls.push([cmd, args]);
      return { code: 0, stdout: "answered r-1", stderr: "" };
    },
  });
  try {
    const r = await t.request("POST", "/api/answer", {
      body: { rid: "r-1", text: "go ahead", op: "op-test1" },
      headers: { "x-console-key": t.key },
    });
    assert.equal(r.status, 202);
    assert.equal(r.json.id, "op-test1");
    assert.equal(r.json.verb, "answer");
    assert.equal(r.json.state, "running");
    await t.app.ops.pending;

    const done = await t.request("GET", "/api/op/op-test1");
    assert.equal(done.json.state, "done");
    assert.equal(done.json.output, "answered r-1");

    // dev mode: bash <wrapper> ctl answer <rid> <text>, an argument array with
    // the answer as one element, never a shell string
    assert.equal(calls[0][0], "bash");
    assert.ok(calls[0][1][0].endsWith("ops/console/v2/runner/spawn-as-owner.sh"));
    assert.deepEqual(calls[0][1].slice(1), ["ctl", "answer", "r-1", "go ahead"]);

    // replaying the same op id does not run the verb twice
    const replay = await t.request("POST", "/api/answer", {
      body: { rid: "r-1", text: "go ahead", op: "op-test1" },
      headers: { "x-console-key": t.key },
    });
    assert.equal(replay.status, 200);
    assert.equal(calls.length, 1);
  } finally {
    await t.close();
  }
});

test("a session verb routes through /api/session/:id/:verb", async () => {
  const calls = [];
  const t = await startTestApp({
    runner: async (cmd, args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  try {
    const r = await t.request("POST", "/api/session/t-4526/kill", { body: {}, headers: { "x-console-key": t.key } });
    assert.equal(r.status, 202);
    await t.app.ops.pending;
    assert.deepEqual(calls[0].slice(1), ["ctl", "kill", "t-4526"]);
    const bad = await t.request("POST", "/api/session/t-4526/rm-rf", { body: {}, headers: { "x-console-key": t.key } });
    assert.equal(bad.status, 404);
  } finally {
    await t.close();
  }
});

test("bad input is refused before anything is executed", async () => {
  const calls = [];
  const t = await startTestApp({
    runner: async (cmd, args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const key = { "x-console-key": t.key };
  try {
    assert.equal((await t.request("POST", "/api/answer", { body: { rid: "r 1; rm -rf /", text: "x" }, headers: key })).status, 400);
    assert.equal((await t.request("POST", "/api/answer", { body: { rid: "r-1", text: "  " }, headers: key })).status, 400);
    assert.equal((await t.request("POST", "/api/dispatch", { body: { bead: "hq-1", rig: "hq", model: "gpt-4" }, headers: key })).status, 400);
    assert.equal((await t.request("POST", "/api/dispatch", { body: { bead: "hq-1", rig: "not-a-rig" }, headers: key })).status, 400);
    assert.equal((await t.request("POST", "/api/req-snooze", { body: { rid: "r-1", until: "tomorrow; reboot" }, headers: key })).status, 400);
    assert.equal(
      (await t.request("POST", "/api/dispatch-batch", { body: { rig: "hq", beads: "a,b,c,d,e,f,g,h,i" }, headers: key })).status,
      400,
    );
    assert.equal((await t.request("POST", "/api/nonsense", { body: {}, headers: key })).status, 404);
    assert.equal(calls.length, 0);
  } finally {
    await t.close();
  }
});

test("alerts can be acked and the slice refreshes", async () => {
  const t = await startTestApp();
  try {
    t.app.alerts.add({ id: "cert-expiry", severity: "P0", title: "cert expires soon", source: "cert" });
    const state = await t.request("GET", "/api/state");
    assert.equal(state.json.alerts.length, 1);
    const ack = await t.request("POST", "/api/alerts/cert-expiry/ack", { body: {}, headers: { "x-console-key": t.key } });
    assert.equal(ack.json.ok, true);
    assert.equal((await t.request("POST", "/api/alerts/nope/ack", { body: {}, headers: { "x-console-key": t.key } })).status, 404);
  } finally {
    await t.close();
  }
});

test("unknown methods and unknown api paths are rejected", async () => {
  const t = await startTestApp();
  try {
    assert.equal((await t.request("DELETE", "/api/state")).status, 405);
    assert.equal((await t.request("GET", "/api/whatever")).status, 404);
    assert.equal((await t.request("GET", "/index.html")).status, 404); // no release published
  } finally {
    await t.close();
  }
});
