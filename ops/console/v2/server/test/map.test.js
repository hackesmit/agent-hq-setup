import test from "node:test";
import assert from "node:assert/strict";
import { computeBadges, mapCalendar, mapHealth, mapMachine, mapReady, mapRequests, mapSessions, mapUsage, rigOfBead, unanswered } from "../src/map.js";

test("missing keys map to empty contract shapes, never a throw", () => {
  assert.deepEqual(mapSessions(undefined), []);
  assert.deepEqual(mapRequests(null), []);
  assert.deepEqual(mapReady(undefined), []);
  const m = mapMachine(undefined);
  assert.equal(m.cores, 0);
  assert.deepEqual(m.load, [0, 0, 0]);
  assert.equal(m.tempC, null);
  assert.deepEqual(m.health, { disk: null, backup: null });
});

test("health reports are renamed, judged, and never invent a zero", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  const h = mapHealth(
    {
      disk: { at: "2026-10-11T11:55:00Z", device: "/dev/nvme0", model: "SAMSUNG", passed: true, temp_c: 38, used_pct: 4, spare_pct: 100, spare_threshold_pct: 10, power_on_hours: 2981, unsafe_shutdowns: 101 },
      backup: { target: "george", last_success_at: "2026-10-08T12:00:00Z", last_attempt_at: "2026-10-11T11:00:00Z", last_result: "skipped: george unreachable" },
    },
    now,
  );
  assert.equal(h.disk.level, "ok");
  assert.equal(h.disk.usedPct, 4);
  assert.equal(h.disk.mediaErrors, null);
  assert.equal(h.backup.level, "warn");
  assert.match(h.backup.problems[0], /72 hours old/);
  assert.deepEqual(mapHealth({ disk: "junk", backup: [] }, now), { disk: null, backup: null });
});

test("v1 empty strings become nulls", () => {
  const [s] = mapSessions({ terminals: [{ id: "t-1", kind: "terminal", rig: "", bead: "", model: "", branch: "" }] });
  assert.equal(s.rig, null);
  assert.equal(s.bead, null);
  assert.equal(s.model, null);
  assert.equal(s.kind, "interactive");
  assert.equal(s.state, "idle");
});

test("a dead pane is closed, not running", () => {
  const [s] = mapSessions({ terminals: [{ id: "t-1", status: "active", pane_dead: true }] });
  assert.equal(s.state, "closed");
});

test("statuses map to the contract's session states", () => {
  const st = (status) => mapSessions({ terminals: [{ id: "t", status }] })[0].state;
  assert.equal(st("active"), "running");
  assert.equal(st("done"), "closed");
  assert.equal(st("exited"), "closed");
  assert.equal(st("snoozed"), "snoozed");
  assert.equal(st("finishable"), "finishable");
  assert.equal(st("something-new"), "idle");
});

test("requests carry age, severity and the run-card fields", () => {
  const now = Date.parse("2026-08-18T10:10:00Z");
  const [r] = mapRequests(
    {
      requests: [
        {
          id: "r-1",
          question: "run the migration",
          ts: "2026-08-18T10:00:00Z",
          status: "open",
          kind: "run",
          cmd: "supabase db push",
          why: "needs a login",
          sev: "P0",
          bead: "dh-4",
          rig: "unassigned",
        },
      ],
    },
    now,
  );
  assert.equal(r.ageSeconds, 600);
  assert.equal(r.kind, "run");
  assert.equal(r.severity, "P0");
  assert.equal(r.command, "supabase db push");
  assert.equal(r.rig, "fintrack-portfolio"); // "unassigned" falls back to the bead prefix
  assert.equal(r.state, "open");
});

test("a request with a command but no kind is a run card; urgent means P0", () => {
  const [r] = mapRequests({ requests: [{ id: "r-1", cmd: "flyctl deploy", urgent: true, ts: "2026-08-18T10:00:00Z" }] });
  assert.equal(r.kind, "run");
  assert.equal(r.severity, "P0");
  const [d] = mapRequests({ requests: [{ id: "r-2", question: "which way?", ts: "2026-08-18T10:00:00Z" }] });
  assert.equal(d.kind, "decide");
  assert.equal(d.severity, "P1");
});

test("snoozed requests keep their own state", () => {
  const out = mapRequests({ requests: [], snoozed: [{ id: "r-9", status: "open", snooze_until: "2026-08-20T09:00:00Z" }] });
  assert.equal(out[0].state, "snoozed");
  assert.equal(out[0].snoozedUntil, "2026-08-20T09:00:00.000Z");
});

