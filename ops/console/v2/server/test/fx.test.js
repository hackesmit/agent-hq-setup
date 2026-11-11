// The USD->MXN folding rate: fetched, cached, bounded, and never invented.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fetchFxRate, FX_URL } from "../src/fx.js";
import { tmpDir } from "./helpers.js";

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  body: null,
  text: async () => JSON.stringify(body),
});

const cacheIn = (dir) => path.join(dir, "fx.json");

test("a live rate is returned, cached, and served from cache while fresh", async () => {
  const dir = tmpDir();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.equal(url, FX_URL);
    return response({ base: "USD", date: "2026-08-27", rates: { MXN: 18.72 } });
  };
  let clock = 1_000_000;
  const opts = { cacheFile: cacheIn(dir), fetchImpl, now: () => clock };

  const first = await fetchFxRate(opts);
  assert.deepEqual(first, { base: "MXN", mxnPerUsd: 18.72, asOf: "2026-08-27", stale: false });
  assert.ok(fs.existsSync(opts.cacheFile), "the rate is cached on disk");

  clock += 60 * 60 * 1000; // one hour later: still fresh, no second fetch
  const second = await fetchFxRate(opts);
  assert.equal(second.mxnPerUsd, 18.72);
  assert.equal(calls, 1, "a fresh cache answers without the network");
});

test("a failed refresh serves the cached rate marked stale; no cache means null", async () => {
  const dir = tmpDir();
  const good = async () => response({ base: "USD", date: "2026-08-26", rates: { MXN: 18.5 } });
  const dead = async () => {
    throw new Error("network down");
  };
  let clock = 1_000_000;
  const cacheFile = cacheIn(dir);

  await fetchFxRate({ cacheFile, fetchImpl: good, now: () => clock });
  clock += 24 * 60 * 60 * 1000; // stale by any measure
  const served = await fetchFxRate({ cacheFile, fetchImpl: dead, now: () => clock, log: () => {} });
  assert.deepEqual(served, { base: "MXN", mxnPerUsd: 18.5, asOf: "2026-08-26", stale: true });

  const never = await fetchFxRate({ cacheFile: cacheIn(tmpDir()), fetchImpl: dead, log: () => {} });
  assert.equal(never, null, "no rate is ever invented");
});

test("an implausible rate is refused, from the API and from the cache alike", async () => {
  const dir = tmpDir();
  // an inverted pair (USD per MXN) is the classic API accident
  const inverted = async () => response({ base: "USD", date: "2026-08-27", rates: { MXN: 0.053 } });
  const r = await fetchFxRate({ cacheFile: cacheIn(dir), fetchImpl: inverted, log: () => {} });
  assert.equal(r, null);

  // a corrupt cache must not become a folding rate just because it parsed
  const cacheFile = cacheIn(tmpDir());
  fs.writeFileSync(cacheFile, JSON.stringify({ mxnPerUsd: 1872, asOf: "2026-08-27", fetchedAt: Date.now() }));
  const dead = async () => {
    throw new Error("down");
  };
  const fromBadCache = await fetchFxRate({ cacheFile, fetchImpl: dead, log: () => {} });
  assert.equal(fromBadCache, null);
});

test("the metadata is as guarded as the number: base, date, and clock skew", async () => {
  // a wrong base pair or an unusable date is a failed refresh, never a rate
  // with an invented ECB date (lucy fix-verify)
  const wrongBase = async () => response({ base: "MXN", date: "2026-08-27", rates: { MXN: 18.5 } });
  assert.equal(await fetchFxRate({ cacheFile: cacheIn(tmpDir()), fetchImpl: wrongBase, log: () => {} }), null);
  const noDate = async () => response({ base: "USD", rates: { MXN: 18.5 } });
  assert.equal(await fetchFxRate({ cacheFile: cacheIn(tmpDir()), fetchImpl: noDate, log: () => {} }), null);

  // a cache stamped from the future would stay "fresh" until that future
  // arrived; it is rejected, so the fetch runs and repairs the cache
  const cacheFile = cacheIn(tmpDir());
  fs.writeFileSync(
    cacheFile,
    JSON.stringify({ mxnPerUsd: 18.5, asOf: "2026-08-27", fetchedAt: Date.now() + 365 * 86400000 }),
  );
  let calls = 0;
  const live = async () => {
    calls += 1;
    return response({ base: "USD", date: "2026-08-27", rates: { MXN: 19.1 } });
  };
  const r = await fetchFxRate({ cacheFile, fetchImpl: live, log: () => {} });
  assert.equal(calls, 1, "a future-stamped cache does not suppress the fetch");
  assert.equal(r.mxnPerUsd, 19.1);

  // a cache with a malformed asOf is rejected the same way
  const cacheFile2 = cacheIn(tmpDir());
  fs.writeFileSync(cacheFile2, JSON.stringify({ mxnPerUsd: 18.5, asOf: "not a date", fetchedAt: Date.now() }));
  const dead = async () => {
    throw new Error("down");
  };
  assert.equal(await fetchFxRate({ cacheFile: cacheFile2, fetchImpl: dead, log: () => {} }), null);
});
