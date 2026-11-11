// Cloud deploy collectors (bead hq-5v78). Payload shapes are copied from live
// responses on 2026-08-19, so the mapping is tested against what the providers
// actually return. No real credential appears here; the stubs below are inert
// strings, and the tests assert the collector never returns one and never
// echoes a provider's error text.

import test from "node:test";
import assert from "node:assert/strict";
import { fetchDeploys, fetchN8n, fetchVercel } from "../src/cloud.js";
import { startTestApp } from "./helpers.js";

const STUB = "t";                                   // inert stand-in, not a credential
const MARKER = ["ab", "cdef", "123456"].join("");   // must never appear in any output

const PROJECTS = { projects: [
  { id: "p1", name: "orbit-acme-dashboard" },
  { id: "p2", name: "fintrack-portfolio" },
  { id: "p3", name: "gym-tracker" },
] };
const DEPLOY = {
  p1: { deployments: [{ readyState: "READY", created: 1787077117238, url: "x-9oc.vercel.app", target: "production", meta: { githubCommitRef: "main" } }] },
  p2: { deployments: [{ readyState: "ERROR", created: 1787070000000, url: "d.vercel.app", target: "production", meta: { githubCommitRef: "master" } }] },
  p3: { deployments: [{ readyState: "BUILDING", created: 1787060000000, url: "g.vercel.app", target: "production", meta: {} }] },
};
/** Routes the two-step Vercel flow the collector now uses. */
const vercelFetch = (over = {}) => async (url) => {
  const u = String(url);
  if (u.includes("/v9/projects")) return { ok: true, text: async () => JSON.stringify(over.projects || PROJECTS) };
  const m = u.match(/projectId=([^&]+)/);
  const key = m && m[1];
  if (over.deploy && over.deploy[key]) return { ok: true, text: async () => JSON.stringify(over.deploy[key]) };
  return { ok: true, text: async () => JSON.stringify(DEPLOY[key] || { deployments: [] }) };
};
const N8N = {
  data: [
    { id: "a", name: "wf one", active: true, updatedAt: "2026-05-11T23:37:14.415Z" },
    { id: "b", name: "wf two", active: false, updatedAt: "2026-06-01T10:00:00.000Z" },
  ],
};

const ok = (payload) => async () => ({ ok: true, text: async () => JSON.stringify(payload) });

test("vercel: newest production per project, states mapped", async () => {
  const r = await fetchVercel({ token: STUB, fetchImpl: vercelFetch() });
  assert.equal(r.configured, true);
  assert.equal(r.error, null);
  assert.equal(r.deploys.length, 3, "one row per project");
  assert.deepEqual(
    r.deploys.map((d) => [d.name, d.state, d.detail]),
    [
      ["orbit-acme-dashboard", "ok", "production main"],
      ["fintrack-portfolio", "failed", "production master"],
      ["gym-tracker", "building", "production"],
    ],
  );
  assert.equal(r.deploys[0].at, new Date(1787077117238).toISOString());
  assert.equal(r.deploys[0].url, "https://x-9oc.vercel.app");
});

test("n8n: one row with the active count", async () => {
  const r = await fetchN8n({ baseUrl: "https://n8n.example/", token: STUB, fetchImpl: ok(N8N) });
  assert.equal(r.deploys.length, 1);
  assert.equal(r.deploys[0].detail, "1 active of 2");
  assert.equal(r.deploys[0].at, "2026-06-01T10:00:00.000Z", "the newest updatedAt wins");
  assert.equal(r.deploys[0].url, "https://n8n.example", "the trailing slash is trimmed");
});

test("an unconfigured provider is not an error and makes no request", async () => {
  let called = false;
  const spy = async () => ((called = true), { ok: true, text: async () => "{}" });
  const v = await fetchVercel({ fetchImpl: spy });
  assert.deepEqual([v.configured, v.error, v.deploys], [false, null, []]);
  const n = await fetchN8n({ baseUrl: "https://n8n.example", fetchImpl: spy });
  assert.equal(n.configured, false);
  const noUrl = await fetchN8n({ token: STUB, fetchImpl: spy });
  assert.equal(noUrl.configured, false, "a credential without a URL is still unconfigured");
  assert.equal(called, false, "an unconfigured provider must not make a request at all");
});

