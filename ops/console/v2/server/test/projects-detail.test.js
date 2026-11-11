import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBeads } from "../src/projects/bd.js";
import {
  DetailSource,
  allBeadArgs,
  beadCounts,
  buildDetail,
  docAvailability,
  epicRollup,
  parseSessionEval,
  readDoc,
  sessionEvalFor,
} from "../src/projects/detail.js";
import { normalizeProject } from "../src/projects/registry.js";

const CFG = { hqRoot: "/home/owner/hq", rigsDir: "/home/owner/hq/rigs" };
const PROJECT = normalizeProject(
  { id: "chesski", name: "Chesski", kind: "rig", path: "/home/owner/hq/rigs/chesski", hub: "01 Projects/chesski/_index.md" },
  CFG,
);

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

const ROWS = [
  { id: "ck-e1", title: "Rule engines", status: "open", issue_type: "epic", labels: ["epic"], due_at: "2026-09-01T00:00:00Z", created_at: "2026-08-01T00:00:00Z" },
  { id: "ck-1", title: "a", status: "open", issue_type: "task", labels: ["P1", "redteam"], parent: "ck-e1", created_at: "2026-08-02T00:00:00Z" },
  { id: "ck-2", title: "b", status: "closed", issue_type: "task", labels: ["P1"], parent: "ck-e1", created_at: "2026-08-02T00:00:00Z", closed_at: "2026-08-10T00:00:00Z" },
  { id: "ck-3", title: "c", status: "in_progress", issue_type: "task", labels: [], created_at: "2026-08-03T00:00:00Z" },
  { id: "ck-4", title: "d", status: "blocked", issue_type: "task", labels: ["P2"], created_at: "2026-08-04T00:00:00Z" },
  { id: "ck-5", title: "e", status: "deferred", issue_type: "task", labels: [], created_at: "2026-08-05T00:00:00Z" },
];

const EVAL_LOG = [
  "2026-08-08T14:36:23-07:00\tsid=aaa\tmodel=claude-sonnet-5\tverdict=PASS\tconf=0.9\tRead-only reconnaissance, no drift.",
  "2026-08-12T14:32:06-07:00\tsid=bbb\tmodel=claude-haiku-4-5\tverdict=FLAG\tconf=0.75\tHook blocked read-only operations.",
  "2026-08-14T09:00:00-07:00\tsid=ccc\tmodel=claude-opus-4-8\tverdict=PASS\tconf=0.8\trig=chesski\tStockfish adapter work.",
  "2026-08-15T09:00:00-07:00\tsid=ddd\tmodel=claude-opus-4-8\tverdict=ESCALATE\tconf=0.6\tcwd=/home/owner/hq/rigs/chesski/engine\tClaimed green with no run.",
  "2026-08-16T09:00:00-07:00\tsid=eee\tmodel=claude-opus-4-8\tverdict=PASS\tconf=0.9\trig=fintrack-portfolio\tCheckout copy.",
  "",
].join("\n");

test("bead counts fold deferred into open and build a label histogram", () => {
  const c = beadCounts(normalizeBeads(ROWS));
  assert.deepEqual({ open: c.open, inProgress: c.inProgress, blocked: c.blocked, closed: c.closed }, { open: 3, inProgress: 1, blocked: 1, closed: 1 });
  assert.deepEqual(c.byLabel, { epic: 1, P1: 2, redteam: 1, P2: 1 });
  assert.equal(allBeadArgs().includes("--all"), true, "closed beads are needed for the detail counts");
});

test("epics roll up their children and sort by due date", () => {
  const epics = epicRollup(normalizeBeads(ROWS));
  assert.equal(epics.length, 1);
  assert.deepEqual(epics[0], { id: "ck-e1", title: "Rule engines", due: "2026-09-01T00:00:00.000Z", children: 2, closed: 1 });
});

test("session-eval rows parse and only attributed ones reach a project", () => {
  const rows = parseSessionEval(EVAL_LOG);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].session, "aaa");
  assert.equal(rows[0].verdict, "PASS");
  assert.equal(rows[0].summary, "Read-only reconnaissance, no drift.");
  const mine = sessionEvalFor(rows, PROJECT);
  assert.deepEqual(mine.map((r) => r.session), ["ddd", "ccc"], "newest first, rig= and cwd= both attribute, unlabelled rows do not");
  assert.equal(mine[0].verdict, "ESCALATE");
  assert.equal(sessionEvalFor(rows, PROJECT, 1).length, 1);
});

test("a cwd under a sibling directory is not attributed to this project", () => {
  const rows = parseSessionEval("2026-08-15T09:00:00-07:00\tsid=x\tverdict=PASS\tcwd=/home/owner/hq/rigs/chesski-old\tnope");
  assert.deepEqual(sessionEvalFor(rows, PROJECT), []);
});

