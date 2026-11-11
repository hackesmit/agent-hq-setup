// Live Codex/OpenAI API spend for the money tab.
//
// The Claude side of agent effort is already on the tab (tokens per day from
// usage.py); this is the OTHER vendor's bill, read live from OpenAI's org
// costs API so what lucy and codex actually cost shows up next to it without
// anyone keying invoices in by hand.
//
// Follows cloud.js to the letter. The admin key comes from the ENVIRONMENT
// (CONSOLE_OPENAI_ADMIN), never the repo and never fetched; a missing key
// means "not configured", not an error. Provider output is hostile input: a
// payload that echoes the key is dropped whole, errors are classified by HTTP
// status alone and never echoed, and a bucket that cannot be mapped is skipped
// without discarding its siblings.
//
// Shape (docs, to be verified live once a key is configured):
//   GET https://api.openai.com/v1/organization/costs?start_time=<unix>&bucket_width=1d&limit=31
//     Authorization: Bearer <admin key>
//     -> {object:"page", data:[{start_time, end_time, results:[{amount:{value, currency}}]}]}
// Values are float dollars; each day is summed unrounded and rounded ONCE into
// integer cents, the same precision rule the rest of the money surface uses.

import { getJson } from "./kuma.js";
import { echoesSecret } from "./cloud.js";

export const OPENAI_COSTS_URL = "https://api.openai.com/v1/organization/costs";
const DAYS_BACK = 31;

function safeError(e) {
  const status = e && typeof e.status === "number" ? e.status : 0;
  if (status === 401 || status === 403) return "key rejected";
  if (status === 404) return "not found";
  if (status === 429) return "rate limited";
  if (status >= 500) return "provider error";
  const text = `${(e && e.name) || ""} ${(e && e.message) || ""}`;
  if (/abort|timeout/i.test(text)) return "timed out";
  if (/too large/i.test(text)) return "response too large";
  return "unreachable";
}

/**
 * @param {{credential: string, fetchImpl?: Function, now?: () => number, log?: Function}} opts
 * @returns {Promise<{source: "openai", configured: boolean, currency: "USD",
 *   days: {day: string, cents: number}[], monthCents: number,
 *   error: string | null, generatedAt: string}>}
 */
export async function fetchOpenAiCosts(opts) {
  const now = opts.now || (() => Date.now());
  const generatedAt = new Date(now()).toISOString();
  const base = { source: "openai", configured: Boolean(opts.credential), currency: "USD", days: [], monthCents: 0, error: null, generatedAt };
  if (!opts.credential) return base;
  const startTime = Math.floor(now() / 1000) - DAYS_BACK * 86400;
  const baseUrl = `${OPENAI_COSTS_URL}?start_time=${startTime}&bucket_width=1d&limit=${DAYS_BACK}`;
  // Pagination is followed, bounded: the host and path stay the repo literal;
  // only the provider's opaque cursor rides as an encoded query value, and a
  // provider that never stops paging is cut off rather than obeyed (lucy).
  const MAX_PAGES = 4;
  const byDay = new Map();
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let j;
    try {
      j = await getJson(cursor ? `${baseUrl}&page=${encodeURIComponent(cursor)}` : baseUrl, {
        timeoutMs: 15000,
        fetchImpl: opts.fetchImpl,
        headers: { authorization: `Bearer ${opts.credential}` },
      });
    } catch (e) {
      return { ...base, error: safeError(e) };
    }
    // A payload that quotes the credential must never reach ConsoleState.
    if (echoesSecret(j, [opts.credential])) return { ...base, error: "provider echoed the key; payload dropped" };

    for (const bucket of Array.isArray(j && j.data) ? j.data : []) {
      // Every bucket is mapped in isolation: a null bucket, a nonsense epoch,
      // or a wrong-currency row is skipped without losing its siblings (lucy).
      if (!bucket || typeof bucket !== "object") continue;
      const start = Number(bucket.start_time);
      // bounded to a representable, plausible window so Date can never throw
      if (!Number.isFinite(start) || start < 946684800 || start > now() / 1000 + 2 * 86400) continue;
      const day = new Date(start * 1000).toISOString().slice(0, 10);
      let dollars = 0;
      for (const r of Array.isArray(bucket.results) ? bucket.results : []) {
        const v = r && r.amount ? Number(r.amount.value) : NaN;
        // Costs are only ever charges in USD; a negative or absurd value, or a
        // row in any other currency, is a mapping accident on a money surface,
        // so the row is skipped, never absorbed or silently converted.
        if (!Number.isFinite(v) || v < 0 || v > 1_000_000) continue;
        const cur = r && r.amount && r.amount.currency;
        if (String(cur).toLowerCase() !== "usd") continue;
        dollars += v;
      }
      byDay.set(day, (byDay.get(day) || 0) + dollars);
    }
    cursor = j && j.has_more && typeof j.next_page === "string" && j.next_page ? j.next_page : null;
    if (!cursor) break;
  }
  const days = [...byDay.entries()]
    .map(([day, dollars]) => ({ day, cents: Math.round(dollars * 100) }))
    .filter((d) => d.cents > 0)
    .sort((a, b) => (a.day < b.day ? -1 : 1));
  const month = generatedAt.slice(0, 7);
  const monthCents = days.filter((d) => d.day.slice(0, 7) === month).reduce((n, d) => n + d.cents, 0);
  return { ...base, days, monthCents };
}
