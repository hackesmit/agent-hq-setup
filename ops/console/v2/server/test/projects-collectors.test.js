import test from "node:test";
import assert from "node:assert/strict";
import { Collectors } from "../src/collectors.js";
import { bdArgv, closedBeadArgs, normalizeBead, normalizeBeads, openBeadArgs } from "../src/projects/bd.js";
import { COMMIT_SCAN, ProjectFacts, activityOf, attentionOf, parseGitLog, perDay, registerProjectCollectors, summarize, windowStartMs } from "../src/projects/collectors.js";
import { Registry, normalizeProject } from "../src/projects/registry.js";

const CFG = { hqRoot: "/home/owner/hq", rigsDir: "/home/owner/hq/rigs" };
const NOW = Date.parse("2026-08-18T12:00:00.000Z");

const project = (over = {}) =>
  normalizeProject({ id: "acme-dashboard", kind: "rig", path: "/home/owner/hq/rigs/acme-dashboard", hub: "01 Projects/acme-dashboard/_index.md", ...over }, CFG);

/**
 * A wrapper stand-in. `handler(verb, args)` returns {code, stdout, stderr}.
 * Nothing spawns; the calls are recorded so the argv itself can be asserted.
 */
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

// Copied from `bd list --json` on this box (2026-08-18), trimmed of description.
const BD_ROWS = [
  {
    id: "xd-1",
    title: "open one",
    status: "open",
    priority: 1,
    issue_type: "task",
    owner: "owner@example.com",
    labels: ["P1", "console-v2"],
    created_at: "2026-08-01T10:00:00Z",
    updated_at: "2026-08-01T10:00:00Z",
    dependency_count: 0,
    dependent_count: 0,
    comment_count: 0,
  },
  { id: "xd-2", title: "running", status: "in_progress", priority: 2, issue_type: "task", labels: [], created_at: "2026-08-02T10:00:00Z" },
  { id: "xd-3", title: "stuck", status: "blocked", priority: 0, issue_type: "task", labels: ["P0"], created_at: "2026-08-03T10:00:00Z" },
  {
    id: "xd-4",
    title: "waiting on a date",
    status: "deferred",
    priority: 3,
    issue_type: "task",
    labels: [],
    estimated_minutes: 30,
    due_at: "2026-08-25T00:00:00Z",
    defer_until: "2026-08-20T00:00:00Z",
    created_at: "2026-08-04T10:00:00Z",
  },
];

const CLOSED_ROWS = [
  { id: "xd-9", title: "done a", status: "closed", priority: 2, issue_type: "task", labels: ["P2"], created_at: "2026-08-01T09:00:00Z", closed_at: "2026-08-17T09:00:00Z" },
  { id: "xd-8", title: "done b", status: "closed", priority: 2, issue_type: "task", labels: [], created_at: "2026-08-01T09:00:00Z", closed_at: "2026-08-17T11:00:00Z" },
  { id: "xd-7", title: "done old", status: "closed", priority: 2, issue_type: "task", labels: [], created_at: "2026-07-20T09:00:00Z", closed_at: "2026-08-01T09:00:00Z" },
];

test("bd's issue JSON maps onto the shared Bead type", () => {
  const b = normalizeBead({
    id: "tt-a55.1",
    title: "child b",
    status: "open",
    priority: 2,
    issue_type: "task",
    estimated_minutes: 45,
    due_at: "2026-08-25T00:00:00Z",
    defer_until: "2026-08-20T00:00:00Z",
    created_at: "2026-08-18T20:53:32Z",
    parent: "tt-a55",
    assignee: "your-gh-user",
    dependencies: [
      { issue_id: "tt-a55.1", depends_on_id: "tt-a55", type: "parent-child" },
      { issue_id: "tt-a55.1", depends_on_id: "tt-t0l", type: "blocks" },
      { issue_id: "tt-zzz", depends_on_id: "tt-a55.1", type: "blocks" },
    ],
  });
  assert.equal(b.estimateMin, 45);
  assert.equal(b.due, "2026-08-25T00:00:00.000Z");
  assert.equal(b.deferUntil, "2026-08-20T00:00:00.000Z");
  assert.equal(b.parent, "tt-a55");
  assert.deepEqual(b.deps, ["tt-t0l"], "parent-child is not a dependency and the reverse edge is not ours");
  assert.equal(b.assignee, "your-gh-user");
  assert.equal(b.type, "task");
});

