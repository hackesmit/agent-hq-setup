import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Registry } from "../src/projects/registry.js";
import { projectRoutes } from "../src/projects/routes.js";
import { FlowSource, beadState, flowGraph, waitingIds } from "../src/projects/flow.js";
import { normalizeBeads } from "../src/projects/bd.js";

const CFG = { hqRoot: "/home/owner/hq", rigsDir: "/home/owner/hq/rigs", devNoAuth: true };
const NOW = Date.parse("2026-11-03T12:00:00.000Z");

// Two epics and a loose bead. e1 is half done; e2 waits on e1's last child.
const ROWS = [
  { id: "ck-e1", title: "epic one", status: "open", issue_type: "epic" },
  { id: "ck-e1.1", title: "first", status: "closed", issue_type: "task", parent: "ck-e1" },
  { id: "ck-e1.2", title: "second", status: "in_progress", issue_type: "task", parent: "ck-e1", dependencies: [{ issue_id: "ck-e1.2", depends_on_id: "ck-e1.1", type: "blocks" }] },
  { id: "ck-e1.3", title: "third", status: "open", issue_type: "task", parent: "ck-e1", dependencies: [{ issue_id: "ck-e1.3", depends_on_id: "ck-e1.2", type: "blocks" }, { issue_id: "ck-e1.3", depends_on_id: "ck-x", type: "blocks" }] },
  { id: "ck-e2", title: "epic two", status: "open", issue_type: "epic" },
  { id: "ck-e2.1", title: "later", status: "open", issue_type: "task", parent: "ck-e2", dependencies: [{ issue_id: "ck-e2.1", depends_on_id: "ck-e1.3", type: "blocks" }, { issue_id: "ck-e2.1", depends_on_id: "ck-e2", type: "parent-child" }] },
  { id: "ck-x", title: "loose", status: "open", issue_type: "task" },
  { id: "ck-audit", title: "egress", status: "open", issue_type: "task", labels: ["egress-ledger"] },
];

const byId = (g) => new Map(g.nodes.map((n) => [n.id, n]));

test("beadState maps status, waiting and a future defer date", () => {
  const w = new Set(["a"]);
  const b = (o) => ({ id: "z", status: "open", deferUntil: null, ...o });
  assert.equal(beadState(b({ status: "closed", id: "a" }), w, NOW), "done", "closed beats waiting");
  assert.equal(beadState(b({ id: "a", status: "in_progress" }), w, NOW), "waiting");
  assert.equal(beadState(b({ status: "blocked" }), w, NOW), "blocked");
  assert.equal(beadState(b({ status: "in_progress" }), w, NOW), "active");
  assert.equal(beadState(b({ status: "deferred" }), w, NOW), "deferred");
  assert.equal(beadState(b({ deferUntil: "2026-12-01T00:00:00Z" }), w, NOW), "deferred");
  assert.equal(beadState(b({ deferUntil: "2026-10-01T00:00:00Z" }), w, NOW), "upcoming");
  assert.equal(beadState(b({}), w, NOW), "upcoming");
});

test("a snoozed request still leaves its bead waiting", () => {
  const w = waitingIds([{ state: "snoozed", bead: "a" }, { state: "cancelled", bead: "b" }]);
  assert.deepEqual([...w], ["a"]);
});

test("a closed epic with open children reads active, not done", () => {
  const rows = [
    { id: "ck-z", title: "z", status: "closed", issue_type: "epic" },
    { id: "ck-z.1", title: "k1", status: "open", parent: "ck-z" },
    { id: "ck-z.2", title: "k2", status: "closed", parent: "ck-z" },
  ];
  const g = flowGraph(normalizeBeads(rows), { now: NOW });
  assert.equal(byId(g).get("ck-z").state, "active");
  const all = flowGraph(normalizeBeads(rows.map((r) => ({ ...r, status: "closed" }))), { now: NOW });
  assert.equal(byId(all).get("ck-z").state, "done");
});

test("waitingIds keeps only open requests that name a bead", () => {
  const ids = waitingIds([
    { state: "open", bead: "a" },
    { state: "answered", bead: "b" },
    { state: "open", bead: null },
    null,
  ]);
  assert.deepEqual([...ids], ["a"]);
});

test("project scope: epics and loose beads, rolled up, deps lifted to epics", () => {
  const g = flowGraph(normalizeBeads(ROWS.slice(0, 7)), { now: NOW });
  assert.equal(g.epic, null);
  const n = byId(g);
  assert.deepEqual([...n.keys()].sort(), ["ck-e1", "ck-e2", "ck-x"]);
  assert.deepEqual(
    { kind: n.get("ck-e1").kind, state: n.get("ck-e1").state, childCount: n.get("ck-e1").childCount, doneCount: n.get("ck-e1").doneCount },
    { kind: "epic", state: "active", childCount: 3, doneCount: 1 },
  );
  assert.equal(n.get("ck-e2").state, "upcoming");
  assert.equal(n.get("ck-x").kind, "bead");
  assert.deepEqual(g.edges, [
    { from: "ck-e1", to: "ck-e2" },
    { from: "ck-x", to: "ck-e1" },
  ]);
});