test("ready beads sort by priority and pick up the bead's Model line", () => {
  const out = mapReady([
    { rig: "hq", beads: [{ id: "hq-2", title: "b", priority: 2, description: "Model: opus-4-8\n" }] },
    { rig: "chesski", beads: [{ id: "ck-1", title: "a", priority: 0, labels: ["P0"] }, { bogus: true }] },
  ]);
  assert.deepEqual(
    out.map((b) => b.id),
    ["ck-1", "hq-2"],
  );
  assert.equal(out[1].model, "claude-opus-4-8");
  assert.equal(out[0].estimateMin, null);
});

test("machine units are converted, not passed through", () => {
  const m = mapMachine(
    {
      cpu: { pct: 2.8, cores: 12, load: [1.07, 0.96, 0.89] },
      mem: { total: 8280805376, used: 2567356416, pct: 31 },
      swap: { total: 2147483648, used: 849289216, pct: 39.5 },
      temp_max: 51.5,
      uptime_s: 93876,
      disks: [{ mount: "/", total: 1081101176832, free: 1013162270720, pct: 6.3 }],
      procs: [{ pid: 1159, rss: 473952256, cmd: "claude" }],
    },
    "hqbox",
  );
  assert.equal(m.mem.totalMb, 7897);
  assert.equal(m.disks[0].totalGb, 1006.9);
  assert.equal(m.topRss[0].rssMb, 452);
  assert.equal(m.tempC, 51.5);
  assert.equal(m.cpuSeries24h.length, 0);
});

test("usage sums the token buckets and carries plan usage", () => {
  const u = mapUsage(
    { today: { output: 10, input: 5, cache_read: 100, cache_write: 1, sessions: 9, models: { "claude-opus-5": 10 } }, week: { output: 20 } },
    { pct: 6.1 },
  );
  assert.equal(u.tokensToday, 116);
  assert.equal(u.outputTokensToday, 10);
  assert.equal(u.sessionsToday, 9);
  assert.equal(u.planUsage.fiveHourPct, 6.1);
  assert.equal(u.planUsage.weeklyPct, null);
  assert.equal(u.byModelWeek[0].model, "claude-opus-5");
});

test("badges count open questions, the top severity and blocked beads", () => {
  const badges = computeBadges({
    requests: [
      { state: "open", severity: "P2" },
      { state: "open", severity: "P0" },
      { state: "resolved", severity: "P0" },
    ],
    projects: [{ counts: { blocked: 2 } }, { counts: { blocked: 1 } }],
    alerts: [{ severity: "P0" }, { severity: "P2" }],
  });
  assert.equal(badges.now, 2);
  assert.equal(badges.nowSeverity, "P0");
  assert.equal(badges.projects, 3);
  assert.equal(badges.machines, 1);
});

test("bead prefixes resolve to project ids", () => {
  assert.equal(rigOfBead("xd-207"), "acme-dashboard");
  assert.equal(rigOfBead("nope-1"), null);
  assert.equal(rigOfBead(""), null);
});

test("an 'active' registry row expires: a corpse is not counted as a live session", () => {
  // The registry found in production had 34 rows claiming active, 33 of them last
  // heard from six days earlier. Its reaper runs only at session start and fails
  // open when it cannot list panes, so the console must not take the claim at
  // face value.
  const now = Date.parse("2026-08-20T12:00:00Z");
  const at = (hoursAgo) => new Date(now - hoursAgo * 3600_000).toISOString();
  const ctl = {
    terminals: [
      { id: "s-fresh", kind: "worker", status: "active", last_seen: at(0.5) },
      { id: "s-longbuild", kind: "worker", status: "active", last_seen: at(5) },
      { id: "s-corpse", kind: "worker", status: "active", last_seen: at(149) },
      { id: "s-snoozed", kind: "worker", status: "snoozed", last_seen: at(149) },
      { id: "s-nodate", kind: "worker", status: "active", last_seen: "" },
    ],
  };
  const byId = Object.fromEntries(mapSessions(ctl, now).map((s) => [s.id, s.state]));

  assert.equal(byId["s-fresh"], "running");
  // a session sitting on a long build is still live: the window is generous
  assert.equal(byId["s-longbuild"], "running", "5h of quiet must not hide a working session");
  assert.equal(byId["s-corpse"], "closed", "six days of silence is not a live terminal");
  // a snoozed session is MEANT to be quiet; expiry applies only to a running claim
  assert.equal(byId["s-snoozed"], "snoozed");
  // an unparseable heartbeat is not evidence of death either way, so nothing changes
  assert.equal(byId["s-nodate"], "running");

  const live = mapSessions(ctl, now).filter((s) => s.state === "running").length;
  assert.equal(live, 3, "the count reflects what is actually alive");
});