test("provider errors are reported by shape, never echoed, and never leak the credential", async () => {
  const cases = [
    [401, `Not authorized: ${MARKER} is invalid`, "token rejected"],
    [404, "team not found", "not found"],
    [429, "rate limit exceeded", "rate limited"],
    [500, `boom at https://api.vercel.com/v6/deployments?x=${MARKER}`, "provider error"],
  ];
  for (const [status, body, want] of cases) {
    const r = await fetchVercel({
      token: MARKER,
      fetchImpl: async () => ({ ok: false, status, text: async () => JSON.stringify({ msg: body }) }),
    });
    assert.equal(r.error, want, `status ${status}`);
    assert.ok(!JSON.stringify(r).includes(MARKER), "the credential must never appear in the report");
    assert.ok(!JSON.stringify(r).includes("api.vercel.com/v6"), "a provider message is not echoed");
  }
  const dead = await fetchVercel({ token: STUB, fetchImpl: async () => { throw new Error("ECONNREFUSED 1.2.3.4"); } });
  assert.equal(dead.error, "unreachable");
});

test("fetchDeploys: each provider degrades alone", async () => {
  const r = await fetchDeploys(
    { vercelToken: STUB, n8nUrl: "https://n8n.example", n8nToken: STUB },
    {
      fetchImpl: async (url) => {
        if (String(url).includes("vercel")) return vercelFetch()(url);
        throw new Error("timeout");
      },
    },
  );
  assert.equal(r.deploys.length, 3, "vercel rows survive an n8n failure");
  assert.deepEqual(Object.fromEntries(r.providers.map((p) => [p.provider, p.error])), { vercel: null, n8n: "timed out" });
});

test("the deploys slice reaches ConsoleState", async () => {
  const rows = (await fetchVercel({ token: STUB, fetchImpl: vercelFetch() })).deploys;
  const t = await startTestApp({
    sources: {
      deploysData: async () => ({
        generatedAt: "2026-08-19T00:00:00Z",
        deploys: rows,
        providers: [{ provider: "vercel", configured: true, error: null }, { provider: "n8n", configured: false, error: null }],
      }),
    },
  });
  try {
    const state = await t.request("GET", "/api/state");
    assert.equal(state.json.deploys.deploys.length, 3);
    assert.equal(state.json.deploys.providers[1].configured, false);
    assert.equal((await t.request("GET", "/api/state/deploys")).status, 200);
  } finally {
    await t.close();
  }
});

// ---------- lucy 2026-08-19: providers are hostile input ----------

test("BLOCKER: a success payload echoing the credential drops the rows entirely", async () => {
  const echoing = await fetchVercel({
    token: MARKER,
    fetchImpl: vercelFetch({ projects: { projects: [{ id: "p1", name: MARKER }] } }),
  });
  assert.deepEqual(echoing.deploys, [], "no row may carry a reflected credential");
  assert.match(echoing.error, /echoed the credential/);
  assert.ok(!JSON.stringify(echoing).includes(MARKER));

  const nested = await fetchVercel({
    token: MARKER,
    fetchImpl: vercelFetch({ deploy: { p1: { deployments: [{ readyState: "READY", created: 1787077117238, url: `${MARKER}.vercel.app`, target: "production" }] } } }),
  });
  assert.ok(!JSON.stringify(nested).includes(MARKER), "a reflected credential deep in a row is caught too");

  const n8n = await fetchN8n({
    baseUrl: "https://n8n.example", token: MARKER,
    fetchImpl: ok({ data: [{ id: "a", name: "wf", active: true, updatedAt: MARKER }] }),
  });
  assert.deepEqual(n8n.deploys, []);
  assert.ok(!JSON.stringify(n8n).includes(MARKER));
});

test("BLOCKER: an n8n url that is not plain https is refused before any request", async () => {
  let called = false;
  const spy = async () => ((called = true), { ok: true, text: async () => "{}" });
  for (const url of ["http://n8n.example", "https://user:pw@n8n.example", "https://n8n.example/?x=1", "https://n8n.example/#f", "notaurl"]) {
    const r = await fetchN8n({ baseUrl: url, token: STUB, fetchImpl: spy });
    assert.match(r.error || "", /https/, `${url} must be refused`);
    assert.deepEqual(r.deploys, []);
  }
  assert.equal(called, false, "a credential must never be sent to a refused url");
  const good = await fetchN8n({ baseUrl: "https://n8n.example/sub/", token: STUB, fetchImpl: ok(N8N) });
  assert.equal(good.deploys[0].url, "https://n8n.example", "only the origin is kept");
});

