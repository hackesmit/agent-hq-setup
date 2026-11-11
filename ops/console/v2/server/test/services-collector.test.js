// services.py (bead hq-7icm, amended plan 2026-08-19) against a synthetic HQ
// tree and stubbed systemctl/docker/tmux/journalctl binaries, plus mapServices
// and the slice/verb/logs wiring. The plan's hard rules under test: policy is
// re-validated every run and an invalid file disables its section loudly;
// heartbeat states are explicit; log output is scrubbed; unknown or
// non-restartable ids are refused at the helper.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mapServices, computeBadges } from "../src/map.js";
import { startTestApp } from "./helpers.js";

const SERVICES_PY = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "collectors", "services.py",
);

function makeTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-services-"));
  const hq = path.join(dir, "hq");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(path.join(hq, "ops", "projects", "console"), { recursive: true });
  fs.mkdirSync(path.join(hq, "ops", "mail"), { recursive: true });
  fs.mkdirSync(path.join(hq, "state", "heartbeat"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const stub = (name, body) => {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  stub("systemctl", [
    'case "$*" in',
    '  *show*good.service*) echo "ActiveState=active"; echo "SubState=running"; echo "ActiveEnterTimestamp=Tue 2026-08-19 10:00:00 UTC"; echo "NRestarts=2";;',
    '  *show*bad.service*) echo "ActiveState=failed"; echo "SubState=exit-code"; echo "NRestarts=7";;',
    '  *restart*good.service*) exit 0;;',
    '  *) exit 1;;',
    "esac",
  ].join("\n"));
  stub("journalctl", 'printf "2026-08-19 line one\\n\\033[31mred ansi line\\033[0m\\nline three\\n"');
  stub("docker", 'case "$1" in inspect) printf "running\\t2026-08-19T00:00:00Z\\t1\\n";; logs) echo "container log";; restart) exit 0;; *) exit 1;; esac');
  stub("tmux", 'exit 1');
  return { dir, hq, bin };
}

function writePolicy(hq, services, jobs) {
  const dirp = path.join(hq, "ops", "projects", "console");
  if (services !== undefined) fs.writeFileSync(path.join(dirp, "services.json"), JSON.stringify(services));
  if (jobs !== undefined) fs.writeFileSync(path.join(dirp, "jobs.json"), JSON.stringify(jobs));
}

function runSvc(t, args) {
  return new Promise((resolve) => {
    execFile(
      "python3",
      [SERVICES_PY, t.hq, ...args],
      { timeout: 30000, env: { ...process.env, PATH: `${t.bin}:${process.env.PATH}` } },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          json: (() => {
            try {
              return JSON.parse(stdout);
            } catch {
              return null;
            }
          })(),
          stderr: String(stderr),
        });
      },
    );
  });
}

const GOOD_SERVICES = [
  { id: "good", label: "Good unit", kind: "systemd-user", unit: "good.service", restartable: true, logs: true },
  { id: "bad", label: "Bad unit", kind: "systemd-user", unit: "bad.service", restartable: false, logs: false },
  { id: "box", label: "Container", kind: "docker", unit: "kuma", restartable: true, logs: true },
  { id: "mux", label: "Tmux", kind: "tmux", unit: "hq", restartable: true, logs: true },
  { id: "sys", label: "System unit", kind: "systemd-system", unit: "good.service", restartable: true, logs: false },
];

