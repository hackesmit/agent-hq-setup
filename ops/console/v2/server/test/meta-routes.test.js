// Capri (proposal 19) server routes: /api/meta/new, /api/meta/status, and the WS
// meta-attach capability gate. A fake runner client and a stub passkey gate stand in
// for the real ones (the passkey verification itself is covered by passkey.test.js);
// here we prove the wiring: disabled -> 404, no capability -> 403, a good capability
// spends and spawns, runner refusals map to the right status, and reconcile/integrity
// events become alerts.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { startTestApp } from "./helpers.js";

/** A runner client stand-in: records spawns, scripts meta.capability/status. */
function fakeRunner(over = {}) {
  const e = new EventEmitter();
  e.connected = true;
  e.updatePending = false;
  e.spawns = [];
  e.start = () => {};
  e.stop = () => {};
  e.list = async () => over.list || [];
  e.request = async () => ({ ok: true });
  e.metaCapability = async () => over.capability || { capability: "runner-cap-1", expiresInS: 60 };
  e.metaStatus = async () => over.status || { enabled: true, live: null, unreconciled: [], lastClose: null, capabilities: 0 };
  e.spawn = async (payload) => {
    e.spawns.push(payload);
    if (over.spawnError) {
      const err = new Error(over.spawnError.code);
      err.code = over.spawnError.code;
      err.detail = over.spawnError.detail || null;
      throw err;
    }
    return { sid: "smeta1" };
  };
  return e;
}

/** A passkey gate stand-in: a capability equal to `good` spends once per connection. */
function fakePasskey(good = "GOOD") {
  const spent = new Set();
  return {
    _spent: spent,
    status: () => ({ enabled: true, passkeys: 1, bootstrap: false }),
    spendCapability: (cap) => {
      if (cap !== good || spent.has(cap)) return false;
      spent.add(cap);
      return true;
    },
    validCapability: (cap) => cap === good && !spent.has(cap),
  };
}

async function appWithMeta(over = {}) {
  const runnerClient = fakeRunner(over.runner || {});
  const passkey = over.passkey || fakePasskey();
  const t = await startTestApp({
    env: { CONSOLE_META_ENABLED: over.enabled === false ? "0" : "1", ...(over.env || {}) },
    runnerClient,
    passkey,
  });
  return { t, runnerClient, passkey, key: t.app.csrf.key };
}

test("POST /api/meta/new is 404 when the meta terminal is disabled", async () => {
  const { t, key } = await appWithMeta({ enabled: false });
  try {
    const r = await t.request("POST", "/api/meta/new", { headers: { "x-console-key": key }, body: { capability: "GOOD" } });
    assert.equal(r.status, 404);
  } finally {
    await t.close();
  }
});

test("POST /api/meta/new without a valid passkey capability is 403 and never spawns", async () => {
  const { t, runnerClient, key } = await appWithMeta();
  try {
    const r = await t.request("POST", "/api/meta/new", { headers: { "x-console-key": key }, body: { capability: "BAD" } });
    assert.equal(r.status, 403);
    assert.equal(runnerClient.spawns.length, 0, "no spawn without a capability");
  } finally {
    await t.close();
  }
});