test("absent fields become nulls, never NaN or undefined", () => {
  const b = normalizeBead({ id: "x", title: "t", status: "open" });
  assert.equal(b.estimateMin, null);
  assert.equal(b.due, null);
  assert.equal(b.deferUntil, null);
  assert.equal(b.closedAt, null);
  assert.equal(b.parent, null);
  assert.deepEqual(b.deps, []);
  assert.equal(b.priority, 3);
  assert.equal(normalizeBead({ id: "x", status: "nonsense" }).status, "open");
  assert.deepEqual(normalizeBeads([{ title: "no id" }, { id: "y" }]).map((x) => x.id), ["y"]);
});

test("bdArgv routes hq to bd and a rig to bd-rig, and gives up for a project with no db", () => {
  const hq = normalizeProject({ id: "hq", path: "/home/owner/hq" }, CFG);
  assert.deepEqual(bdArgv(hq, ["list", "--json"]), { verb: "bd", args: ["list", "--json"] });
  assert.deepEqual(bdArgv(project(), ["list", "--json"]), { verb: "bd-rig", args: ["acme-dashboard", "list", "--json"] });
  assert.equal(bdArgv(normalizeProject({ id: "studioco-digital" }, CFG), ["list"]), null);
  assert.equal(openBeadArgs()[0], "list");
  assert.ok(openBeadArgs().includes("--json"));
  const closed = closedBeadArgs("2026-07-19T12:00:00.000Z");
  assert.deepEqual(closed.slice(-4), ["--status", "closed", "--closed-after", "2026-07-19"], "bd takes a date, not a full timestamp");
});

test("perDay counts events into their own UTC day, 30 entries, oldest first", () => {
  const closed = normalizeBeads(CLOSED_ROWS);
  const series = perDay(closed.map((b) => b.closedAt), NOW);
  assert.equal(series.length, 30);
  assert.equal(series[0], 0, "nothing closed 30 days ago");
  // the window ends on 2026-08-18 at index 29, so 2026-08-01 sits at index 12
  assert.equal(series[12], 1, "the 08-01 close, on its own day and not carried forward");
  assert.equal(series[27], 0, "08-16 was quiet, and a per-day series says so");
  assert.equal(series[28], 2, "both 08-17 closes land on 08-17");
  assert.equal(series[29], 0, "nothing closed today");
  assert.equal(
    series.reduce((a, b) => a + b, 0),
    3,
    "every row in the window is counted exactly once",
  );
});

test("perDay drops what falls outside the window or has no timestamp", () => {
  const series = perDay(["2026-08-17T09:00:00Z", null, "", "2020-01-01T00:00:00Z", "not a date"], NOW);
  assert.equal(
    series.reduce((a, b) => a + b, 0),
    1,
    "only the one inside the window counts",
  );
});

test("perDay buckets by the UTC INSTANT, not by slicing the string", () => {
  // 00:30 at +02:00 is 22:30 the previous day in UTC. Slicing the text would file it
  // under the 18th and move a bar a whole day.
  const offset = perDay(["2026-08-18T00:30:00+02:00"], NOW);
  assert.equal(offset[28], 1, "it belongs to 08-17");
  assert.equal(offset[29], 0, "and not to today");
  // The same instant written as Z has to land in the same slot.
  assert.deepEqual(perDay(["2026-08-17T22:30:00Z"], NOW), offset);
});

test("the window opens at a UTC midnight, not at this time of day 30 days back", () => {
  // The buckets are calendar days, so the boundary the truncation test compares
  // against has to be one too, or an evening scan calls itself short.
  const start = windowStartMs(NOW);
  assert.equal(new Date(start).toISOString(), "2026-07-20T00:00:00.000Z");
});

