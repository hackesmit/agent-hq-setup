// The Errors tab's server half (bead hq-hsl2.3): listing through the real
// wrapper verb and helper (bash + python3, no sudo), tolerance of malformed
// incident files, the resolve action over HTTP with the CSRF gate, and the term
// lookup that lets a fixing incident's pane attach.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Collectors } from "../src/collectors.js";
import { Wrapper } from "../src/wrapper.js";
import { buildReport, createErrors, normalizeIncident, wrapperSource } from "../src/errors.js";
import { devConfig, startTestApp, tmpDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.resolve(here, "..", "..", "runner", "spawn-as-owner.sh");

function fixtureHq() {
  const hq = tmpDir("hq-errors-");
  const dir = path.join(hq, "state", "errors", "incidents");
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now() / 1000;
  const base = (id, status, extra = {}) => ({
    id, fp: `fp-${id}`, project: "hq", title: `title ${id}`, host: "hqbox",
    opened_ts: now - 600, updated_ts: now - 60, status, repeats: 0, last_repeat_ts: null,
    mid: `<${id}@x>`, body: "trace", fixer: null, result: null, bead: null, note: null,
    future_field: "readers must tolerate this", ...extra,
  });
  const write = (o) => fs.writeFileSync(path.join(dir, `${o.id}.json`), JSON.stringify(o));
  write(base("a-escalated", "escalated", { bead: "hq-zz1", note: "breaker tripped" }));
  write(base("b-fixing", "fixing", { fixer: { tmux_target: "%999999", log_path: "/tmp/x.log", started_ts: now - 30 } }));
  write(base("c-fixed", "fixed", { result: { marker: "FIXED", summary: "patched", receipt: "Verification: code - pytest - pass" } }));
  write(base("d-logged", "logged"));
  write(base("e-resolved", "resolved"));
  write(base("f-watching", "watching", { repeats: 4 }));
  // malformed: not JSON, not an object, and a stray temp file that must be ignored
  fs.writeFileSync(path.join(dir, "g-broken.json"), "{ not json");
  fs.writeFileSync(path.join(dir, "h-array.json"), "[1,2]");
  fs.writeFileSync(path.join(dir, ".a-escalated.json.123.tmp"), "{}");
  return { hq, dir };
}

function wrapperFor(hq) {
  const cfg = devConfig({ hqRoot: hq, env: { CONSOLE_WRAPPER: WRAPPER } });
  return { cfg, wrapper: new Wrapper(cfg) };
}

test("normalizeIncident tolerates missing optional fields and unknown status", () => {
  const inc = normalizeIncident({ id: "x-1", status: "weird", opened_ts: "2026-10-19T00:00:00Z" }, "x-1.json", 5);
  assert.equal(inc.status, "unknown");
  assert.equal(inc.rawStatus, "weird");
  assert.equal(inc.title, "(untitled)");
  assert.equal(inc.fixer, null);
  assert.equal(inc.repeats, 0);
  assert.ok(Math.abs(inc.openedTs - Date.parse("2026-10-19T00:00:00Z") / 1000) < 1);
  assert.equal(normalizeIncident([1], "y.json", 0), null);
  // the file name stands in for a missing id
  assert.equal(normalizeIncident({ status: "fixed" }, "z-9.json", 0).id, "z-9");
});

test("buildReport keeps going past malformed files and counts statuses", () => {
  const rep = buildReport({
    incidents: [
      { file: "a.json", mtime: 1, text: JSON.stringify({ id: "a", status: "escalated", opened_ts: 10 }) },
      { file: "b.json", mtime: 1, text: "nope" },
      { file: "c.json", mtime: 1, error: "unreadable: Permission denied" },
      { file: "d.json", mtime: 1, text: JSON.stringify({ id: "d", status: "watching", opened_ts: 20 }) },
    ],
    volume: { source: "fps", hours: 24, fps: [{ fp: "f1", last_ts: 5, count: 3 }] },
  });
  assert.deepEqual(rep.incidents.map((i) => i.id), ["d", "a"]);
  assert.equal(rep.counts.escalated, 1);
  assert.equal(rep.counts.watching, 1);
  assert.equal(rep.malformed.length, 2);
  assert.equal(rep.volume.fps[0].buckets, null);
});

test("errors list through the real wrapper verb: every status, malformed files reported", async () => {
  const { hq } = fixtureHq();
  const { wrapper } = wrapperFor(hq);
  const rep = buildReport(await wrapperSource(wrapper).list());
  const byStatus = Object.fromEntries(rep.incidents.map((i) => [i.status, i.id]));
  assert.deepEqual(Object.keys(byStatus).sort(), ["escalated", "fixed", "fixing", "logged", "resolved", "watching"]);
  assert.deepEqual(rep.malformed.map((m) => m.file).sort(), ["g-broken.json", "h-array.json"]);
  const fixing = rep.incidents.find((i) => i.status === "fixing");
  // a pane id that does not exist on this box is reported, not attachable
  assert.ok(fixing.pane);
  assert.equal(fixing.pane.attachable, false);
  assert.equal(fixing.fixer.logPath, "/tmp/x.log");
  const fixed = rep.incidents.find((i) => i.status === "fixed");
  assert.match(fixed.result.receipt, /^Verification:/);
  // no mail.db in the fixture: the volume strip says so instead of failing
  assert.equal(rep.volume.source, "none");
});

test("volume falls back to fps.last_ts when fp_events is absent, and uses fp_events when present", async () => {
  const { hq } = fixtureHq();
  const db = path.join(hq, "state", "mail.db");
  const { DatabaseSync } = await import("node:sqlite");
  const d = new DatabaseSync(db);
  const now = Date.now() / 1000;
  d.exec("CREATE TABLE fps(fp TEXT PRIMARY KEY, project TEXT, title TEXT, first_ts REAL, last_ts REAL, count INTEGER)");
  d.prepare("INSERT INTO fps VALUES (?,?,?,?,?,?)").run("fp-new", "hq", "new one", now - 7200, now - 60, 7);
  d.prepare("INSERT INTO fps VALUES (?,?,?,?,?,?)").run("fp-old", "hq", "old one", now - 999999, now - 99999, 2);
  const { wrapper } = wrapperFor(hq);
  let rep = buildReport(await wrapperSource(wrapper).list());
  assert.equal(rep.volume.source, "fps");
  assert.deepEqual(rep.volume.fps.map((f) => f.fp), ["fp-new"]);
  d.exec("CREATE TABLE fp_events(fp TEXT, ts REAL)");
  for (const dt of [30, 40, 4000]) d.prepare("INSERT INTO fp_events VALUES (?,?)").run("fp-new", now - dt);
  d.close();
  rep = buildReport(await wrapperSource(wrapper).list());
  assert.equal(rep.volume.source, "fp_events");
  assert.equal(rep.volume.fps[0].total, 3);
  assert.equal(rep.volume.fps[0].buckets.length, 24);
  assert.equal(rep.volume.fps[0].buckets[23], 2);
});

test("resolve rewrites the file atomically, keeps unknown fields, and refuses bad ids", async () => {
  const { hq, dir } = fixtureHq();
  const { wrapper } = wrapperFor(hq);
  const src = wrapperSource(wrapper);
  const r = await src.resolve("a-escalated");
  assert.equal(r.code, 0, r.stderr);
  const after = JSON.parse(fs.readFileSync(path.join(dir, "a-escalated.json"), "utf8"));
  assert.equal(after.status, "resolved");
  assert.equal(after.resolved_from, "escalated");
  assert.ok(after.resolved_ts > 0);
  assert.equal(after.future_field, "readers must tolerate this");
  assert.equal((await src.resolve("a-escalated")).code, 6);
  assert.equal((await src.resolve("nope")).code, 4);
  assert.equal((await src.resolve("g-broken")).code, 5);
  assert.equal((await src.resolve("../etc")).code, 2);
  assert.ok(!fs.readdirSync(dir).some((n) => n.includes(".resolve-")), "no resolve temp file left behind");
});

test("termRecord vouches only for an attachable pane of a fixing incident, read-only", async () => {
  const collectors = new Collectors();
  const source = {
    async list() {
      return {
        incidents: [
          { file: "f.json", mtime: 1, text: JSON.stringify({ id: "f", status: "fixing" }) },
          { file: "g.json", mtime: 1, text: JSON.stringify({ id: "g", status: "fixed" }) },
        ],
        panes: {
          f: { id: "%12", alive: true, attachable: true },
          g: { id: "%13", alive: true, attachable: true },
        },
      };
    },
    async resolve() {
      return { code: 0, json: { ok: true } };
    },
  };
  const errors = createErrors({ collectors, source });
  assert.equal(errors.termRecord("%12"), null, "nothing before the first refresh");
  const rec = await errors.termRecordFresh("%12");
  assert.equal(rec.id, "%12");
  assert.equal(rec.writable, false);
  assert.equal(errors.termRecord("%13"), null, "a fixed incident's pane is not served");
  assert.equal(errors.termRecord("s-123"), null);
});

test("resolve over HTTP: CSRF gate like the money routes, then the source decides", async () => {
  const calls = [];
  const errorsSource = {
    async list() {
      return { incidents: [{ file: "a.json", mtime: 1, text: JSON.stringify({ id: "a", status: "escalated" }) }] };
    },
    async resolve(id) {
      calls.push(id);
      return id === "a" ? { code: 0, json: { ok: true, id, status: "resolved" } } : { code: 4, json: null, stderr: "no such incident" };
    },
  };
  const t = await startTestApp({});
  try {
    // startTestApp builds the app with fake sources, so the errors slice answers empty
    const st = await t.request("GET", "/api/state");
    assert.equal(st.status, 200);
    assert.ok(st.json.errors && Array.isArray(st.json.errors.incidents));
  } finally {
    await t.close();
  }
  const { createApp } = await import("../src/server.js");
  const http = await import("node:http");
  const cfg = devConfig({});
  const app = createApp({ cfg, sources: (await import("./helpers.js")).fakeSources(), errorsSource, log: () => {} });
  const server = http.createServer(app.handleRequest);
  server.on("connection", (s) => app.auth.gateSocket(s).catch(() => s.destroy()));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const post = (p, key) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "POST", path: p, headers: { host: `127.0.0.1:${cfg.port}`, "content-type": "application/json", ...(key ? { "x-console-key": key } : {}) } },
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
    assert.equal((await post("/api/errors/a/resolve", null)).status, 403);
    assert.equal(calls.length, 0, "no key, no write");
    const ok = await post("/api/errors/a/resolve", app.csrf.key);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.status, "resolved");
    assert.equal((await post("/api/errors/zz/resolve", app.csrf.key)).status, 404);
    assert.equal((await post("/api/errors/..%2Fx/resolve", app.csrf.key)).status, 400);
    assert.deepEqual(calls, ["a", "zz"]);
    const st = await app.buildState();
    assert.equal(st.errors.counts.escalated, 1);
  } finally {
    app.ws.closeAll(1001, "test over");
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
