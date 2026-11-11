import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Registry } from "../src/projects/registry.js";
import { projectRoutes } from "../src/projects/routes.js";
import { ProjectFacts } from "../src/projects/collectors.js";
import { DetailSource } from "../src/projects/detail.js";

const CFG = { hqRoot: "/home/owner/hq", rigsDir: "/home/owner/hq/rigs", devNoAuth: true };
const NOW = Date.parse("2026-08-18T12:00:00.000Z");

const ROWS = [
  { id: "ck-e1", title: "epic", status: "open", issue_type: "epic", created_at: "2026-08-01T00:00:00Z" },
  { id: "ck-1", title: "a", status: "open", issue_type: "task", parent: "ck-e1", estimated_minutes: 60, created_at: "2026-08-02T00:00:00Z" },
  { id: "ck-2", title: "b", status: "closed", issue_type: "task", created_at: "2026-08-02T00:00:00Z", closed_at: "2026-08-16T00:00:00Z" },
  { id: "ck-3", title: "c", status: "blocked", issue_type: "task", created_at: "2026-08-03T00:00:00Z" },
];

function fakeWrapper(handler) {
  const calls = [];
  return {
    calls,
    argv: (verb, args = []) => ({ cmd: "bash", args: ["spawn-as-owner.sh", verb, ...args] }),
    async call(verb, args = [], opts = {}) {
      calls.push({ verb, args, opts });
      const r = (await handler(verb, args)) || {};
      return { code: r.code == null ? 0 : r.code, stdout: r.stdout || "", stderr: r.stderr || "" };
    },
  };
}

const defaultHandler = (verb, args) => {
  if (verb === "git-log") return { stdout: "abc\t1755500000\tD\tmerged a branch\n" };
  if (verb === "vault-read") return { code: 2, stderr: "no such vault file" };
  const bdArgs = verb === "bd-rig" ? args.slice(1) : args;
  if (bdArgs.includes("--status")) return { stdout: JSON.stringify(ROWS.filter((r) => r.status === "closed")) };
  if (bdArgs.includes("--all")) return { stdout: JSON.stringify(ROWS) };
  return { stdout: JSON.stringify(ROWS.filter((r) => r.status !== "closed")) };
};

function fakeRes() {
  let resolve;
  const done = new Promise((r) => (resolve = r));
  return {
    status: null,
    headers: null,
    text: "",
    json: null,
    done,
    writeHead(code, headers) {
      this.status = code;
      this.headers = headers;
    },
    end(body) {
      this.text = body ? String(body) : "";
      try {
        this.json = JSON.parse(this.text);
      } catch {
        this.json = null;
      }
      resolve(this);
    },
  };
}

function router(over = {}) {
  const wrapper = over.wrapper || fakeWrapper(over.handler || defaultHandler);
  return projectRoutes({
    cfg: CFG,
    wrapper,
    registry: new Registry(CFG),
    facts: new ProjectFacts({ wrapper, now: () => NOW }),
    detail: new DetailSource({ wrapper, cfg: CFG, now: () => NOW, readFile: () => "" }),
    truths: over.truths || { read: () => ({ project: "chesski", rev: 2, updatedAt: null, entries: [] }), write: async () => ({ rev: 3 }) },
    now: () => NOW,
    timelineOptions: { tzOffsetMinutes: 0 },
    log: () => {},
    ...over.opts,
  });
}

async function call(route, method, url, body) {
  const req = Object.assign(new EventEmitter(), { method, url });
  if (body !== undefined) req.body = body;
  const res = fakeRes();
  const owned = route(req, res, url.split("?")[0]);
  if (!owned) return { owned: false, res: null };
  await res.done;
  return { owned: true, res };
}

test("the router only claims /api/projects", async () => {
  const r = router();
  assert.equal((await call(r, "GET", "/api/state")).owned, false);
  assert.equal((await call(r, "GET", "/api/projectsfoo")).owned, false);
  assert.equal((await call(r, "GET", "/healthz")).owned, false);
  assert.equal((await call(r, "GET", "/api/projects")).owned, true);
  assert.equal((await call(r, "GET", "/api/projects/chesski")).owned, true);
});

