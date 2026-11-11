import test from "node:test";
import assert from "node:assert/strict";
import { Auth, certVerdict, normalizeIp } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { fakeSocket } from "./helpers.js";

const OWNER = "owner@example.com";
const prodCfg = (over = {}) =>
  loadConfig({ env: { CONSOLE_HOST: "hqbox.example.ts.net", CONSOLE_PORT: "8787", ...over }, argv: [] });

function whoisOf(login, nodeId = "nPEER", addrs = ["100.64.0.9"]) {
  return async () => ({ UserProfile: { LoginName: login }, Node: { StableID: nodeId, Addresses: addrs } });
}
const selfOf = (nodeId = "nSELF", ips = ["100.64.0.1"]) => async () => ({ nodeId, ips });

test("owner on another node is accepted", async () => {
  const auth = new Auth(prodCfg(), { whois: whoisOf(OWNER), selfInfo: selfOf() });
  const v = await auth.authorizePeer("100.64.0.9", 40000);
  assert.equal(v.ok, true);
  assert.equal(v.login, OWNER);
});

test("a different login is refused", async () => {
  const auth = new Auth(prodCfg(), { whois: whoisOf("someone-else@example.com"), selfInfo: selfOf() });
  const v = await auth.authorizePeer("100.64.0.9", 40000);
  assert.equal(v.ok, false);
  assert.match(v.reason, /not the owner/);
});

test("self-peer is refused by node id even with the owner login", async () => {
  const auth = new Auth(prodCfg(), { whois: whoisOf(OWNER, "nSELF", ["100.64.0.1"]), selfInfo: selfOf("nSELF") });
  const v = await auth.authorizePeer("100.64.0.9", 40000);
  assert.equal(v.ok, false);
  assert.match(v.reason, /self-peer/);
});

test("self-peer is refused by address when the node id is missing", async () => {
  const auth = new Auth(prodCfg(), { whois: whoisOf(OWNER, "", ["100.64.0.1"]), selfInfo: selfOf("") });
  const v = await auth.authorizePeer("100.64.0.1", 40000);
  assert.equal(v.ok, false);
  assert.match(v.reason, /self-peer/);
});

test("no whois (daemon down) refuses rather than falling open", async () => {
  const auth = new Auth(prodCfg(), {
    whois: async () => {
      throw new Error("connect ENOENT /var/run/tailscale/tailscaled.sock");
    },
    selfInfo: selfOf(),
  });
  const v = await auth.authorizePeer("100.64.0.9", 40000);
  assert.equal(v.ok, false);
  assert.match(v.reason, /whois failed/);
});

test("whois without a login is refused", async () => {
  const auth = new Auth(prodCfg(), { whois: async () => ({ Node: {} }), selfInfo: selfOf() });
  const v = await auth.authorizePeer("100.64.0.9", 40000);
  assert.equal(v.ok, false);
  assert.match(v.reason, /no login/);
});

test("gateSocket destroys a refused socket and stamps an accepted one", async () => {
  const auth = new Auth(prodCfg(), { whois: whoisOf("intruder@example.com"), selfInfo: selfOf() });
  const bad = fakeSocket("100.64.0.5");
  await auth.gateSocket(bad);
  assert.equal(bad.destroyed, true);
  assert.equal(auth.socketAllowed(bad), false);

  const good = new Auth(prodCfg(), { whois: whoisOf(OWNER), selfInfo: selfOf() });
  const ok = fakeSocket("100.64.0.9");
  await good.gateSocket(ok);
  assert.equal(ok.destroyed, false);
  assert.equal(good.socketAllowed(ok), true);
});

test("dev mode accepts loopback only and never calls whois", async () => {
  let called = 0;
  const auth = new Auth(loadConfig({ env: { CONSOLE_DEV_NOAUTH: "1" }, argv: [] }), {
    whois: async () => {
      called += 1;
      return {};
    },
  });
  assert.equal((await auth.authorizePeer("127.0.0.1", 1)).ok, true);
  assert.equal((await auth.authorizePeer("::ffff:127.0.0.1", 1)).ok, true);
  assert.equal((await auth.authorizePeer("100.64.0.9", 1)).ok, false);
  assert.equal(called, 0);
});

