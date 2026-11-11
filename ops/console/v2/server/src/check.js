// `node src/server.js --check`: the health-gated activation probe.
//
// Design section 3: the candidate loads configuration, resolves the release
// root (absent is a first-boot state and passes), verifies the protocol version
// constant, initialises collectors read-only, prints one JSON health line and
// exits 0/1. It never binds a port, never writes state, never reconciles.

import fs from "node:fs";
import { Alerts } from "./alerts.js";
import { Collectors, registerAll } from "./collectors.js";
import { Ops } from "./actions.js";
import { StaticServer } from "./static.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { loadConfig } from "./config.js";

/**
 * @param {{cfg?: any, sources?: any, expectProtocol?: number}} [opts]
 * @returns {Promise<{ok: boolean, checks: Record<string, any>}>}
 */
export async function runCheck(opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const checks = {};
  const problems = [];

  checks.config = { ok: true, port: cfg.port, host: cfg.host, owner: cfg.owner, devNoAuth: cfg.devNoAuth };

  // Protocol constant: a candidate that does not speak the version the rest of
  // the release expects must not be activated.
  const expect = opts.expectProtocol == null ? PROTOCOL_VERSION : opts.expectProtocol;
  checks.protocol = { ok: PROTOCOL_VERSION === expect, version: PROTOCOL_VERSION, expected: expect };
  if (!checks.protocol.ok) problems.push("protocol version mismatch");

  // Release root: absent is fine on first boot; present but unreadable is not.
  const statik = new StaticServer({ root: cfg.releaseRoot, log: () => {} });
  const found = await statik.reload();
  checks.releaseRoot = { ok: true, present: found, path: cfg.releaseRoot, release: statik.release };

  // TLS: report, never demand. Provisioning may run --check before the cert.
  if (cfg.tls) {
    try {
      const st = fs.statSync(`${cfg.tlsDir}/cert.pem`);
      checks.tls = { ok: true, present: true, size: st.size };
    } catch {
      checks.tls = { ok: true, present: false };
    }
  } else {
    checks.tls = { ok: true, present: false, devNoAuth: true };
  }

  // Collectors read-only: no alerts file, no ops dir, no hw/usage state writes.
  const alerts = new Alerts({ file: cfg.alertsFile, readOnly: true });
  const reg = new Collectors({ log: () => {} });
  registerAll(reg, { cfg, sources: opts.sources, alerts, readOnly: true });
  const ops = new Ops({ dir: cfg.opsDir, readOnly: true });
  checks.opsDir = { ok: true, readOnly: ops.readOnly };

  // Concurrent, each capped. One after another, flow (~27s) and calendar (~17s)
  // alone overran activate.sh's 30s cap, so releases passed or failed by luck
  // (2026-10-01: f744ac6 failed three runs in a row). A slow collector is a
  // degraded console, recorded as an error below, never a reason to block.
  const capMs = opts.collectorCapMs ?? 10000;
  const results = Object.fromEntries(
    await Promise.all(
      [...reg.entries.keys()].map(async (name) => {
        let timer;
        const late = new Promise((resolve) => {
          timer = setTimeout(() => resolve({ changed: false, error: `no answer within ${capMs / 1000}s (check only)` }), capMs);
        });
        const r = await Promise.race([reg.refresh(name), late]);
        clearTimeout(timer);
        return [name, r];
      }),
    ),
  );
  const collectorErrors = Object.entries(results)
    .filter(([, r]) => r && r.error)
    .map(([name, r]) => `${name}: ${r.error}`);
  checks.collectors = { ok: true, count: reg.statuses().length, errors: collectorErrors };
  // A failing collector is a degraded console, not a bad release: it does not
  // fail the check (the running server shows an error chip). Only the release
  // and protocol invariants gate activation.

  return { ok: problems.length === 0, checks, problems };
}