test("activityOf counts commits for a project with a checkout, beads for one without", () => {
  const commits = [
    { sha: "a", at: "2026-08-17T09:00:00Z", author: "the owner", subject: "one" },
    { sha: "b", at: "2026-08-17T10:00:00Z", author: "the owner", subject: "two" },
    { sha: "c", at: "2026-08-10T10:00:00Z", author: "the owner", subject: "three" },
  ];
  const facts = { live: [], closed: normalizeBeads(CLOSED_ROWS), commits, error: null };

  const repo = activityOf(project(), facts, NOW);
  assert.equal(repo.source, "commits");
  assert.equal(repo.values.reduce((a, b) => a + b, 0), 3);
  assert.equal(repo.values[28], 2, "both 08-17 commits land on 08-17");
  assert.equal(repo.truncated, false);

  // A client with no path has no gitDir, so commits are not the question there.
  const client = activityOf(normalizeProject({ id: "studioco-digital" }, CFG), facts, NOW);
  assert.equal(client.source, "beads");
  assert.equal(client.values.reduce((a, b) => a + b, 0), 3, "the closed rows instead");
});

test("truncation is decided by a sentinel row, not by the reply merely being full", () => {
  // git-log takes a count, not a date. The fetch asks for COMMIT_SCAN + 1 so that a
  // full-length reply PROVES something was left out; a repo that simply holds exactly
  // COMMIT_SCAN commits used to be reported as truncated when nothing was missing.
  const rows = (n, at) => new Array(n).fill(null).map((_, i) => ({ sha: String(i), at, author: "d", subject: "x" }));
  const facts = (commits) => ({ live: [], closed: [], commits, error: null });

  const exactly = rows(COMMIT_SCAN, "2026-08-17T09:00:00Z");
  assert.equal(activityOf(project(), facts(exactly), NOW).truncated, false, "exactly full is not proof of more");

  // One extra row came back, and that boundary row is still inside the window: commits
  // in the window were dropped, so the card has to say the early days are incomplete.
  const overflowing = rows(COMMIT_SCAN + 1, "2026-08-17T09:00:00Z");
  assert.equal(activityOf(project(), facts(overflowing), NOW).truncated, true);

  // The extra row reaches back past the window, so the window itself is complete.
  const reaching = rows(COMMIT_SCAN, "2026-08-17T09:00:00Z").concat([
    { sha: "old", at: "2026-06-01T09:00:00Z", author: "d", subject: "old" },
  ]);
  assert.equal(activityOf(project(), facts(reaching), NOW).truncated, false);

  // A backdated commit in the MIDDLE of the reply must not vouch for the window: only
  // the boundary row is asked, because git does not promise monotonic commit dates.
  const backdated = rows(COMMIT_SCAN, "2026-08-17T09:00:00Z");
  backdated[5] = { sha: "backdated", at: "2026-05-01T00:00:00Z", author: "d", subject: "old" };
  assert.equal(
    activityOf(project(), facts(backdated.concat(rows(1, "2026-08-16T09:00:00Z"))), NOW).truncated,
    true,
    "the boundary row is in the window, whatever an earlier row claims",
  );

  // A short log is never truncated, however old its oldest commit.
  assert.equal(activityOf(project(), facts(rows(3, "2026-08-17T09:00:00Z")), NOW).truncated, false);
});

test("attention ranks needs-you over blocked over late", () => {
  const counts = { open: 1, inProgress: 0, blocked: 1, closed7d: 0 };
  assert.equal(attentionOf({ needsYou: 2, counts, late: true, status: "active" }), "needs-you");
  assert.equal(attentionOf({ needsYou: 0, counts, late: true, status: "active" }), "blocked");
  assert.equal(attentionOf({ needsYou: 0, counts: { open: 1, inProgress: 0, blocked: 0, closed7d: 0 }, late: true, status: "active" }), "late");
  assert.equal(attentionOf({ needsYou: 0, counts: { open: 1, inProgress: 0, blocked: 0, closed7d: 0 }, late: false, status: "active" }), "ok");
  assert.equal(attentionOf({ needsYou: 0, counts: { open: 0, inProgress: 0, blocked: 0, closed7d: 0 }, late: false, status: "active" }), "quiet");
  assert.equal(attentionOf({ needsYou: 0, counts, late: false, status: "paused" }), "blocked");
  assert.equal(attentionOf({ needsYou: 0, counts: { open: 3, inProgress: 0, blocked: 0, closed7d: 0 }, late: false, status: "paused" }), "quiet");
});

