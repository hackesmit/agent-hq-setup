// Cloud deploy collectors (design 4.4, bead hq-5v78): Vercel and n8n.
//
// Tokens are read from the ENVIRONMENT, never from the repo and never fetched
// by this process. That keeps the code independent of the still-open plumbing
// question (how a token reaches the caged hqconsole server) because every
// candidate answer ends with a variable in the server's environment. A missing
// token is not an error: that source is simply "not configured" and says so.
//
// Shapes verified live against both APIs on 2026-08-19:
//   GET https://api.vercel.com/v9/projects?limit=N                 Bearer
//   GET https://api.vercel.com/v6/deployments?projectId=..&target=production&limit=1
//     -> {deployments: [{name, state, readyState, created(ms), url, target, meta}]}
//   GET <n8n>/api/v1/workflows?limit=N                             X-N8N-API-KEY
//     -> {data: [{id, name, active, updatedAt}], nextCursor?}
//
// Everything the providers return is treated as hostile input (lucy 2026-08-19):
//   - a response that ECHOES a configured credential is dropped entirely, not
//     merely truncated: a compromised provider must not be able to route a
//     token into ConsoleState and the browser through a success payload.
//   - error text is never echoed and never parsed; errors are classified by
//     HTTP status alone, because an error body can quote the request URL.
//   - a row that cannot be mapped is skipped without discarding its siblings.
//   - "ok" is only ever claimed on data that actually supports it.

import { getJson } from "./kuma.js";

const PROJECT_LIMIT = 20;
const N8N_LIMIT = 100;

function safeError(e) {
  const status = e && typeof e.status === "number" ? e.status : 0;
  if (status === 401 || status === 403) return "token rejected";
  if (status === 404) return "not found";
  if (status === 429) return "rate limited";
  if (status >= 500) return "provider error";
  const text = `${(e && e.name) || ""} ${(e && e.message) || ""}`;
  if (/abort|timeout/i.test(text)) return "timed out";
  if (/too large/i.test(text)) return "response too large";
  return "unreachable";
}

/** True when any string anywhere in the value contains a configured secret. */
export function echoesSecret(value, secrets) {
  // A floor is required: a one or two character "secret" would match ordinary
  // text everywhere and drop healthy data. Real provider tokens are 60+ chars,
  // so 4 is comfortably below anything genuine while staying selective.
  const needles = (secrets || []).filter((s) => typeof s === "string" && s.length >= 4);
  if (needles.length === 0) return false;
  const seen = new Set();
  const walk = (v) => {
    if (typeof v === "string") return needles.some((n) => v.includes(n));
    if (!v || typeof v !== "object" || seen.has(v)) return false;
    seen.add(v);
    return Object.values(v).some(walk);
  };
  return walk(value);
}

/** ISO string only for a timestamp a Date can actually represent. */
function isoOf(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * An n8n base URL is operator-supplied config, but it decides where an API key
 * is SENT, so it is validated hard: https only, no credentials in the URL, no
 * query or fragment, and only the origin is ever kept or shown (lucy).
 */
export function safeBaseUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || ""));
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.search || u.hash) return null;
  return u.origin;
}

const READY = { READY: "ok", ERROR: "failed", CANCELED: "failed", BUILDING: "building", QUEUED: "building", INITIALIZING: "building" };

/**
 * Newest PRODUCTION deployment per project. Asking for a flat deployment list
 * would both mask a failed production behind a newer preview and drop projects
 * past the page limit, so the project list drives one bounded query each.
 * @param {{token?: string, fetchImpl?: Function, timeoutMs?: number}} opts
 */
