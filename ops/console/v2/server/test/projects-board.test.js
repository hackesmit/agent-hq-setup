import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBeads } from "../src/projects/bd.js";
import { normalizeProject } from "../src/projects/registry.js";
import { CHECKLIST_MAX, buildBoardRow, parentOf, pickEpic, sortBoard } from "../src/projects/board.js";

const CFG = { hqRoot: "/home/owner/hq", rigsDir: "/home/owner/hq/rigs" };
const NOW = Date.parse("2026-09-06T12:00:00.000Z");

const project = (over = {}) =>
  normalizeProject({ id: "studioco-digital", name: "studioco Digital", kind: "rig", sphere: "personal", path: "/home/owner/hq/rigs/studioco-digital", ...over }, CFG);

// Shaped like `bd list --json --all` on this box: dotted children, no parent column.
const ROWS = [
  { id: "hq-cczm", title: "studioco site: launch build", status: "open", issue_type: "epic", priority: 1, created_at: "2026-08-20T00:00:00Z" },
  { id: "hq-cczm.1", title: "merge polish", status: "closed", issue_type: "task", priority: 1, created_at: "2026-08-21T00:00:00Z", closed_at: "2026-09-02T10:00:00Z" },
  { id: "hq-cczm.2", title: "light mode", status: "closed", issue_type: "task", priority: 2, created_at: "2026-08-21T00:00:00Z", closed_at: "2026-09-03T10:00:00Z" },
  { id: "hq-cczm.5", title: "contact system", status: "in_progress", issue_type: "task", priority: 1, created_at: "2026-08-22T00:00:00Z" },
  { id: "hq-cczm.12", title: "chatbot demo", status: "open", issue_type: "task", priority: 2, created_at: "2026-08-22T00:00:00Z" },
  { id: "hq-cczm.17", title: "ops visual numbers", status: "open", issue_type: "task", priority: 2, created_at: "2026-08-22T00:00:00Z" },
  { id: "hq-wm0p", title: "studioco business", status: "open", issue_type: "epic", priority: 1, created_at: "2026-08-20T00:00:00Z" },
  { id: "hq-wm0p.11", title: "accounts round two", status: "blocked", issue_type: "task", priority: 1, created_at: "2026-08-22T00:00:00Z" },
  { id: "hq-egress", title: "acquired a domain", status: "open", issue_type: "task", priority: 3, labels: ["egress-ledger"], created_at: "2026-08-22T00:00:00Z" },
];

function facts(rows, extra = {}) {
  const beads = normalizeBeads(rows);
  return {
    live: beads.filter((b) => b.status !== "closed"),
    closed: beads.filter((b) => b.status === "closed"),
    commits: [{ sha: "abc", at: "2026-09-03T00:00:00.000Z", author: "D", subject: "copy: fee model" }],
    error: null,
    ...extra,
  };
}

const summary = (over = {}) => ({ attention: "ok", completion: 0.5, needsYou: 0, counts: { open: 2, inProgress: 1, blocked: 1, closed7d: 2 }, ...over });

test("parentOf reads the parent column first and the dotted id second", () => {
  assert.equal(parentOf({ id: "hq-cczm.5", parent: null }), "hq-cczm");
  assert.equal(parentOf({ id: "hq-x.5", parent: "hq-y" }), "hq-y");
  assert.equal(parentOf({ id: "hq-cczm", parent: null }), null);
});

test("the epic in motion is the one whose child is in progress, with its children as the checklist", () => {
  const row = buildBoardRow(project(), summary(), facts(ROWS), { nowMs: NOW, ready: [] });
  assert.equal(row.epic.id, "hq-cczm");
  assert.deepEqual([row.epic.done, row.epic.total], [2, 5]);
  assert.equal(row.scope, "epic");
  // newest close first
  assert.deepEqual(row.done.map((d) => d.id), ["hq-cczm.2", "hq-cczm.1"]);
  // moving first, then priority, then id
  assert.deepEqual(row.todo.map((t) => t.id), ["hq-cczm.5", "hq-cczm.12", "hq-cczm.17"]);
  assert.deepEqual(row.next, { id: "hq-cczm.5", title: "contact system", status: "in_progress" });
  // blocked reads across the whole project, not only the epic
  assert.deepEqual(row.blocked.map((b) => b.id), ["hq-wm0p.11"]);
  assert.equal(row.lastCommit.subject, "copy: fee model");
});

test("with nothing in progress the ready bead names the epic and the next task", () => {
  const rows = ROWS.map((r) => (r.id === "hq-cczm.5" ? { ...r, status: "open" } : r));
  const ready = [{ rig: "studioco-digital", id: "hq-cczm.12", title: "chatbot demo", priority: 2 }];
  const row = buildBoardRow(project(), summary(), facts(rows), { nowMs: NOW, ready });
  assert.equal(row.epic.id, "hq-cczm");
  assert.deepEqual(row.next, { id: "hq-cczm.12", title: "chatbot demo", status: "ready" });
});