test("epic rollup: done when all closed, blocked over waiting over active", () => {
  const mk = (kids) =>
    normalizeBeads([{ id: "ck-e", title: "e", status: "open", issue_type: "epic" }, ...kids.map((s, i) => ({ id: `ck-e.${i + 1}`, title: "k", status: s, parent: "ck-e" }))]);
  const st = (kids, requests = []) => byId(flowGraph(mk(kids), { now: NOW, requests })).get("ck-e").state;
  assert.equal(st(["closed", "closed"]), "done");
  assert.equal(st(["blocked", "in_progress"], [{ state: "open", bead: "ck-e.2" }]), "blocked");
  assert.equal(st(["open", "in_progress"], [{ state: "open", bead: "ck-e.1" }]), "waiting");
  assert.equal(st(["open", "in_progress"]), "active");
  assert.equal(st(["open", "closed"]), "upcoming");
  assert.equal(st(["deferred", "closed"]), "deferred");
  assert.equal(st([]), "upcoming", "a childless epic keeps its own state");
});

test("epic scope: children, edges among them, outside deps as stubs", () => {
  const g = flowGraph(normalizeBeads(ROWS.slice(0, 7)), { epic: "ck-e1", now: NOW, requests: [{ state: "open", bead: "ck-e1.3" }] });
  assert.equal(g.epic, "ck-e1");
  const n = byId(g);
  assert.deepEqual([...n.keys()].sort(), ["ck-e1.1", "ck-e1.2", "ck-e1.3", "ck-x"]);
  assert.equal(n.get("ck-e1.1").state, "done");
  assert.equal(n.get("ck-e1.2").state, "active");
  assert.equal(n.get("ck-e1.3").state, "waiting");
  assert.equal(n.get("ck-x").kind, "stub");
  assert.equal(n.get("ck-x").title, "loose");
  assert.deepEqual(g.edges, [
    { from: "ck-e1.1", to: "ck-e1.2" },
    { from: "ck-e1.2", to: "ck-e1.3" },
    { from: "ck-x", to: "ck-e1.3" },
  ]);
  const g2 = flowGraph(normalizeBeads(ROWS.slice(0, 7)), { epic: "ck-e2", now: NOW });
  assert.deepEqual(
    g2.nodes.map((x) => [x.id, x.kind]),
    [["ck-e2.1", "bead"], ["ck-e1.3", "stub"]],
    "the parent link is not an edge, the cross-epic dep is a stub",
  );
});

test("a dep cycle and a parent cycle terminate", () => {
  const beads = normalizeBeads([
    { id: "ck-a", title: "a", status: "open", parent: "ck-b", dependencies: [{ issue_id: "ck-a", depends_on_id: "ck-c", type: "blocks" }] },
    { id: "ck-b", title: "b", status: "open", parent: "ck-a" },
    { id: "ck-c", title: "c", status: "open", dependencies: [{ issue_id: "ck-c", depends_on_id: "ck-d", type: "blocks" }] },
    { id: "ck-d", title: "d", status: "open", dependencies: [{ issue_id: "ck-d", depends_on_id: "ck-c", type: "blocks" }] },
  ]);
  const g = flowGraph(beads, { now: NOW });
  assert.deepEqual(g.nodes.map((x) => x.id).sort(), ["ck-a", "ck-b", "ck-c", "ck-d"], "both beads of a parent cycle stay visible");
  assert.deepEqual(g.edges, [
    { from: "ck-c", to: "ck-a" },
    { from: "ck-c", to: "ck-d" },
    { from: "ck-d", to: "ck-c" },
  ]);
  const ge = flowGraph(beads, { epic: "ck-a", now: NOW });
  assert.deepEqual(ge.nodes.map((x) => x.id), ["ck-b", "ck-c"], "the cycle back to ck-a carries its dep along");
});

// ---- the route ----

function fakeWrapper(handler) {
  const calls = [];
  return {
    calls,
    async call(verb, args = []) {
      calls.push({ verb, args });
      const r = (await handler(verb, args)) || {};
      return { code: r.code == null ? 0 : r.code, stdout: r.stdout || "", stderr: r.stderr || "" };
    },
  };
}

function fakeRes() {
  let resolve;
  const done = new Promise((r) => (resolve = r));
  return {
    status: null,
    json: null,
    done,
    writeHead(code) {
      this.status = code;
    },
    end(body) {
      try {
        this.json = JSON.parse(String(body));
      } catch {
        this.json = null;
      }
      resolve(this);
    },
  };
}

function router({ stdout = JSON.stringify(ROWS), code = 0, requests = [] } = {}) {
  const wrapper = fakeWrapper(() => ({ stdout, code }));
  const collectors = { has: (n) => n === "requests", get: async () => requests };
  return {
    wrapper,
    route: projectRoutes({ cfg: CFG, wrapper, registry: new Registry(CFG), collectors, now: () => NOW, log: () => {} }),
  };
}

