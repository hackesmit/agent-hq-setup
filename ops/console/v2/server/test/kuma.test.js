// Uptime Kuma monitors (bead hq-5v78, design 4.4). The payload shapes here are
// copied from a real Kuma 2.5.0 instance (seeded locally: three monitors on a
// published status page, one down), so the mapping is tested against what the
// program actually emits rather than what its docs imply.

import test from "node:test";
import assert from "node:assert/strict";
import { fetchMonitors, getJson, mapMonitors } from "../src/kuma.js";
import { startTestApp } from "./helpers.js";

const PAGE = {
  config: { title: "HQ Status", slug: "hq" },
  incidents: [],
  maintenanceList: [],
  publicGroupList: [
    {
      name: "Services",
      monitorList: [
        { id: 1, name: "acme prod" },
        { id: 2, name: "gym-tracker api" },
        { id: 3, name: "n8n" },
      ],
    },
  ],
};
const BEATS = {
  heartbeatList: {
    1: [{ status: 1, time: "2026-08-20 03:09:00", msg: "", ping: 42 }],
    2: [{ status: 1, time: "2026-08-20 03:09:10", msg: "", ping: null }],
    3: [{ status: 0, time: "2026-08-20 03:07:42", msg: "", ping: 46 }],
  },
  uptimeList: { "1_24": 0.9987, "2_24": 1, "3_24": 0.5 },
};

test("mapMonitors folds the two real payloads into rows", () => {
  const rows = mapMonitors(PAGE, BEATS);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    id: "1", name: "acme prod", group: "Services", state: "up",
    lastCheck: "2026-08-20 03:09:00", pingMs: 42, uptime24: 99.9,
  });
  assert.equal(rows[1].pingMs, null, "a null ping stays null, never 0");
  assert.equal(rows[2].state, "down");
  assert.equal(rows[2].uptime24, 50);
});

test("mapMonitors is defensive about shapes that crossed a network", () => {
  assert.deepEqual(mapMonitors(null, null), []);
  assert.deepEqual(mapMonitors({ publicGroupList: "nope" }, {}), []);
  const rows = mapMonitors(
    { publicGroupList: [{ name: 42, monitorList: [{ id: 7 }, { name: "no id" }, null] }] },
    { heartbeatList: { 7: "not a list" }, uptimeList: { "7_24": "x" } },
  );
  assert.equal(rows.length, 1, "only the row with an id survives");
  assert.deepEqual([rows[0].state, rows[0].uptime24, rows[0].lastCheck], ["unknown", null, null]);
});

test("fetchMonitors: unconfigured and failing pages are honest, never a fake all-up", async () => {
  const none = await fetchMonitors({ url: "http://x", slug: "" });
  assert.deepEqual([none.monitors, none.error], [[], "no status page configured"]);

  const failing = await fetchMonitors({
    url: "http://kuma.invalid", slug: "hq",
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ status: "fail", msg: "Status Page Not Found" }) }),
  });
  assert.deepEqual(failing.monitors, []);
  assert.equal(failing.error, "Status Page Not Found", "Kuma's own message is surfaced");

  const dead = await fetchMonitors({
    url: "http://kuma.invalid", slug: "hq",
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.match(dead.error, /ECONNREFUSED/);
});

test("getJson bounds the response and refuses redirects", async () => {
  await assert.rejects(
    () => getJson("http://x", { fetchImpl: async () => ({ ok: true, text: async () => "x".repeat(3 * 1024 * 1024) }) }),
    /too large/,
  );
  let opts = null;
  await getJson("http://x", { fetchImpl: async (_u, o) => ((opts = o), { ok: true, text: async () => "{}" }) });
  assert.equal(opts.redirect, "error", "a status page must not redirect us somewhere else");
  await assert.rejects(
    () => getJson("http://x", { timeoutMs: 20, fetchImpl: (_u, o) => new Promise((_r, rej) => o.signal.addEventListener("abort", () => rej(new Error("aborted")))) }),
    /abort/i,
  );
});

test("the monitors slice reaches ConsoleState", async () => {
  const t = await startTestApp({
    sources: {
      kumaData: async () => ({
        generatedAt: "2026-08-19T00:00:00Z",
        source: "http://127.0.0.1:3001/status/hq",
        monitors: mapMonitors(PAGE, BEATS),
        error: null,
      }),
    },
  });
  try {
    const state = await t.request("GET", "/api/state");
    assert.equal(state.json.monitors.monitors.length, 3);
    assert.equal(state.json.monitors.monitors[2].state, "down");
    const slice = await t.request("GET", "/api/state/monitors");
    assert.equal(slice.status, 200);
    assert.equal(slice.json.slice, "monitors");
  } finally {
    await t.close();
  }
});

test("getJson only speaks http and https", async () => {
  // Not defending against today's callers, all of which pass literals or config. This
  // is here so that a URL arriving from somewhere new cannot reach a scheme that reads
  // local state, and so that the restriction is a test somebody has to argue with
  // rather than a habit.
  for (const url of ["file:///etc/passwd", "gopher://h/1", "data:text/plain,x", "ftp://h/f"]) {
    await assert.rejects(() => getJson(url, { fetchImpl: async () => ({ ok: true }) }), /refusing scheme/);
  }
  await assert.rejects(() => getJson("not a url", { fetchImpl: async () => ({ ok: true }) }), /not a usable url/);
});

test("getJson refuses to follow a redirect, and says so by construction", async () => {
  // Pins redirect: "error". Following redirects and re-validating each hop is the other
  // defensible design; it is strictly more code for a set of destinations we already
  // know, so if someone later "fixes" this to follow them, this test should stop them
  // and make them say why.
  let sawInit = null;
  const fetchImpl = async (_u, init) => {
    sawInit = init;
    return { ok: true, headers: { get: () => null }, body: null, text: async () => "{}" };
  };
  await getJson("https://example.com/x", { fetchImpl });
  assert.equal(sawInit.redirect, "error", "redirects must not be followed");
});