test("calendar: somebody else's text is bounded, and a link that is not https is not a link", () => {
  // This is the only collector whose input comes from outside the box: an event
  // title is written by whoever sent the invitation.
  const mapped = mapCalendar({
    ok: true,
    generatedAt: "2026-08-21T10:00:00Z",
    events: [
      { id: "a", title: "x".repeat(500), startsAt: "2026-08-21T11:00:00Z", endsAt: "", response: "needsAction", meetLink: "https://meet.google.com/abc" },
      { id: "b", title: "js link", startsAt: "2026-08-21T12:00:00Z", meetLink: "javascript:alert(1)" },
      { id: "c", title: "http link", startsAt: "2026-08-21T13:00:00Z", meetLink: "http://insecure.example" },
      { id: "d", title: "bad response", startsAt: "2026-08-21T14:00:00Z", response: "somethingElse" },
      { title: "no start", startsAt: "" },
    ],
  });

  assert.equal(mapped.ok, true);
  assert.equal(mapped.events.length, 4, "the event with no start time is dropped");
  assert.equal(mapped.events[0].title.length, 200, "a long title is bounded rather than trusted");
  assert.equal(mapped.events[0].meetLink, "https://meet.google.com/abc");
  assert.equal(mapped.events[1].meetLink, null, "javascript: is not a meeting link");
  assert.equal(mapped.events[2].meetLink, null, "http: is not either");
  assert.equal(mapped.events[3].response, null, "a response outside the known set is no response");
  assert.equal(mapped.events[0].response, "needsAction");
  assert.equal(unanswered(mapped).length, 1);
});

test("calendar: a failure is a shape the card can render", () => {
  const mapped = mapCalendar({ ok: false, reason: "the grant may have been revoked" });
  assert.equal(mapped.ok, false);
  assert.match(mapped.reason, /revoked/);
  assert.deepEqual(mapped.events, []);
  assert.equal(unanswered(mapped).length, 0);
});

test("focus is only offered where it could do something", () => {
  // Focus selects a tmux PANE. A terminal this console started is a runner PTY
  // with no pane, so the control could never work on it, and offering it anyway
  // is the same class of mistake as the Dispatch button on an hq bead.
  const rows = mapSessions({
    terminals: [
      { id: "s-pane", kind: "worker", status: "active", tmux_window: "%14", last_seen: new Date().toISOString() },
      { id: "s-window", kind: "worker", status: "active", tmux_window: "work:main", last_seen: new Date().toISOString() },
      { id: "s-runner", kind: "interactive", status: "active", last_seen: new Date().toISOString() },
    ],
  });
  const by = Object.fromEntries(rows.map((r) => [r.id, r.focusable]));
  assert.equal(by["s-pane"], true);
  assert.equal(by["s-window"], false, "a window name is not a pane id; focus takes a pane");
  assert.equal(by["s-runner"], false, "a runner-owned PTY has no pane at all");
});

test("mapSessions carries the hook's turn state and drops unknown values", () => {
  const now = Date.parse("2026-10-20T03:00:00Z");
  const ctl = {
    terminals: [
      { id: "s-a", status: "active", last_seen: "2026-10-20T02:59:00Z" },
      { id: "s-b", status: "active", last_seen: "2026-10-20T02:59:00Z" },
      { id: "s-c", status: "active", last_seen: "2026-10-20T02:59:00Z" },
      { id: "s-d", status: "active", last_seen: "2026-10-20T02:59:00Z" },
    ],
    turns: {
      "s-a": { turn: "working", at: "2026-10-20T02:58:00Z" },
      "s-b": { turn: "sleeping", at: "2026-10-20T02:58:00Z" },
      "s-d": { turn: "background", at: "2026-10-20T02:57:00Z" },
    },
  };
  const [a, b, c, d] = mapSessions(ctl, now);
  assert.equal(d.turn, "background", "a turn ended with background work passes through");
  assert.equal(d.turnAt, "2026-10-20T02:57:00.000Z");
  assert.equal(a.turn, "working");
  assert.equal(a.turnAt, "2026-10-20T02:58:00.000Z");
  assert.equal(b.turn, null);
  assert.equal(b.turnAt, null);
  assert.equal(c.turn, null);
});

