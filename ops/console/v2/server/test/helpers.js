// Test helpers: temp dirs, fake sockets, fake collector sources, a live app on
// loopback in dev mode. No network, no tailscale, no shell-outs.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";

export function tmpDir(prefix = "hqconsole-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function devConfig(over = {}) {
  const state = over.stateDir || tmpDir();
  return loadConfig({
    env: {
      CONSOLE_DEV_NOAUTH: "1",
      CONSOLE_PORT: String(over.port || 8788),
      CONSOLE_STATE_DIR: state,
      // moneyDir defaults to a SIBLING of the state dir (the provisioned layout);
      // for a tmp state dir that sibling is the shared os.tmpdir, so tests pin it
      // inside their own tree to stay isolated from each other.
      CONSOLE_MONEY_DIR: path.join(state, "money"),
      CONSOLE_RELEASE_ROOT: over.releaseRoot || path.join(state, "release"),
      HQ_ROOT: over.hqRoot || "/home/owner/hq",
      HQ_STATE_DIR: state,
      ...(over.env || {}),
    },
    argv: over.argv || [],
  });
}

/** A socket-shaped object for the auth and ws unit tests. */
export function fakeSocket(ip = "127.0.0.1", port = 51234) {
  const s = {
    remoteAddress: ip,
    remotePort: port,
    destroyed: false,
    written: [],
    destroy() {
      this.destroyed = true;
    },
    write(chunk) {
      this.written.push(String(chunk));
      return true;
    },
  };
  return s;
}

/** Deterministic collector sources: no ctl.sh, no python, no bd. */
export function fakeSources(over = {}) {
  return {
    ctlState: over.ctlState || (async () => ({ terminals: [], requests: [], snoozed: [], phases: {}, tasks: {}, usage: {} })),
    hw: over.hw || (async () => ({ cpu: { pct: 1, cores: 4, load: [0, 0, 0] }, mem: {}, swap: {}, disks: [], procs: [] })),
    usage: over.usage || (async () => ({ today: {}, week: {} })),
    readyBeads: over.readyBeads || (async () => []),
    gitLog: over.gitLog || (async () => ""),
    stackData: over.stackData || (async () => ({ generatedAt: "2026-08-19T00:00:00Z", windows: [7, 30, 90], items: [] })),
    servicesData:
      over.servicesData ||
      (async () => ({
        generatedAt: "2026-08-19T00:00:00Z",
        services: [],
        servicesError: null,
        jobs: [],
        jobsError: null,
        automations: { mail: { flags: { disabled: false, logOnly: false }, heartbeats: [], recentRuns: [] } },
      })),
    deploysData: over.deploysData || (async () => ({ generatedAt: "2026-08-19T00:00:00Z", deploys: [], providers: [{ provider: "vercel", configured: false, error: null }, { provider: "n8n", configured: false, error: null }] })),
    kumaData: over.kumaData || (async () => ({ generatedAt: "2026-08-19T00:00:00Z", source: null, monitors: [], error: "no status page configured" })),
    usageSeries: over.usageSeries || (async () => ({ series: [{ day: "2026-08-18", sessions: 2, output: 1000, input: 5000, cache_read: 20000, cache_write: 0 }] })),
  };
}

/**
 * Start the app on loopback with the dev gate, and return a fetch-ish helper.
 */
export async function startTestApp(over = {}) {
  const cfg = devConfig(over);
  const app = createApp({ cfg, sources: fakeSources(over.sources), runner: over.runner, runnerClient: over.runnerClient, wrapper: over.wrapper, passkey: over.passkey, projects: over.projects, uploads: over.uploads, loaded: over.loaded, log: () => {} });
  const server = http.createServer(app.handleRequest);
  server.on("connection", (socket) => {
    app.auth.gateSocket(socket).catch(() => socket.destroy());
  });
  server.on("upgrade", (req, socket, head) => app.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  // the Host header must name the configured port, so align config and socket
  const host = `127.0.0.1:${cfg.port}`;

  async function request(method, urlPath, opts = {}) {
    const headers = { host, ...(opts.headers || {}) };
    const body = opts.raw ? opts.raw : opts.body === undefined ? null : JSON.stringify(opts.body);
    if (body && !opts.raw) headers["content-type"] = "application/json";
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode, headers: res.headers, text: data, json });
        });
      });
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  return {
    app,
    cfg,
    server,
    port,
    request,
    key: app.csrf.key,
    async close() {
      app.ws.closeAll(1001, "test over");
      const done = new Promise((r) => server.close(r));
      // keep-alive and WebSocket sockets would hold close() open forever
      server.closeAllConnections();
      await done;
    },
  };
}
