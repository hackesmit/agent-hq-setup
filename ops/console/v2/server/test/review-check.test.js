// Adversarial review probes (hq-px56): --check writes nothing, binds nothing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCheck } from "../src/check.js";
import { loadConfig } from "../src/config.js";
import { fakeSources, tmpDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "..", "src", "server.js");

function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      out.push(p + (e.isDirectory() ? "/" : ""));
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

test("runCheck in PROD config (tls, sudo wrapper) creates no state dir, no alerts, no ops, no health file, and no tls dir", async () => {
  const base = tmpDir("hqconsole-review-check-");
  const consoleState = path.join(base, "console-state");
  const hqState = path.join(base, "hq-state");
  const tls = path.join(base, "tls");
  const cfg = loadConfig({
    env: {
      CONSOLE_HOST: "hqbox.example.ts.net",
      CONSOLE_PORT: "8787",
      CONSOLE_STATE_DIR: consoleState,
      HQ_STATE_DIR: hqState,
      CONSOLE_TLS_DIR: tls,
      CONSOLE_RELEASE_ROOT: path.join(base, "releases", "current"),
      HQ_ROOT: base,
    },
    argv: ["--check"],
  });
  assert.equal(cfg.tls, true);
  assert.equal(cfg.check, true);
  const before = snapshot(base);
  const r = await runCheck({ cfg, sources: fakeSources() });
  assert.equal(r.ok, true);
  assert.equal(r.checks.tls.present, false);
  assert.deepEqual(snapshot(base), before, "check must leave the whole tree untouched");
  assert.equal(fs.existsSync(consoleState), false);
  assert.equal(fs.existsSync(cfg.healthFile), false);
});

test("real `node src/server.js --check` end to end: exit 0, one JSON line, state dir untouched, port never bound", async () => {
  const base = tmpDir("hqconsole-review-check-e2e-");
  const consoleState = path.join(base, "console-state");
  // a fake wrapper so the check does not need sudo, ctl.sh, bd, or python
  const wrapper = path.join(base, "fake-wrapper.sh");
  fs.writeFileSync(
    wrapper,
    [
      "#!/usr/bin/env bash",
      'echo "$@" >> "$0.calls"',
      'case "$1" in',
      '  ctl) echo \'{"terminals":[],"requests":[],"snoozed":[],"phases":{},"tasks":{},"usage":{}}\';;',
      '  hw) echo \'{"cpu":{"pct":1,"cores":4,"load":[0,0,0]},"mem":{},"swap":{},"disks":[],"procs":[]}\';;',
      '  usage) echo \'{"today":{},"week":{}}\';;',
      '  stack) echo \'{"generatedAt":"2026-08-19T00:00:00Z","windows":[7,30,90],"items":[]}\';;',
      '  flow) echo \'{"generatedAt":"2026-08-19T00:00:00Z","rigs":[],"errors":[]}\';;',
      '  services) echo \'{"generatedAt":"2026-08-19T00:00:00Z","services":[],"servicesError":null,"jobs":[],"jobsError":null,"automations":{"mail":{"flags":{"disabled":false,"logOnly":false},"heartbeats":[],"recentRuns":[]}}}\';;',
      '  bd|bd-rig) echo "[]";;',
      "esac",
    ].join("\n"),
  );
  fs.chmodSync(wrapper, 0o755);
  // pick a free port and make sure the check never binds it
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));

  const env = {
    ...process.env,
    CONSOLE_HOST: "hqbox.example.ts.net",
    CONSOLE_PORT: String(port),
    CONSOLE_STATE_DIR: consoleState,
    HQ_STATE_DIR: path.join(base, "hq-state"),
    CONSOLE_TLS_DIR: path.join(base, "tls"),
    CONSOLE_RELEASE_ROOT: path.join(base, "releases", "current"),
    CONSOLE_WRAPPER: wrapper,
    CONSOLE_WRAPPER_SUDO: "0",
    HQ_ROOT: base,
  };
  delete env.CONSOLE_DEV_NOAUTH;
  const before = snapshot(base);
  const res = await new Promise((resolve) => {
    let bound = null;
    // while the check runs, keep trying the port: it must stay closed
    const tries = setInterval(() => {
      const c = net.connect(port, "127.0.0.1");
      c.on("connect", () => {
        bound = true;
        c.destroy();
      });
      c.on("error", () => {});
    }, 20);
    execFile("node", [serverJs, "--check"], { env, timeout: 30000 }, (err, stdout, stderr) => {
      clearInterval(tries);
      resolve({ code: err ? err.code : 0, stdout, stderr, bound });
    });
  });
  assert.equal(res.code, 0, `stderr: ${res.stderr}`);
  const lines = res.stdout.trim().split("\n");
  assert.equal(lines.length, 1, "exactly one JSON line on stdout");
  const j = JSON.parse(lines[0]);
  assert.equal(j.ok, true);
  assert.equal(j.checks.collectors.errors.length, 0, JSON.stringify(j.checks.collectors));
  assert.equal(res.bound, null, "check must never bind the console port");
  const after = snapshot(base).filter((p) => !p.startsWith(wrapper));
  assert.deepEqual(after, before.filter((p) => !p.startsWith(wrapper)), "check must not create anything under its state trees");
  assert.equal(fs.existsSync(consoleState), false);
  // every wrapper call was a read-only verb
  const calls = fs.readFileSync(wrapper + ".calls", "utf8").trim().split("\n");
  for (const c of calls) assert.match(c, /^(ctl state|hw --state |usage --state |bd ready|bd-rig \S+ ready|git-log \S+ \d+$|stack$|flow$|services$)/, `unexpected wrapper call in --check: ${c}`);
});