test("usage carries every plan window from the plan-usage timer", () => {
  const u = mapUsage({}, {
    pct: 4, weekly_pct: 1, updated: "2026-10-20T05:20:00Z",
    limits: [
      { kind: "session", label: "5 h", percent: 4, severity: "normal", resets_at: "2026-10-20T08:30:00Z", active: true },
      { kind: "weekly_scoped", label: "Week, Fable", percent: 0, resets_at: "2026-10-27T04:00:00Z" },
      "junk",
    ],
  });
  assert.equal(u.planUsage.limits.length, 3);
  assert.deepEqual(u.planUsage.limits[0], { kind: "session", label: "5 h", percent: 4, severity: "normal", resetsAt: "2026-10-20T08:30:00Z", active: true });
  assert.equal(u.planUsage.limits[1].percent, 0);
  assert.equal(u.planUsage.limits[2].percent, null);
  assert.equal(u.planUsage.updatedAt, "2026-10-20T05:20:00Z");
  assert.equal(u.planUsage.error, null);
});

test("only an open request makes a session wait on the owner", () => {
  const live = new Date().toISOString();
  const terminals = ["s-open", "s-answered", "s-claimed", "s-done"].map((id) => ({ id, kind: "terminal", status: "active", last_seen: live }));
  const requests = [
    { id: "r-1", session: "s-open", status: "open" },
    { id: "r-2", session: "s-answered", status: "answered" },
    { id: "r-3", session: "s-claimed", status: "revival_claimed" },
    { id: "r-4", session: "s-done", status: "delivered" },
  ];
  const states = Object.fromEntries(mapSessions({ terminals, requests }).map((s) => [s.id, s.state]));
  assert.equal(states["s-open"], "waiting");
  assert.equal(states["s-answered"], "running");
  assert.equal(states["s-claimed"], "running");
  assert.equal(states["s-done"], "running");
});

test("a worker whose pane died is finishable, not a dead terminal card", () => {
  const [w] = mapSessions({ terminals: [{ id: "s-1", kind: "worker", status: "active", pane_dead: true }] });
  assert.equal(w.state, "finishable");
  const [x] = mapSessions({ terminals: [{ id: "s-2", kind: "worker", status: "exited", pane_dead: true }] });
  assert.equal(x.state, "finishable");
  const [d] = mapSessions({ terminals: [{ id: "s-3", kind: "worker", status: "done" }] });
  assert.equal(d.state, "closed");
});

test("a live pane with a stale heartbeat stays a card; a stale row with no live pane is closed", () => {
  const old = new Date(Date.now() - 7 * 3600e3).toISOString();
  const [live] = mapSessions({ terminals: [{ id: "s-i", kind: "interactive", status: "active", pane_live: true, tmux_window: "%5", last_seen: old }] });
  assert.equal(live.state, "running");
  const [gone] = mapSessions({ terminals: [{ id: "s-g", kind: "interactive", status: "active", pane_live: false, tmux_window: "%6", last_seen: old }] });
  assert.equal(gone.state, "closed");
});

test("ctl's reconciled rows: a worker whose pane is gone or back at a shell is finishable, never running (hq-je3fk.5)", () => {
  const now = Date.parse("2026-10-30T20:00:00Z");
  const seen = "2026-10-30T19:59:00Z";
  const rows = mapSessions({
    terminals: [
      { id: "s-gone", kind: "worker", status: "exited", pane_state: "gone", pane_live: false, needs_finish: true, last_seen: seen },
      { id: "s-shell", kind: "worker", status: "exited", pane_state: "shell", pane_live: false, needs_finish: true, last_seen: seen },
      { id: "s-term", kind: "terminal", status: "exited", pane_state: "shell", pane_live: false, last_seen: seen },
      { id: "s-live", kind: "worker", status: "active", pane_state: "live", pane_live: true, last_seen: seen },
      { id: "s-closed", kind: "worker", status: "closed", pane_state: "gone", pane_live: false, last_seen: seen },
    ],
  }, now);
  const st = Object.fromEntries(rows.map((r) => [r.id, r.state]));
  assert.deepEqual(st, { "s-gone": "finishable", "s-shell": "finishable", "s-term": "closed", "s-live": "running", "s-closed": "closed" });
});