test("POST /api/meta/new with a good capability spends it, mints a runner ticket, and spawns kind=meta", async () => {
  const { t, runnerClient, passkey, key } = await appWithMeta();
  try {
    const r = await t.request("POST", "/api/meta/new", { headers: { "x-console-key": key }, body: { capability: "GOOD" } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.sid, "smeta1");
    assert.equal(runnerClient.spawns.length, 1);
    assert.equal(runnerClient.spawns[0].kind, "meta");
    assert.equal(runnerClient.spawns[0].capability, "runner-cap-1", "the runner's ticket, not the passkey one");
    assert.equal(passkey._spent.has("GOOD"), true, "the passkey capability was spent");
    // the same capability cannot start a second session
    const r2 = await t.request("POST", "/api/meta/new", { headers: { "x-console-key": key }, body: { capability: "GOOD" } });
    assert.equal(r2.status, 403);
    assert.equal(runnerClient.spawns.length, 1);
  } finally {
    await t.close();
  }
});

test("a runner 'already live' refusal maps to 409; a meta-check refusal to 422", async () => {
  {
    const { t, key } = await appWithMeta({ runner: { spawnError: { code: "meta session already live" } } });
    try {
      const r = await t.request("POST", "/api/meta/new", { headers: { "x-console-key": key }, body: { capability: "GOOD" } });
      assert.equal(r.status, 409);
    } finally {
      await t.close();
    }
  }
  {
    const { t, key } = await appWithMeta({ runner: { spawnError: { code: "meta refused", detail: "meta settings writable by this user" } } });
    try {
      const r = await t.request("POST", "/api/meta/new", { headers: { "x-console-key": key }, body: { capability: "GOOD" } });
      assert.equal(r.status, 422);
      assert.match(r.json.detail, /writable/);
    } finally {
      await t.close();
    }
  }
});

test("GET /api/meta/status merges the passkey and runner views", async () => {
  const { t } = await appWithMeta({
    runner: { status: { enabled: true, live: { sid: "smeta1", startedAt: "t" }, unreconciled: [], lastClose: null, capabilities: 0 } },
  });
  try {
    const r = await t.request("GET", "/api/meta/status");
    assert.equal(r.status, 200);
    assert.equal(r.json.enabled, true);
    assert.equal(r.json.passkeys, 1);
    assert.equal(r.json.bootstrap, false);
    assert.equal(r.json.live.sid, "smeta1");
  } finally {
    await t.close();
  }
});

test("a runner meta.reconcile/integrity event becomes an alert", async () => {
  const { t, runnerClient } = await appWithMeta();
  try {
    runnerClient.emit("meta.integrity", { sid: "smeta1", ok: false, integrityFailed: "cage changed: CLAUDE.md" });
    runnerClient.emit("meta.reconcile", { sid: "smeta1", autoReverted: [{ kind: "cron", name: "x" }], changed: [], errors: [] });
    // alerts surface through /api/state
    const r = await t.request("GET", "/api/state");
    assert.equal(r.status, 200);
    const alerts = r.json.alerts || [];
    const integ = alerts.find((a) => a.id === "meta-integrity-smeta1");
    assert.ok(integ, "integrity alert present");
    assert.equal(integ.severity, "P1");
    assert.match(integ.detail, /cage changed/);
    assert.ok(alerts.find((a) => a.id === "meta-reconcile-smeta1"), "reconcile alert present");
  } finally {
    await t.close();
  }
});

test("the WS meta-attach fails closed when the session cache has not refreshed yet", async () => {
  // Simulate the attach handler directly: a sid known to be meta (authoritative set)
  // requires a passkey even though the sessions cache returns undefined for it.
  const { attachTermHandlers } = await import("../src/runner-client.js");
  const sent = [];
  const ws = { sendTo: (sock, msg) => sent.push(msg), onMessage: () => {} };
  const runner = { connected: true, updatePending: false, request: async () => ({ replay: "", cols: 80, rows: 24, writable: true }), on: () => {}, off: () => {} };
  const metaSet = new Set(["smeta-fresh"]);
  let spent = false;
  const passkey = { spendCapability: () => { spent = true; return false; } };
  attachTermHandlers({
    ws,
    runner,
    sessions: () => undefined, // cache miss: the collector has not refreshed
    passkey,
    connKey: () => "conn-A",
    isMeta: (sid) => metaSet.has(sid),
    log: () => {},
  });
  // drive a term.attach for the fresh meta sid with no capability
  await ws.onMessage({}, JSON.stringify({ t: "term.attach", sid: "smeta-fresh", cols: 80, rows: 24 }));
  assert.ok(spent, "the passkey gate was consulted despite the cache miss");
  assert.ok(sent.some((m) => m.t === "term.error" && /passkey required/.test(m.error)), JSON.stringify(sent));
});

// ---- driving Capri, not just starting it ---------------------------------
// The gate used to protect only `term.attach`. `term.input` reached the uncaged
// PTY with no capability and without ever attaching, so anyone past the owner
// gate could type into the most privileged session on the box. These four prove
// the rule that replaced it: every term verb resolves whether the sid is meta,
// an unresolvable sid is refused rather than served, and writing requires an
// attachment that only a spent assertion could have produced.

/** Build a term-handler harness over a fake ws/runner pair. */
async function termHarness(o = {}) {
  const { attachTermHandlers } = await import("../src/runner-client.js");
  const sent = [];
  const asked = [];
  const ws = { sendTo: (sock, msg) => sent.push(msg), onMessage: () => {} };
  const runner = {
    connected: true,
    updatePending: false,
    request: async (op, args) => {
      asked.push({ op, ...args });
      return { replay: "", cols: 80, rows: 24, writable: true };
    },
    on: () => {},
    off: () => {},
  };
  attachTermHandlers({
    ws,
    runner,
    sessions: o.sessions || (() => undefined),
    sessionsFresh: o.sessionsFresh,
    passkey: o.passkey,
    requirePasskey: o.requirePasskey,
    connKey: () => "conn-A",
    isMeta: o.isMeta || (() => false),
    log: () => {},
  });
  const sock = { on: () => {} };
  return { ws, sock, sent, asked, send: (msg) => ws.onMessage(sock, JSON.stringify(msg)) };
}

test("term.input into the meta session is refused when this connection never attached", async () => {
  const h = await termHarness({ isMeta: (sid) => sid === "smeta" });
  await h.send({ t: "term.input", sid: "smeta", data: "rm -rf /\r" });
  assert.ok(
    h.sent.some((m) => m.t === "term.error" && /not attached/.test(m.error)),
    JSON.stringify(h.sent),
  );
  assert.equal(h.asked.filter((a) => a.op === "input").length, 0, "nothing reached the runner");
});

test("term.input reaches a worker only over the connection that attached it", async () => {
  const rows = { w1: { id: "w1", kind: "worker", attachable: true, writable: true } };
  const h = await termHarness({ sessions: (sid) => rows[sid] });
  await h.send({ t: "term.input", sid: "w1", data: "x" });
  assert.equal(h.asked.filter((a) => a.op === "input").length, 0, "refused before attaching");
  await h.send({ t: "term.attach", sid: "w1", cols: 80, rows: 24 });
  await h.send({ t: "term.input", sid: "w1", data: "x" });
  assert.equal(h.asked.filter((a) => a.op === "input").length, 1, "allowed once attached");
});

test("a sid nothing can account for is refused, not forwarded", async () => {
  // The old code read a cache miss as "not meta" and forwarded the attach. Now a
  // miss costs one awaited refresh, and a sid still unknown after it is refused.
  let refreshed = 0;
  const h = await termHarness({
    sessions: () => undefined,
    sessionsFresh: async () => {
      refreshed += 1;
      return undefined;
    },
  });
  await h.send({ t: "term.attach", sid: "%7", cols: 80, rows: 24 });
  assert.equal(refreshed, 1, "the miss triggered exactly one refresh");
  assert.ok(h.sent.some((m) => m.t === "term.error" && /unknown session/.test(m.error)), JSON.stringify(h.sent));
  assert.equal(h.asked.filter((a) => a.op === "attach").length, 0, "the runner was never asked");
});

test("the awaited refresh is what catches a Capri the restarted console has not seen", async () => {
  // metaSids is empty (this process never started it) and the cache is cold, but
  // the refresh returns the runner's row: the passkey gate must still fire.
  let spent = false;
  const h = await termHarness({
    sessions: () => undefined,
    sessionsFresh: async (sid) => (sid === "smeta" ? { id: "smeta", kind: "meta", attachable: true } : undefined),
    passkey: {
      spendCapability: () => {
        spent = true;
        return false;
      },
    },
  });
  await h.send({ t: "term.attach", sid: "smeta", cols: 80, rows: 24 });
  assert.ok(spent, "the gate was consulted for a sid only the refresh knew about");
  assert.ok(h.sent.some((m) => m.t === "term.error" && /passkey required/.test(m.error)), JSON.stringify(h.sent));
});

// ---- proposal 31: metaRequirePasskey -------------------------------------
// Default TRUE: nothing changes unless root sets CONSOLE_META_REQUIRE_PASSKEY=0.
// With it off, reaching the authenticated console origin is the gate: start and
// attach need no capability and the passkey store is never consulted.

test("meta/status reports requirePasskey: true by default, false when root waives it", async () => {
  const a = await appWithMeta({});
  try {
    const r = await a.t.request("GET", "/api/meta/status", {});
    assert.equal(r.json.requirePasskey, true);
  } finally {
    await a.t.close();
  }
  const b = await appWithMeta({ env: { CONSOLE_META_REQUIRE_PASSKEY: "0" } });
  try {
    const r = await b.t.request("GET", "/api/meta/status", {});
    assert.equal(r.json.requirePasskey, false);
  } finally {
    await b.t.close();
  }
});

test("with the passkey waived, meta/new spawns with no capability and never consults the store", async () => {
  let consulted = false;
  const passkey = {
    status: () => ({ enabled: true, passkeys: 0, bootstrap: true }),
    spendCapability: () => { consulted = true; return false; },
  };
  const { t, runnerClient, key } = await appWithMeta({ env: { CONSOLE_META_REQUIRE_PASSKEY: "0" }, passkey });
  try {
    const r = await t.request("POST", "/api/meta/new", { headers: { "x-console-key": key }, body: {} });
    assert.equal(r.status, 201);
    assert.equal(runnerClient.spawns.length, 1);
    assert.equal(consulted, false, "the passkey store was consulted despite the waiver");
  } finally {
    await t.close();
  }
});

test("with the passkey required (an unset flag), meta/new without a capability stays 403", async () => {
  const { t, runnerClient, key } = await appWithMeta({});
  try {
    const r = await t.request("POST", "/api/meta/new", { headers: { "x-console-key": key }, body: {} });
    assert.equal(r.status, 403);
    assert.equal(runnerClient.spawns.length, 0);
  } finally {
    await t.close();
  }
});

test("WS meta-attach with the passkey waived attaches without a capability, and input then flows", async () => {
  let consulted = false;
  const h = await termHarness({
    isMeta: (sid) => sid === "smeta",
    passkey: { spendCapability: () => { consulted = true; return false; } },
    requirePasskey: false,
  });
  await h.send({ t: "term.attach", sid: "smeta", cols: 80, rows: 24 });
  assert.ok(h.sent.some((m) => m.t === "term.open" && m.sid === "smeta"), JSON.stringify(h.sent));
  assert.equal(consulted, false, "the passkey gate was consulted despite the waiver");
  await h.send({ t: "term.input", sid: "smeta", data: "ls\r" });
  assert.equal(h.asked.filter((a) => a.op === "input").length, 1, "input flows once attached");
});

test("WS meta-attach still demands the passkey when the flag is absent", async () => {
  const h = await termHarness({
    isMeta: (sid) => sid === "smeta",
    passkey: { spendCapability: () => false },
  });
  await h.send({ t: "term.attach", sid: "smeta", cols: 80, rows: 24 });
  assert.ok(h.sent.some((m) => m.t === "term.error" && /passkey required/.test(m.error)), JSON.stringify(h.sent));
});