test("git-log lines become Commit records, with tabs in the subject preserved", () => {
  const out = parseGitLog("abc123\t1755500000\tthe owner\tconsole v2: a\tb\ndef456\t1755400000\tthe owner\tsecond\n\n");
  assert.equal(out.length, 2);
  assert.equal(out[0].sha, "abc123");
  assert.equal(out[0].author, "the owner");
  assert.equal(out[0].subject, "console v2: a\tb");
  assert.equal(out[0].at, new Date(1755500000000).toISOString());
});

test("a ProjectSummary is folded from bd, git, requests and ready", async () => {
  const w = fakeWrapper((verb, args) => {
    if (verb === "bd-rig" && args.includes("--status")) return { stdout: JSON.stringify(CLOSED_ROWS) };
    if (verb === "bd-rig") return { stdout: JSON.stringify(BD_ROWS) };
    if (verb === "git-log") return { stdout: "abc\t1755500000\tthe owner\tmerge branch\n" };
    return { code: 2, stderr: "verb not allowed" };
  });
  const p = project({ goal: "ship it", targetDate: "2026-09-01" });
  const facts = new ProjectFacts({ wrapper: w, now: () => NOW });
  const s = summarize(p, await facts.get(p), {
    nowMs: NOW,
    requests: [
      { rig: "acme-dashboard", state: "open" },
      { rig: "acme-dashboard", state: "resolved" },
      { rig: "chesski", state: "open" },
    ],
    ready: [{ rig: "chesski", id: "ck-1" }, { rig: "acme-dashboard", id: "xd-1", title: "open one" }],
  });
  assert.deepEqual(s.counts, { open: 2, inProgress: 1, blocked: 1, closed7d: 2 });
  assert.equal(s.needsYou, 1);
  assert.deepEqual(s.nextUp, { id: "xd-1", title: "open one" });
  assert.equal(s.lastMergeAt, new Date(1755500000000).toISOString());
  assert.equal(s.attention, "needs-you");
  assert.equal(s.goal, "ship it");
  assert.equal(s.targetDate, "2026-09-01");
  assert.equal(s.activity30d.length, 30);
  assert.equal(s.activitySource, "commits", "a rig with a checkout plots commits");
  // That fixture commit is a year old: it still dates the "merge" line, and it still
  // contributes nothing to a 30-day window, which is the point of the two being separate.
  assert.equal(s.activity30d.reduce((a, b) => a + b, 0), 0);
  assert.equal(s.lastDeploy, null);
  assert.equal(s.error, null);
});

test("an overdue open bead makes the card late when nothing more urgent applies", async () => {
  const w = fakeWrapper((verb, args) => {
    if (verb === "bd-rig" && args.includes("--status")) return { stdout: "[]" };
    if (verb === "bd-rig") return { stdout: JSON.stringify([{ id: "xd-1", status: "open", title: "t", due_at: "2026-08-01T00:00:00Z" }]) };
    return { stdout: "" };
  });
  const p = project();
  const facts = new ProjectFacts({ wrapper: w, now: () => NOW });
  const s = summarize(p, await facts.get(p), { nowMs: NOW, requests: [], ready: [] });
  assert.equal(s.attention, "late");
});

test("a bd failure keeps the last good numbers and surfaces the error", async () => {
  let mode = "ok";
  const w = fakeWrapper((verb, args) => {
    if (mode === "boom" && verb === "bd-rig") return { code: 1, stderr: "dolt: connection refused" };
    if (verb === "bd-rig" && args.includes("--status")) return { stdout: JSON.stringify(CLOSED_ROWS) };
    if (verb === "bd-rig") return { stdout: JSON.stringify(BD_ROWS) };
    return { stdout: "abc\t1755500000\tthe owner\tm\n" };
  });
  let now = NOW;
  const p = project();
  const facts = new ProjectFacts({ wrapper: w, now: () => now, ttlS: 1 });
  const first = await facts.get(p);
  assert.equal(first.error, null);
  assert.equal(first.live.length, 4);
  mode = "boom";
  now += 5000;
  const second = await facts.get(p);
  assert.equal(second.live.length, 4, "the last good beads survive the failure");
  assert.match(second.error, /connection refused/);
  const s = summarize(p, second, { nowMs: now, requests: [], ready: [] });
  assert.deepEqual(s.counts, { open: 2, inProgress: 1, blocked: 1, closed7d: 2 });
  assert.match(s.error, /connection refused/);
});

