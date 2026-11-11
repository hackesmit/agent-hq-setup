// The one exchange rate the money tab needs: MXN per USD, so the folded view
// can say what everything amounts to in one currency.
//
// The LEDGER never converts. Every stored amount stays integer cents in its own
// currency, every server-side sum stays per-currency, and the rate here rides
// the money slice as display metadata: the web folds USD into MXN at render
// time and says which rate it used. That keeps the record exact and makes the
// conversion auditable instead of baked in.
//
// The rate comes from frankfurter.app (ECB reference rates, no key, a repo
// literal, which is what getJson's no-untrusted-URL invariant requires) and is
// cached on disk, so a restart or an offline stretch serves the last known
// rate marked stale rather than no rate at all. ECB publishes once a business
// day; fetching more often than a few hours apart buys nothing.

import fs from "node:fs";
import path from "node:path";
import { getJson } from "./kuma.js";

// The .dev host is frankfurter's canonical one; the old .app host answers 301
// and getJson refuses redirects by design, so the redirect target is spelled
// out here rather than followed.
export const FX_URL = "https://api.frankfurter.dev/v1/latest?from=USD&to=MXN";
const FRESH_MS = 6 * 60 * 60 * 1000;
// A money surface refuses absurdity instead of displaying it: the peso has
// lived between 3 and 26 per dollar since it dropped three zeros in 1993, so a
// rate outside these bounds is an API accident (an inverted pair, a unit
// change), not news, and folding by it would misstate every total on the tab.
const MIN_RATE = 1;
const MAX_RATE = 1000;

/**
 * @param {{cacheFile: string, now?: () => number, fetchImpl?: Function, log?: Function}} opts
 * @returns {Promise<{base: "MXN", mxnPerUsd: number, asOf: string, stale: boolean} | null>}
 *   null means no rate has ever been obtained; callers show per-currency
 *   figures rather than inventing a rate.
 */
export async function fetchFxRate(opts) {
  const now = opts.now || (() => Date.now());
  const log = opts.log || (() => {});
  const cached = readCache(opts.cacheFile, now());
  if (cached && now() - cached.fetchedAt < FRESH_MS) {
    return { base: "MXN", mxnPerUsd: cached.mxnPerUsd, asOf: cached.asOf, stale: false };
  }
  try {
    const j = await getJson(FX_URL, { timeoutMs: 8000, fetchImpl: opts.fetchImpl });
    const rate = j && j.rates ? Number(j.rates.MXN) : NaN;
    if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) {
      throw new Error(`implausible USD->MXN rate: ${String(rate)}`);
    }
    // The metadata is as load-bearing as the number (lucy): the note on the tab
    // says "ECB <date>", so a response with the wrong base pair or no usable
    // date is a failed refresh, never a rate with an invented date.
    if (!j || j.base !== "USD") throw new Error(`unexpected base: ${String(j && j.base)}`);
    const asOf = typeof j.date === "string" && DATE_RE.test(j.date) ? j.date : null;
    if (!asOf) throw new Error(`unusable rate date: ${String(j && j.date)}`);
    writeCache(opts.cacheFile, { mxnPerUsd: rate, asOf, fetchedAt: now() }, log);
    return { base: "MXN", mxnPerUsd: rate, asOf, stale: false };
  } catch (e) {
    log(`fx: ${String((e && e.message) || e)}; ${cached ? "serving the cached rate as stale" : "no rate available"}`);
    if (cached) return { base: "MXN", mxnPerUsd: cached.mxnPerUsd, asOf: cached.asOf, stale: true };
    return null;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A cache stamped from the future would count as fresh until that future
// arrived, so the fetch would never run again; allow only small clock skew.
const MAX_SKEW_MS = 10 * 60 * 1000;

function readCache(file, nowMs) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const rate = Number(j.mxnPerUsd);
    const fetchedAt = Number(j.fetchedAt);
    // The same plausibility gates as the live path: a hand-edited or corrupt
    // cache must not become a folding rate, or a fabricated date, just
    // because it parsed.
    if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) return null;
    if (!Number.isFinite(fetchedAt) || fetchedAt > nowMs + MAX_SKEW_MS) return null;
    if (typeof j.asOf !== "string" || !DATE_RE.test(j.asOf)) return null;
    return { mxnPerUsd: rate, asOf: j.asOf, fetchedAt };
  } catch {
    return null;
  }
}

function writeCache(file, rec, log) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec) + "\n");
    fs.renameSync(tmp, file);
  } catch (e) {
    log(`fx: cache not written: ${String((e && e.message) || e)}`);
  }
}