test("GET /api/projects returns a summary per registry entry", async () => {
  const { res } = await call(router(), "GET", "/api/projects");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json));
  const ck = res.json.find((p) => p.id === "chesski");
  assert.deepEqual(ck.counts, { open: 2, inProgress: 0, blocked: 1, closed7d: 1 }, "the epic counts as open work too");
  assert.equal(ck.activity30d.length, 30);
  assert.equal(ck.lastMergeAt, new Date(1755500000000).toISOString());
});

test("GET /api/projects/:id returns the detail payload", async () => {
  const { res } = await call(router(), "GET", "/api/projects/chesski");
  assert.equal(res.status, 200);
  assert.equal(res.json.summary.id, "chesski");
  assert.equal(res.json.beads.closed, 1);
  assert.equal(res.json.epics.length, 1);
  assert.equal(res.json.commits[0].subject, "merged a branch");
  assert.deepEqual(res.json.docs, { knowledge: false, hub: false, decisions: false }, "chesski has no DECISIONS.md and the vault probe failed");
  assert.equal(res.json.truthsRev, 2);
});

test("an unknown or unsafe project id is a 404, never a wrapper call", async () => {
  const wrapper = fakeWrapper(() => {
    throw new Error("must not be called");
  });
  const r = router({ wrapper });
  for (const url of ["/api/projects/nope", "/api/projects/..%2F..%2Fetc", "/api/projects/CHESSKI"]) {
    const { res } = await call(r, "GET", url);
    assert.equal(res.status, 404, url);
  }
  assert.equal(wrapper.calls.length, 0);
});

test("GET beads filters by status and refuses an unknown one", async () => {
  const r = router();
  const all = await call(r, "GET", "/api/projects/chesski/beads");
  assert.equal(all.res.json.length, 4);
  const open = await call(r, "GET", "/api/projects/chesski/beads?status=open");
  assert.deepEqual(open.res.json.map((b) => b.id), ["ck-e1", "ck-1"]);
  const two = await call(r, "GET", "/api/projects/chesski/beads?status=open,blocked");
  assert.equal(two.res.json.length, 3);
  const bad = await call(r, "GET", "/api/projects/chesski/beads?status=wat");
  assert.equal(bad.res.status, 400);
});

test("GET timeline projects the open beads and keeps the closed ones as history", async () => {
  const { res } = await call(router(), "GET", "/api/projects/chesski/timeline");
  assert.equal(res.status, 200);
  const byId = new Map(res.json.map((i) => [i.id, i]));
  assert.equal(byId.get("ck-2").projected, false);
  assert.equal(byId.get("ck-2").end, "2026-08-16T00:00:00.000Z");
  assert.equal(byId.get("ck-e1").kind, "epic");
  // ck-1 is inside the epic: rolled up by default, but its projection still
  // shapes the epic's bar
  assert.equal(byId.has("ck-1"), false);
  assert.equal(byId.get("ck-e1").start, "2026-08-18T12:00:00.000Z");
  assert.equal(byId.get("ck-e1").end, "2026-08-18T13:00:00.000Z");
});

test("GET truths returns the document and POST writes it", async () => {
  const written = [];
  const truths = {
    read: () => ({ project: "chesski", rev: 1, updatedAt: null, entries: [] }),
    write: async (project, body) => {
      written.push([project.id, body]);
      return { project: "chesski", rev: 2, updatedAt: "2026-08-18T12:00:00.000Z", entries: body.entries };
    },
  };
  const r = router({ truths });
  const got = await call(r, "GET", "/api/projects/chesski/truths");
  assert.equal(got.res.json.rev, 1);

  const entries = [{ kind: "constraint", text: "Docker does not run on the laptop" }];
  const put = await call(r, "POST", "/api/projects/chesski/truths", { rev: 1, entries });
  assert.equal(put.res.status, 200);
  assert.equal(put.res.json.rev, 2);
  assert.deepEqual(written, [["chesski", { rev: 1, entries }]]);
});

test("a stale truths write is a 409 carrying the revision to reload", async () => {
  const { StaleRevision } = await import("../src/projects/truths.js");
  const truths = {
    read: () => ({ rev: 5 }),
    write: async () => {
      throw new StaleRevision(5, 3);
    },
  };
  const { res } = await call(router({ truths }), "POST", "/api/projects/chesski/truths", { rev: 3, entries: [] });
  assert.equal(res.status, 409);
  assert.equal(res.json.rev, 5);
  assert.match(res.json.error, /stale revision/);
});

