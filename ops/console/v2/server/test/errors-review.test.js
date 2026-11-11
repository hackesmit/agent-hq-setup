// Review round 1 on hq-hsl2.3: one test per finding.
//   1/6 only hq-errors panes named after the incident are attachable (fake tmux)
//   2   resolve takes the mail automation's flock, re-reads inside it, says busy
//   3   actionable incidents are never capped, history is, and the drop is counted
//   4   a bad field type marks one file malformed instead of aborting the report
//   5   symlinks, fifos, .lock and .unreadable files are not incidents
//   7   the mail side's optional fields are carried to the tab
//   8   a bad %-escape in the resolve url is a 400
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildReport } from "../src/errors.js";
import { createApp } from "../src/server.js";
import { devConfig, fakeSources, tmpDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.resolve(here, "..", "..", "runner", "errors-verbs.py");

function hqWith(incidents) {
  const hq = tmpDir("hq-errors-r1-");
  const dir = path.join(hq, "state", "errors", "incidents");
  fs.mkdirSync(dir, { recursive: true });
  for (const o of incidents) fs.writeFileSync(path.join(dir, `${o.id}.json`), JSON.stringify(o));
  return { hq, dir };
}

/** A fake tmux on PATH that prints a fixed pane inventory for list-panes. */
function fakeTmux(lines) {
  const bin = tmpDir("fake-tmux-");
  const inv = path.join(bin, "panes.txt");
  fs.writeFileSync(inv, lines.map((l) => l.join("\t")).join("\n") + "\n");
  fs.writeFileSync(
    path.join(bin, "tmux"),
    `#!/bin/sh\nfor a in "$@"; do [ "$a" = list-panes ] && exec cat '${inv}'; done\nexit 1\n`,
    { mode: 0o755 },
  );
  return bin;
}

function helper(hq, args, env = {}) {
  const r = spawnSync("/usr/bin/python3", [HELPER, hq, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout.trim() || "null") : null, err: r.stderr };
}

const fixing = (id, fixer) => ({ id, status: "fixing", title: id, opened_ts: 1, fixer });

test("1/6: only a live pane in session hq-errors, window named after the incident, is attachable", () => {
  const bin = fakeTmux([
    // pane, session, window name, window id, pane index, dead
    ["%6", "hq", "0", "@1", "0", "0"],
    ["%20", "hq-errors", "20261019T064624Z-3c8b1b99", "@5", "0", "0"],
    ["%21", "hq-errors", "other-incident", "@6", "0", "0"],
    ["%22", "hq-errors", "inc-dead", "@7", "0", "1"],
    ["%23", "hq-errors", "inc.dotted", "@8", "0", "0"],
    ["%24", "hq-errors", "inc-wid", "@9", "0", "0"],
    ["%25", "hq-errors", "inc-pidx", "@10", "1", "0"],
  ]);
  const { hq } = hqWith([
    fixing("evil-pane", { tmux_pane: "%6" }),
    fixing("evil-target", { tmux_target: "hq:0" }),
    fixing("20261019T064624Z-3c8b1b99", { tmux_pane: "%20", tmux_target: "hq-errors:20261019T064624Z-3c8b1b99" }),
    fixing("by-target-elsewhere", { tmux_target: "hq-errors:other-incident" }),
    fixing("borrowed-pane", { tmux_pane: "%21" }),
    fixing("inc-dead", { tmux_target: "hq-errors:inc-dead" }),
    fixing("inc.dotted", { tmux_target: "hq-errors:inc.dotted" }),
    fixing("inc-wid", { tmux_window_id: "@9" }),
    fixing("inc-pidx", { tmux_target: "hq-errors:inc-pidx.1" }),
    fixing("on-socket", { tmux_target: "-L hq-errors hq-errors:on-socket" }),
  ]);
  const r = helper(hq, ["list"], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.code, 0, r.err);
  const p = r.out.panes;
  const attachable = Object.entries(p).filter(([, v]) => v.attachable).map(([k, v]) => `${k}=${v.id}`).sort();
  assert.deepEqual(attachable, [
    "20261019T064624Z-3c8b1b99=%20",
    "inc-pidx=%25",
    "inc-wid=%24",
    "inc.dotted=%23",
  ]);
  assert.equal(p["evil-pane"].attachable, false, "the owner's own hq:0 pane is never offered");
  assert.equal(p["evil-pane"].id, null);
  assert.equal(p["evil-target"].attachable, false);
  assert.match(p["evil-target"].reason, /outside the hq-errors session/);
  assert.equal(p["by-target-elsewhere"].attachable, false);
  assert.equal(p["borrowed-pane"].attachable, false);
  assert.equal(p["inc-dead"].attachable, false);
  assert.equal(p["on-socket"].attachable, false);
});

test("2: resolve waits for the mail side's flock, says busy when it stays held, re-reads inside it", async () => {
  const { hq, dir } = hqWith([{ id: "inc-l", status: "escalated", title: "t", opened_ts: 1 }]);
  const lockPath = path.join(dir, "inc-l.lock");
  // The holder takes the lock, rewrites the incident while holding it (as the
  // mail automation does), signals, and keeps holding until told to stop.
  const holder = spawn("python3", ["-c", `
import fcntl, json, os, sys, time
fd = os.open(${JSON.stringify(lockPath)}, os.O_RDWR | os.O_CREAT, 0o644)
fcntl.flock(fd, fcntl.LOCK_EX)
p = ${JSON.stringify(path.join(dir, "inc-l.json"))}
o = json.load(open(p)); o["status"] = "fixed"; o["mail_side"] = "wrote this"
tmp = p + ".tmp"; json.dump(o, open(tmp, "w")); os.replace(tmp, p)
print("held", flush=True)
sys.stdin.read()
`], { stdio: ["pipe", "pipe", "inherit"] });
  await new Promise((r) => holder.stdout.once("data", r));
  try {
    const busy = helper(hq, ["resolve", "inc-l"], { HQ_ERRORS_LOCK_WAIT_S: "1" });
    assert.equal(busy.code, 8, busy.err);
    assert.match(busy.err, /busy/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "inc-l.json"), "utf8")).status, "fixed", "nothing written while locked");
  } finally {
    holder.stdin.end();
    await new Promise((r) => holder.on("exit", r));
  }
  const ok = helper(hq, ["resolve", "inc-l"], { HQ_ERRORS_LOCK_WAIT_S: "5" });
  assert.equal(ok.code, 0, ok.err);
  const after = JSON.parse(fs.readFileSync(path.join(dir, "inc-l.json"), "utf8"));
  assert.equal(after.status, "resolved");
  assert.equal(after.resolved_from, "fixed", "the version written under the lock is the one resolved");
  assert.equal(after.mail_side, "wrote this");
  // resolved is terminal: a second resolve changes nothing
  assert.equal(helper(hq, ["resolve", "inc-l"]).code, 6);
});

