// Adversarial review (hq-px56): probes that failed before the fixes and now guard them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Auth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { createApp, startServer } from "../src/server.js";
import { buildVerbs } from "../src/actions.js";
import { Wrapper } from "../src/wrapper.js";
import { fakeSources, tmpDir } from "./helpers.js";

const OWNER = "owner@example.com";
const ownerWhois = async () => ({ UserProfile: { LoginName: OWNER }, Node: { StableID: "nPEER", Addresses: ["100.64.0.9/32"] } });
const selfInfo = async () => ({ nodeId: "nSELF", ips: ["100.64.0.1"] });

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

function get(mod, opts) {
  return new Promise((resolve) => {
    const req = mod.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", (e) => resolve({ status: null, error: e.code || e.message }));
    req.end();
  });
}

// FINDING 1 (BLOCKER): in production (TLS) the peer gate stamps the raw
// net.Socket from the 'connection' event, but req.socket / the upgrade socket
// is the TLSSocket, a different object. Every request and every WS upgrade
// therefore fails socketAllowed() and is 403'd + destroyed. The whole prod
// path is untested (all tests use plain http).
test("FINDING 1: startServer in TLS mode serves /healthz to an owner peer", async () => {
  const base = tmpDir("hqconsole-review-tls-");
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
  assert.equal(cfg.tls, true);
  const auth = new Auth(cfg, { whois: ownerWhois, selfInfo, tailnetIp: async () => "100.64.0.1" });
  // bind loopback for the test only; the gate logic under test is unchanged
  auth.resolveBindAddress = async () => "127.0.0.1";
  const { server, shutdown } = await startServer({ cfg, auth, sources: fakeSources(), log: () => {} });
  try {
    const r = await get(https, { host: "127.0.0.1", port, path: "/healthz", rejectUnauthorized: false, headers: { host: `hqbox.example.ts.net:${port}` } });
    assert.equal(r.status, 200, `owner peer over TLS got ${JSON.stringify(r)}`);
  } finally {
    await shutdown("test");
    server.closeAllConnections();
  }
});

// FINDING 2 / 2b (async gate) are covered against the real wiring in review-gate.test.js.

// FINDING 3 (MAJOR): id()/text()/when() accept a leading "-", so browser
// supplied values become OPTIONS to bd / ctl.sh / snooze.sh. Reproduction
// outside the tests: `bd create "-h" -p 2 -t task` prints bd's help (exit 0)
// instead of creating a bead titled "-h". Owner-only and CSRF-gated, but the
// page renders worker-controlled markdown, so an XSS there gets option
// injection into owner-context CLIs on top of the intended verbs.
test("FINDING 3: values taken from the request body never start with '-' when handed to the wrapper", () => {
  const cfg = loadConfig({ env: { CONSOLE_DEV_NOAUTH: "1" }, argv: [] });
  const verbs = buildVerbs({ cfg, wrapper: new Wrapper(cfg) });
  const cases = [
    ["capture title", () => verbs.capture({ rig: "hq", title: "-h" })],
    ["capture title long flag", () => verbs.capture({ rig: "hq", title: "--file /etc/passwd" })],
    ["snooze when", () => verbs.snooze({ session: "s1", until: "--id" })],
    ["req-snooze when", () => verbs["req-snooze"]({ rid: "r1", until: "--until" })],
    ["answer text", () => verbs.answer({ rid: "r1", text: "--file" })],
    ["name label", () => verbs.name({ session: "s1", name: "--clear" })],
    ["phase name", () => verbs.phase({ bead: "b1", phase: "--nope" })],
    ["session id", () => verbs.kill({ session: "--confirm" })],
    ["rid", () => verbs.sink({ rid: "--top" })],
    ["bead id", () => verbs.dispatch({ bead: "--rig", rig: "hq", model: "claude-opus-4-8" })],
  ];
  const offenders = [];
  for (const [what, build] of cases) {
    try {
      const plan = build();
      offenders.push(`${what}: ${JSON.stringify(plan.args)}`);
    } catch (e) {
      if (!(e && e.status === 400)) offenders.push(`${what}: threw ${String(e)}`);
    }
  }
  assert.deepEqual(offenders, [], "each leading-dash value should be a 400, not an argv element");
});