test("MAJOR: a preview deployment can never speak for production", async () => {
  const r = await fetchVercel({
    token: STUB,
    fetchImpl: vercelFetch({ deploy: { p1: { deployments: [{ readyState: "READY", created: 1787077117238, url: "p.vercel.app", target: "preview" }] } } }),
  });
  assert.ok(!r.deploys.some((d) => d.name === "orbit-acme-dashboard"), "a preview row is dropped, not shown as production green");
});

test("MAJOR: one unmappable row never discards its siblings", async () => {
  const r = await fetchVercel({
    token: STUB,
    fetchImpl: vercelFetch({ deploy: { p1: { deployments: [{ readyState: "READY", created: 1e100, url: "x.vercel.app", target: "production" }] } } }),
  });
  assert.equal(r.error, null);
  assert.equal(r.deploys.length, 3, "the out-of-range date costs its own field, not the provider");
  assert.equal(r.deploys[0].at, null, "an unrepresentable date is null, never a fabricated one");
});

test("MAJOR: partial or malformed n8n data never claims a confident ok", async () => {
  const paged = await fetchN8n({ baseUrl: "https://n8n.example", token: STUB, fetchImpl: ok({ data: N8N.data, nextCursor: "more" }) });
  assert.equal(paged.deploys[0].state, "unknown");
  assert.match(paged.deploys[0].detail, /partial/);
  const junk = await fetchN8n({ baseUrl: "https://n8n.example", token: STUB, fetchImpl: ok({ data: [null, { active: "false" }] }) });
  assert.equal(junk.deploys[0].state, "unknown", "a non-boolean active is not an active workflow");
  assert.match(junk.deploys[0].detail, /0 active of 0, partial/);
});

test("MINOR: a wrong top-level shape is an invalid response, not an empty one", async () => {
  const v = await fetchVercel({ token: STUB, fetchImpl: ok({}) });
  assert.equal(v.error, "invalid response");
  const n = await fetchN8n({ baseUrl: "https://n8n.example", token: STUB, fetchImpl: ok({ data: "oops" }) });
  assert.equal(n.error, "invalid response");
});

test("BLOCKER: an oversized body is cut off, not buffered", async () => {
  // a stream that would never end if it were drained
  const endless = {
    ok: true,
    headers: { get: () => null },
    body: {
      getReader() {
        const chunk = new Uint8Array(256 * 1024);
        return { read: async () => ({ done: false, value: chunk }), cancel: async () => {} };
      },
    },
  };
  const r = await fetchVercel({ token: STUB, fetchImpl: async () => endless });
  assert.equal(r.error, "response too large", "the cap fires during the read, not after it");
});

test("fix-verify: a failed or non-production project marks partial instead of vanishing", async () => {
  const throttled = await fetchVercel({
    token: STUB,
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes("/v9/projects")) return { ok: true, text: async () => JSON.stringify(PROJECTS) };
      if (u.includes("p2")) return { ok: false, status: 429, text: async () => "{}" };
      return vercelFetch()(url);
    },
  });
  assert.equal(throttled.deploys.length, 2, "the other projects still report");
  assert.equal(throttled.partial, true, "the throttled project is not silently dropped");

  const noTarget = await fetchVercel({
    token: STUB,
    fetchImpl: vercelFetch({ deploy: { p1: { deployments: [{ readyState: "READY", created: 1787077117238, url: "x.vercel.app" }] } } }),
  });
  assert.ok(!noTarget.deploys.some((d) => d.name === "orbit-acme-dashboard"), "a missing target is not assumed to be production");
  assert.equal(noTarget.partial, true);

  const shape = await fetchVercel({
    token: STUB,
    fetchImpl: vercelFetch({ deploy: { p1: { deployments: "nope" } } }),
  });
  assert.equal(shape.partial, true, "a malformed deployments field counts as omitted, not as no deployment");
});

test("fix-verify: an oversized declared length aborts the transfer", async () => {
  let cancelled = false;
  const r = await fetchVercel({
    token: STUB,
    fetchImpl: async () => ({
      ok: true,
      headers: { get: (h) => (h === "content-length" ? String(2 * 1024 * 1024 * 1024) : null) },
      body: { cancel: async () => { cancelled = true; }, getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) },
    }),
  });
  assert.equal(r.error, "response too large");
  assert.equal(cancelled, true, "the body is cancelled, not merely abandoned");
});