test("3: every actionable incident is listed whatever the history size; history is capped and counted", () => {
  const { hq, dir } = hqWith([]);
  const old = Date.now() / 1000 - 100000;
  for (const [id, status] of [["act-fix", "fixing"], ["act-esc", "escalated"], ["act-watch", "watching"], ["odd", "paused"]]) {
    const f = path.join(dir, `${id}.json`);
    fs.writeFileSync(f, JSON.stringify({ id, status, title: id }));
    fs.utimesSync(f, old, old); // the oldest files on disk
  }
  for (let i = 0; i < 305; i++) fs.writeFileSync(path.join(dir, `h-${i}.json`), JSON.stringify({ id: `h-${i}`, status: i % 2 ? "fixed" : "resolved" }));
  const r = helper(hq, ["list"], { PATH: "/nonexistent" });
  assert.equal(r.code, 0, r.err);
  const rep = buildReport(r.out);
  const ids = new Set(rep.incidents.map((i) => i.id));
  for (const id of ["act-fix", "act-esc", "act-watch", "odd"]) assert.ok(ids.has(id), `${id} must not be capped`);
  assert.equal(rep.omitted, 5);
  assert.equal(rep.incidents.length, 304);
});

test("4: a valid-JSON incident with a bad field type is one malformed entry, the rest still render", () => {
  const { hq, dir } = hqWith([{ id: "good", status: "escalated", title: "fine", opened_ts: 2 }]);
  fs.writeFileSync(path.join(dir, "badtype.json"), '{"id":"badtype","status":"fixed","title":{"toString":null}}');
  fs.writeFileSync(path.join(dir, "badid.json"), '{"id":{"toString":null},"status":{"toString":null}}');
  const r = helper(hq, ["list"], { PATH: "/nonexistent" });
  const rep = buildReport(r.out);
  assert.deepEqual(rep.incidents.map((i) => i.id), ["good"]);
  assert.deepEqual(rep.malformed.map((m) => m.file).sort(), ["badid.json", "badtype.json"]);
  assert.match(rep.malformed.find((m) => m.file === "badtype.json").error, /bad field/);
});