test("a rejected truths payload keeps its own status code", async () => {
  const { TruthsError } = await import("../src/projects/truths.js");
  const truths = {
    read: () => ({ rev: 0 }),
    write: async () => {
      throw new TruthsError("entry text must not be empty", 400);
    },
  };
  const { res } = await call(router({ truths }), "POST", "/api/projects/chesski/truths", { rev: 0, entries: [{ kind: "truth", text: "" }] });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /must not be empty/);
});

test("POST is only accepted where a route exists, and a non-object body is refused", async () => {
  const r = router();
  const wrong = await call(r, "POST", "/api/projects/chesski/beads", { rev: 0 });
  assert.equal(wrong.res.status, 404, "the collection itself is not writable");
  const list = await call(r, "POST", "/api/projects", {});
  assert.equal(list.res.status, 405);
  const bad = await call(r, "POST", "/api/projects/chesski/truths", ["not", "an", "object"]);
  assert.equal(bad.res.status, 400);
  const deep = await call(r, "GET", "/api/projects/chesski/beads/ck-1");
  assert.equal(deep.res.status, 404, "the bead route is POST only");
});

test("POST beads/:bead sets only the due date, through the bd update verb", async () => {
  const seen = [];
  const wrapper = fakeWrapper((verb, args) => {
    seen.push([verb, ...args]);
    if (args.includes("show")) return { stdout: JSON.stringify([{ id: "ck-1", title: "a", status: "open", due_at: "2026-09-05T00:00:00Z" }]) };
    if (args.includes("update")) return { stdout: "updated" };
    return defaultHandler(verb, args);
  });
  const { res } = await call(router({ wrapper }), "POST", "/api/projects/chesski/beads/ck-1", { due: "2026-09-05" });
  assert.equal(res.status, 200);
  assert.equal(res.json.id, "ck-1");
  assert.equal(res.json.due, "2026-09-05T00:00:00.000Z");
  assert.deepEqual(
    seen.find((c) => c.includes("update")),
    ["bd-rig", "chesski", "update", "ck-1", "--due", "2026-09-05"],
  );
});

test("a null due clears the date and every other field is ignored", async () => {
  const seen = [];
  const wrapper = fakeWrapper((verb, args) => {
    seen.push(args);
    if (args.includes("show")) return { stdout: JSON.stringify([{ id: "ck-1", title: "a", status: "open" }]) };
    return { stdout: "" };
  });
  const { res } = await call(router({ wrapper }), "POST", "/api/projects/chesski/beads/ck-1", { due: null, status: "closed", title: "hijack" });
  assert.equal(res.status, 200);
  const update = seen.find((a) => a.includes("update"));
  assert.deepEqual(update, ["chesski", "update", "ck-1", "--due", ""]);
  assert.equal(update.includes("--status"), false, "nothing but the due date is ever written");
});

test("a bad bead id, a foreign bead and a bad date never reach bd", async () => {
  const wrapper = fakeWrapper(() => {
    throw new Error("must not be called");
  });
  const r = router({ wrapper });
  const cases = [
    ["/api/projects/chesski/beads/..%2F..%2Fetc", { due: "2026-09-05" }, 400],
    ["/api/projects/chesski/beads/ck-1;rm%20-rf", { due: "2026-09-05" }, 400],
    ["/api/projects/chesski/beads/xd-207", { due: "2026-09-05" }, 404],
    ["/api/projects/chesski/beads/ck-1", { due: "tomorrow" }, 400],
    ["/api/projects/chesski/beads/ck-1", { due: "--force" }, 400],
    ["/api/projects/chesski/beads/ck-1", { due: 12345 }, 400],
  ];
  for (const [url, body, want] of cases) {
    const { res } = await call(r, "POST", url, body);
    assert.equal(res.status, want, `${url} ${JSON.stringify(body)}`);
  }
  assert.equal(wrapper.calls.length, 0);
});

test("a bd update that fails is a 502 carrying the reason", async () => {
  const wrapper = fakeWrapper(() => ({ code: 1, stderr: "issue not found: ck-1" }));
  const { res } = await call(router({ wrapper }), "POST", "/api/projects/chesski/beads/ck-1", { due: "2026-09-05" });
  assert.equal(res.status, 502);
  assert.match(res.json.error, /issue not found/);
});