export async function fetchVercel(opts = {}) {
  const out = { provider: "vercel", configured: Boolean(opts.token), deploys: [], error: null, partial: false };
  if (!opts.token) return out;
  const headers = { Authorization: `Bearer ${opts.token}` };
  const secrets = [opts.token];
  try {
    const projects = await getJson(`https://api.vercel.com/v9/projects?limit=${PROJECT_LIMIT}`, { ...opts, headers });
    if (!projects || !Array.isArray(projects.projects)) throw Object.assign(new Error("shape"), { status: 0, invalid: true });
    if (echoesSecret(projects, secrets)) throw Object.assign(new Error("echo"), { echoed: true });
    const list = projects.projects.filter((p) => p && typeof p.name === "string" && typeof p.id === "string");
    out.partial = projects.projects.length >= PROJECT_LIMIT;
    // Bounded concurrency: 20 simultaneous requests invites throttling, and a
    // throttled project would then vanish (lucy). Batches of 5, and any project
    // that fails marks the provider partial instead of disappearing.
    const results = [];
    for (let i = 0; i < list.length; i += 5) {
      const batch = await Promise.all(
        list.slice(i, i + 5).map(async (p) => {
        try {
          const j = await getJson(
            `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(p.id)}&target=production&limit=1`,
            { ...opts, headers },
          );
          if (echoesSecret(j, secrets)) return { echoed: true };
          if (!j || !Array.isArray(j.deployments)) return { failed: true };
          const d = j.deployments[0];
          if (!d) return null;                       // a project with no production deploy yet
          // Only an EXPLICIT production deployment may speak for production: a
          // missing target is unknown, not an assumption (lucy).
          if (d.target !== "production") return { failed: true };
          return {
            id: `vercel:${p.name}`,
            provider: "vercel",
            name: p.name.slice(0, 60),
            state: READY[String(d.readyState || d.state || "").toUpperCase()] || "unknown",
            detail: [d.target || "production", d.meta && d.meta.githubCommitRef].filter((x) => typeof x === "string").join(" ").slice(0, 60) || null,
            at: isoOf(d.created),
            url: typeof d.url === "string" && /^[A-Za-z0-9.-]{1,180}$/.test(d.url) ? `https://${d.url}` : null,
          };
        } catch {
          return { failed: true };   // never discards siblings, but is counted
        }
      }),
      );
      results.push(...batch);
    }
    if (results.some((r) => r && r.echoed)) throw Object.assign(new Error("echo"), { echoed: true });
    const omitted = results.filter((r) => r && r.failed).length;
    if (omitted > 0) out.partial = true;
    out.deploys = results.filter((r) => r && !r.echoed && !r.failed);
  } catch (e) {
    out.error = e && e.echoed ? "provider echoed the credential; rows dropped" : e && e.invalid ? "invalid response" : safeError(e);
    out.deploys = [];
  }
  return out;
}

/**
 * n8n workflows: how many exist and how many are active. Completeness is
 * claimed only when the provider says there is no further page.
 * @param {{baseUrl?: string, token?: string, fetchImpl?: Function, timeoutMs?: number}} opts
 */
export async function fetchN8n(opts = {}) {
  const base = safeBaseUrl(opts.baseUrl);
  const out = { provider: "n8n", configured: Boolean(base && opts.token), deploys: [], error: null, partial: false };
  if (!opts.baseUrl || !opts.token) return out;
  if (!base) {
    out.error = "url must be https with no credentials";
    return out;
  }
  try {
    const j = await getJson(`${base}/api/v1/workflows?limit=${N8N_LIMIT}`, {
      ...opts,
      headers: { "X-N8N-API-KEY": opts.token },
    });
    if (!j || !Array.isArray(j.data)) throw Object.assign(new Error("shape"), { invalid: true });
    if (echoesSecret(j, [opts.token])) throw Object.assign(new Error("echo"), { echoed: true });
    const rows = j.data.filter((w) => w && typeof w === "object" && typeof w.active === "boolean");
    const malformed = rows.length !== j.data.length;
    out.partial = Boolean(j.nextCursor) || malformed;
    const active = rows.filter((w) => w.active).length;
    const times = rows.map((w) => (typeof w.updatedAt === "string" ? w.updatedAt : "")).filter(Boolean).sort();
    out.deploys.push({
      id: "n8n:workflows",
      provider: "n8n",
      name: "n8n workflows",
      // a partial or malformed page cannot support a confident "ok"
      state: rows.length === 0 || out.partial ? "unknown" : "ok",
      detail: `${active} active of ${rows.length}${out.partial ? ", partial" : ""}`,
      at: times.length ? times[times.length - 1] : null,
      url: base,
    });
  } catch (e) {
    out.error = e && e.echoed ? "provider echoed the credential; rows dropped" : e && e.invalid ? "invalid response" : safeError(e);
    out.deploys = [];
  }
  return out;
}

/** Both providers, each degrading alone. */
export async function fetchDeploys(cfg, opts = {}) {
  const [vercel, n8n] = await Promise.all([
    fetchVercel({ token: cfg.vercelToken, ...opts }),
    fetchN8n({ baseUrl: cfg.n8nUrl, token: cfg.n8nToken, ...opts }),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    deploys: [...vercel.deploys, ...n8n.deploys],
    providers: [
      { provider: "vercel", configured: vercel.configured, error: vercel.error, partial: vercel.partial },
      { provider: "n8n", configured: n8n.configured, error: n8n.error, partial: n8n.partial },
    ],
  };
}
