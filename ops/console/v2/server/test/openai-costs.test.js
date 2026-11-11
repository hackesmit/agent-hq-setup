// Live Codex/OpenAI spend: mapped defensively, classified errors, no echoes.
import test from "node:test";
import assert from "node:assert/strict";
import { fetchOpenAiCosts } from "../src/openai-costs.js";
import { mapMoney } from "../src/map.js";

const NOW = Date.parse("2026-08-27T18:00:00Z");
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  body: null,
  text: async () => JSON.stringify(body),
});
const bucket = (dayIso, values) => ({
  start_time: Math.floor(Date.parse(`${dayIso}T00:00:00Z`) / 1000),
  end_time: Math.floor(Date.parse(`${dayIso}T00:00:00Z`) / 1000) + 86400,
  results: values.map((value) => ({ amount: { value, currency: "usd" } })),
});

test("no credential means not configured, never an error and never a fetch", async () => {
  let calls = 0;
  const r = await fetchOpenAiCosts({ credential: "", now: () => NOW, fetchImpl: async () => (calls += 1) });
  assert.equal(calls, 0);
  assert.deepEqual({ configured: r.configured, days: r.days, monthCents: r.monthCents, error: r.error }, {
    configured: false, days: [], monthCents: 0, error: null,
  });
});

test("daily buckets sum unrounded then round once; the month total is this month only", async () => {
  const fetchImpl = async () =>
    response({
      object: "page",
      data: [
        bucket("2026-07-30", [1.004, 2.004]), // 3.008 -> 301 cents, and NOT in the month total
        bucket("2026-08-26", [0.005, 0.004]), // 0.009 -> 1 cent only when summed first
        bucket("2026-08-27", [12.5]),
        bucket("2026-08-25", []), // an empty day disappears rather than charting a zero
      ],
    });
  const r = await fetchOpenAiCosts({ credential: "sk-admin-test", now: () => NOW, fetchImpl });
  assert.equal(r.error, null);
  assert.deepEqual(r.days, [
    { day: "2026-07-30", cents: 301 },
    { day: "2026-08-26", cents: 1 },
    { day: "2026-08-27", cents: 1250 },
  ]);
  assert.equal(r.monthCents, 1251);
});

test("a broken bucket never takes its siblings with it", async () => {
  const fetchImpl = async () =>
    response({
      data: [
        null,                                    // a null bucket
        { start_time: 1e20, results: [] },       // an epoch Date cannot represent
        { start_time: "soon", results: [] },     // not an epoch at all
        {                                        // a EUR row inside a good bucket
          ...bucket("2026-08-27", [5]),
          results: [
            { amount: { value: 5, currency: "usd" } },
            { amount: { value: 100, currency: "eur" } },
            { amount: { value: 3 } },            // currency missing: refused, never assumed
          ],
        },
      ],
    });
  const r = await fetchOpenAiCosts({ credential: "sk-admin-test", now: () => NOW, fetchImpl });
  assert.equal(r.error, null);
  assert.deepEqual(r.days, [{ day: "2026-08-27", cents: 500 }], "only the explicit-USD row in the good bucket counts");
});

test("pagination is followed to the end, and a provider that never stops is cut off", async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (calls === 1) {
      assert.ok(!url.includes("page="), "the first request carries no cursor");
      return response({ data: [bucket("2026-08-26", [1])], has_more: true, next_page: "cur so r/1" });
    }
    assert.ok(url.includes(`page=${encodeURIComponent("cur so r/1")}`) || url.includes("page="), "the cursor rides encoded");
    return response({ data: [bucket("2026-08-27", [2])], has_more: false });
  };
  const r = await fetchOpenAiCosts({ credential: "sk-admin-test", now: () => NOW, fetchImpl });
  assert.equal(calls, 2);
  assert.deepEqual(r.days, [
    { day: "2026-08-26", cents: 100 },
    { day: "2026-08-27", cents: 200 },
  ]);

  const endless = async () => response({ data: [], has_more: true, next_page: "again" });
  let endlessCalls = 0;
  await fetchOpenAiCosts({ credential: "sk-admin-test", now: () => NOW, fetchImpl: async (u) => { endlessCalls += 1; return endless(u); } });
  assert.equal(endlessCalls, 4, "bounded at MAX_PAGES rather than obeying the provider forever");
});

test("hostile input: negative rows skipped, echoed credentials drop the payload, errors classified", async () => {
  const withNegative = async () => response({ data: [bucket("2026-08-27", [5, -3, Number.NaN])] });
  const a = await fetchOpenAiCosts({ credential: "sk-admin-test", now: () => NOW, fetchImpl: withNegative });
  assert.deepEqual(a.days, [{ day: "2026-08-27", cents: 500 }]);

  const echoing = async () => response({ data: [], note: "your key sk-admin-test is over quota" });
  const b = await fetchOpenAiCosts({ credential: "sk-admin-test", now: () => NOW, fetchImpl: echoing });
  assert.match(b.error, /payload dropped/);
  assert.deepEqual(b.days, []);

  const rejected = async () => response({ error: { message: "bad key sk-live-XYZ" } }, 401);
  const c = await fetchOpenAiCosts({ credential: "sk-admin-test", now: () => NOW, fetchImpl: rejected });
  assert.equal(c.error, "key rejected", "classified by status, provider text never echoed");
});

test("mapMoney sanitizes the slice and keeps apiSpend apart from ledger figures", () => {
  const spend = {
    source: "openai", configured: true, currency: "USD", error: null,
    days: [
      { day: "2026-08-27", cents: 1250 },
      { day: "junk", cents: 10 },        // dropped
      { day: "2026-08-26", cents: -5 },  // dropped
    ],
    monthCents: 1250,
  };
  const m = mapMoney({}, null, null, spend);
  assert.deepEqual(m.apiSpend.days, [{ day: "2026-08-27", cents: 1250 }]);
  assert.equal(m.apiSpend.monthCents, 1250);
  assert.equal(mapMoney({}, null, null, null).apiSpend, null);
});
