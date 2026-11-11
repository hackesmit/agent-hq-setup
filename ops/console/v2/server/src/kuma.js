// Uptime Kuma monitors (design 4.4 "Uptime Kuma monitors are read from its
// status API to avoid re-implementing checks", bead hq-5v78).
//
// Deliberately the CREDENTIAL-FREE half of P2.5: a published status page
// serves plain JSON with no token, so this needs none of the token plumbing
// the Vercel/n8n/Fly collectors are still blocked on. Kuma keeps probing; the
// console only displays what Kuma already knows.
//
// Two endpoints, both verified against a real 2.5.0 instance:
//   GET /api/status-page/<slug>            -> {config, publicGroupList:[{name, monitorList:[{id,name}]}]}
//   GET /api/status-page/heartbeat/<slug>  -> {heartbeatList:{"<id>":[{status,time,ping}]}, uptimeList:{"<id>_24":0..1}}
// Status codes are Kuma's own: 0 down, 1 up, 2 pending, 3 maintenance.

const STATUS = { 0: "down", 1: "up", 2: "pending", 3: "maintenance" };

/** A real number or null. Never coerces null/""/undefined into 0. */
function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
const MAX_BODY = 2 * 1024 * 1024;

/**
 * Bounded JSON GET. The body is consumed INCREMENTALLY with a byte counter and
 * the request is aborted the moment it passes the cap: awaiting res.text()
 * first would buffer a hostile gigabyte before any check could run (lucy).
 */
async function readBounded(res, ac) {
  const declared = Number(res.headers && typeof res.headers.get === "function" ? res.headers.get("content-length") : NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    // abort and cancel first: throwing alone would leave the transfer running
    ac.abort();
    try {
      if (res.body && typeof res.body.cancel === "function") await res.body.cancel();
    } catch {
      /* already gone */
    }
    throw new Error("response too large");
  }
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    // a stub or a body-less response: still bounded, just after the fact
    const text = typeof res.text === "function" ? await res.text() : "";
    if (Buffer.byteLength(text) > MAX_BODY) throw new Error("response too large");
    return text;
  }
  const reader = body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY) {
      try {
        await reader.cancel();
      } catch {
        /* already gone */
      }
      ac.abort();
      throw new Error("response too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The one place this server talks to the network.
 *
 * THE INVARIANT THAT MAKES THIS SAFE, written down because it is load-bearing and
 * invisible: every URL passed here is either a literal in this repo or built from an
 * environment variable the owner sets (CONSOLE_KUMA_URL, CONSOLE_N8N_URL, api.vercel.com).
 * None of it comes from a request body, a bead, an upload or an agent. That is why there
 * is no address validation here and no private-range blocking: there is no untrusted URL
 * to defend against, and building that machinery for a surface without the input would be
 * ceremony rather than security.
 *
 * IF THAT EVER STOPS BEING TRUE, this function needs the rest of it before the feature
 * ships: resolve the host, reject private and link-local addresses, unwrap IPv4-mapped
 * IPv6, and pin the resolved address for the connection so a second lookup cannot answer
 * differently. Treat that paragraph as the condition on the change, not as a suggestion.
 *
 * What IS enforced here regardless, because these are cheap and a future caller should
 * not be able to relax them by accident:
 *   - only http and https, so a scheme that reads local state can never be reached even
 *     if a URL arrives from somewhere new
 *   - redirects are refused outright rather than followed and re-checked, which is the
 *     stronger of the two options and costs nothing when every destination is known
 *   - the body is bounded by both the declared length and the bytes actually read
 *   - the whole request is bounded by a timeout
 *
 * @param {string} url
 * @param {{timeoutMs?: number, fetchImpl?: Function, headers?: any}} [opts]
 */
export async function getJson(url, { timeoutMs = 5000, fetchImpl, headers } = {}) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== "function") throw new Error("no fetch available");
  let scheme;
  try {
    scheme = new URL(String(url)).protocol;
  } catch {
    throw new Error("not a usable url");
  }
  if (scheme !== "http:" && scheme !== "https:") throw new Error(`refusing scheme ${scheme}`);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await f(url, { signal: ac.signal, redirect: "error", headers: headers || undefined });
    const text = await readBounded(res, ac);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text);
        if (j && typeof j.msg === "string") msg = j.msg;
      } catch {
        /* not the JSON error shape */
      }
      const err = new Error(msg);
      err.status = res.status;      // classifiers use the status, not the prose
      throw err;
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch both endpoints and fold them into one report. Never throws: an
 * unreachable or unconfigured Kuma is an honest error string, never a
 * fabricated "all up".
 * @param {{url: string, slug: string, fetchImpl?: Function, timeoutMs?: number}} opts
 */
export async function fetchMonitors(opts) {
  const base = String(opts.url || "").replace(/\/+$/, "");
  const slug = String(opts.slug || "");
  const out = { generatedAt: new Date().toISOString(), source: base ? `${base}/status/${slug}` : null, monitors: [], error: null };
  if (!base || !slug) {
    out.error = "no status page configured";
    return out;
  }
  try {
    const [page, beats] = await Promise.all([
      getJson(`${base}/api/status-page/${encodeURIComponent(slug)}`, opts),
      getJson(`${base}/api/status-page/heartbeat/${encodeURIComponent(slug)}`, opts),
    ]);
    out.monitors = mapMonitors(page, beats);
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 200);
  }
  return out;
}

/** The two payloads -> MonitorRow[]. Defensive: the shapes cross a network. */
export function mapMonitors(page, beats) {
  const groups = Array.isArray(page && page.publicGroupList) ? page.publicGroupList : [];
  const beatList = (beats && typeof beats.heartbeatList === "object" && beats.heartbeatList) || {};
  const uptime = (beats && typeof beats.uptimeList === "object" && beats.uptimeList) || {};
  const rows = [];
  for (const g of groups.slice(0, 30)) {
    const group = String((g && g.name) || "").slice(0, 60);
    const list = Array.isArray(g && g.monitorList) ? g.monitorList : [];
    for (const m of list.slice(0, 100)) {
      if (!m || m.id == null) continue;
      const id = String(m.id);
      const beat = Array.isArray(beatList[id]) ? beatList[id][beatList[id].length - 1] : null;
      const up = uptime[`${id}_24`];
      rows.push({
        id,
        name: String(m.name || id).slice(0, 80),
        group,
        state: beat && STATUS[beat.status] ? STATUS[beat.status] : "unknown",
        lastCheck: beat && beat.time ? String(beat.time).slice(0, 40) : null,
        // Number(null) is 0, so a plain isFinite check would turn "no ping" and
        // "no uptime yet" into a confident 0. Require an actual number.
        pingMs: num(beat && beat.ping),
        uptime24: (() => {
          const v = num(up);
          return v === null ? null : Math.round(v * 1000) / 10;
        })(),
      });
    }
  }
  return rows.slice(0, 200);
}