test("5: symlinks and fifos are skipped, .lock and .unreadable are not incidents", () => {
  const { hq, dir } = hqWith([{ id: "real", status: "logged", title: "r" }]);
  const outside = path.join(tmpDir("outside-"), "secret.json");
  fs.writeFileSync(outside, JSON.stringify({ id: "secret", status: "escalated", title: "leaked" }));
  fs.symlinkSync(outside, path.join(dir, "secret.json"));
  execFileSync("mkfifo", [path.join(dir, "pipe.json")]);
  fs.writeFileSync(path.join(dir, "real.lock"), "");
  fs.writeFileSync(path.join(dir, "real.unreadable"), "x");
  const r = helper(hq, ["list"], { PATH: "/nonexistent" });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out.incidents.map((i) => i.file), ["real.json"]);
  // resolve refuses to follow a symlinked incident file too
  const s = helper(hq, ["resolve", "secret"], { HQ_ERRORS_LOCK_WAIT_S: "1" });
  assert.equal(s.code, 5, s.err);
  assert.equal(JSON.parse(fs.readFileSync(outside, "utf8")).status, "escalated", "the symlink target is untouched");
});

test("7: the mail side's optional fields reach the tab", () => {
  const rep = buildReport({
    incidents: [{
      file: "w.json", mtime: 1, text: JSON.stringify({
        id: "w", status: "watching", title: "fetch", condition_since: 100, last_seen_ts: 200, loopdead_alert_ts: 300,
        policy: { reason: "transient fetch failure, no fixer below 3 repeats" },
        outbox: [{ done: true }, { done: false }],
        result: { marker: "NONE", rc: 3 },
        fixer: { tmux_window_id: "@4" },
      }),
    }, {
      file: "s.json", mtime: 1, text: JSON.stringify({ id: "s", status: "watching", policy: "threshold 3", outbox: [{ done: true }] }),
    }],
  });
  const w = rep.incidents.find((i) => i.id === "w");
  assert.equal(w.mailPending, true);
  assert.equal(w.conditionSinceTs, 100);
  assert.equal(w.lastSeenTs, 200);
  assert.equal(w.loopdeadAlertTs, 300);
  assert.equal(w.policy, "transient fetch failure, no fixer below 3 repeats");
  assert.equal(w.result.rc, 3);
  assert.equal(w.fixer.tmuxWindowId, "@4");
  const s = rep.incidents.find((i) => i.id === "s");
  assert.equal(s.mailPending, false);
  assert.equal(s.policy, "threshold 3");
});

test("8: a bad %-escape in the resolve url answers 400, and busy maps to 503", async () => {
  const http = await import("node:http");
  const cfg = devConfig({});
  const errorsSource = {
    async list() {
      return { incidents: [] };
    },
    async resolve(id) {
      return id === "busy" ? { code: 8, json: null, stderr: "incident busy is busy (the mail automation is updating it); retry in a minute" } : { code: 4, json: null, stderr: "no such incident" };
    },
  };
  const app = createApp({ cfg, sources: fakeSources(), errorsSource, log: () => {} });
  const server = http.createServer(app.handleRequest);
  server.on("connection", (s) => app.auth.gateSocket(s).catch(() => s.destroy()));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const post = (p) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "POST", path: p, headers: { host: `127.0.0.1:${cfg.port}`, "content-type": "application/json", "x-console-key": app.csrf.key } },
        (res) => {
          let d = "";
          res.on("data", (c) => (d += c));
          res.on("end", () => resolve({ status: res.statusCode, json: d ? JSON.parse(d) : null }));
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
  try {
    assert.equal((await post("/api/errors/%E0%A4%A/resolve")).status, 400);
    const busy = await post("/api/errors/busy/resolve");
    assert.equal(busy.status, 503);
    assert.match(busy.json.error, /retry/);
  } finally {
    app.ws.closeAll(1001, "test over");
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
