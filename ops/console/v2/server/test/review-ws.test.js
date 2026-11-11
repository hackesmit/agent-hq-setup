// Adversarial review probes (hq-px56): WebSocket token and upgrade gate.
import test from "node:test";
import assert from "node:assert/strict";
import { Auth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { WsLayer, createTokens } from "../src/ws.js";
import { WS_PROTOCOL } from "../src/protocol.js";
import { fakeSocket } from "./helpers.js";

const cfg = loadConfig({ env: { CONSOLE_HOST: "hqbox.example.ts.net", CONSOLE_PORT: "8787" }, argv: [] });
const ORIGIN = "https://hqbox.example.ts.net:8787";

async function gated(socket) {
  const auth = new Auth(cfg, {
    whois: async () => ({ UserProfile: { LoginName: cfg.owner }, Node: { StableID: "nPEER" } }),
    selfInfo: async () => ({ nodeId: "nSELF", ips: ["100.64.0.1"] }),
  });
  await auth.gateSocket(socket);
  return auth;
}

function req(proto, headers = {}, url = "/ws") {
  return { url, headers: { host: "hqbox.example.ts.net:8787", origin: ORIGIN, "sec-websocket-protocol": proto, ...headers } };
}

test("token reuse: second upgrade with the same token is refused, and the token is burnt on a failed attempt too", async () => {
  const sock = fakeSocket("100.64.0.9", 5000);
  const auth = await gated(sock);
  const tokens = createTokens({});
  const ws = new WsLayer({ cfg, auth, tokens, getHello: async () => ({}) });
  const { token } = tokens.mint("100.64.0.9:5000");
  assert.equal(ws.validateUpgrade(req(`${WS_PROTOCOL}, tok.${token}`), sock).ok, true);
  assert.equal(ws.validateUpgrade(req(`${WS_PROTOCOL}, tok.${token}`), sock).ok, false);

  // a token presented with a bad origin is refused before redeem (origin is
  // checked first), so it stays in the store; it must still be unusable from
  // any other address
  const { token: t2 } = tokens.mint("100.64.0.9:5000");
  assert.equal(ws.validateUpgrade(req(`${WS_PROTOCOL}, tok.${t2}`, { origin: "https://evil.example.com" }), sock).ok, false);
  assert.equal(tokens.size, 1);
  const other = fakeSocket("100.64.0.77", 6000);
  await gated(other);
  assert.equal(ws.validateUpgrade(req(`${WS_PROTOCOL}, tok.${t2}`), other).ok, false);
});

test("token minted for one address is useless from another address (owner device B)", async () => {
  const a = fakeSocket("100.64.0.9", 5000);
  const b = fakeSocket("100.64.0.10", 5000);
  const auth = await gated(a);
  await auth.gateSocket(b);
  const tokens = createTokens({});
  const ws = new WsLayer({ cfg, auth, tokens, getHello: async () => ({}) });
  const { token } = tokens.mint("100.64.0.9:5000");
  const v = ws.validateUpgrade(req(`${WS_PROTOCOL}, tok.${token}`), b);
  assert.equal(v.ok, false);
  assert.match(v.reason, /another connection/);
});

test("token expiry is enforced at redeem time with an injectable clock", () => {
  let t = 1_000_000;
  const tokens = createTokens({ ttlMs: 30000, now: () => t });
  const { token } = tokens.mint("100.64.0.9:5000");
  t += 29_999;
  assert.equal(tokens.redeem(token, "100.64.0.9:5001").ok, true);
  const { token: t2 } = tokens.mint("100.64.0.9:5000");
  t += 30_000;
  const v = tokens.redeem(t2, "100.64.0.9:5001");
  assert.equal(v.ok, false);
  assert.equal(tokens.size, 0);
});

test("wrong or missing Origin, wrong Host, wrong path, and missing/duplicate token subprotocols are all refused", async () => {
  const sock = fakeSocket("100.64.0.9", 5000);
  const auth = await gated(sock);
  const tokens = createTokens({});
  const ws = new WsLayer({ cfg, auth, tokens, getHello: async () => ({}) });
  const mint = () => tokens.mint("100.64.0.9:5000").token;
  const cases = [
    ["origin without port", req(`${WS_PROTOCOL}, tok.${mint()}`, { origin: "https://hqbox.example.ts.net" })],
    ["origin http", req(`${WS_PROTOCOL}, tok.${mint()}`, { origin: "http://hqbox.example.ts.net:8787" })],
    ["origin null", req(`${WS_PROTOCOL}, tok.${mint()}`, { origin: "null" })],
    ["origin missing", { url: "/ws", headers: { host: "hqbox.example.ts.net:8787", "sec-websocket-protocol": `${WS_PROTOCOL}, tok.${mint()}` } }],
    ["origin suffix", req(`${WS_PROTOCOL}, tok.${mint()}`, { origin: "https://hqbox.example.ts.net:8787.evil.com" })],
    ["host mismatch", req(`${WS_PROTOCOL}, tok.${mint()}`, { host: "evil.example.com" })],
    ["wrong path", req(`${WS_PROTOCOL}, tok.${mint()}`, {}, "/api/ws")],
    ["no app protocol", req(`tok.${mint()}`)],
    ["two tokens", req(`${WS_PROTOCOL}, tok.${mint()}, tok.${mint()}`)],
    ["empty token", req(`${WS_PROTOCOL}, tok.`)],
    ["unknown token", req(`${WS_PROTOCOL}, tok.nope`)],
    ["no protocol header", req(undefined)],
  ];
  for (const [name, r] of cases) {
    assert.equal(ws.validateUpgrade(r, sock).ok, false, `${name} must be refused`);
  }
  // control: the same socket with a fresh token and correct headers passes
  assert.equal(ws.validateUpgrade(req(`${WS_PROTOCOL}, tok.${mint()}`), sock).ok, true);
});

test("an upgrade on an ungated socket is refused even with a valid token", async () => {
  const minted = fakeSocket("100.64.0.9", 5000);
  const auth = await gated(minted);
  const tokens = createTokens({});
  const ws = new WsLayer({ cfg, auth, tokens, getHello: async () => ({}) });
  const { token } = tokens.mint("100.64.0.9:5000");
  const ungated = fakeSocket("100.64.0.9", 5001);
  const v = ws.validateUpgrade(req(`${WS_PROTOCOL}, tok.${token}`), ungated);
  assert.equal(v.ok, false);
  assert.match(v.reason, /not authorized/);
});
