// Reports (hq-o6wn.4): the store's read side and its routes. What matters: a garbled
// file is never served, the unread count is honest, marking read goes through
// publish.py's lock, the routes sit behind the same gate and boot key as the rest,
// and no mail HTML reaches the page with anything that can run.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Auth } from "../src/auth.js";
import { Reports, ReportsError, sanitizeHtml } from "../src/reports.js";
import { createApp } from "../src/server.js";
import { devConfig, fakeSources, startTestApp, tmpDir } from "./helpers.js";

// this checkout's root, so mark-read runs this checkout's publish.py
const HQ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const PUBLISH = path.join(HQ, "ops", "reports", "publish.py");

function put(dir, rec) {
  const r = { kind: "stack", title: `title ${rec.id}`, project: "hq", created: "2026-10-27T10:00:00Z", severity: "info", body_md: "body", body_html: null, source: "test", ...rec };
  const d = path.join(dir, r.created.slice(0, 4), r.created.slice(5, 7));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${rec.fileId || r.id}.json`), typeof rec.raw === "string" ? rec.raw : JSON.stringify(r));
}

function seed(dir) {
  put(dir, { id: "r-old", kind: "escalate", created: "2026-09-01T08:00:00Z" });
  put(dir, { id: "r-mid", kind: "stack", created: "2026-10-01T08:00:00Z" });
  put(dir, { id: "r-new", kind: "escalate", created: "2026-10-27T08:00:00Z", body_html: '<p onclick="x()">hi<script>alert(1)</script></p>' });
}

function store() {
  const state = tmpDir("hq-reports-");
  const dir = path.join(state, "reports");
  seed(dir);
  const r = new Reports({ dir, publishScript: PUBLISH, log: () => {} });
  return { r, dir, cleanup: () => fs.rmSync(state, { recursive: true, force: true }) };
}

const readJson = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "read.json"), "utf8")).read;

test("list is newest first, paged, and filters by kind and unread", async () => {
  const { r, cleanup } = store();
  try {
    const all = r.list();
    assert.deepEqual(all.items.map((x) => x.id), ["r-new", "r-mid", "r-old"]);
    assert.equal(all.total, 3);
    assert.equal(all.unread, 3);
    assert.equal(all.items[0].body_md, undefined, "the list carries headers, not bodies");
    assert.equal(all.items[0].hasHtml, true);

    const page = r.list({ limit: "1", offset: "1" });
    assert.deepEqual(page.items.map((x) => x.id), ["r-mid"]);
    assert.equal(page.total, 3);

    assert.deepEqual(r.list({ kind: "escalate" }).items.map((x) => x.id), ["r-new", "r-old"]);
    assert.throws(() => r.list({ kind: "nope" }), (e) => e instanceof ReportsError && e.status === 400);

    await r.markRead("r-new");
    const unread = r.list({ unread: "1" });
    assert.deepEqual(unread.items.map((x) => x.id), ["r-mid", "r-old"]);
    assert.equal(unread.unread, 2);
    assert.equal(r.list().items[0].read, true);
    // wild paging values clamp instead of failing
    assert.equal(r.list({ limit: "99999", offset: "-4" }).limit, 200);
    assert.equal(r.list({ limit: "x" }).limit, 50);
  } finally {
    cleanup();
  }
});

test("a garbled or mismatched file is skipped, never served", () => {
  const { r, dir, cleanup } = store();
  try {
    put(dir, { id: "r-bad", raw: "{not json" });
    put(dir, { id: "r-liar", fileId: "r-other" }); // file name and id disagree
    put(dir, { id: "r-kind", kind: "weird" });
    put(dir, { id: "r-date", created: "2026-10-05T00:00:00Z", raw: JSON.stringify({ id: "r-date", kind: "escalate", title: "t", created: "yesterday" }) });
    assert.deepEqual(r.list().items.map((x) => x.id), ["r-new", "r-mid", "r-old"]);
    assert.throws(() => r.get("r-other"), (e) => e.status === 404);
    assert.throws(() => r.get("../../etc/passwd"), (e) => e.status === 404);
  } finally {
    cleanup();
  }
});

test("a corrupt read.json is an error, not zero read", () => {
  const { r, dir, cleanup } = store();
  try {
    fs.writeFileSync(path.join(dir, "read.json"), "garbage");
    assert.throws(() => r.summary(), ReportsError);
  } finally {
    cleanup();
  }
});

test("mark read goes through publish.py, keeps earlier marks, and read-all marks the rest", async () => {
  const { r, dir, cleanup } = store();
  try {
    const one = await r.markRead("r-old");
    assert.equal(one.unread, 2);
    assert.deepEqual(readJson(dir), ["r-old"]);
    // the store's own lock file proves the write went through publish.mark_read
    assert.ok(fs.existsSync(path.join(dir, ".lock")));
    await assert.rejects(r.markRead("r-ghost"), (e) => e.status === 404);

    const errs = await r.markAll("escalate");
    assert.equal(errs.marked, 1);
    assert.deepEqual(readJson(dir).sort(), ["r-new", "r-old"]);
    const rest = await r.markAll(null);
    assert.equal(rest.marked, 1);
    assert.equal(rest.unread, 0);
    assert.equal((await r.markAll(null)).marked, 0);
  } finally {
    cleanup();
  }
});

test("a failed publish is reported, and the read marks stay as they were", async () => {
  const { dir, cleanup } = store();
  try {
    const r = new Reports({ dir, publishScript: "/nonexistent/publish.py", log: () => {} });
    await assert.rejects(r.markRead("r-new"), (e) => e instanceof ReportsError && e.status === 500);
    assert.equal(fs.existsSync(path.join(dir, "read.json")), false);
    const ro = new Reports({ dir, publishScript: PUBLISH, readOnly: true, log: () => {} });
    await assert.rejects(ro.markRead("r-new"), (e) => e.status === 409);
  } finally {
    cleanup();
  }
});

test("sanitizeHtml rebuilds an allowlist and leaves nothing that runs", () => {
  const cases = [
    '<script>alert(1)</script>',
    '<SCRIPT src=x></SCRIPT >',
    '<img src=x onerror=alert(1)>',
    '<svg><script>alert(1)</script></svg>',
    '<svg/onload=alert(1)>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="java&#115;cript:alert(1)">x</a>',
    '<a href="&#106;avascript&colon;alert(1)">x</a>',
    '<a href=" \tjavascript:alert(1)">x</a>',
    '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    '<p style="background:url(https://evil.example/x)" onmouseover="alert(1)">x</p>',
    '<div><style>*{display:none}</style></div>',
    '<!--<script>alert(1)</script>-->',
    '<b>unterminated <a href="https://ok" onclick="alert(1)',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
    '<template><script>alert(1)</script></template>',
    '<textarea></textarea><script>alert(1)</script>',
    '<<script>script>alert(1)<</script>/script>',
  ];
  // Every "<" left in the output must open a tag the sanitizer wrote itself, with only
  // the attributes it writes; anything else came through as escaped text.
  const TAG = /<(\/?)([a-z0-9]+)((?: [a-z]+="[^"<>]*")*)>/g;
  for (const c of cases) {
    const out = sanitizeHtml(c);
    const rest = out.replace(TAG, (all, close, name, attrs) => {
      assert.match(name, /^(a|b|p|div|em|mi)$/, `${c} -> ${out}`);
      for (const m of attrs.matchAll(/ ([a-z]+)="([^"]*)"/g)) {
        assert.ok(["href", "rel", "target"].includes(m[1]), `${c} -> ${out}`);
        if (m[1] === "href") assert.match(m[2], /^(https?:\/\/|mailto:)/, `${c} -> ${out}`);
      }
      return "";
    });
    assert.doesNotMatch(rest, /</, `${c} -> ${out}`);
  }
});

test("sanitizeHtml keeps readable structure and safe links, balanced", () => {
  const out = sanitizeHtml('<table border=1><tr><td colspan="2" class="x">a &amp; b</td></tr></table><p>see <a href="https://hq.example/x?a=1&amp;b=2">here</a> & <em>now</div>');
  assert.equal(
    out,
    '<table><tr><td colspan="2">a &amp; b</td></tr></table><p>see <a href="https://hq.example/x?a=1&amp;b=2" rel="noopener noreferrer nofollow" target="_blank">here</a> &amp; <em>now</em></p>',
  );
  assert.equal(sanitizeHtml("a < b > c"), "a &lt; b &gt; c");
  assert.equal(sanitizeHtml("</div></body>text"), "text", "a stray close tag cannot close the page around it");
  assert.equal(sanitizeHtml('<a href="mailto:d@example.com">m</a>'), '<a href="mailto:d@example.com" rel="noopener noreferrer nofollow" target="_blank">m</a>');
});

// ---- routes -------------------------------------------------------------------------

async function app() {
  const state = tmpDir("hq-reports-app-");
  seed(path.join(state, "reports"));
  const t = await startTestApp({ stateDir: state, hqRoot: HQ });
  const close = t.close;
  t.close = async () => {
    await close();
    fs.rmSync(state, { recursive: true, force: true });
  };
  return t;
}

test("the routes list, read one with sanitized html, and mark read", async () => {
  const t = await app();
  try {
    const list = await t.request("GET", "/api/reports?kind=escalate&limit=5");
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.json.items.map((x) => x.id), ["r-new", "r-old"]);
    assert.equal((await t.request("GET", "/api/reports?kind=bogus")).status, 400);

    const one = await t.request("GET", "/api/reports/r-new");
    assert.equal(one.status, 200);
    assert.equal(one.json.body_html, "<p>hi</p>");
    assert.equal(one.json.read, false, "reading a report does not mark it read");
    assert.equal((await t.request("GET", "/api/reports/r-ghost")).status, 404);

    const state0 = await t.request("GET", "/api/state");
    assert.deepEqual(state0.json.reports, { total: 3, unread: 3 });
    assert.equal(state0.json.badges.reports, 3);

    const marked = await t.request("POST", "/api/reports/r-new/read", { headers: { "x-console-key": t.key }, body: {} });
    assert.equal(marked.status, 200, marked.text);
    assert.equal(marked.json.unread, 2);
    assert.equal((await t.request("POST", "/api/reports/r-ghost/read", { headers: { "x-console-key": t.key }, body: {} })).status, 404);

    const all = await t.request("POST", "/api/reports/read-all", { headers: { "x-console-key": t.key }, body: {} });
    assert.equal(all.status, 200);
    assert.equal(all.json.marked, 2);
    const state1 = await t.request("GET", "/api/state");
    assert.equal(state1.json.reports.unread, 0);
    assert.equal(state1.json.badges.reports, 0);
  } finally {
    await t.close();
  }
});

test("mark read without the boot key, or from a foreign origin, is refused and marks nothing", async () => {
  const t = await app();
  try {
    const none = await t.request("POST", "/api/reports/r-new/read", { body: {} });
    assert.equal(none.status, 403);
    const stale = await t.request("POST", "/api/reports/read-all", { headers: { "x-console-key": "stale" }, body: {} });
    assert.equal(stale.status, 403);
    const foreign = await t.request("POST", "/api/reports/read-all", { headers: { "x-console-key": t.key, origin: "https://evil.example" }, body: {} });
    assert.equal(foreign.status, 403);
    assert.equal((await t.request("GET", "/api/reports")).json.unread, 3);
  } finally {
    await t.close();
  }
});

test("the report routes sit behind the Host pin and the peer gate", async () => {
  const t = await app();
  try {
    const host = await t.request("GET", "/api/reports", { headers: { host: "evil.example.com" } });
    assert.equal(host.status, 403);
    assert.equal(host.json.error, "bad host");
  } finally {
    await t.close();
  }

  // A peer the gate refuses never reaches the route: the socket is closed unanswered.
  const state = tmpDir("hq-reports-deny-");
  seed(path.join(state, "reports"));
  const cfg = devConfig({ stateDir: state, hqRoot: HQ });
  class Deny extends Auth {
    async authorizePeer() {
      return { ok: false, reason: "test: not the owner" };
    }
  }
  const a = createApp({ cfg, sources: fakeSources(), auth: new Deny(cfg), log: () => {} });
  const server = http.createServer(a.handleRequest);
  server.on("connection", (socket) => a.auth.gateSocket(socket).catch(() => socket.destroy()));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    for (const [method, p] of [["GET", "/api/reports"], ["GET", "/api/reports/r-new"], ["POST", "/api/reports/read-all"]]) {
      const got = await new Promise((resolve) => {
        const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path: p, headers: { host: `127.0.0.1:${cfg.port}`, "x-console-key": a.csrf.key } }, (res) => resolve(res.statusCode));
        req.on("error", () => resolve("refused"));
        req.end(method === "POST" ? "{}" : undefined);
      });
      assert.ok(got === "refused" || got === 403, `${method} ${p} got ${got}`);
    }
    assert.equal(fs.existsSync(path.join(state, "reports", "read.json")), false);
  } finally {
    a.ws.closeAll(1001, "test over");
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("sanitizeHtml stays linear on a run of unclosed tags", () => {
  const t0 = Date.now();
  const out = sanitizeHtml("<a ".repeat(80000));
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.ok(!out.includes("<a"));
});

test("an unreadable store raises instead of reading as empty", { skip: process.getuid && process.getuid() === 0 }, () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "reports-eacces-"));
  fs.mkdirSync(path.join(dir, "2026", "10"), { recursive: true });
  fs.chmodSync(path.join(dir, "2026"), 0o000);
  try {
    const r = new Reports({ dir, publishScript: PUBLISH, log: () => {} });
    assert.throws(() => r.summary(), ReportsError);
  } finally {
    fs.chmodSync(path.join(dir, "2026"), 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sanitizeHtml stays fast when one closing bracket ends the run", () => {
  const t0 = Date.now();
  sanitizeHtml("<a ".repeat(80000) + ">");
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});

test("sanitizeHtml stays fast on deep nesting plus stray close tags", () => {
  const t0 = Date.now();
  sanitizeHtml("<div>".repeat(80000) + "</span>".repeat(80000));
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});

test("a report unreadable once is listed after its permissions return", { skip: process.getuid && process.getuid() === 0 }, () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "reports-chmod-"));
  const month = path.join(dir, "2026", "10");
  fs.mkdirSync(month, { recursive: true });
  const file = path.join(month, "r1.json");
  fs.writeFileSync(file, JSON.stringify({ id: "r1", kind: "stack", title: "t", project: "hq", created: "2026-10-28T00:00:00Z", severity: "info", body_md: "x", body_html: null, source: "" }));
  try {
    fs.chmodSync(file, 0o000);
    const r = new Reports({ dir, publishScript: PUBLISH, log: () => {} });
    assert.equal(r.summary().total, 0);
    fs.chmodSync(file, 0o644);
    assert.equal(r.summary().total, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("machine mail (error, digest, fixed, logged) never shows on the Reports tab", () => {
  const { r, dir, cleanup } = store();
  try {
    for (const kind of ["error", "digest", "fixed", "logged"]) put(dir, { id: `m-${kind}`, kind, created: "2026-10-28T08:00:00Z" });
    assert.deepEqual(r.list().items.map((x) => x.id), ["r-new", "r-mid", "r-old"]);
    assert.equal(r.summary().unread, 3);
    assert.equal(r.list({ kind: "error" }).total, 0);
  } finally {
    cleanup();
  }
});
