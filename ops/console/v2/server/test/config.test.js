import test from "node:test";
import assert from "node:assert/strict";
import { ConfigError, allowedOrigins, hostAllowed, loadConfig } from "../src/config.js";

test("defaults match the design", () => {
  const cfg = loadConfig({ env: {}, argv: [] });
  assert.equal(cfg.owner, "owner@example.com");
  assert.equal(cfg.port, 8787);
  assert.equal(cfg.host, "hqbox.example.ts.net");
  assert.equal(cfg.hqRoot, "/home/owner/hq");
  assert.equal(cfg.releaseRoot, "/var/lib/hqconsole/releases/current");
  assert.equal(cfg.devNoAuth, false);
  assert.equal(cfg.tls, true);
  assert.equal(cfg.bindHost, null);
  assert.equal(cfg.check, false);
  // The ledger's home is the console's OWN tree, a sibling of state like the
  // inbox (prod: the provisioned /var/lib/hqconsole/money). It must never
  // default under stateDir: that is ~/hq/state, which the hqconsole user
  // cannot write, and on 2026-08-27 that misdefault took the server down on
  // the first money write. The test helpers pin CONSOLE_MONEY_DIR, so only
  // this env-free assertion guards the production default.
  assert.equal(cfg.moneyDir, "/var/lib/hqconsole/money");
});

test("--check is a flag, dev-noauth binds loopback without TLS", () => {
  const cfg = loadConfig({ env: { CONSOLE_DEV_NOAUTH: "1" }, argv: ["--check"] });
  assert.equal(cfg.check, true);
  assert.equal(cfg.devNoAuth, true);
  assert.equal(cfg.bindHost, "127.0.0.1");
  assert.equal(cfg.tls, false);
});

test("dev-noauth refuses to run alongside a tailnet bind", () => {
  assert.throws(
    () => loadConfig({ env: { CONSOLE_DEV_NOAUTH: "1", CONSOLE_BIND_TAILNET: "1" }, argv: [] }),
    ConfigError,
  );
});

test("a non-integer port is a config error, not a NaN", () => {
  assert.throws(() => loadConfig({ env: { CONSOLE_PORT: "eight" }, argv: [] }), ConfigError);
});

test("Host must name this console exactly", () => {
  const cfg = loadConfig({ env: { CONSOLE_HOST: "hqbox.example.ts.net", CONSOLE_PORT: "8787" }, argv: [] });
  assert.ok(hostAllowed(cfg, "hqbox.example.ts.net:8787"));
  assert.ok(hostAllowed(cfg, "HQBOX.EXAMPLE.TS.NET"));
  assert.ok(!hostAllowed(cfg, "127.0.0.1:8787"));
  assert.ok(!hostAllowed(cfg, "evil.example.com"));
  assert.ok(!hostAllowed(cfg, "hqbox.example.ts.net.evil.com"));
  assert.ok(!hostAllowed(cfg, ""));
});

test("origins are exact strings", () => {
  const cfg = loadConfig({ env: { CONSOLE_HOST: "hqbox.example.ts.net", CONSOLE_PORT: "8787" }, argv: [] });
  assert.deepEqual(allowedOrigins(cfg), ["https://hqbox.example.ts.net:8787"]);
  const dev = loadConfig({ env: { CONSOLE_DEV_NOAUTH: "1", CONSOLE_PORT: "8788" }, argv: [] });
  assert.deepEqual(allowedOrigins(dev), ["http://127.0.0.1:8788", "http://localhost:8788"]);
});
