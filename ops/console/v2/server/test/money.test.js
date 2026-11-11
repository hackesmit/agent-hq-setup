// The money ledger (bead hq-9fri, lucy-amended contract): a money surface, so
// every rule is a test: integer cents, op-key idempotency, tombstone deletes,
// torn-tail recovery, per-currency totals that are never combined.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger, MoneyError } from "../src/money.js";
import { mapMoney } from "../src/map.js";
import { startTestApp } from "./helpers.js";

function makeLedger(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-money-"));
  const ledger = new Ledger({ dir, now: over.now || (() => Date.parse("2026-08-19T12:00:00Z")) }).load();
  return { dir, ledger };
}

test("add: strict validation on a money surface", async () => {
  const { dir, ledger } = makeLedger();
  try {
    const bad = [
      [{ amountCents: 100, currency: "MXN", category: "hosting" }, /op/],
      [{ op: "k1", amountCents: 10.5, currency: "MXN", category: "hosting" }, /integer/],
      [{ op: "k1", amountCents: 0, currency: "MXN", category: "hosting" }, /integer/],
      [{ op: "k1", amountCents: "100", currency: "MXN", category: "hosting" }, /integer/],
      [{ op: "k1", amountCents: 2_000_000_000, currency: "MXN", category: "hosting" }, /integer/],
      [{ op: "k1", amountCents: 100, currency: "EUR", category: "hosting" }, /currency/],
      [{ op: "k1", amountCents: 100, currency: "MXN", category: "Hosting!" }, /slug/],
    ];
    for (const [body, re] of bad) {
      await assert.rejects(() => ledger.add(body), re, JSON.stringify(body));
    }
    const { entry } = await ledger.add({ op: "k1", amountCents: 24900, currency: "MXN", category: "hosting", note: "vps" });
    assert.match(entry.id, /^m-/);
    assert.equal(entry.amountCents, 24900);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("idempotency: a replayed op key returns the original, never a second line", async () => {
  const { dir, ledger } = makeLedger();
  try {
    const first = await ledger.add({ op: "same", amountCents: 500, currency: "USD", category: "api" });
    const again = await ledger.add({ op: "same", amountCents: 999999, currency: "MXN", category: "other" });
    assert.equal(again.replayed, true);
    assert.equal(again.entry.id, first.entry.id);
    assert.equal(again.entry.amountCents, 500, "the replay returns the ORIGINAL, not the retry body");
    const lines = fs.readFileSync(path.join(dir, "ledger.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    // a delete replayed with an entry op key is a conflict, not a mutation
    await assert.rejects(() => ledger.remove({ op: "same", target: first.entry.id }), /entry/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tombstones: unknown 404, double delete 409, delete replay is idempotent", async () => {
  const { dir, ledger } = makeLedger();
  try {
    const { entry } = await ledger.add({ op: "e1", amountCents: 100, currency: "MXN", category: "x" });
    await assert.rejects(() => ledger.remove({ op: "d0", target: "m-nope" }), (e) => e instanceof MoneyError && e.status === 404);
    const del = await ledger.remove({ op: "d1", target: entry.id });
    assert.equal(del.replayed, false);
    assert.equal((await ledger.remove({ op: "d1", target: entry.id })).replayed, true, "same op key replays");
    await assert.rejects(() => ledger.remove({ op: "d2", target: entry.id }), (e) => e.status === 409, "a NEW delete of a deleted entry conflicts");
    assert.deepEqual(ledger.visible(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery: a torn final line is truncated so a later append survives (BLOCKER)", async () => {
  const { dir, ledger } = makeLedger();
  try {
    await ledger.add({ op: "a", amountCents: 100, currency: "MXN", category: "x" });
    await ledger.add({ op: "b", amountCents: 200, currency: "MXN", category: "x" });
    const file = path.join(dir, "ledger.jsonl");
    fs.appendFileSync(file, '{"t":"entry","id":"m-torn'); // crash mid-append, no newline

    // reload truncates the torn tail; a NEW acknowledged append must then
    // survive a second reload (the lucy blocker: old code concatenated onto
    // the torn bytes and lost the new entry on the next load).
    const reloaded = new Ledger({ dir }).load();
    assert.equal(reloaded.corrupt, null);
    assert.equal(reloaded.visible().length, 2);
    await reloaded.add({ op: "c", amountCents: 300, currency: "MXN", category: "x" });
    const third = new Ledger({ dir }).load();
    assert.equal(third.corrupt, null, "the file is clean after truncation");
    assert.equal(third.visible().length, 3, "the entry appended after recovery is not lost");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery: a broken middle line or invalid record marks the ledger corrupt (503, no partial trust)", async () => {
  const { dir, ledger } = makeLedger();
  try {
    await ledger.add({ op: "a", amountCents: 100, currency: "MXN", category: "x" });
    await ledger.add({ op: "b", amountCents: 200, currency: "MXN", category: "x" });
    const file = path.join(dir, "ledger.jsonl");
    const edited = fs.readFileSync(file, "utf8").split("\n");
    edited[0] = "{broken";
    fs.writeFileSync(file, edited.join("\n"));
    const bad = new Ledger({ dir }).load();
    assert.match(bad.corrupt, /corruption/);
    // every path fails loudly with 503, never a lie of "0 entries"
    assert.throws(() => bad.visible(), (e) => e instanceof MoneyError && e.status === 503);
    await assert.rejects(() => bad.add({ op: "z", amountCents: 1, currency: "MXN", category: "x" }), (e) => e.status === 503);

    // a valid-JSON but schema-invalid historical record is also corruption
    fs.writeFileSync(file, JSON.stringify({ t: "entry", id: "m-000000000000", op: "o", ts: "2026-08-19T00:00:00Z", amountCents: 5, currency: "EUR", category: "x" }) + "\n");
    const badCurrency = new Ledger({ dir }).load();
    assert.match(badCurrency.corrupt, /corruption/);

    // duplicate ids are corruption too
    const line = JSON.stringify({ t: "entry", id: "m-aaaaaaaaaaaa", op: "o1", ts: "2026-08-19T00:00:00Z", amountCents: 5, currency: "USD", category: "x", note: "" });
    fs.writeFileSync(file, line + "\n" + line.replace('"o1"', '"o2"') + "\n");
    assert.match(new Ledger({ dir }).load().corrupt, /duplicate/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("totals: per currency per month, never combined", async () => {
  const { dir, ledger } = makeLedger();
  try {
    await ledger.add({ op: "1", amountCents: 10000, currency: "MXN", category: "hosting" });
    await ledger.add({ op: "2", amountCents: 10000, currency: "USD", category: "hosting" });
    await ledger.add({ op: "3", amountCents: -2500, currency: "USD", category: "refund" });
    const totals = ledger.totals();
    assert.deepEqual(totals, [
      { month: "2026-08", currency: "MXN", cents: 10000 },
      { month: "2026-08", currency: "USD", cents: 7500 },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mapMoney: honest range from whatever usage.py has", () => {
  const report = mapMoney({ series: [{ day: "2026-08-18", input: 10, output: "5", cache_read: 100, sessions: 1 }, { day: "", dropped: true }] }, null);
  assert.equal(report.rangeDays, 1);
  assert.deepEqual(report.series[0], { day: "2026-08-18", input: 10, output: 5, cacheRead: 100, sessions: 1 });
  assert.deepEqual(report.ledger, []);
});

test("the money routes: entry, replay status codes, delete, slice refresh", async () => {
  const t = await startTestApp({});
  try {
    const post = (url, body) => t.request("POST", url, { body, headers: { "x-console-key": t.key } });
    const r1 = await post("/api/money/entry", { op: "op-a", amountCents: 45000, currency: "MXN", category: "hosting", note: "vps agosto" });
    assert.equal(r1.status, 201, r1.text);
    const r2 = await post("/api/money/entry", { op: "op-a", amountCents: 45000, currency: "MXN", category: "hosting" });
    assert.equal(r2.status, 200, "an op-key replay is a 200 with the original entry");
    assert.equal(r2.json.id, r1.json.id);

    const state = await t.request("GET", "/api/state");
    assert.equal(state.json.money.ledger.length, 1);
    assert.equal(state.json.money.totals[0].cents, 45000);
    assert.equal(state.json.money.series.length, 1, "the fake usage series flows through");

    const bad = await post("/api/money/entry", { op: "op-b", amountCents: 1.5, currency: "MXN", category: "x" });
    assert.equal(bad.status, 400);

    const del = await post("/api/money/delete", { op: "op-c", target: r1.json.id });
    assert.equal(del.status, 200, del.text);
    const gone = await post("/api/money/delete", { op: "op-d", target: r1.json.id });
    assert.equal(gone.status, 409);
    const after = await t.request("GET", "/api/state/money");
    assert.equal(after.json.data.ledger.length, 0);
  } finally {
    await t.close();
  }
});

test("red-team: mail-switch on must be a strict boolean", async () => {
  const t = await startTestApp({ runner: async () => ({ code: 0, stdout: "{}", stderr: "" }) });
  try {
    const bad = await t.request("POST", "/api/mail-switch", {
      body: { switch: "disabled", on: "false" },
      headers: { "x-console-key": t.key },
    });
    assert.equal(bad.status, 400, "the string 'false' must not be treated as truthy");
  } finally {
    await t.close();
  }
});

test("fix-verify: a schema-invalid FINAL line without a newline is corruption, not a torn tail", async () => {
  const { dir, ledger } = makeLedger();
  try {
    await ledger.add({ op: "a", amountCents: 100, currency: "MXN", category: "x" });
    const file = path.join(dir, "ledger.jsonl");
    // valid JSON, invalid schema (EUR), no trailing newline: must NOT be truncated away
    fs.appendFileSync(file, JSON.stringify({ t: "entry", id: "m-000000000000", op: "z", ts: "2026-08-19T00:00:00Z", amountCents: 5, currency: "EUR", category: "x" }));
    const bad = new Ledger({ dir }).load();
    assert.match(bad.corrupt, /corruption/, "a parsed-but-invalid final line is corruption");
    // the file is untouched (not silently truncated)
    assert.ok(fs.readFileSync(file, "utf8").includes("EUR"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fix-verify: a dangling or forward tombstone on disk is corruption", async () => {
  const { dir } = makeLedger();
  try {
    const file = path.join(dir, "ledger.jsonl");
    const entry = JSON.stringify({ t: "entry", id: "m-aaaaaaaaaaaa", op: "e", ts: "2026-08-19T00:00:00Z", amountCents: 5, currency: "USD", category: "x", note: "" });
    const tomb = JSON.stringify({ t: "tombstone", id: "m-bbbbbbbbbbbb", op: "d", ts: "2026-08-19T00:00:00Z", target: "m-aaaaaaaaaaaa" });
    // forward reference: tombstone before its target
    fs.writeFileSync(file, tomb + "\n" + entry + "\n");
    assert.match(new Ledger({ dir }).load().corrupt, /dangling or duplicate tombstone/);
    // dangling: target never exists
    fs.writeFileSync(file, JSON.stringify({ t: "tombstone", id: "m-cccccccccccc", op: "d2", ts: "2026-08-19T00:00:00Z", target: "m-999999999999" }) + "\n");
    assert.match(new Ledger({ dir }).load().corrupt, /dangling or duplicate tombstone/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- commitments: what repeats, what it costs, and who it is for -----------
// A commitment is a SCHEDULE, not money that moved. The rules that matter are
// that it never leaks into a total of actual movement, that its monthly cost is
// right whatever the cadence, and that cancelling it stops it counting.

test("cadence maths: monthly cost is right, and month-ends do not roll forward", async () => {
  const { addMonths, monthlyCents, nextDue } = await import("../src/money.js");

  // 31 Jan plus a month is the last day of February, not the 3rd of March.
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2026-01-31", 13), "2027-02-28");
  assert.equal(addMonths("2026-03-15", 1), "2026-04-15");

  const at = (cadence, cents) => monthlyCents({ cadence, amountCents: cents });
  assert.equal(at("monthly", 2000), 2000);
  assert.equal(at("yearly", 24000), 2000);
  assert.equal(at("quarterly", 6000), 2000);
  assert.equal(at("weekly", 100), Math.round((100 * 52) / 12));

  const monthly = { cadence: "monthly", startsOn: "2026-01-15", endsOn: null, amountCents: 1000 };
  assert.equal(nextDue(monthly, "2026-08-01"), "2026-08-15");
  assert.equal(nextDue(monthly, "2026-08-15"), "2026-08-15", "due today is still due");
  assert.equal(nextDue(monthly, "2026-08-16"), "2026-09-15");
  // an ended commitment has no next date at all
  assert.equal(nextDue({ ...monthly, endsOn: "2026-07-01" }, "2026-08-01"), null);
  // a weekly schedule that started long ago still resolves
  assert.equal(nextDue({ cadence: "weekly", startsOn: "2020-01-01", endsOn: null }, "2026-08-19"), "2026-08-19");
});

test("a commitment is a forecast and never counts as money that moved", async () => {
  const { dir, ledger } = makeLedger();
  try {
    // negative is money IN, positive is money OUT: the ledger's existing convention
    await ledger.add({ op: "e1", amountCents: -50000, currency: "MXN", category: "retainer", client: "lodgeco", project: "lodgeco-site" });
    await ledger.addCommitment({
      op: "c1", label: "Figma", amountCents: 30000, currency: "MXN",
      category: "tools", cadence: "monthly", startsOn: "2026-01-10", vendor: "figma",
    });

    // the subscription is NOT in the ledger of actual movement
    const ids = ledger.visible().map((e) => e.id);
    assert.equal(ids.length, 1, "one real entry, and the schedule is not one of them");
    const flows = ledger.flows();
    assert.deepEqual(flows, [{ currency: "MXN", inCents: 50000, outCents: 0, netCents: 50000 }]);

    // it IS in the forecast
    const rate = ledger.runRate();
    assert.deepEqual(rate, [{ currency: "MXN", inCents: 0, outCents: 30000, netCents: -30000, count: 1 }]);

    const live = ledger.liveCommitments();
    assert.equal(live.length, 1);
    assert.equal(live[0].monthlyCents, 30000);
    assert.equal(live[0].nextDueOn, "2026-09-10", "next due after the injected today of 19 Aug");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelling a commitment stops it counting, and is idempotent by op key", async () => {
  const { dir, ledger } = makeLedger();
  try {
    const { commitment } = await ledger.addCommitment({
      op: "c1", label: "Vercel", amountCents: 4000, currency: "USD",
      category: "hosting", cadence: "monthly", startsOn: "2026-02-01",
    });
    assert.equal(ledger.runRate()[0].outCents, 4000);

    const first = await ledger.cancelCommitment({ op: "x1", target: commitment.id });
    assert.equal(first.replayed, false);
    const replay = await ledger.cancelCommitment({ op: "x1", target: commitment.id });
    assert.equal(replay.replayed, true, "the same op key returns the original outcome");

    assert.deepEqual(ledger.runRate(), [], "a cancelled commitment is not a run rate");
    assert.equal(ledger.liveCommitments().length, 0);
    await assert.rejects(() => ledger.cancelCommitment({ op: "x2", target: commitment.id }), /already cancelled/);
    await assert.rejects(() => ledger.cancelCommitment({ op: "x3", target: "m-000000000000" }), /no such commitment/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("client value and effort, with the project mapping emerging from the ledger", async () => {
  const { dir, ledger } = makeLedger();
  try {
    // they paid us (negative), and we spent on their hosting (positive)
    await ledger.add({ op: "a", amountCents: -120000, currency: "MXN", category: "invoice", client: "acme", project: "acme-dashboard" });
    await ledger.add({ op: "b", amountCents: -80000, currency: "MXN", category: "invoice", client: "acme", project: "acme-financial" });
    await ledger.add({ op: "c", amountCents: 15000, currency: "MXN", category: "hosting", client: "acme" });
    await ledger.add({ op: "d", amountCents: -4000, currency: "USD", category: "invoice", client: "lodgeco", project: "lodgeco-site" });
    await ledger.addCommitment({ op: "r", label: "retainer", amountCents: -25000, currency: "MXN", category: "retainer", cadence: "monthly", startsOn: "2026-01-01", client: "acme", project: "acme-dashboard" });

    const effort = { "acme-dashboard": { tokens: 1_000_000, sessions: 12 }, "acme-financial": { tokens: 250_000, sessions: 3 } };
    const rows = ledger.clients((project) => effort[project]);

    assert.deepEqual(rows.map((r) => r.client), ["lodgeco", "acme"]);
    const acme = rows[1];
    // the mapping was never configured: it came from the tags on the payments
    assert.deepEqual(acme.projects, ["acme-dashboard", "acme-financial"]);
    assert.equal(acme.tokens, 1_250_000);
    assert.equal(acme.sessions, 15);
    assert.equal(acme.commitmentCount, 1);
    const mxn = acme.money.find((m) => m.currency === "MXN");
    assert.equal(mxn.inCents, 200000);
    assert.equal(mxn.outCents, 15000);
    assert.equal(mxn.monthlyCents, -25000, "the retainer is forecast, held apart from what moved");

    // currencies are never combined, here as everywhere else in this ledger
    assert.deepEqual(rows[0].money.map((m) => m.currency), ["USD"]);
    // a client with no project tagged reports no effort rather than a guess
    assert.equal(rows[0].tokens, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("commitment validation is as strict as the entry path", async () => {
  const { dir, ledger } = makeLedger();
  try {
    const base = { op: "k", amountCents: 100, currency: "MXN", category: "tools", cadence: "monthly", startsOn: "2026-01-01" };
    const bad = [
      [{ ...base, op: "" }, /op/],
      [{ ...base, amountCents: 0 }, /integer/],
      [{ ...base, amountCents: 1.5 }, /integer/],
      [{ ...base, currency: "EUR" }, /currency/],
      [{ ...base, category: "Tools!" }, /slug/],
      [{ ...base, cadence: "fortnightly" }, /cadence/],
      [{ ...base, startsOn: "01-01-2026" }, /startsOn/],
      [{ ...base, startsOn: "2026-13-45" }, /startsOn/],
      [{ ...base, endsOn: "2025-01-01" }, /precede/],
      [{ ...base, client: "Not A Slug" }, /client/],
    ];
    for (const [body, re] of bad) {
      await assert.rejects(() => ledger.addCommitment(body), re, JSON.stringify(body));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a ledger carrying commitments survives a reload byte for byte", async () => {
  const { dir, ledger } = makeLedger();
  try {
    await ledger.add({ op: "e", amountCents: -500, currency: "USD", category: "invoice", client: "lodgeco" });
    const { commitment } = await ledger.addCommitment({ op: "c", label: "Proton", amountCents: 1200, currency: "USD", category: "tools", cadence: "yearly", startsOn: "2026-03-01", vendor: "proton" });
    await ledger.addCommitment({ op: "c2", label: "gone", amountCents: 900, currency: "USD", category: "tools", cadence: "monthly", startsOn: "2026-03-01" });
    const second = await ledger.liveCommitments();
    await ledger.cancelCommitment({ op: "x", target: second.find((c) => c.label === "gone").id });

    const { Ledger } = await import("../src/money.js");
    const reloaded = new Ledger({ dir, now: () => Date.parse("2026-08-19T12:00:00Z") }).load();
    assert.equal(reloaded.corrupt, null, reloaded.corrupt || "");
    assert.deepEqual(reloaded.liveCommitments(), ledger.liveCommitments());
    assert.deepEqual(reloaded.runRate(), ledger.runRate());
    assert.equal(reloaded.liveCommitments().length, 1);
    assert.equal(reloaded.liveCommitments()[0].id, commitment.id);
    assert.equal(reloaded.visible()[0].client, "lodgeco", "the new entry fields survive too");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the cross-vendor round on the commitment work ------------------------

test("a date that does not exist is refused, and so is one with junk on the end", async () => {
  const { dir, ledger } = makeLedger();
  try {
    const base = { amountCents: 100, currency: "MXN", category: "tools", cadence: "monthly" };
    // Date.parse normalises 30 February to 2 March, so a regex plus a parse is
    // not enough: the value has to round-trip to the same y/m/d it came from.
    await assert.rejects(() => ledger.addCommitment({ ...base, op: "d1", startsOn: "2026-02-30" }), /startsOn/);
    await assert.rejects(() => ledger.addCommitment({ ...base, op: "d2", startsOn: "2026-04-31" }), /startsOn/);
    await assert.rejects(() => ledger.addCommitment({ ...base, op: "d3", startsOn: "2025-02-29" }), /startsOn/);
    // and the value must MATCH before anything slices it
    await assert.rejects(() => ledger.addCommitment({ ...base, op: "d4", startsOn: "2026-01-01garbage" }), /startsOn/);
    await assert.rejects(() => ledger.addCommitment({ ...base, op: "d5", startsOn: "2026-01-01T00:00:00Z" }), /startsOn/);
    await assert.rejects(() => ledger.addCommitment({ ...base, op: "d6", startsOn: "2026-03-01", endsOn: "2026-06-31" }), /endsOn/);

    // a real leap day is fine
    const ok = await ledger.addCommitment({ ...base, op: "d7", startsOn: "2028-02-29" });
    assert.equal(ok.commitment.startsOn, "2028-02-29");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an ended commitment is not live, and every view agrees that it is not", async () => {
  const { dir, ledger } = makeLedger();
  try {
    // ends before the injected today of 19 Aug 2026
    await ledger.addCommitment({
      op: "e1", label: "old retainer", amountCents: -120000, currency: "MXN", category: "revenue",
      cadence: "monthly", startsOn: "2026-01-01", endsOn: "2026-07-01", client: "acme", project: "acme-dashboard",
    });
    await ledger.addCommitment({
      op: "e2", label: "current", amountCents: 5000, currency: "MXN", category: "tools",
      cadence: "monthly", startsOn: "2026-01-01",
    });

    // the card's count, the forecast and the client rollup are one answer
    assert.equal(ledger.liveCommitments().length, 1, "the ended one is not live");
    assert.equal(ledger.liveCommitments()[0].label, "current");
    const rate = ledger.runRate();
    assert.deepEqual(rate, [{ currency: "MXN", inCents: 0, outCents: 5000, netCents: -5000, count: 1 }]);
    const clients = ledger.clients();
    assert.equal(clients.length, 0, "an ended commitment is not a client commitment either");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the run rate rounds once per currency, not once per commitment", async () => {
  const { dir, ledger } = makeLedger();
  try {
    // twelve yearly items of one cent each is one cent a month, not nothing.
    // Rounding each record first would report a portfolio that costs zero.
    for (let i = 0; i < 12; i += 1) {
      await ledger.addCommitment({
        op: `y${i}`, label: `tiny ${i}`, amountCents: 1, currency: "USD",
        category: "tools", cadence: "yearly", startsOn: "2026-01-05",
      });
    }
    const rate = ledger.runRate();
    assert.equal(rate.length, 1);
    assert.equal(rate[0].count, 12);
    assert.equal(rate[0].outCents, 1, "twelve cents a year is one cent a month");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an entry carries its client, vendor and project through the write path", async () => {
  const { dir, ledger } = makeLedger();
  try {
    await ledger.add({
      op: "t1", amountCents: -50000, currency: "MXN", category: "revenue",
      note: "august", client: "acme", vendor: "", project: "acme-dashboard",
    });
    const row = ledger.visible()[0];
    assert.equal(row.client, "acme");
    assert.equal(row.project, "acme-dashboard");
    assert.equal(row.vendor, null, "an empty tag is absent, never the empty string");

    // and that is what makes the client rollup reachable at all
    const clients = ledger.clients(() => ({ tokens: 100, sessions: 1 }));
    assert.equal(clients.length, 1);
    assert.deepEqual(clients[0].projects, ["acme-dashboard"]);
    assert.equal(clients[0].tokens, 100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- auto-post (the owner 2026-09-30): due commitments become real entries, once ----

test("postDue books every due occurrence once, dated on its due day, income and costs alike", async () => {
  const { dir, ledger } = makeLedger({ now: () => Date.parse("2026-09-30T18:00:00Z") });
  try {
    await ledger.addCommitment({ op: "w", label: "Salary", amountCents: -200000, currency: "MXN", category: "revenue", cadence: "weekly", startsOn: "2026-09-04", client: "orbit-acme", vendor: "owner", project: "acme-dashboard" });
    await ledger.addCommitment({ op: "m", label: "Pt 2", amountCents: -1620000, currency: "MXN", category: "revenue", cadence: "monthly", startsOn: "2026-07-31", client: "orbit-acme" });
    await ledger.addCommitment({ op: "s", label: "Claude Max", amountCents: 20000, currency: "USD", category: "api", cadence: "monthly", startsOn: "2026-08-01", vendor: "anthropic" });
    assert.equal(await ledger.postDue(), 9);
    const got = ledger.visible().map((e) => `${e.ts.slice(0, 10)} ${e.currency} ${e.amountCents}`).sort();
    assert.deepEqual(got, [
      "2026-07-31 MXN -1620000",
      "2026-08-01 USD 20000",
      "2026-08-31 MXN -1620000",
      "2026-09-01 USD 20000",
      "2026-09-04 MXN -200000",
      "2026-09-11 MXN -200000",
      "2026-09-18 MXN -200000",
      "2026-09-25 MXN -200000",
      "2026-09-30 MXN -1620000", // Jul 31 anchor clamps to the month's last day, and today counts
    ]);
    const salary = ledger.visible().find((e) => e.ts.startsWith("2026-09-04"));
    assert.equal(salary.client, "orbit-acme");
    assert.equal(salary.project, "acme-dashboard");
    assert.equal(salary.note, "auto: Salary");
    // posted entries are money that moved: flows and months count them
    assert.deepEqual(ledger.flows(), [
      { currency: "MXN", inCents: 5660000, outCents: 0, netCents: 5660000 },
      { currency: "USD", inCents: 0, outCents: 40000, netCents: -40000 },
    ]);

    // a second pass writes nothing; a reload sees the same ledger and still writes nothing
    assert.equal(await ledger.postDue(), 0);
    const reloaded = new Ledger({ dir, now: () => Date.parse("2026-09-30T18:00:00Z") }).load();
    assert.equal(reloaded.corrupt, null);
    assert.equal(await reloaded.postDue(), 0);
    assert.equal(reloaded.visible().length, 9);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("postDue: a deleted occurrence stays deleted, a cancelled commitment stops, the future waits", async () => {
  let now = Date.parse("2026-09-12T08:00:00Z");
  const { dir, ledger } = makeLedger({ now: () => now });
  try {
    const { commitment } = await ledger.addCommitment({ op: "w", label: "Salary", amountCents: -200000, currency: "MXN", category: "revenue", cadence: "weekly", startsOn: "2026-09-04" });
    assert.equal(await ledger.postDue(), 2, "Sep 4 and Sep 11; Sep 18 is in the future");
    const sep11 = ledger.visible().find((e) => e.ts.startsWith("2026-09-11"));
    await ledger.remove({ op: "d1", target: sep11.id }); // that payment did not arrive
    assert.equal(await ledger.postDue(), 0, "the deleted occurrence is never re-posted");
    assert.equal(ledger.visible().length, 1);

    now = Date.parse("2026-09-19T08:00:00Z");
    assert.equal(await ledger.postDue(), 1, "Sep 18 posts once it is due");
    await ledger.cancelCommitment({ op: "x", target: commitment.id });
    now = Date.parse("2026-10-30T08:00:00Z");
    assert.equal(await ledger.postDue(), 0, "a cancelled commitment posts nothing more");
    assert.equal(ledger.visible().length, 2, "and what it already posted stays");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("postDue: endsOn bounds the posting, read-only never writes, a huge backfill is capped per pass", async () => {
  const { dir, ledger } = makeLedger({ now: () => Date.parse("2026-09-30T12:00:00Z") });
  try {
    await ledger.addCommitment({ op: "e", label: "ended", amountCents: 1000, currency: "MXN", category: "tools", cadence: "monthly", startsOn: "2026-06-15", endsOn: "2026-08-20" });
    assert.equal(await ledger.postDue(), 3, "Jun 15, Jul 15, Aug 15 and nothing after endsOn");

    await ledger.addCommitment({ op: "old", label: "typo", amountCents: 100, currency: "MXN", category: "tools", cadence: "weekly", startsOn: "2010-01-01" });
    assert.equal(await ledger.postDue(), 400, "capped per pass");
    assert.ok((await ledger.postDue()) > 0, "the rest continues on later passes");

    const ro = new Ledger({ dir, readOnly: true, now: () => Date.parse("2027-01-01T00:00:00Z") }).load();
    assert.equal(await ro.postDue(), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("postDue: quarterly and yearly keep their anchor day through clamped months (no double post)", async () => {
  const run = async (c, today) => {
    const { dir, ledger } = makeLedger({ now: () => Date.parse(`${today}T12:00:00Z`) });
    try {
      await ledger.addCommitment({ op: "q", label: "x", amountCents: 1000, currency: "MXN", category: "tools", ...c });
      await ledger.postDue();
      return ledger.visible().map((e) => e.ts.slice(0, 10)).sort();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  assert.deepEqual(await run({ cadence: "quarterly", startsOn: "2026-01-31" }, "2026-12-31"),
    ["2026-01-31", "2026-04-30", "2026-07-31", "2026-10-31"]);
  assert.deepEqual(await run({ cadence: "yearly", startsOn: "2024-02-29" }, "2028-03-01"),
    ["2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"]);
  assert.deepEqual(await run({ cadence: "quarterly", startsOn: "2025-11-30" }, "2026-12-01"),
    ["2025-11-30", "2026-02-28", "2026-05-30", "2026-08-30", "2026-11-30"]);
  const { nextDue } = await import("../src/money.js");
  assert.equal(nextDue({ cadence: "quarterly", startsOn: "2026-01-31", endsOn: null }, "2026-05-01"), "2026-07-31");
});
