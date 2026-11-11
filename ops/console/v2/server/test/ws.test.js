import test from "node:test";
import assert from "node:assert/strict";
import { Auth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { WsLayer, createTokens, parseProtocols } from "../src/ws.js";
import { WS_PROTOCOL } from "../src/protocol.js";
import { fakeSocket } from "./helpers.js";

const cfg = loadConfig({ env: { CONSOLE_HOST: "hqbox.example.ts.net", CONSOLE_PORT: "8787" }, argv: [] });

function authFor(socket) {
  const auth = new Auth(cfg, {
    whois: async () => ({ UserProfile: { LoginName: cfg.owner }, Node: { StableID: "nPEER" } }),
    selfInfo: async () => ({ nodeId: "nSELF", ips: ["100.64.0.1"] }),
  });
  return auth.gateSocket(socket).then(() => auth);
}

function upgradeReq(over = {}) {
  return {
    url: over.url || "/ws",
    headers: {
      host: "hqbox.example.ts.net:8787",
      origin: "https://hqbox.example.ts.net:8787",
      "sec-websocket-protocol": over.proto,
      ...(over.headers || {}),
    },
  };
}

test("tokens are one-use", () => {
  const t = createTokens({});
  const { token } = t.mint("100.64.0.9:5000");
  assert.equal(t.redeem(token, "100.64.0.9:5000").ok, true);
  const again = t.redeem(token, "100.64.0.9:5000");
  assert.equal(again.ok, false);
  assert.match(again.reason, /unknown or used/);
});

test("tokens expire after 30 seconds", () => {
  let now = 1000;
  const t = createTokens({ now: () => now, ttlMs: 30000 });
  const { token, expiresInS } = t.mint("a:1");
  assert.equal(expiresInS, 30);
  now += 30001;
  const r = t.redeem(token, "a:1");
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown or used|expired/);
});

test("a token is bound to the peer address, and to the full tuple in strict mode", () => {
  const t = createTokens({});
  const { token } = t.mint("100.64.0.9:5000");
  // another device cannot use it
  assert.equal(t.redeem(token, "100.64.0.77:5000").ok, false);
  // the same device's new connection can (a browser upgrades on a new socket)
  const { token: t2 } = t.mint("100.64.0.9:5000");
  assert.equal(t.redeem(t2, "100.64.0.9:5001").ok, true);

  const strict = createTokens({ strictPort: true });
  const { token: t3 } = strict.mint("100.64.0.9:5000");
  const wrongPort = strict.redeem(t3, "100.64.0.9:5001");
  assert.equal(wrongPort.ok, false);
  assert.match(wrongPort.reason, /another connection/);
});

test("subprotocol header parsing", () => {
  assert.deepEqual(parseProtocols("hq-console-v1, tok.abc"), ["hq-console-v1", "tok.abc"]);
  assert.deepEqual(parseProtocols(""), []);
});

