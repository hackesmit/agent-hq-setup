// The read marker. One timestamp, but the rules around it are what make the ribbon
// trustworthy: it only ever moves when asked, it survives a restart, and it cannot be
// pushed into the future by a client with a bad clock.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Seen } from "../src/seen.js";
import { startTestApp } from "./helpers.js";

function store(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-seen-"));
  const file = path.join(dir, "seen.json");
  return { file, dir, make: (o = {}) => new Seen({ file, log: () => {}, ...over, ...o }).load(), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("starts with no marker, which is not the same as 'nothing happened'", () => {
  const s = store();
  try {
    assert.equal(s.make().get().at, null);
  } finally {
    s.cleanup();
  }
});

test("a set marker survives a restart", () => {
  const s = store();
  try {
    const a = s.make();
    const at = "2026-08-19T23:14:00.000Z";
    a.set(at);
    assert.equal(s.make().get().at, at);
  } finally {
    s.cleanup();
  }
});

test("defaults to now when no timestamp is given", () => {
  const s = store();
  try {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const a = s.make({ now: () => now });
    assert.equal(a.set().at, new Date(now).toISOString());
  } finally {
    s.cleanup();
  }
});

test("refuses to move into the future, whatever the client's clock says", () => {
  const s = store();
  try {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const a = s.make({ now: () => now });
    const r = a.set("2027-01-01T00:00:00.000Z");
    assert.equal(r.at, new Date(now).toISOString(), "a future marker would blank the ribbon forever");
  } finally {
    s.cleanup();
  }
});

test("a garbage stored value reads as no marker rather than a wrong one", () => {
  const s = store();
  try {
    fs.writeFileSync(s.file, JSON.stringify({ at: "yesterday sometime" }));
    assert.equal(s.make().get().at, null);
    fs.writeFileSync(s.file, "{ not json");
    assert.equal(s.make().get().at, null);
  } finally {
    s.cleanup();
  }
});

test("a garbage timestamp from a client falls back to now instead of unsetting it", () => {
  const s = store();
  try {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const a = s.make({ now: () => now });
    assert.equal(a.set("nonsense").at, new Date(now).toISOString());
  } finally {
    s.cleanup();
  }
});

test("the marker only ever advances, so a stale device cannot unread the night", () => {
  // two devices race by design: the phone marks the night seen at breakfast, then a
  // desktop tab that has been open since yesterday posts its older timestamp
  const s = store();
  try {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const a = s.make({ now: () => now });
    a.set("2026-08-20T10:00:00.000Z");
    const back = a.set("2026-08-20T08:00:00.000Z");
    assert.equal(back.at, "2026-08-20T10:00:00.000Z", "a backward marker would make read events unread");
    // forward still moves
    assert.equal(a.set("2026-08-20T11:00:00.000Z").at, "2026-08-20T11:00:00.000Z");
  } finally {
    s.cleanup();
  }
});

test("a marker that could not be written is reported, not silently believed", () => {
  const s = store();
  try {
    const a = s.make();
    a.set("2026-08-19T23:14:00.000Z");
    // make the write fail the way a full or read-only disk would
    fs.chmodSync(s.dir, 0o500);
    assert.throws(() => a.set("2026-08-20T01:00:00.000Z"), /could not save/);
    // and the in-memory value did not move either, so a later read agrees with disk
    assert.equal(a.get().at, "2026-08-19T23:14:00.000Z");
  } finally {
    try {
      fs.chmodSync(s.dir, 0o700);
    } catch {
      /* best effort */
    }
    s.cleanup();
  }
});

test("read-only mode does not persist", () => {
  const s = store();
  try {
    const a = s.make({ readOnly: true });
    a.set("2026-08-19T23:14:00.000Z");
    assert.equal(a.get().at, null);
    assert.equal(fs.existsSync(s.file), false);
  } finally {
    s.cleanup();
  }
});

test("the routes read and move the marker, and a GET never moves it", async () => {
  const t = await startTestApp();
  const key = t.app.csrf.key;
  try {
    assert.equal((await t.request("GET", "/api/seen")).json.at, null);
    // a read does not set a baseline: only the explicit POST does
    assert.equal((await t.request("GET", "/api/seen")).json.at, null);

    const at = "2026-08-19T23:14:00.000Z";
    const set = await t.request("POST", "/api/seen", { headers: { "x-console-key": key }, body: { at } });
    assert.equal(set.status, 200);
    assert.equal(set.json.at, at);
    assert.equal((await t.request("GET", "/api/seen")).json.at, at);

    const bump = await t.request("POST", "/api/seen", { headers: { "x-console-key": key }, body: {} });
    assert.ok(Date.parse(bump.json.at) >= Date.parse(at));
  } finally {
    await t.close();
  }
});

test("moving the marker needs the CSRF key", async () => {
  const t = await startTestApp();
  try {
    const r = await t.request("POST", "/api/seen", { body: { at: "2026-08-19T23:14:00.000Z" } });
    assert.ok(r.status === 403 || r.status === 401, `got ${r.status}`);
    assert.equal((await t.request("GET", "/api/seen")).json.at, null);
  } finally {
    await t.close();
  }
});
