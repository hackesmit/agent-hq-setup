// flow.py (bead hq-3y18) against a fixture ledger, plus mapFlow. The bead's
// hard rules under test: read-only over the ledgers, the three computations
// (lead time as a distribution, blocked vs in_progress from the interaction
// log with old_value as the segment authority, reopens as rework), audit
// labels excluded, empty and single-bead cases, and defensive mapping.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mapFlow } from "../src/map.js";

const FLOW_PY = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "collectors", "flow.py",
);

// The fixture clock. Everything below is placed relative to it.
const NOW = "2026-08-24T12:00:00Z";
const H = 3600;
const at = (secondsAgo) => new Date(Date.parse(NOW) - secondsAgo * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

function issue(id, createdAgoS, closedAgoS, labels = []) {
  return {
    id,
    status: closedAgoS == null ? "open" : "closed",
    labels,
    created_at: at(createdAgoS),
    ...(closedAgoS == null ? {} : { closed_at: at(closedAgoS) }),
  };
}

function change(issueId, agoS, from, to) {
  return JSON.stringify({
    kind: "field_change", issue_id: issueId, created_at: at(agoS),
    extra: { field: "status", old_value: from, new_value: to },
  });
}

function writeRig(root, name, issues, interactionLines) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "issues.json"), JSON.stringify(issues));
  fs.writeFileSync(path.join(d, "interactions.jsonl"), interactionLines.join("\n") + "\n");
  return d;
}

