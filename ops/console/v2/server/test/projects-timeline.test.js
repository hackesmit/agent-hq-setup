import test from "node:test";
import assert from "node:assert/strict";
import { addWorkingMinutes, criticalPath, milestones, nextWorkingInstant, projectTimeline, topoOrder } from "../src/projects/timeline.js";

const T0 = "2026-08-18T09:00:00.000Z"; // a Tuesday, 09:00 with tzOffsetMinutes 0
const OPTS = { tzOffsetMinutes: 0 };

function bead(over = {}) {
  return {
    id: "x-1",
    title: "t",
    status: "open",
    priority: 2,
    labels: [],
    type: "task",
    parent: null,
    deps: [],
    due: null,
    deferUntil: null,
    estimateMin: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    closedAt: null,
    assignee: null,
    ...over,
  };
}

const byId = (items) => new Map(items.map((i) => [i.id, i]));

test("a closed bead spans created to closed and is not a projection", () => {
  const items = projectTimeline(
    [bead({ id: "a", status: "closed", createdAt: "2026-08-10T00:00:00.000Z", closedAt: "2026-08-16T12:00:00.000Z" })],
    T0,
    OPTS,
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].projected, false);
  assert.equal(items[0].start, "2026-08-10T00:00:00.000Z");
  assert.equal(items[0].end, "2026-08-16T12:00:00.000Z");
  assert.equal(items[0].critical, false);
});

test("a missing estimate defaults to 15 minutes and lands in working hours", () => {
  const items = projectTimeline([bead({ id: "a" })], "2026-08-18T06:00:00.000Z", OPTS);
  assert.equal(items[0].start, "2026-08-18T09:00:00.000Z");
  assert.equal(items[0].end, "2026-08-18T09:15:00.000Z");
  assert.equal(items[0].projected, true);
});

test("work spills over the close of business into the next working day", () => {
  const items = projectTimeline([bead({ id: "a", estimateMin: 120 })], "2026-08-18T17:00:00.000Z", OPTS);
  assert.equal(items[0].start, "2026-08-18T17:00:00.000Z");
  assert.equal(items[0].end, "2026-08-19T10:00:00.000Z");
});

test("nextWorkingInstant and addWorkingMinutes agree on the window edges", () => {
  const cfg = { workStartHour: 9, workEndHour: 18, offMin: 0 };
  assert.equal(new Date(nextWorkingInstant(Date.parse("2026-08-18T18:00:00Z"), cfg)).toISOString(), "2026-08-19T09:00:00.000Z");
  assert.equal(new Date(nextWorkingInstant(Date.parse("2026-08-18T12:00:00Z"), cfg)).toISOString(), "2026-08-18T12:00:00.000Z");
  const end = addWorkingMinutes(Date.parse("2026-08-18T09:00:00Z"), 9 * 60, cfg);
  assert.equal(new Date(end).toISOString(), "2026-08-18T18:00:00.000Z");
});

test("a dependency must close before its successor starts, and one lane serialises the rest", () => {
  const beads = [
    bead({ id: "a", priority: 0, estimateMin: 60 }),
    bead({ id: "c", priority: 1, estimateMin: 15 }),
    bead({ id: "b", priority: 2, estimateMin: 30, deps: ["a"] }),
  ];
  const items = byId(projectTimeline(beads, T0, OPTS));
  assert.equal(items.get("a").start, "2026-08-18T09:00:00.000Z");
  assert.equal(items.get("a").end, "2026-08-18T10:00:00.000Z");
  assert.equal(items.get("c").start, "2026-08-18T10:00:00.000Z");
  assert.equal(items.get("b").start, "2026-08-18T10:15:00.000Z");
  assert.equal(items.get("b").end, "2026-08-18T10:45:00.000Z");
  assert.ok(Date.parse(items.get("b").start) >= Date.parse(items.get("a").end));
});

test("two lanes place independent beads in parallel", () => {
  const beads = [bead({ id: "a", priority: 0, estimateMin: 60 }), bead({ id: "b", priority: 1, estimateMin: 60 })];
  const items = byId(projectTimeline(beads, T0, { ...OPTS, lanes: 2 }));
  assert.equal(items.get("a").start, "2026-08-18T09:00:00.000Z");
  assert.equal(items.get("b").start, "2026-08-18T09:00:00.000Z");
});

test("a defer date moves the epoch for that bead", () => {
  const items = byId(
    projectTimeline([bead({ id: "a", deferUntil: "2026-08-20T12:00:00.000Z" })], T0, OPTS),
  );
  assert.equal(items.get("a").start, "2026-08-20T12:00:00.000Z");
  assert.equal(items.get("a").end, "2026-08-20T12:15:00.000Z");
});

