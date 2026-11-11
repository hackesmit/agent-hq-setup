// The money routes over real HTTP (regression for the 2026-08-27 outage).
//
// money.test.js proves the Ledger's rules by calling it directly. Nothing
// exercised the ROUTES, so two production-only failures went unseen: the
// ledger dir pointed into ~/hq/state where the hqconsole user cannot write,
// and the router's catch block crashed the whole process (ReferenceError on
// an out-of-scope `url`) instead of answering 500. The browser saw an empty
// reply: "I clicked add and nothing happened."
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startTestApp, tmpDir } from "./helpers.js";

const post = (t, urlPath, body) => t.request("POST", urlPath, { body, headers: { "x-console-key": t.key } });

test("the money lifecycle over HTTP: entry, commitment, cancel, delete, replay", async () => {
  const t = await startTestApp({});
  try {
    const entry = await post(t, "/api/money/entry", {
      op: "op-e1", amountCents: 24900, currency: "MXN", category: "hosting", note: "vultr",
    });
    assert.equal(entry.status, 201, entry.text);
    assert.equal(entry.json.amountCents, 24900);

    // the same op key replays the original outcome instead of writing twice
    const replay = await post(t, "/api/money/entry", {
      op: "op-e1", amountCents: 24900, currency: "MXN", category: "hosting", note: "vultr",
    });
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.json.id, entry.json.id);

    // Today's real date, so the assertion cannot rot at a UTC midnight: a
    // commitment starting today is always next due today.
    const today = new Date().toISOString().slice(0, 10);
    const commitment = await post(t, "/api/money/commitment", {
      op: "op-c1", label: "Proton", amountCents: 1200, currency: "USD",
      category: "tools", cadence: "monthly", startsOn: today,
    });
    assert.equal(commitment.status, 201, commitment.text);
    assert.equal(commitment.json.monthlyCents, 1200);
    assert.equal(commitment.json.nextDueOn, today);

    const cancel = await post(t, "/api/money/commitment/cancel", { op: "op-x1", target: commitment.json.id });
    assert.equal(cancel.status, 200, cancel.text);

    const del = await post(t, "/api/money/delete", { op: "op-d1", target: entry.json.id });
    assert.equal(del.status, 200, del.text);

    // Goals: their own store and routes; the money slice carries them.
    const goal = await post(t, "/api/money/goal", { op: "op-g1", label: "Cover the month", kind: "in", targetCents: 6000000, currency: "MXN" });
    assert.equal(goal.status, 201, goal.text);
    assert.equal(goal.json.kind, "in");
    const goalReplay = await post(t, "/api/money/goal", { op: "op-g1", kind: "in", targetCents: 1, currency: "USD" });
    assert.equal(goalReplay.status, 200, goalReplay.text);
    assert.equal(goalReplay.json.id, goal.json.id);
    const badGoal = await post(t, "/api/money/goal", { op: "op-g2", kind: "net", targetCents: 100, currency: "MXN", month: "2026-10" });
    assert.equal(badGoal.status, 400, badGoal.text);
    const state = await t.request("GET", "/api/state");
    assert.equal(state.status, 200);
    assert.deepEqual(state.json.money.goals.map((g) => g.id), [goal.json.id]);
    const goalDel = await post(t, "/api/money/goal/delete", { op: "op-gd1", target: goal.json.id });
    assert.equal(goalDel.status, 200, goalDel.text);
    assert.equal((await t.request("GET", "/api/state")).json.money.goals.length, 0);

    // a validation refusal is a 400 with a readable reason, never a crash
    const bad = await post(t, "/api/money/commitment", {
      op: "op-c2", amountCents: 100, currency: "USD", category: "tools",
      cadence: "fortnightly", startsOn: "2026-08-27",
    });
    assert.equal(bad.status, 400, bad.text);
    assert.match(bad.json.error, /cadence/);
  } finally {
    await t.close();
  }
});

test("an unwritable money dir answers 500 and the server survives it", async () => {
  // The dir's parent is a regular FILE, so the append's mkdirSync throws a
  // plain fs error with no .status: exactly the shape that crashed production.
  const state = tmpDir();
  const blocker = path.join(state, "blocker");
  fs.writeFileSync(blocker, "not a directory\n");
  const t = await startTestApp({ stateDir: state, env: { CONSOLE_MONEY_DIR: path.join(blocker, "money") } });
  try {
    const r = await post(t, "/api/money/commitment", {
      op: "op-c1", label: "x", amountCents: 100, currency: "MXN",
      category: "tools", cadence: "monthly", startsOn: "2026-08-27",
    });
    assert.equal(r.status, 500, r.text);
    // the unexpected error's message stays in the log, not the response
    assert.equal(r.json.error, "server error");

    // the process is still alive and answering
    const health = await t.request("GET", "/healthz");
    assert.equal(health.status, 200);
  } finally {
    await t.close();
  }
});