test("upgrade: happy path, then every refusal", async () => {
  const socket = fakeSocket("100.64.0.9", 5000);
  const auth = await authFor(socket);
  const tokens = createTokens({});
  const ws = new WsLayer({ cfg, auth, tokens, getHello: async () => ({}), log: () => {} });

  const good = tokens.mint(Auth.connKey(socket)).token;
  assert.equal(ws.validateUpgrade(upgradeReq({ proto: `${WS_PROTOCOL}, tok.${good}` }), socket).ok, true);

  // wrong origin
  const t2 = tokens.mint(Auth.connKey(socket)).token;
  const badOrigin = ws.validateUpgrade(
    upgradeReq({ proto: `${WS_PROTOCOL}, tok.${t2}`, headers: { origin: "https://evil.example.com" } }),
    socket,
  );
  assert.equal(badOrigin.ok, false);
  assert.match(badOrigin.reason, /origin/);

  // wrong host
  const t3 = tokens.mint(Auth.connKey(socket)).token;
  const badHost = ws.validateUpgrade(
    upgradeReq({ proto: `${WS_PROTOCOL}, tok.${t3}`, headers: { host: "127.0.0.1:8787" } }),
    socket,
  );
  assert.equal(badHost.ok, false);
  assert.match(badHost.reason, /host/);

  // missing subprotocol
  const t4 = tokens.mint(Auth.connKey(socket)).token;
  const noProto = ws.validateUpgrade(upgradeReq({ proto: `tok.${t4}` }), socket);
  assert.equal(noProto.ok, false);
  assert.match(noProto.reason, /subprotocol/);

  // no token at all
  assert.equal(ws.validateUpgrade(upgradeReq({ proto: WS_PROTOCOL }), socket).ok, false);

  // a token minted for another device
  const other = fakeSocket("100.64.0.44", 5001);
  const stolen = tokens.mint(Auth.connKey(other)).token;
  const wrongConn = ws.validateUpgrade(upgradeReq({ proto: `${WS_PROTOCOL}, tok.${stolen}` }), socket);
  assert.equal(wrongConn.ok, false);
  assert.match(wrongConn.reason, /another connection/);

  // an unauthorized socket cannot upgrade even with a valid-looking token
  const rogue = fakeSocket("100.64.0.77", 6000);
  const t5 = tokens.mint(Auth.connKey(rogue)).token;
  const unauth = ws.validateUpgrade(upgradeReq({ proto: `${WS_PROTOCOL}, tok.${t5}` }), rogue);
  assert.equal(unauth.ok, false);
  assert.match(unauth.reason, /not authorized/);

  // wrong path
  const t6 = tokens.mint(Auth.connKey(socket)).token;
  assert.equal(ws.validateUpgrade(upgradeReq({ url: "/wss", proto: `${WS_PROTOCOL}, tok.${t6}` }), socket).ok, false);
});

test("a refused upgrade writes 403 and destroys the socket", async () => {
  const socket = fakeSocket("100.64.0.9", 5000);
  const auth = await authFor(socket);
  const ws = new WsLayer({ cfg, auth, tokens: createTokens({}), getHello: async () => ({}), log: () => {} });
  ws.handleUpgrade(upgradeReq({ proto: WS_PROTOCOL }), socket, Buffer.alloc(0));
  assert.match(socket.written.join(""), /^HTTP\/1\.1 403 Forbidden/);
  assert.equal(socket.destroyed, true);
});

test("term.* is answered with runner-not-connected, ping with pong", async () => {
  const auth = new Auth(cfg, {});
  const ws = new WsLayer({ cfg, auth, tokens: createTokens({}), getHello: async () => ({}), log: () => {} });
  const sent = [];
  const client = { readyState: 1, OPEN: 1, send: (m) => sent.push(JSON.parse(m)), on() {} };
  ws.clients.set(client, { slices: null });

  ws.onMessage(client, JSON.stringify({ t: "term.attach", sid: "t-1", cols: 80, rows: 24 }));
  assert.deepEqual(sent.pop(), { t: "term.error", sid: "t-1", error: "runner not connected" });
  ws.onMessage(client, JSON.stringify({ t: "term.input", sid: "t-1", data: "ls\n" }));
  assert.equal(sent.pop().error, "runner not connected");
  ws.onMessage(client, JSON.stringify({ t: "ping", ts: 42 }));
  assert.deepEqual(sent.pop(), { t: "pong", ts: 42 });
  ws.onMessage(client, "not json at all");
  assert.equal(sent.length, 0);
});

test("subscribe filters the slice broadcast", () => {
  const ws = new WsLayer({ cfg, auth: new Auth(cfg, {}), tokens: createTokens({}), getHello: async () => ({}), log: () => {} });
  const sent = [];
  const client = { readyState: 1, OPEN: 1, send: (m) => sent.push(JSON.parse(m)), on() {} };
  ws.clients.set(client, { slices: null });
  ws.onMessage(client, JSON.stringify({ t: "subscribe", slices: ["sessions"] }));
  ws.broadcastSlice("requests", []);
  assert.equal(sent.length, 0);
  ws.broadcastSlice("sessions", [{ id: "t-1" }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].t, "state");
  assert.equal(sent[0].slice, "sessions");
});
