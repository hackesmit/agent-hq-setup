// Adversarial review probes (hq-px56): peer gate and header trust.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Auth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { fakeSources } from "./helpers.js";

const OWNER = "owner@example.com";
const prodCfg = (over = {}) =>
  loadConfig({ env: { CONSOLE_HOST: "hqbox.example.ts.net", CONSOLE_PORT: "8787", ...over }, argv: [] });
const selfOf = (nodeId = "nSELF", ips = ["100.64.0.1"]) => async () => ({ nodeId, ips });

test("whois: numeric Node.ID equal to self id is refused", async () => {
  const auth = new Auth(prodCfg(), {
    whois: async () => ({ UserProfile: { LoginName: OWNER }, Node: { ID: 12345, Addresses: ["100.64.0.9/32"] } }),
    selfInfo: selfOf("12345"),
  });
  const v = await auth.authorizePeer("100.64.0.9", 1);
  assert.equal(v.ok, false);
  assert.match(v.reason, /self-peer/);
});

test("whois: peer whose Addresses (CIDR form) include our own tailnet ip is refused", async () => {
  const auth = new Auth(prodCfg(), {
    whois: async () => ({ UserProfile: { LoginName: OWNER }, Node: { StableID: "nOTHER", Addresses: ["100.64.0.1/32", "fd7a::1/128"] } }),
    selfInfo: selfOf("nSELF", ["100.64.0.1"]),
  });
  const v = await auth.authorizePeer("100.64.0.9", 1);
  assert.equal(v.ok, false);
  assert.match(v.reason, /self-peer/);
});

test("whois: ipv4-mapped peer address equal to self ip is refused", async () => {
  const auth = new Auth(prodCfg(), {
    whois: async () => ({ UserProfile: { LoginName: OWNER }, Node: { StableID: "nOTHER" } }),
    selfInfo: selfOf("nSELF", ["100.64.0.1"]),
  });
  const v = await auth.authorizePeer("::ffff:100.64.0.1", 1);
  assert.equal(v.ok, false);
  assert.match(v.reason, /self-peer/);
});

test("whois: owner login with different case is refused (exact match)", async () => {
  const auth = new Auth(prodCfg(), {
    whois: async () => ({ UserProfile: { LoginName: OWNER.toUpperCase() }, Node: { StableID: "nOTHER" } }),
    selfInfo: selfOf(),
  });
  const v = await auth.authorizePeer("100.64.0.9", 1);
  assert.equal(v.ok, false);
});

test("whois: null, non-object, and empty-string login all refuse", async () => {
  for (const ret of [null, "string", 42, { UserProfile: { LoginName: "" } }, { UserProfile: null }]) {
    const auth = new Auth(prodCfg(), { whois: async () => ret, selfInfo: selfOf() });
    const v = await auth.authorizePeer("100.64.0.9", 1);
    assert.equal(v.ok, false, `whois=${JSON.stringify(ret)} must refuse`);
  }
});

test("whois: self identity failing refuses even for the owner", async () => {
  const auth = new Auth(prodCfg(), {
    whois: async () => ({ UserProfile: { LoginName: OWNER }, Node: { StableID: "nOTHER" } }),
    selfInfo: async () => {
      throw new Error("tailscale status failed");
    },
  });
  const v = await auth.authorizePeer("100.64.0.9", 1);
  assert.equal(v.ok, false);
});

test("prod cfg: dev loopback shortcut is not active", async () => {
  const auth = new Auth(prodCfg(), { whois: async () => null, selfInfo: selfOf() });
  const v = await auth.authorizePeer("127.0.0.1", 1);
  assert.equal(v.ok, false);
});

test("dev cfg: only loopback, tailnet address refused, headers irrelevant", async () => {
  const cfg = loadConfig({ env: { CONSOLE_DEV_NOAUTH: "1" }, argv: [] });
  const auth = new Auth(cfg, { whois: async () => ({ UserProfile: { LoginName: OWNER } }) });
  assert.equal((await auth.authorizePeer("100.64.0.9", 1)).ok, false);
  assert.equal((await auth.authorizePeer("::1", 1)).ok, true);
});

test("host: mismatch, port mismatch, prefix and suffix tricks are all refused", () => {
  const auth = new Auth(prodCfg(), {});
  for (const h of [
    "evil.example.com",
    "hqbox.example.ts.net:8788",
    "hqbox.example.ts.net.evil.com",
    "xhqbox.example.ts.net",
    "hqbox.example.ts.net:8787:8787",
    "",
    undefined,
    "127.0.0.1:8787",
    "localhost:8787",
  ]) {
    assert.equal(auth.hostAllowed(h), false, `host ${h} must be refused`);
  }
  assert.equal(auth.hostAllowed("HQBOX.example.ts.net:8787"), true);
});

/**
 * A live http app in PROD configuration with a fake whois that refuses, and a
 * client that forges every identity-looking header it can think of. Nothing in
 * the headers may open the door: the socket is destroyed or the request 403s.
 */
async function liveProdApp(whoisResult, delayMs = 0) {
  const cfg = prodCfg({ CONSOLE_PORT: "8787" });
  const auth = new Auth(cfg, {
    whois: () => new Promise((resolve) => setTimeout(() => resolve(whoisResult), delayMs)),
    selfInfo: selfOf(),
  });
  const app = createApp({ cfg, auth, sources: fakeSources(), log: () => {} });
  const server = http.createServer(app.handleRequest);
  server.on("connection", (socket) => {
    app.auth.gateSocket(socket).catch(() => socket.destroy());
  });
  server.on("upgrade", (req, socket, head) => app.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    app,
    port: server.address().port,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}

function rawRequest(port, headers, path = "/healthz") {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", (e) => resolve({ status: null, error: e.code }));
    req.end();
  });
}

test("forged identity headers do not authorize a peer whois refuses", async () => {
  const t = await liveProdApp({ UserProfile: { LoginName: "attacker@example.com" }, Node: { StableID: "nX" } });
  try {
    const r = await rawRequest(t.port, {
      host: "hqbox.example.ts.net:8787",
      "x-forwarded-for": "100.64.0.9",
      "x-real-ip": "100.64.0.9",
      "tailscale-user-login": OWNER,
      "x-tailscale-user": OWNER,
      "x-tailscale-login": OWNER,
      "x-console-key": t.app.csrf.key,
    });
    assert.ok(r.status === null || r.status === 403, `got ${JSON.stringify(r)}`);
  } finally {
    await t.close();
  }
});

test("a whois-refused peer never gets 200 even with the correct Host and CSRF key", async () => {
  const t = await liveProdApp(null);
  try {
    const r = await rawRequest(t.port, { host: "hqbox.example.ts.net:8787", "x-console-key": t.app.csrf.key }, "/api/state");
    assert.ok(r.status === null || r.status === 403, `got ${JSON.stringify(r)}`);
  } finally {
    await t.close();
  }
});
