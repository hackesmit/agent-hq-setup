// Configuration: environment and flags, resolved once and frozen.
// Design: docs/superpowers/specs/2026-08-17-console-v2-design.md section 3.

import path from "node:path";
import { PROTOCOL_VERSION, WS_PROTOCOL } from "./protocol.js";

export class ConfigError extends Error {}

const DEFAULTS = {
  owner: "owner@example.com",
  port: 8787,
  host: "hqbox.example.ts.net",
  hqRoot: "/home/owner/hq",
  releaseRoot: "/var/lib/hqconsole/releases/current",
  consoleStateDir: "/var/lib/hqconsole/state",
  tlsDir: "/var/lib/hqconsole/tls",
  tailscaleSocket: "/var/run/tailscale/tailscaled.sock",
};

/** @param {string|undefined} v @param {number} d */
function intOr(v, d, name) {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ConfigError(`${name} must be an integer, got ${JSON.stringify(v)}`);
  return n;
}

/**
 * @param {{env?: NodeJS.ProcessEnv, argv?: string[]}} [opts]
 */
export function loadConfig(opts = {}) {
  const env = opts.env || process.env;
  const argv = opts.argv || process.argv.slice(2);

  const check = argv.includes("--check");
  const devNoAuth = env.CONSOLE_DEV_NOAUTH === "1";
  const port = intOr(env.CONSOLE_PORT, DEFAULTS.port, "CONSOLE_PORT");
  if (port < 0 || port > 65535) throw new ConfigError(`CONSOLE_PORT out of range: ${port}`);

  // Dev mode is loopback only. A tailnet bind alongside it would put an
  // unauthenticated socket on the tailnet, so it is refused outright.
  if (devNoAuth && env.CONSOLE_BIND_TAILNET === "1") {
    throw new ConfigError("CONSOLE_DEV_NOAUTH=1 cannot be combined with CONSOLE_BIND_TAILNET=1");
  }

  const hqRoot = path.resolve(env.HQ_ROOT || DEFAULTS.hqRoot);
  const stateDir = path.resolve(env.HQ_STATE_DIR || path.join(hqRoot, "state"));
  // The server runs as hqconsole in production and cannot write into ~/hq, so
  // its own state lives in its own tree; dev keeps it inside the repo.
  const consoleStateDir = path.resolve(
    env.CONSOLE_STATE_DIR || (devNoAuth ? path.join(hqRoot, "state", "console-v2") : DEFAULTS.consoleStateDir),
  );
  const releaseRoot = path.resolve(env.CONSOLE_RELEASE_ROOT || DEFAULTS.releaseRoot);
  const wrapperPath = path.resolve(
    env.CONSOLE_WRAPPER ||
      (devNoAuth
        ? path.join(hqRoot, "ops", "console", "v2", "runner", "spawn-as-owner.sh")
        : path.join(releaseRoot, "runner", "spawn-as-owner.sh")),
  );

  const cfg = {
    check,
    devNoAuth,
    owner: env.CONSOLE_OWNER || DEFAULTS.owner,
    port,
    host: (env.CONSOLE_HOST || DEFAULTS.host).toLowerCase(),
    hqRoot,
    stateDir,
    consoleStateDir,
    alertsFile: path.join(consoleStateDir, "alerts.jsonl"),
    opsDir: path.join(consoleStateDir, "ops"),
    runnerSocket: env.CONSOLE_RUNNER_SOCKET || (devNoAuth ? path.join(consoleStateDir, "runner.sock") : "/run/hqconsole/runner.sock"),
    // the inbox is the sibling of the state dir (prod: state and inbox both under /var/lib/hqconsole),
    // and a test or dev state dir gets its own inbox next to it
    inboxDir: env.CONSOLE_INBOX_DIR || path.join(path.dirname(consoleStateDir), "inbox"),
    // The money ledger lives in the console's OWN tree like the inbox does
    // (prod: the provisioned /var/lib/hqconsole/money, 0750 hqconsole). It must
    // NOT default under stateDir: that is ~/hq/state, owned by owner, so the
    // first write EACCESed and 2026-08-27 that took the whole server down.
    moneyDir: env.CONSOLE_MONEY_DIR || path.join(path.dirname(consoleStateDir), "money"),
    // Uptime Kuma's published status page: plain JSON, no token (design 4.4).
    // Empty slug = not configured, and the panel says so rather than inventing health.
    kumaUrl: env.CONSOLE_KUMA_URL || "http://127.0.0.1:3001",
    kumaStatusPage: env.CONSOLE_KUMA_PAGE || "",
    // Cloud deploy tokens come from the environment only: never the repo, never
    // fetched by this process. Absent means "not configured", not an error.
    vercelToken: env.CONSOLE_VERCEL_TOKEN || "",
    n8nUrl: env.CONSOLE_N8N_URL || "",
    n8nToken: env.CONSOLE_N8N_TOKEN || "",
    healthFile: path.join(consoleStateDir, "health.json"),
    // OpenAI org-costs admin credential for the live Codex spend readout. Same
    // contract as the deploy tokens: environment only, never the repo; absent
    // means the readout says "not configured" rather than erroring.
    openaiAdmin: env.CONSOLE_OPENAI_ADMIN || "",
    releaseRoot,
    tlsDir: path.resolve(env.CONSOLE_TLS_DIR || DEFAULTS.tlsDir),
    tailscaleSocket: env.CONSOLE_TAILSCALE_SOCK || DEFAULTS.tailscaleSocket,
    // The single owner-context entry point; see wrapper.js.
    wrapperPath,
    wrapperSudo: env.CONSOLE_WRAPPER_SUDO === undefined || env.CONSOLE_WRAPPER_SUDO === ""
      ? !devNoAuth
      : env.CONSOLE_WRAPPER_SUDO === "1",
    wrapperUser: env.CONSOLE_WRAPPER_USER || "owner",
    // Capri, the meta terminal (proposal 19): OFF unless root sets the flag on the
    // unit. The meta dir holds the settings, hooks, passkey store and audit trail.
    metaEnabled: env.CONSOLE_META_ENABLED === "1",
    // Proposal 31: on a single-user tailnet-only box the owner may waive the passkey;
    // reaching the tailnet origin is then the gate. Default TRUE (passkey required):
    // only the explicit value "0", set by root in the unit env, relaxes it.
    metaRequirePasskey: env.CONSOLE_META_REQUIRE_PASSKEY !== "0",
    metaDir: path.resolve(env.CONSOLE_META_DIR || (devNoAuth ? path.join(consoleStateDir, "meta") : "/var/lib/hqconsole/meta")),
    // WebAuthn identity is the PUBLIC name the browser uses, which is not necessarily
    // the bind host (CONSOLE_HOST can be a bind address). Configurable and independent;
    // defaults to the tailnet host and its https origin.
    metaRpId: env.CONSOLE_META_RP_ID || (env.CONSOLE_HOST || DEFAULTS.host).toLowerCase(),
    metaOrigin:
      env.CONSOLE_META_ORIGIN ||
      (devNoAuth ? `http://127.0.0.1:${port}` : `https://${(env.CONSOLE_HOST || DEFAULTS.host).toLowerCase()}:${port}`),
    rigsDir: path.resolve(env.HQ_RIGS_DIR || path.join(hqRoot, "rigs")),
    protocol: PROTOCOL_VERSION,
    wsProtocol: WS_PROTOCOL,
    // Dev binds loopback and never terminates TLS; prod binds the tailnet
    // address resolved at start from `tailscale ip -4`.
    bindHost: devNoAuth ? "127.0.0.1" : null,
    tls: !devNoAuth,
    certWarnDays: intOr(env.CONSOLE_CERT_WARN_DAYS, 7, "CONSOLE_CERT_WARN_DAYS"),
    shutdownGraceMs: intOr(env.CONSOLE_SHUTDOWN_GRACE_MS, 60000, "CONSOLE_SHUTDOWN_GRACE_MS"),
    wsTokenTtlMs: intOr(env.CONSOLE_WS_TOKEN_TTL_MS, 30000, "CONSOLE_WS_TOKEN_TTL_MS"),
    // Ceiling on simultaneously accepted connections. See the note at listen():
    // the owner check costs a round trip to tailscaled and is paid before we know
    // whether the peer is allowed, so the accept rate needs a bound of its own.
    maxConnections: intOr(env.CONSOLE_MAX_CONNECTIONS, 256, "CONSOLE_MAX_CONNECTIONS"),
    // see ws.js sameConn: browsers upgrade on a new connection, so the port
    // half of the tuple is enforced only when this is set
    wsTokenStrictPort: env.CONSOLE_WS_TOKEN_STRICT_PORT === "1",
  };
  return Object.freeze(cfg);
}

/** @typedef {ReturnType<typeof loadConfig>} Config */

/** The web origins the browser may present. Exact strings, no wildcards. */
export function allowedOrigins(cfg) {
  if (cfg.devNoAuth) {
    return [`http://127.0.0.1:${cfg.port}`, `http://localhost:${cfg.port}`];
  }
  const out = [`https://${cfg.host}:${cfg.port}`];
  if (cfg.port === 443) out.push(`https://${cfg.host}`);
  return out;
}

/** Host header must name this console exactly (with or without the port). */
export function hostAllowed(cfg, hostHeader) {
  const h = String(hostHeader || "").toLowerCase();
  if (!h) return false;
  const names = cfg.devNoAuth ? ["127.0.0.1", "localhost"] : [cfg.host];
  for (const n of names) {
    if (h === n || h === `${n}:${cfg.port}`) return true;
  }
  return false;
}
