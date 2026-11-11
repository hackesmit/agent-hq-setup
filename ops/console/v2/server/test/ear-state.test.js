import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEarState } from "../src/collectors.js";

const tmp = () => path.join(os.tmpdir(), `ear-${Math.random().toString(36).slice(2)}.json`);

test("a fresh state is reported online with its phase and text", () => {
  const f = tmp();
  fs.writeFileSync(f, JSON.stringify({ state: "listening", at: new Date().toISOString(), text: "hi" }));
  const r = readEarState(f);
  assert.equal(r.state, "listening");
  assert.equal(r.online, true);
  assert.equal(r.text, "hi");
});

test("a stale heartbeat collapses to offline (a dead ear must not look alive)", () => {
  const f = tmp();
  const old = new Date(Date.now() - 120000).toISOString();
  fs.writeFileSync(f, JSON.stringify({ state: "idle", at: old }));
  const r = readEarState(f);
  assert.equal(r.state, "offline");
  assert.equal(r.online, false);
});

test("a future/backward-clock timestamp does not read as forever-online", () => {
  const f = tmp();
  const future = new Date(Date.now() + 3600000).toISOString();
  fs.writeFileSync(f, JSON.stringify({ state: "listening", at: future }));
  const r = readEarState(f);
  assert.equal(r.state, "offline");
  assert.equal(r.online, false);
});

test("an unknown phase collapses to offline", () => {
  const f = tmp();
  fs.writeFileSync(f, JSON.stringify({ state: "hacking", at: new Date().toISOString() }));
  assert.equal(readEarState(f).state, "offline");
});

test("missing and malformed files are offline, never a throw", () => {
  assert.equal(readEarState("/does/not/exist.json").state, "offline");
  const f = tmp();
  fs.writeFileSync(f, "{not json");
  assert.equal(readEarState(f).state, "offline");
});

test("muted is a real phase, distinct from offline", () => {
  const f = path.join(os.tmpdir(), `ear-m-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ state: "muted", at: new Date().toISOString() }));
  const r = readEarState(f);
  assert.equal(r.state, "muted");   // the ear is running, just holding no mic
  assert.equal(r.online, true);
});

test("a real progress figure is carried through", () => {
  const f = path.join(os.tmpdir(), `ear-p-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ state: "thinking", at: new Date().toISOString(), progress: 0.42 }));
  assert.equal(readEarState(f).progress, 0.42);
});

test("an out-of-range or malformed progress is dropped, never clamped", () => {
  for (const bad of [7, -1, "0.5", null, NaN]) {
    const f = path.join(os.tmpdir(), `ear-b-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify({ state: "thinking", at: new Date().toISOString(), progress: bad }));
    assert.equal(readEarState(f).progress, null, `progress ${String(bad)} should be dropped`);
  }
});

test("a stale ear reports no progress, so the crystal cannot hold a dead fill", () => {
  const f = path.join(os.tmpdir(), `ear-s-${Math.random().toString(36).slice(2)}.json`);
  const old = new Date(Date.now() - 120000).toISOString();
  fs.writeFileSync(f, JSON.stringify({ state: "thinking", at: old, progress: 0.5 }));
  const r = readEarState(f);
  assert.equal(r.state, "offline");
  assert.equal(r.progress, null);
});

test("a speaker verdict is carried only when it is one of the known values", () => {
  const mk = (speaker) => {
    const f = path.join(os.tmpdir(), `ear-v-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify({ state: "listening", at: new Date().toISOString(), speaker }));
    return readEarState(f).speaker;
  };
  assert.equal(mk("unknown"), "unknown");
  assert.equal(mk("nonsense"), undefined);
});