test("a project with no beads db costs no wrapper call and reports zeroes", async () => {
  const w = fakeWrapper(() => ({ code: 2, stderr: "should not be called" }));
  const p = normalizeProject({ id: "studioco-digital", kind: "client", hub: "01 Projects/studioco-digital/_index.md" }, CFG);
  const facts = new ProjectFacts({ wrapper: w, now: () => NOW });
  const s = summarize(p, await facts.get(p), { nowMs: NOW, requests: [], ready: [] });
  assert.equal(w.calls.length, 0, "no bd and no git-log for a project with neither");
  assert.deepEqual(s.counts, { open: 0, inProgress: 0, blocked: 0, closed7d: 0 });
  assert.equal(s.attention, "quiet");
  assert.equal(s.error, null);
});

test("the projects collector replaces the placeholder and sorts by attention", async () => {
  const w = fakeWrapper((verb, args) => {
    const rig = verb === "bd-rig" ? args[0] : "hq";
    if (verb === "git-log") return { stdout: "abc\t1755500000\tD\tm\n" };
    if (args.includes("--status")) return { stdout: "[]" };
    if (rig === "chesski") return { stdout: JSON.stringify([{ id: "ck-1", status: "blocked", title: "b" }]) };
    if (rig === "gym-tracker") return { stdout: JSON.stringify([{ id: "gt-1", status: "open", title: "o" }]) };
    return { stdout: "[]" };
  });
  const reg = new Collectors({});
  reg.register("projects", 60, async () => [{ id: "placeholder" }]);
  reg.register("requests", 5, async () => [{ rig: "gym-tracker", state: "open" }]);
  reg.register("ready", 60, async () => [{ rig: "gym-tracker", id: "gt-1", title: "o" }]);
  registerProjectCollectors({
    collectors: reg,
    wrapper: w,
    cfg: CFG,
    registry: new Registry(CFG),
    now: () => NOW,
  });
  const rows = await reg.get("projects");
  assert.ok(rows.length >= 5);
  assert.equal(rows.find((r) => r.id === "placeholder"), undefined, "the placeholder collector is gone");
  assert.equal(rows[0].id, "gym-tracker", "needs-you sorts first");
  assert.equal(rows[0].attention, "needs-you");
  assert.equal(rows[1].id, "chesski");
  assert.equal(rows[1].attention, "blocked");
  assert.deepEqual(rows[0].nextUp, { id: "gt-1", title: "o" });
});