test("late is set for an overdue open bead and for a closed bead that missed its due date", () => {
  const items = byId(
    projectTimeline(
      [
        bead({ id: "open-late", due: "2026-08-17T00:00:00.000Z" }),
        bead({ id: "open-ok", due: "2026-09-17T00:00:00.000Z" }),
        bead({
          id: "closed-late",
          status: "closed",
          due: "2026-08-15T00:00:00.000Z",
          createdAt: "2026-08-10T00:00:00.000Z",
          closedAt: "2026-08-16T00:00:00.000Z",
        }),
        bead({
          id: "closed-ok",
          status: "closed",
          due: "2026-08-17T00:00:00.000Z",
          createdAt: "2026-08-10T00:00:00.000Z",
          closedAt: "2026-08-16T00:00:00.000Z",
        }),
      ],
      T0,
      OPTS,
    ),
  );
  assert.equal(items.get("open-late").late, true);
  assert.equal(items.get("open-ok").late, false);
  assert.equal(items.get("closed-late").late, true);
  assert.equal(items.get("closed-ok").late, false);
});

test("the critical path is the longest estimate-weighted chain, not the longest chain", () => {
  // a(10) -> b(10) -> c(10) is three hops for 30 minutes;
  // d(120) -> e(120) is two hops for 240 and must win.
  const beads = [
    bead({ id: "a", estimateMin: 10 }),
    bead({ id: "b", estimateMin: 10, deps: ["a"] }),
    bead({ id: "c", estimateMin: 10, deps: ["b"] }),
    bead({ id: "d", estimateMin: 120 }),
    bead({ id: "e", estimateMin: 120, deps: ["d"] }),
  ];
  const items = byId(projectTimeline(beads, T0, OPTS));
  assert.equal(items.get("d").critical, true);
  assert.equal(items.get("e").critical, true);
  assert.equal(items.get("a").critical, false);
  assert.equal(items.get("c").critical, false);
});

test("criticalPath uses the default estimate for beads without one", () => {
  const beads = [bead({ id: "a" }), bead({ id: "b", deps: ["a"] })];
  const path = criticalPath(beads, (b) => b.estimateMin || 15);
  assert.deepEqual([...path].sort(), ["a", "b"]);
});

test("a dependency cycle still yields every bead exactly once", () => {
  const beads = [bead({ id: "a", deps: ["b"] }), bead({ id: "b", deps: ["a"] })];
  assert.deepEqual(topoOrder(beads).map((b) => b.id).sort(), ["a", "b"]);
  const items = projectTimeline(beads, T0, OPTS);
  assert.equal(items.length, 2);
});

test("a dependency outside the project does not drop the bead", () => {
  const items = projectTimeline([bead({ id: "a", deps: ["other-99"] })], T0, OPTS);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].deps, ["other-99"]);
});

test("an epic spans its children, and the children roll up into it by default", () => {
  const beads = [
    bead({ id: "e", type: "epic", title: "milestone" }),
    bead({ id: "k1", parent: "e", priority: 0, estimateMin: 60 }),
    bead({ id: "k2", parent: "e", priority: 1, estimateMin: 60 }),
  ];
  // atoms: the full drill-down still exists for a caller that asks for it
  const atoms = byId(projectTimeline(beads, T0, { ...OPTS, atoms: true }));
  assert.equal(atoms.get("e").kind, "epic");
  assert.equal(atoms.get("e").start, atoms.get("k1").start);
  assert.equal(atoms.get("e").end, atoms.get("k2").end);
  assert.equal(atoms.get("k1").kind, "bead");
  // default: the plan reads at the idea level, one bar per epic, no atoms
  const rolled = byId(projectTimeline(beads, T0, OPTS));
  assert.equal(rolled.get("e").kind, "epic");
  assert.equal(rolled.get("e").start, atoms.get("k1").start, "the hidden children still shape the epic's bar");
  assert.equal(rolled.has("k1"), false);
  assert.equal(rolled.has("k2"), false);
});

test("a bead whose parent is not an epic stays visible in the rolled-up plan", () => {
  const beads = [
    bead({ id: "t1", title: "standalone" }),
    bead({ id: "t2", parent: "t1", title: "subtask of a task" }),
  ];
  const rolled = byId(projectTimeline(beads, T0, OPTS));
  assert.equal(rolled.has("t1"), true);
  assert.equal(rolled.has("t2"), true, "only epic children roll up; a task parent hides nothing");
});

test("milestones report percent of children closed", () => {
  const beads = [
    bead({ id: "e", type: "epic", due: "2026-09-01T00:00:00.000Z" }),
    bead({ id: "k1", parent: "e", status: "closed", closedAt: "2026-08-11T00:00:00.000Z" }),
    bead({ id: "k2", parent: "e" }),
    bead({ id: "k3", parent: "e" }),
  ];
  const [m] = milestones(beads);
  assert.equal(m.children, 3);
  assert.equal(m.closed, 1);
  assert.equal(m.pctClosed, 33);
  assert.equal(m.due, "2026-09-01T00:00:00.000Z");
});

test("an empty bead list projects nothing", () => {
  assert.deepEqual(projectTimeline([], T0, OPTS), []);
  assert.deepEqual(projectTimeline(null, T0, OPTS), []);
});