test("status: states per kind, missing policy degrades, invalid policy disables loudly", async () => {
  const t = makeTree();
  try {
    // no policy files at all: empty sections, no errors
    let r = await runSvc(t, ["status"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([r.json.services, r.json.jobs], [[], []]);
    assert.equal(r.json.servicesError, null);

    writePolicy(t.hq, GOOD_SERVICES);
    r = await runSvc(t, ["status"]);
    const by = new Map(r.json.services.map((s) => [s.id, s]));
    assert.equal(by.get("good").state, "active");
    assert.equal(by.get("good").restarts, 2);
    assert.equal(by.get("bad").state, "failed");
    assert.equal(by.get("box").state, "running");
    assert.equal(by.get("mux").state, "inactive", "tmux exit 1 means no session");
    assert.equal(by.get("sys").restartable, false, "systemd-system is never restartable in v1");
    assert.equal(by.get("good").restartable, true);

    // duplicate id disables the whole section with a reason
    writePolicy(t.hq, [GOOD_SERVICES[0], GOOD_SERVICES[0]]);
    r = await runSvc(t, ["status"]);
    assert.deepEqual(r.json.services, []);
    assert.match(r.json.servicesError, /duplicate id/);

    // an option-shaped unit is refused at load
    writePolicy(t.hq, [{ id: "evil", kind: "systemd-user", unit: "--bad", restartable: true, logs: true }]);
    r = await runSvc(t, ["status"]);
    assert.match(r.json.servicesError, /bad unit/);
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("jobs: explicit heartbeat states, containment, future quarantine", async () => {
  const t = makeTree();
  try {
    const hb = path.join(t.hq, "state", "heartbeat");
    fs.writeFileSync(path.join(hb, "fresh"), "x");
    fs.writeFileSync(path.join(hb, "old"), "x");
    fs.utimesSync(path.join(hb, "old"), new Date(0), new Date(Date.now() - 3600_000));
    fs.writeFileSync(path.join(hb, "json"), JSON.stringify({ last: new Date().toISOString() }));
    fs.writeFileSync(path.join(hb, "futurist"), "x");
    fs.utimesSync(path.join(hb, "futurist"), new Date(0), new Date(Date.now() + 48 * 3600_000));
    writePolicy(t.hq, undefined, [
      { id: "fresh", heartbeat: "state/heartbeat/fresh", source: "mtime", cadenceS: 60 },
      { id: "old", heartbeat: "state/heartbeat/old", source: "mtime", cadenceS: 60 },
      { id: "json", heartbeat: "state/heartbeat/json", source: "json:last", cadenceS: 60 },
      { id: "gone", heartbeat: "state/heartbeat/nope", source: "mtime", cadenceS: 60 },
      { id: "futurist", heartbeat: "state/heartbeat/futurist", source: "mtime", cadenceS: 60 },
    ]);
    const r = await runSvc(t, ["status"]);
    const by = new Map(r.json.jobs.map((j) => [j.id, j]));
    assert.equal(by.get("fresh").state, "ok");
    assert.equal(by.get("old").state, "stale");
    assert.equal(by.get("old").missed, true);
    assert.equal(by.get("json").state, "ok");
    assert.equal(by.get("gone").state, "missing");
    assert.equal(by.get("futurist").state, "future");

    // traversal is refused at policy load
    writePolicy(t.hq, undefined, [{ id: "esc", heartbeat: "../etc/passwd", source: "mtime", cadenceS: 60 }]);
    const r2 = await runSvc(t, ["status"]);
    assert.match(r2.json.jobsError, /bad heartbeat path/);
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("logs: allowlist enforced, ANSI scrubbed; restart: refusals and success", async () => {
  const t = makeTree();
  try {
    writePolicy(t.hq, GOOD_SERVICES);
    const logs = await runSvc(t, ["logs", "good", "10"]);
    assert.equal(logs.code, 0, logs.stderr);
    assert.ok(logs.json.lines.some((l) => l.includes("red ansi line")), JSON.stringify(logs.json.lines));
    assert.ok(!logs.json.lines.some((l) => l.includes("\x1b")), "ANSI must be scrubbed");

    assert.equal((await runSvc(t, ["logs", "bad", "10"])).code, 2, "logs:false is refused");
    assert.equal((await runSvc(t, ["logs", "nope", "10"])).code, 2, "unknown id is refused");

    assert.equal((await runSvc(t, ["restart", "good"])).code, 0);
    assert.equal((await runSvc(t, ["restart", "bad"])).code, 2, "restartable:false is refused");
    assert.equal((await runSvc(t, ["restart", "sys"])).code, 2, "system units are never restartable");
    assert.equal((await runSvc(t, ["restart", "nope"])).code, 2);
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("mail-switch: flag files toggle idempotently and show in status", async () => {
  const t = makeTree();
  try {
    const flag = path.join(t.hq, "ops", "mail", "DISABLED");
    assert.equal((await runSvc(t, ["mail-switch", "disabled", "on"])).code, 0);
    assert.ok(fs.existsSync(flag));
    assert.equal((await runSvc(t, ["mail-switch", "disabled", "on"])).code, 0, "on twice is fine");
    let r = await runSvc(t, ["status"]);
    assert.equal(r.json.automations.mail.flags.disabled, true);
    assert.equal((await runSvc(t, ["mail-switch", "disabled", "off"])).code, 0);
    assert.equal((await runSvc(t, ["mail-switch", "disabled", "off"])).code, 0, "off twice is fine");
    assert.ok(!fs.existsSync(flag));
    r = await runSvc(t, ["status"]);
    assert.equal(r.json.automations.mail.flags.disabled, false);
    assert.equal((await runSvc(t, ["mail-switch", "sideways", "on"])).code, 2);
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("mapServices coerces junk; badges count failing services and missed jobs", () => {
  const mapped = mapServices({
    generatedAt: "2026-08-19T00:00:00Z",
    services: [
      { id: "a", kind: "weird", unit: "u", state: "failed" },
      { id: "b", kind: "docker", unit: "u2", state: "running", restarts: "3" },
      { unit: "no-id, dropped" },
    ],
    jobs: [{ id: "j", heartbeat: "x", cadenceS: 60, state: "nonsense", missed: true }],
    automations: { mail: { flags: { disabled: 1 }, heartbeats: null, recentRuns: "x" } },
  });
  assert.equal(mapped.services.length, 2);
  assert.equal(mapped.services[0].kind, "systemd-user", "unknown kinds coerce");
  assert.equal(mapped.services[1].restarts, 3);
  assert.equal(mapped.jobs[0].state, "malformed");
  assert.equal(mapped.automations.mail.flags.disabled, true);
  const badges = computeBadges({ requests: [], projects: [], alerts: [], stack: null, services: mapped });
  assert.equal(badges.machines, 2, "one failed service + one missed job");
});

test("the services slice is served; restart and mail-switch verbs go through the wrapper with idempotency", async () => {
  const calls = [];
  const t = await startTestApp({
    runner: async (cmd, args) => {
      calls.push(args.slice(1));
      if (args[1] === "service-logs") {
        return { code: 0, stdout: JSON.stringify({ id: args[2], lines: ["alpha", "beta"] }), stderr: "" };
      }
      return { code: 0, stdout: "{}", stderr: "" };
    },
    sources: {
      servicesData: async () => ({
        generatedAt: "2026-08-19T00:00:00Z",
        services: [{ id: "good", label: "Good", kind: "systemd-user", unit: "good.service", restartable: true, logs: true, state: "active" }],
        servicesError: null,
        jobs: [],
        jobsError: null,
        automations: { mail: { flags: { disabled: false, logOnly: false }, heartbeats: [], recentRuns: [] } },
      }),
    },
  });
  try {
    const full = await t.request("GET", "/api/state");
    assert.equal(full.json.services.services.length, 1);

    // This read starts a privileged process across the sudo boundary, so it
    // carries the per-boot key like a mutation does.
    const guarded = { headers: { "X-Console-Key": t.key } };
    const noKey = await t.request("GET", "/api/service/good/logs?n=25");
    assert.notEqual(noKey.status, 200, "an unkeyed read never reaches the wrapper");
    assert.equal(calls.length, 0, "and spawns nothing");

    const logs = await t.request("GET", "/api/service/good/logs?n=25", guarded);
    assert.equal(logs.status, 200, logs.text);
    assert.deepEqual(logs.json.lines, ["alpha", "beta"]);
    assert.ok(calls.some((c) => c.join(" ") === "service-logs good 25"), JSON.stringify(calls));
    const badId = await t.request("GET", "/api/service/UPPER/logs", guarded);
    assert.equal(badId.status, 404, "an id outside the shape never reaches the wrapper");

    const r1 = await t.request("POST", "/api/service-restart", {
      body: { service: "good", op: "op-idem-1" },
      headers: { "x-console-key": t.key },
    });
    assert.equal(r1.status, 202, r1.text);
    const r2 = await t.request("POST", "/api/service-restart", {
      body: { service: "good", op: "op-idem-1" },
      headers: { "x-console-key": t.key },
    });
    assert.equal(r2.status, 200, "a replayed op key returns the stored record");
    assert.equal(r2.json.id, r1.json.id);
    assert.equal(calls.filter((c) => c[0] === "service-restart").length, 1, "one restart only");

    const sw = await t.request("POST", "/api/mail-switch", {
      body: { switch: "log-only", on: true, op: "op-idem-2" },
      headers: { "x-console-key": t.key },
    });
    assert.equal(sw.status, 202, sw.text);
    assert.ok(calls.some((c) => c.join(" ") === "mail-switch log-only on"), JSON.stringify(calls));
    const badSw = await t.request("POST", "/api/mail-switch", {
      body: { switch: "everything", on: true },
      headers: { "x-console-key": t.key },
    });
    assert.equal(badSw.status, 400);
  } finally {
    await t.close();
  }
});

// ---------- lucy red-team 2026-08-19 ----------

test("red-team: recentRuns refuses a symlink, mail-switch refuses a symlinked flag", async () => {
  const t = makeTree();
  try {
    const secret = path.join(t.dir, "secret");
    fs.writeFileSync(secret, "SECRET-TOKEN-VALUE");
    fs.mkdirSync(path.join(t.hq, "state", "mail-runs"), { recursive: true });
    fs.symlinkSync(secret, path.join(t.hq, "state", "mail-runs", "leak"));
    const r = await runSvc(t, ["status"]);
    assert.ok(!JSON.stringify(r.json).includes("SECRET-TOKEN-VALUE"), "a symlinked run file must not be disclosed");

    const outside = path.join(t.dir, "outside-flag");
    fs.symlinkSync(outside, path.join(t.hq, "ops", "mail", "DISABLED"));
    const sw = await runSvc(t, ["mail-switch", "disabled", "on"]);
    assert.equal(sw.code, 2, "creating through a symlinked flag path is refused");
    assert.ok(!fs.existsSync(outside), "nothing lands at the symlink target");
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("red-team: a 1e309 json heartbeat is malformed, not a crash of the whole report", async () => {
  const t = makeTree();
  try {
    const hb = path.join(t.hq, "state", "heartbeat");
    fs.writeFileSync(path.join(hb, "inf"), JSON.stringify({ last: 1e309 }));
    fs.writeFileSync(path.join(hb, "ok"), "x");
    writePolicy(t.hq, [GOOD_SERVICES[0]], [
      { id: "inf", heartbeat: "state/heartbeat/inf", source: "json:last", cadenceS: 60 },
      { id: "ok", heartbeat: "state/heartbeat/ok", source: "mtime", cadenceS: 60 },
    ]);
    const r = await runSvc(t, ["status"]);
    assert.equal(r.code, 0, r.stderr);
    const by = new Map(r.json.jobs.map((j) => [j.id, j]));
    assert.equal(by.get("inf").state, "malformed");
    assert.equal(by.get("ok").state, "ok", "the other rows still report");
    assert.equal(r.json.services.length, 1, "and services are unaffected");
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("red-team: a log firehose is capped, not buffered to exhaustion", async () => {
  const t = makeTree();
  try {
    fs.writeFileSync(path.join(t.bin, "journalctl"), "#!/bin/sh\nexec yes 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'\n", { mode: 0o755 });
    writePolicy(t.hq, [GOOD_SERVICES[0]]);
    const r = await runSvc(t, ["logs", "good", "50"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.json.lines.length <= 200);
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("red-team: MORE hanging services than workers still return by the absolute deadline", async () => {
  const t = makeTree();
  try {
    // systemctl that records each invocation then hangs; with 12 hangers and 8
    // workers, ONLY the 8 that fit a worker may ever spawn: the 4 queued probes
    // must short-circuit past the absolute deadline without spawning (that call
    // count is what distinguishes the fix from the old 500 ms-floor regression).
    const callFile = path.join(t.dir, "systemctl.calls");
    fs.writeFileSync(path.join(t.bin, "systemctl"), `#!/bin/sh\necho x >> "${callFile}"\nsleep 1000\n`, { mode: 0o755 });
    const hangers = Array.from({ length: 12 }, (_, i) => ({
      id: `hang${i}`, label: `Hang ${i}`, kind: "systemd-user", unit: `hang${i}.service`, restartable: false, logs: false,
    }));
    writePolicy(t.hq, hangers);
    const started = Date.now();
    const r = await new Promise((resolve) => {
      execFile(
        "python3",
        [SERVICES_PY, t.hq, "status"],
        { timeout: 30000, env: { ...process.env, PATH: `${t.bin}:${process.env.PATH}`, HQ_SERVICES_DEADLINE: "3" } },
        (err, stdout) => resolve({ code: err ? 1 : 0, json: JSON.parse(stdout) }),
      );
    });
    const elapsed = Date.now() - started;
    assert.equal(r.code, 0);
    assert.equal(r.json.services.length, 12);
    assert.ok(r.json.services.every((s) => s.state === "unavailable"), "all hangers report unavailable");
    const spawns = fs.existsSync(callFile) ? fs.readFileSync(callFile, "utf8").trim().split("\n").filter(Boolean).length : 0;
    // At most the worker count may spawn (a stalled host may show fewer); the
    // regression that gave every queued probe fresh runtime would show up to 12.
    assert.ok(spawns <= 8, `no post-deadline wave: at most 8 probes spawn, saw ${spawns}`);
    assert.ok(elapsed < 8000, `bounded by the absolute deadline (took ${elapsed}ms)`);
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("red-team: an already-expired run_cmd never spawns (deterministic short-circuit)", async () => {
  const t = makeTree();
  try {
    const marker = path.join(t.dir, "spawned");
    // end_at 10 s in the PAST: run_cmd must return without ever touching the file.
    const snippet = [
      "import sys, time, json",
      `sys.path.insert(0, ${JSON.stringify(path.dirname(SERVICES_PY))})`,
      "import importlib.util",
      `spec = importlib.util.spec_from_file_location('svc', ${JSON.stringify(SERVICES_PY)})`,
      "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
      `code, out, err = m.run_cmd(['touch', ${JSON.stringify(marker)}], end_at=time.monotonic() - 10)`,
      "print(json.dumps({'code': code}))",
    ].join("\n");
    const r = await new Promise((resolve) => {
      execFile("python3", ["-c", snippet], { timeout: 10000 }, (err, stdout) => resolve({ err, stdout }));
    });
    assert.match(r.stdout, /"code": -1/);
    assert.ok(!fs.existsSync(marker), "an expired run_cmd must not spawn the process at all");
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});