test("bind address: dev loopback, prod refuses a loopback answer", async () => {
  const dev = new Auth(loadConfig({ env: { CONSOLE_DEV_NOAUTH: "1" }, argv: [] }), {});
  assert.equal(await dev.resolveBindAddress(), "127.0.0.1");

  const prod = new Auth(prodCfg(), { tailnetIp: async () => "100.64.0.1" });
  assert.equal(await prod.resolveBindAddress(), "100.64.0.1");

  const bad = new Auth(prodCfg(), { tailnetIp: async () => "127.0.0.1" });
  await assert.rejects(() => bad.resolveBindAddress(), /loopback/);
});

test("host and origin checks are exact", () => {
  const auth = new Auth(prodCfg(), {});
  assert.ok(auth.hostAllowed("hqbox.example.ts.net:8787"));
  assert.ok(!auth.hostAllowed("localhost:8787"));
  assert.ok(auth.originAllowed("https://hqbox.example.ts.net:8787"));
  assert.ok(!auth.originAllowed("https://hqbox.example.ts.net"));
  assert.ok(!auth.originAllowed("http://hqbox.example.ts.net:8787"));
  assert.ok(!auth.originAllowed("null"));
});

test("connKey binds a token to address and port", () => {
  assert.equal(Auth.connKey(fakeSocket("::ffff:100.64.0.9", 4242)), "100.64.0.9:4242");
  assert.equal(normalizeIp("::ffff:10.0.0.1"), "10.0.0.1");
});

test("cert verdict drives the start/alert/exit decision", () => {
  assert.equal(certVerdict(30), "ok");
  assert.equal(certVerdict(3), "warn");
  assert.equal(certVerdict(0), "expired");
  assert.equal(certVerdict(-2), "expired");
  assert.equal(certVerdict(null), "unknown");
});

test("loadTls reads both files and survives an unparseable certificate", async () => {
  const auth = new Auth(prodCfg(), { readFile: async (p) => Buffer.from(`content of ${p}`) });
  const tls = await auth.loadTls();
  assert.match(tls.cert.toString(), /cert\.pem$/);
  assert.match(tls.key.toString(), /key\.pem$/);
  assert.equal(tls.notAfter, null);
  assert.equal(tls.daysLeft, null);
  assert.equal(tls.expired, false);
});

test("a broken self-lookup costs one subprocess per interval, not one per connection", async () => {
  // Every accepted socket asks who the peer is, and the self-identity lookup sits
  // on that path. The old code awaited BEFORE assigning the cache, so concurrent
  // connections each spawned their own lookup, and a failure cached nothing at all
  // so every future connection retried forever.
  let calls = 0;
  let clock = 0;
  const failing = new Auth(
    prodCfg(),
    {
      now: () => clock,
      selfInfo: async () => {
        calls += 1;
        throw new Error("tailscale unavailable");
      },
    },
  );
  // ten at once share one lookup
  await Promise.allSettled(Array.from({ length: 10 }, () => failing.self()));
  assert.equal(calls, 1, `concurrent callers shared one lookup, got ${calls}`);
  // and the failure is remembered rather than retried per call
  await Promise.allSettled(Array.from({ length: 10 }, () => failing.self()));
  assert.equal(calls, 1, "the cached failure answered without another subprocess");
  // once the window passes it tries again, so a box that recovers serves again
  clock += 10_000;
  await failing.self().catch(() => {});
  assert.equal(calls, 2, "it retries after the failure window");

  // a success is cached permanently and shared by concurrent callers
  let okCalls = 0;
  const good = new Auth(
    prodCfg(),
    { now: () => clock, selfInfo: async () => { okCalls += 1; return { ips: ["100.1.2.3"], nodeId: "n1" }; } },
  );
  const all = await Promise.all(Array.from({ length: 10 }, () => good.self()));
  assert.equal(okCalls, 1);
  assert.equal(all[0].nodeId, "n1");
});