test("doc availability probes the vault and the rig checkout", async () => {
  const w = fakeWrapper((verb, args) => {
    if (verb !== "vault-read") return { code: 2 };
    if (args[0] === "01 Projects/chesski/Knowledge.md") return { stdout: "# Knowledge\n" };
    return { code: 2, stderr: "no such vault file" };
  });
  const docs = await docAvailability(w, PROJECT, { exists: (p) => p === "/home/owner/hq/rigs/chesski/DECISIONS.md" });
  assert.deepEqual(docs, { knowledge: true, hub: false, decisions: true });
  const none = await docAvailability(w, normalizeProject({ id: "studioco-digital" }, CFG), { exists: () => false });
  assert.deepEqual(none, { knowledge: false, hub: false, decisions: false });
});

test("a doc is returned as raw markdown with nothing stripped", async () => {
  const raw = "# Knowledge\n\n<script>alert(1)</script>\n\n- a note\n";
  const w = fakeWrapper(() => ({ stdout: raw }));
  const doc = await readDoc(w, PROJECT, "knowledge");
  assert.equal(doc.markdown, raw, "sanitising is the web's job at render time");
  assert.equal(doc.path, "01 Projects/chesski/Knowledge.md");
  assert.equal(doc.updatedAt, null);

  const dec = await readDoc(w, PROJECT, "decisions", {
    readFile: () => "# Decisions\n",
    stat: () => ({ mtimeMs: Date.parse("2026-08-01T00:00:00Z") }),
  });
  assert.equal(dec.markdown, "# Decisions\n");
  assert.equal(dec.updatedAt, "2026-08-01T00:00:00.000Z");

  const missing = await readDoc(fakeWrapper(() => ({ code: 2 })), PROJECT, "hub");
  assert.equal(missing, null);
});

test("the detail source caches beads and commits and keeps them through a bd failure", async () => {
  let mode = "ok";
  const w = fakeWrapper((verb) => {
    if (verb === "git-log") return { stdout: "abc\t1755500000\tD\tsubject\n" };
    if (mode === "boom") return { code: 1, stderr: "dolt down" };
    return { stdout: JSON.stringify(ROWS) };
  });
  let now = 0;
  const src = new DetailSource({ wrapper: w, cfg: CFG, ttlS: 10, now: () => now, readFile: () => EVAL_LOG });
  const a = await src.get(PROJECT);
  assert.equal(a.beads.length, 6);
  assert.equal(a.commits.length, 1);
  const before = w.calls.length;
  await src.get(PROJECT);
  assert.equal(w.calls.length, before, "a fresh entry is served from cache");
  mode = "boom";
  now += 20000;
  const b = await src.get(PROJECT);
  assert.equal(b.beads.length, 6, "the last good snapshot survives");
  assert.match(b.error, /dolt down/);
  assert.equal(src.sessionEvalRows().length, 5);
});

test("buildDetail assembles the whole page payload", async () => {
  const w = fakeWrapper((verb, args) => {
    if (verb === "git-log") return { stdout: "abc\t1755500000\tD\tsubject\n" };
    if (verb === "vault-read") return args[0].endsWith("Knowledge.md") ? { stdout: "# k" } : { code: 2 };
    return { stdout: JSON.stringify(ROWS) };
  });
  const src = new DetailSource({ wrapper: w, cfg: CFG, now: () => 0, readFile: () => EVAL_LOG });
  const summary = { id: "chesski", name: "Chesski", counts: { open: 3, inProgress: 1, blocked: 1, closed7d: 0 } };
  const detail = await buildDetail({
    project: PROJECT,
    summary,
    source: src,
    wrapper: w,
    truths: { read: () => ({ rev: 4 }) },
    deps: { exists: () => false },
  });
  assert.equal(detail.summary, summary);
  assert.equal(detail.beads.closed, 1);
  assert.equal(detail.epics.length, 1);
  assert.equal(detail.commits.length, 1);
  assert.deepEqual(detail.docs, { knowledge: true, hub: false, decisions: false });
  assert.equal(detail.sessionEval.length, 2);
  assert.equal(detail.truthsRev, 4);
  assert.equal(detail.error, null);
});

test("a truths file that cannot be read reports rev 0 instead of failing the page", async () => {
  const w = fakeWrapper(() => ({ stdout: "[]" }));
  const src = new DetailSource({ wrapper: w, cfg: CFG, now: () => 0, readFile: () => "" });
  const detail = await buildDetail({
    project: PROJECT,
    summary: {},
    source: src,
    wrapper: w,
    truths: {
      read: () => {
        throw new Error("permission denied");
      },
    },
    deps: { exists: () => false },
  });
  assert.equal(detail.truthsRev, 0);
});