test("a project with no beads database refuses the due edit rather than shelling out", async () => {
  const wrapper = fakeWrapper(() => ({ stdout: "" }));
  const { res } = await call(router({ wrapper }), "POST", "/api/projects/studioco-digital/beads/cd-1", { due: "2026-09-05" });
  assert.equal(res.status, 404);
  assert.match(res.json.error, /no beads database/);
  assert.equal(wrapper.calls.length, 0);
});

test("GET doc requires a known name and 404s when the document is absent", async () => {
  const r = router();
  const bad = await call(r, "GET", "/api/projects/chesski/doc?name=passwd");
  assert.equal(bad.res.status, 400);
  const none = await call(r, "GET", "/api/projects/chesski/doc?name=hub");
  assert.equal(none.res.status, 404);

  const withDoc = router({
    handler: (verb, args) => (verb === "vault-read" ? { stdout: `# ${args[0]}\n` } : defaultHandler(verb, args)),
  });
  const ok = await call(withDoc, "GET", "/api/projects/chesski/doc?name=knowledge");
  assert.equal(ok.res.status, 200);
  assert.equal(ok.res.json.name, "knowledge");
  assert.match(ok.res.json.markdown, /01 Projects\/chesski\/Knowledge\.md/);
});

test("an unknown leaf is a 404, and a wrapper that explodes degrades rather than 500s", async () => {
  const r = router();
  const leaf = await call(r, "GET", "/api/projects/chesski/wat");
  assert.equal(leaf.res.status, 404);

  const boom = router({
    handler: () => {
      throw new Error("wrapper exploded");
    },
  });
  const { res } = await call(boom, "GET", "/api/projects/chesski/timeline");
  assert.equal(res.status, 200, "a bd outage empties the chart, it does not break the page");
  assert.deepEqual(res.json, []);
});

test("an unreadable registry is a 500 with the reason, not a silent empty grid", async () => {
  const wrapper = fakeWrapper(defaultHandler);
  const r = projectRoutes({
    cfg: CFG,
    wrapper,
    registry: {
      list() {
        throw new Error("cannot parse ops/projects.json");
      },
      get() {
        throw new Error("cannot parse ops/projects.json");
      },
    },
    now: () => NOW,
    log: () => {},
  });
  const { res } = await call(r, "GET", "/api/projects");
  assert.equal(res.status, 500);
  assert.match(res.json.error, /cannot parse/);
});

test("the collector slice is preferred over a recomputation when it is wired", async () => {
  const wrapper = fakeWrapper(defaultHandler);
  const collectors = {
    has: (n) => n === "projects",
    get: async () => [{ id: "chesski", name: "from the collector", attention: "ok" }],
  };
  const r = projectRoutes({ cfg: CFG, wrapper, registry: new Registry(CFG), collectors, now: () => NOW, log: () => {} });
  const { res } = await call(r, "GET", "/api/projects");
  assert.deepEqual(res.json, [{ id: "chesski", name: "from the collector", attention: "ok" }]);
  assert.equal(wrapper.calls.length, 0, "no bd call when the slice is already cached");
});

test("a JSON body arriving on the stream is parsed when the caller did not", async () => {
  const written = [];
  const truths = { read: () => ({ rev: 0 }), write: async (p, b) => (written.push(b), { rev: 1 }) };
  const r = router({ truths });
  const req = Object.assign(new EventEmitter(), { method: "POST", url: "/api/projects/chesski/truths" });
  const res = fakeRes();
  assert.equal(r(req, res, "/api/projects/chesski/truths"), true);
  req.emit("data", JSON.stringify({ rev: 0, entries: [] }));
  req.emit("end");
  await res.done;
  assert.equal(res.status, 200);
  assert.deepEqual(written, [{ rev: 0, entries: [] }]);
});

test("a malformed streamed body is a 400", async () => {
  const r = router();
  const req = Object.assign(new EventEmitter(), { method: "POST", url: "/api/projects/chesski/truths" });
  const res = fakeRes();
  r(req, res, "/api/projects/chesski/truths");
  req.emit("data", "{ not json");
  req.emit("end");
  await res.done;
  assert.equal(res.status, 400);
  assert.match(res.json.error, /bad json/);
});
