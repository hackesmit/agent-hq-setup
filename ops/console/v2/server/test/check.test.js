import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCheck } from "../src/check.js";
import { PROTOCOL_VERSION } from "../src/protocol.js";
import { devConfig, fakeSources, tmpDir } from "./helpers.js";

test("check passes with no release present and writes nothing", async () => {
  const state = tmpDir();
  const cfg = devConfig({ stateDir: state, releaseRoot: path.join(state, "no-release") });
  const before = fs.readdirSync(state);
  const r = await runCheck({ cfg, sources: fakeSources() });
  assert.equal(r.ok, true);
  assert.equal(r.checks.releaseRoot.present, false);
  assert.equal(r.checks.protocol.version, PROTOCOL_VERSION);
  assert.equal(r.checks.opsDir.readOnly, true);
  assert.deepEqual(fs.readdirSync(state), before);
  assert.equal(fs.existsSync(cfg.alertsFile), false);
  assert.equal(fs.existsSync(cfg.opsDir), false);
});

test("check fails on a protocol mismatch", async () => {
  const cfg = devConfig({ stateDir: tmpDir() });
  const r = await runCheck({ cfg, sources: fakeSources(), expectProtocol: PROTOCOL_VERSION + 1 });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(" "), /protocol/);
});

test("a failing collector is reported but does not fail activation", async () => {
  const cfg = devConfig({ stateDir: tmpDir() });
  const r = await runCheck({
    cfg,
    sources: fakeSources({
      ctlState: async () => {
        throw new Error("ctl state produced no JSON (exit 1)");
      },
    }),
  });
  assert.equal(r.ok, true);
  assert.ok(r.checks.collectors.errors.some((e) => e.startsWith("sessions:")));
});

test("check sees a present release root", async () => {
  const root = tmpDir("hqconsole-release-");
  fs.mkdirSync(path.join(root, "web"));
  fs.writeFileSync(path.join(root, "web", "index.html"), "<html></html>");
  const cfg = devConfig({ stateDir: tmpDir(), releaseRoot: root });
  const r = await runCheck({ cfg, sources: fakeSources() });
  assert.equal(r.checks.releaseRoot.present, true);
  assert.equal(r.checks.releaseRoot.release, path.basename(root));
});

test("--check via the real entrypoint prints one JSON line and exits 0", async () => {
  const { execFile } = await import("node:child_process");
  const state = tmpDir();
  const entry = new URL("../src/server.js", import.meta.url).pathname;
  const out = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [entry, "--check"],
      {
        timeout: 60000,
        env: {
          ...process.env,
          CONSOLE_DEV_NOAUTH: "1",
          CONSOLE_STATE_DIR: state,
          CONSOLE_RELEASE_ROOT: path.join(state, "none"),
          HQ_ROOT: state, // no ctl.sh here: collectors fail, the check still passes
          HQ_STATE_DIR: state,
        },
      },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });
  assert.equal(out.code, 0, out.stderr);
  const lines = out.stdout.trim().split("\n");
  const parsed = JSON.parse(lines[lines.length - 1]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.checks.protocol.version, PROTOCOL_VERSION);
  assert.equal(fs.existsSync(path.join(state, "console-v2")), false);
});

test("a hanging collector cannot hold the check past its cap (activate.sh allows 30s)", async () => {
  const state = tmpDir();
  const cfg = devConfig({ stateDir: state, releaseRoot: path.join(state, "no-release") });
  const never = () => new Promise(() => {});
  const started = Date.now();
  const r = await runCheck({ cfg, sources: fakeSources({ stackData: never, readyBeads: never }), collectorCapMs: 200 });
  assert.ok(Date.now() - started < 2000, "two hung collectors cost one cap, not a hang");
  assert.equal(r.ok, true, "a slow collector is a degraded console, not a bad release");
  const errs = r.checks.collectors.errors;
  assert.ok(errs.some((e) => e.startsWith("stack: no answer within")), JSON.stringify(errs));
  assert.ok(errs.some((e) => e.startsWith("ready: no answer within")), JSON.stringify(errs));
});
