// Review follow-up (hq-px56, findings F1/F2): the peer gate must hold in the
// real wiring (startServer): TLS owner peers are served, a slow whois never
// 403s an owner's first request, and a refused peer gets a reset with no HTTP
// response body (its bytes never reach the http parser).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Auth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { startServer } from "../src/server.js";
import { fakeSources, tmpDir } from "./helpers.js";

const OWNER = "owner@example.com";
const ownerWhois = async () => ({ UserProfile: { LoginName: OWNER }, Node: { StableID: "nPEER", Addresses: ["100.64.0.9/32"] } });
const strangerWhois = async () => ({ UserProfile: { LoginName: "x@example.com" }, Node: { StableID: "nX", Addresses: ["100.64.0.7/32"] } });
const selfInfo = async () => ({ nodeId: "nSELF", ips: ["100.64.0.1"] });
const delayed = (fn, ms) => () => new Promise((resolve) => setTimeout(() => resolve(fn()), ms));

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

function get(opts) {
  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", (e) => resolve({ status: null, error: e.code || e.message }));
    req.end();
  });
}

async function boot(whois) {
  const base = tmpDir("hqconsole-review-gate-");
  const tls = path.join(base, "tls");
  fs.mkdirSync(tls);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(tls, "key.pem"), "-out", path.join(tls, "cert.pem"), "-days", "30", "-subj", "/CN=hqbox.example.ts.net"], { stdio: "ignore" });
  const port = await freePort();
  const cfg = loadConfig({
    env: {
      CONSOLE_HOST: "hqbox.example.ts.net",
      CONSOLE_PORT: String(port),
      CONSOLE_STATE_DIR: path.join(base, "state"),
      HQ_STATE_DIR: path.join(base, "hq-state"),
      CONSOLE_TLS_DIR: tls,
      CONSOLE_RELEASE_ROOT: path.join(base, "releases", "current"),
      HQ_ROOT: base,
    },
    argv: [],
  });
  const auth = new Auth(cfg, { whois, selfInfo, tailnetIp: async () => "100.64.0.1" });
  auth.resolveBindAddress = async () => "127.0.0.1";
  const started = await startServer({ cfg, auth, sources: fakeSources(), log: () => {} });
  return { ...started, port };
}

test("gate: an owner peer whose whois takes 150ms still gets 200 on its first request (TLS, real wiring)", async () => {
  const { server, shutdown, port } = await boot(delayed(ownerWhois, 150));
  try {
    const r = await get({ host: "127.0.0.1", port, path: "/healthz", rejectUnauthorized: false, headers: { host: `hqbox.example.ts.net:${port}` } });
    assert.equal(r.status, 200, `got ${JSON.stringify(r)}`);
  } finally {
    await shutdown("test");
    server.closeAllConnections();
  }
});

test("gate: a refused peer gets a reset and never an HTTP response, even while whois is pending", async () => {
  const { server, shutdown, port } = await boot(delayed(strangerWhois, 150));
  try {
    const r = await get({ host: "127.0.0.1", port, path: "/healthz", rejectUnauthorized: false, headers: { host: `hqbox.example.ts.net:${port}` } });
    assert.equal(r.status, null, `refused peer received an HTTP response: ${JSON.stringify(r)}`);
  } finally {
    await shutdown("test");
    server.closeAllConnections();
  }
});