function runFlow(fixture) {
  return new Promise((resolve, reject) => {
    execFile("python3", [FLOW_PY, "--fixture", fixture, "--now", NOW], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`flow.py failed: ${err.message}\n${stderr}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`flow.py emitted no JSON: ${String(stdout).slice(0, 300)}`));
      }
    });
  });
}

function makeFixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hq-flow-"));
}

test("an empty ledger yields zeros and nulls, never a crash", async () => {
  const root = makeFixture();
  writeRig(root, "empty", [], []);
  const out = await runFlow(root);
  const rig = out.rigs.find((r) => r.rig === "empty");
  assert.ok(rig);
  for (const w of ["7", "30", "90"]) {
    assert.equal(rig.windows[w].closed, 0);
    assert.equal(rig.windows[w].medianLeadS, null);
    assert.equal(rig.windows[w].reworkShare, null);
    assert.equal(rig.windows[w].blockedShare, null);
  }
  assert.equal(rig.weekly.length, 6);
});

test("a single closed bead: its lead time IS the median and the p90", async () => {
  const root = makeFixture();
  // created 5h ago, closed 2h ago: lead 3h
  writeRig(root, "one", [issue("a-1", 5 * H, 2 * H)], []);
  const out = await runFlow(root);
  const w = out.rigs[0].windows["7"];
  assert.equal(w.closed, 1);
  assert.equal(w.medianLeadS, 3 * H);
  assert.equal(w.p90LeadS, 3 * H);
  assert.equal(w.reopened, 0);
  assert.equal(w.reworkShare, 0);
});

test("lead time is a distribution over the window, and windows select by closed time", async () => {
  const root = makeFixture();
  writeRig(root, "r", [
    issue("a-1", 10 * H, 9 * H),          // lead 1h, closed today
    issue("a-2", 20 * H, 17 * H),         // lead 3h, closed today
    issue("a-3", 30 * H, 25 * H),         // lead 5h, closed yesterday
    issue("a-4", 40 * 24 * H, 39 * 24 * H), // closed 39 days ago: outside 7 and 30
  ], []);
  const out = await runFlow(root);
  const rig = out.rigs[0];
  assert.equal(rig.windows["7"].closed, 3);
  assert.equal(rig.windows["7"].medianLeadS, 3 * H);
  assert.equal(rig.windows["30"].closed, 3);
  assert.equal(rig.windows["90"].closed, 4);
});

test("time in status trusts the row's old_value: an unlogged claim still counts as in_progress", async () => {
  const root = makeFixture();
  // The ledger never logged the claim (open -> in_progress); the close row's
  // old_value=in_progress is the only statement of where the time went. The
  // real hq ledger looks exactly like this.
  writeRig(root, "r", [
    issue("a-1", 10 * H, 2 * H), // life 8h
  ], [
    change("a-1", 2 * H, "in_progress", "closed"),
  ]);
  const out = await runFlow(root);
  const w = out.rigs[0].windows["7"];
  // all 8h attributed to in_progress, none blocked
  assert.equal(w.blockedShare, 0);
});

test("blocked share: a bead that waited on the owner shows it", async () => {
  const root = makeFixture();
  // open 10h ago, claimed at 9h (logged), blocked 8h..2h (6h), then closed at 1h
  writeRig(root, "r", [
    issue("a-1", 10 * H, 1 * H),
  ], [
    change("a-1", 9 * H, "open", "in_progress"),
    change("a-1", 8 * H, "in_progress", "blocked"),
    change("a-1", 2 * H, "blocked", "in_progress"),
    change("a-1", 1 * H, "in_progress", "closed"),
  ]);
  const out = await runFlow(root);
  const w = out.rigs[0].windows["7"];
  // blocked 6h, in_progress 1h + 1h = 2h: share 6/8
  assert.ok(Math.abs(w.blockedShare - 6 / 8) < 1e-9, `got ${w.blockedShare}`);
});

test("rework: a closed -> open transition counts as a reopen, in its own window", async () => {
  const root = makeFixture();
  writeRig(root, "r", [
    issue("a-1", 60 * 24 * H, 2 * H),  // eventually re-closed today
    issue("a-2", 10 * H, 5 * H),
  ], [
    change("a-1", 50 * 24 * H, "in_progress", "closed"),
    change("a-1", 3 * H, "closed", "open"),          // reopened today
    change("a-1", 2 * H, "open", "closed"),
  ]);
  const out = await runFlow(root);
  const w7 = out.rigs[0].windows["7"];
  assert.equal(w7.reopened, 1);
  assert.equal(w7.closed, 2);
  assert.equal(w7.reworkShare, 0.5);
});

test("audit labels are excluded from every number", async () => {
  const root = makeFixture();
  writeRig(root, "r", [
    issue("a-1", 5 * H, 2 * H),
    issue("a-2", 5 * H, 2 * H, ["egress-ledger"]),
    issue("a-3", 5 * H, 2 * H, ["session-eval"]),
  ], [
    change("a-2", 3 * H, "closed", "open"),  // an audit reopen is paperwork, not rework
    change("a-2", 2 * H, "open", "closed"),
  ]);
  const out = await runFlow(root);
  const w = out.rigs[0].windows["7"];
  assert.equal(w.closed, 1);
  assert.equal(w.reopened, 0);
});

test("weekly trend is oldest-first with six entries", async () => {
  const root = makeFixture();
  writeRig(root, "r", [issue("a-1", 5 * H, 2 * H)], []);
  const out = await runFlow(root);
  const weekly = out.rigs[0].weekly;
  assert.equal(weekly.length, 6);
  assert.ok(weekly[0].weekStart < weekly[5].weekStart);
  assert.equal(weekly[5].closed, 1);
  assert.equal(weekly[5].medianLeadS, 3 * H);
});

test("torn interaction lines and unparseable issues are skipped, not fatal", async () => {
  const root = makeFixture();
  const d = writeRig(root, "r", [
    issue("a-1", 5 * H, 2 * H),
    { id: "a-bad", status: "closed", created_at: "not a date", closed_at: "also not" },
  ], [change("a-1", 2 * H, "in_progress", "closed")]);
  fs.appendFileSync(path.join(d, "interactions.jsonl"), '{"torn json\n');
  const out = await runFlow(root);
  assert.equal(out.rigs[0].windows["7"].closed, 1);
});

test("mapFlow is defensive against a mangled report", () => {
  assert.deepEqual(mapFlow(null).rigs, []);
  assert.deepEqual(mapFlow("junk").rigs, []);
  const mapped = mapFlow({
    generatedAt: NOW,
    rigs: [
      { rig: "hq", windows: { 7: { closed: "3", medianLeadS: 12.5 }, 30: {}, 90: null }, weekly: [{ weekStart: "2026-08-17", medianLeadS: null, closed: 2 }] },
      { windows: {} },            // no rig name: dropped
    ],
  });
  assert.equal(mapped.rigs.length, 1);
  assert.equal(mapped.rigs[0].windows["7"].closed, 3);
  assert.equal(mapped.rigs[0].windows["7"].medianLeadS, 12.5);
  assert.equal(mapped.rigs[0].windows["30"].medianLeadS, null);
  assert.equal(mapped.rigs[0].windows["90"].closed, 0);
  assert.equal(mapped.rigs[0].weekly[0].weekStart, "2026-08-17");
});