test("a project with no epic shows the fortnight's closes as done and open beads as todo", () => {
  const rows = [
    { id: "gt-1", title: "old close", status: "closed", issue_type: "task", priority: 2, created_at: "2026-07-01T00:00:00Z", closed_at: "2026-07-11T00:00:00Z" },
    { id: "gt-2", title: "fresh close", status: "closed", issue_type: "task", priority: 2, created_at: "2026-08-01T00:00:00Z", closed_at: "2026-09-01T00:00:00Z" },
    { id: "gt-3", title: "import parser", status: "blocked", issue_type: "task", priority: 1, created_at: "2026-08-01T00:00:00Z" },
    { id: "gt-4", title: "prod down", status: "open", issue_type: "decision", priority: 1, created_at: "2026-08-01T00:00:00Z" },
  ];
  const row = buildBoardRow(project({ id: "gym-tracker", name: "Gym", path: "/home/owner/hq/rigs/gym-tracker" }), null, facts(rows), { nowMs: NOW, ready: [] });
  assert.equal(row.epic, null);
  assert.equal(row.scope, "recent");
  assert.deepEqual(row.done.map((d) => d.id), ["gt-2"]);
  // blocked is its own list, not a to-do item twice
  assert.deepEqual(row.todo.map((t) => t.id), ["gt-4"]);
  assert.deepEqual(row.blocked.map((t) => t.id), ["gt-3"]);
  assert.equal(row.todoTotal, 1);
  assert.equal(row.next, null);
  // no summary: counts come from the facts, completion stays unknown
  assert.equal(row.completion, null);
  assert.equal(row.attention, "blocked");
  assert.deepEqual(row.counts, { open: 1, inProgress: 0, blocked: 1, closed7d: 1 });
});

test("between sessions the open epic with the freshest close still reads as the phase", () => {
  const rows = ROWS.filter((r) => r.id !== "hq-cczm.5").concat([
    { id: "hq-wm0p.1", title: "research", status: "closed", issue_type: "task", priority: 1, created_at: "2026-08-22T00:00:00Z", closed_at: "2026-09-05T10:00:00Z" },
  ]);
  const all = normalizeBeads(rows);
  const epic = pickEpic(all, all.filter((b) => b.status !== "closed"), null);
  assert.equal(epic.id, "hq-wm0p");
});

test("an open epic with open work beats one whose children are all closed", () => {
  const rows = [
    { id: "hq-old", title: "finished phase", status: "open", issue_type: "epic", priority: 1, created_at: "2026-08-01T00:00:00Z" },
    { id: "hq-old.1", title: "done", status: "closed", issue_type: "task", priority: 1, created_at: "2026-08-02T00:00:00Z", closed_at: "2026-09-05T00:00:00Z" },
    { id: "hq-live", title: "current phase", status: "open", issue_type: "epic", priority: 1, created_at: "2026-08-01T00:00:00Z" },
    { id: "hq-live.1", title: "done earlier", status: "closed", issue_type: "task", priority: 1, created_at: "2026-08-02T00:00:00Z", closed_at: "2026-08-20T00:00:00Z" },
    { id: "hq-live.2", title: "still open", status: "open", issue_type: "task", priority: 1, created_at: "2026-08-02T00:00:00Z" },
  ];
  const all = normalizeBeads(rows);
  assert.equal(pickEpic(all, all.filter((b) => b.status !== "closed"), null).id, "hq-live");
});

test("the checklist is capped but the totals are not", () => {
  const rows = [{ id: "hq-e", title: "big epic", status: "open", issue_type: "epic", priority: 1, created_at: "2026-08-01T00:00:00Z" }];
  for (let i = 1; i <= 30; i += 1) {
    rows.push({ id: `hq-e.${i}`, title: `step ${i}`, status: i <= 20 ? "closed" : "open", issue_type: "task", priority: 2, created_at: "2026-08-02T00:00:00Z", closed_at: i <= 20 ? `2026-08-${String(i).padStart(2, "0")}T00:00:00Z` : undefined });
  }
  const row = buildBoardRow(project(), summary(), facts(rows), { nowMs: NOW, ready: [] });
  assert.equal(row.done.length, CHECKLIST_MAX);
  assert.equal(row.doneTotal, 20);
  assert.equal(row.todoTotal, 10);
  assert.deepEqual([row.epic.done, row.epic.total], [20, 30]);
});

test("sortBoard puts work before personal, paused last, and attention inside a band", () => {
  const rows = [
    { id: "b", name: "b", sphere: "personal", status: "active", attention: "ok", needsYou: 0 },
    { id: "a", name: "a", sphere: "work", status: "active", attention: "ok", needsYou: 0 },
    { id: "c", name: "c", sphere: "work", status: "paused", attention: "needs-you", needsYou: 3 },
    { id: "d", name: "d", sphere: "work", status: "active", attention: "blocked", needsYou: 0 },
    { id: "e", name: "e", sphere: null, status: "active", attention: "ok", needsYou: 0 },
  ];
  assert.deepEqual(sortBoard(rows).map((r) => r.id), ["d", "a", "b", "e", "c"]);
});