test("completion is closed over everything scoped, audit records are invisible, and the active epic is the phase in motion", async () => {
  const rows = [
    { id: "xd-e1", title: "phase one", status: "open", issue_type: "epic", labels: [], created_at: "2026-08-01T00:00:00Z" },
    { id: "xd-20", title: "doing", status: "in_progress", issue_type: "task", parent: "xd-e1", labels: [], created_at: "2026-08-02T00:00:00Z" },
    { id: "xd-21", title: "queued", status: "open", issue_type: "task", parent: "xd-e1", labels: [], created_at: "2026-08-02T00:00:00Z" },
    { id: "xd-22", title: "an egress record", status: "open", issue_type: "task", labels: ["egress-ledger"], created_at: "2026-08-02T00:00:00Z" },
    { id: "xd-23", title: "a session eval", status: "open", issue_type: "task", labels: ["session-eval"], created_at: "2026-08-02T00:00:00Z" },
  ];
  const closedRows = [
    { id: "xd-10", title: "done child", status: "closed", issue_type: "task", parent: "xd-e1", labels: [], created_at: "2026-08-01T00:00:00Z", closed_at: "2026-08-10T00:00:00Z" },
    { id: "xd-11", title: "done old", status: "closed", issue_type: "task", labels: [], created_at: "2026-06-01T00:00:00Z", closed_at: "2026-06-10T00:00:00Z" },
    { id: "xd-12", title: "closed eval", status: "closed", issue_type: "task", labels: ["session-eval"], created_at: "2026-08-01T00:00:00Z", closed_at: "2026-08-10T00:00:00Z" },
  ];
  const w = fakeWrapper((verb, args) => {
    if (verb === "bd-rig" && args.includes("--status")) return { stdout: JSON.stringify(closedRows) };
    if (verb === "bd-rig") return { stdout: JSON.stringify(rows) };
    if (verb === "git-log") return { stdout: "" };
    return { code: 2, stderr: "verb not allowed" };
  });
  const p = project({});
  const facts = new ProjectFacts({ wrapper: w, now: () => NOW });
  const got = await facts.get(p);
  assert.equal(got.live.some((b) => b.id === "xd-22" || b.id === "xd-23"), false, "audit beads never reach the facts");
  assert.equal(got.closed.some((b) => b.id === "xd-12"), false);
  const s = summarize(p, got, { nowMs: NOW, requests: [], ready: [] });
  // scoped: epic + 2 live children + 2 closed = 5; closed = 2
  assert.equal(s.completion, 2 / 5);
  assert.deepEqual(s.activeEpic, { id: "xd-e1", title: "phase one", done: 1, total: 3 });
  assert.equal(s.startedAt, "2026-06-01T00:00:00.000Z", "invested-since is the earliest bead ever filed");
  assert.equal(s.worth, null, "no worth in the registry entry means unset, not invented");
  assert.equal(s.earned, null, "no ledger in ctx means unknown, never $0");
});

test("a project with no beads has null completion, not a fake zero", async () => {
  const w = fakeWrapper((verb) => (verb === "git-log" ? { stdout: "" } : { stdout: "[]" }));
  const p = project({});
  const facts = new ProjectFacts({ wrapper: w, now: () => NOW });
  const s = summarize(p, await facts.get(p), { nowMs: NOW, requests: [], ready: [] });
  assert.equal(s.completion, null);
  assert.equal(s.activeEpic, null);
});

test("a label-scoped project sees only its slice of the hq ledger", async () => {
  const rows = [
    { id: "hq-1", title: "am work", status: "open", issue_type: "task", labels: ["P1", "nonprofit-a"], created_at: "2026-08-01T00:00:00Z" },
    { id: "hq-2", title: "other hq work", status: "open", issue_type: "task", labels: ["console"], created_at: "2026-08-01T00:00:00Z" },
  ];
  const closedRows = [
    { id: "hq-3", title: "am done", status: "closed", issue_type: "task", labels: ["nonprofit-a"], created_at: "2026-07-01T00:00:00Z", closed_at: "2026-07-20T00:00:00Z" },
    { id: "hq-4", title: "other done", status: "closed", issue_type: "task", labels: [], created_at: "2026-07-01T00:00:00Z", closed_at: "2026-07-20T00:00:00Z" },
  ];
  const w = fakeWrapper((verb, args) => {
    if (verb === "bd" && args.includes("--status")) return { stdout: JSON.stringify(closedRows) };
    if (verb === "bd") return { stdout: JSON.stringify(rows) };
    return { code: 2, stderr: "verb not allowed" };
  });
  const p = { id: "nonprofit-a", name: "AM", kind: "client", status: "active", path: null, deploys: [], gitDir: null, beadSource: { mode: "hq", rig: null }, beadLabel: "nonprofit-a" };
  const facts = new ProjectFacts({ wrapper: w, now: () => NOW });
  const got = await facts.get(p);
  assert.deepEqual(got.live.map((b) => b.id), ["hq-1"]);
  assert.deepEqual(got.closed.map((b) => b.id), ["hq-3"]);
  const s = summarize(p, got, { nowMs: NOW, requests: [], ready: [] });
  assert.equal(s.completion, 1 / 2, "one closed of two scoped, only the labeled slice");
});