async function get(route, url) {
  const req = Object.assign(new EventEmitter(), { method: "GET", url });
  const res = fakeRes();
  route(req, res, url.split("?")[0]);
  return res.done;
}

test("GET flow returns the project graph without audit beads", async () => {
  const { route, wrapper } = router({ requests: [{ state: "open", bead: "ck-x" }] });
  const res = await get(route, "/api/projects/chesski/flow");
  assert.equal(res.status, 200);
  assert.equal(res.json.project, "chesski");
  assert.equal(res.json.epic, null);
  assert.deepEqual(res.json.nodes.map((n) => n.id).sort(), ["ck-e1", "ck-e2", "ck-x"]);
  assert.equal(res.json.nodes.find((n) => n.id === "ck-x").state, "waiting");
  assert.ok(wrapper.calls[0].args.includes("--all"), "closed beads are read too");
  await get(route, "/api/projects/chesski/flow?epic=ck-e1");
  assert.equal(wrapper.calls.length, 1, "a second read inside the TTL is cached");
});

test("GET flow?epic scopes to the epic", async () => {
  const res = await get(router().route, "/api/projects/chesski/flow?epic=ck-e1");
  assert.equal(res.status, 200);
  assert.equal(res.json.epic, "ck-e1");
  assert.equal(res.json.nodes.length, 4);
});

test("GET flow fails closed", async () => {
  const { route } = router();
  assert.equal((await get(route, "/api/projects/nope/flow")).status, 404, "unknown project");
  assert.equal((await get(route, "/api/projects/chesski/flow?epic=ck-zz")).status, 404, "unknown epic");
  assert.equal((await get(route, "/api/projects/chesski/flow?epic=hq-e1")).status, 404, "a bead of another project");
  assert.equal((await get(route, "/api/projects/chesski/flow?epic=ck-x")).status, 404, "a bead that is not an epic");
  assert.equal((await get(route, "/api/projects/chesski/flow?epic=..%2Fx")).status, 400, "not a bead id");
  assert.equal((await get(router({ code: 1, stdout: "" }).route, "/api/projects/chesski/flow")).status, 502, "bd failed");
  assert.equal((await get(router({ stdout: "[{\"id\": \"ck-1\", " }).route, "/api/projects/chesski/flow")).status, 502, "truncated JSON");
  assert.equal((await get(router({ stdout: "{\"id\": \"ck-1\"}" }).route, "/api/projects/chesski/flow")).status, 502, "not a list");
  assert.equal((await get(router({ stdout: "[{\"title\": \"no id\"}]" }).route, "/api/projects/chesski/flow")).status, 502, "row without id");
  const empty = await get(router({ stdout: "" }).route, "/api/projects/chesski/flow");
  assert.deepEqual([empty.status, empty.json.nodes], [200, []], "no output is an empty ledger");
});

test("FlowSource refetches after the TTL", async () => {
  let t = NOW;
  const wrapper = fakeWrapper(() => ({ stdout: "[]" }));
  const src = new FlowSource({ wrapper, now: () => t });
  const project = { id: "chesski", beadSource: { mode: "rig", rig: "chesski" } };
  await src.beads(project);
  t += 31000;
  await src.beads(project);
  assert.equal(wrapper.calls.length, 2);
});

test("FlowSource keeps the last good graph when bd fails, but never one it could not parse", async () => {
  let t = NOW;
  let reply = { stdout: JSON.stringify(ROWS) };
  const wrapper = fakeWrapper(() => reply);
  const src = new FlowSource({ wrapper, now: () => t });
  const project = { id: "chesski", beadSource: { mode: "rig", rig: "chesski" } };
  const first = await src.beads(project);
  t += 31000;
  reply = { code: 1, stdout: "" };
  assert.equal(await src.beads(project), first, "a busy ledger serves the cached list");
  reply = { stdout: "not json" };
  await assert.rejects(src.beads(project), /not JSON/);
});

test("GET flow?focus opens the focused bead's epic", async () => {
  const { route } = router();
  const inEpic = await get(route, "/api/projects/chesski/flow?focus=ck-e1.2");
  assert.equal(inEpic.status, 200);
  assert.equal(inEpic.json.epic, "ck-e1");
  assert.equal(inEpic.json.epicTitle, "epic one");
  const loose = await get(route, "/api/projects/chesski/flow?focus=ck-x");
  assert.deepEqual([loose.status, loose.json.epic], [200, null], "a bead with no epic keeps the project scope");
  const unknown = await get(route, "/api/projects/chesski/flow?focus=ck-nope");
  assert.equal(unknown.status, 404, "a focus bead outside the project is a 404");
  const both = await get(route, "/api/projects/chesski/flow?epic=ck-e2&focus=ck-e1.2");
  assert.equal(both.json.epic, "ck-e2", "an explicit epic wins");
  assert.equal((await get(route, "/api/projects/chesski/flow?focus=..")).status, 400);
});
