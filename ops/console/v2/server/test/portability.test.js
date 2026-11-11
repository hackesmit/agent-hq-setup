// Portability: the console must be re-identifiable by configuration alone.
//
// The workshop was written for one box and grew one person's name into a hundred places
// (docs/SHARING.md counts them). The console is the part that is already portable, and
// this test is what keeps it that way: every value that says WHOSE this install is has
// to come from the environment, so a second operator changes one file rather than
// hunting through source. A default that cannot be overridden is a bug here, not a
// convenience.
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

/** What a second operator would put in ops/config/site.env. */
const THEIRS = {
  CONSOLE_HOST: "box.tailscale-example.ts.net",
  CONSOLE_OWNER: "someone@example.com",
  CONSOLE_PORT: "9001",
  HQ_ROOT: "/home/someone/hq",
};

test("every identity value follows the environment", () => {
  const cfg = loadConfig({ env: { ...THEIRS }, argv: [] });
  assert.equal(cfg.host, "box.tailscale-example.ts.net");
  assert.equal(cfg.owner, "someone@example.com");
  assert.equal(cfg.port, 9001);
  assert.equal(cfg.hqRoot, "/home/someone/hq");
  // derived paths follow the root rather than being spelled out again
  assert.equal(cfg.rigsDir, "/home/someone/hq/rigs");
  assert.ok(cfg.stateDir.startsWith("/home/someone/hq"), cfg.stateDir);
});

test("the WebAuthn identity follows the host, and can be set apart from it", () => {
  const derived = loadConfig({ env: { ...THEIRS }, argv: [] });
  assert.equal(derived.metaRpId, "box.tailscale-example.ts.net");
  assert.equal(derived.metaOrigin, "https://box.tailscale-example.ts.net:9001");

  // a console reached by another name than the one it binds
  const split = loadConfig({
    env: { ...THEIRS, CONSOLE_META_RP_ID: "hq.example.com", CONSOLE_META_ORIGIN: "https://hq.example.com" },
    argv: [],
  });
  assert.equal(split.metaRpId, "hq.example.com");
  assert.equal(split.metaOrigin, "https://hq.example.com");
});

test("no identity value from this install leaks into a configured one", () => {
  const cfg = loadConfig({ env: { ...THEIRS }, argv: [] });
  const spelled = JSON.stringify(cfg);
  for (const mine of ["hqbox.example", "owner", "/home/owner"]) {
    assert.ok(!spelled.includes(mine), `a configured install still mentions ${mine}`);
  }
});

test("the defaults are still this install, so nothing changes without a site file", () => {
  const cfg = loadConfig({ env: {}, argv: [] });
  assert.equal(cfg.host, "hqbox.example.ts.net");
  assert.equal(cfg.owner, "owner@example.com");
  assert.equal(cfg.hqRoot, "/home/owner/hq");
});

test("the meta terminal and cloud collectors stay off until configured", () => {
  const cfg = loadConfig({ env: { ...THEIRS }, argv: [] });
  assert.equal(cfg.metaEnabled, false, "an uncaged session is never on by default");
  assert.equal(cfg.vercelToken, "");
  assert.equal(cfg.n8nToken, "");
  assert.equal(cfg.kumaStatusPage, "", "an unconfigured monitor says so rather than implying health");
});
