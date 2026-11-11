// Sticky notes: the store and its routes. A note is scratch, but it is the owner's scratch,
// so the rules that matter are that it survives a restart, that a garbled file cannot put
// a wrong note on the screen, and that positions stay inside the viewport fractions.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Notes, NotesError } from "../src/notes.js";
import { startTestApp } from "./helpers.js";

function store(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-notes-"));
  const file = path.join(dir, "notes.json");
  const n = new Notes({ file, log: () => {}, ...over }).load();
  return { n, file, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a note round-trips through the file and survives a restart", () => {
  const { n, file, cleanup } = store();
  try {
    const made = n.create({ text: "call the accountant", x: 0.2, y: 0.8, color: "green" });
    assert.match(made.id, /^n-[0-9a-f]{12}$/);
    assert.equal(made.text, "call the accountant");
    assert.equal(made.color, "green");
    // a second process reading the same file sees it
    const again = new Notes({ file, log: () => {} }).load();
    assert.equal(again.list().length, 1);
    assert.equal(again.list()[0].text, "call the accountant");
    assert.equal(again.list()[0].x, 0.2);
  } finally {
    cleanup();
  }
});

test("positions are clamped to the viewport fraction, and sizes to something usable", () => {
  const { n, cleanup } = store();
  try {
    const wild = n.create({ x: 5, y: -3, w: 10000, h: 1 });
    assert.equal(wild.x, 1);
    assert.equal(wild.y, 0);
    assert.equal(wild.w, 600);
    assert.equal(wild.h, 120);
    const nan = n.create({ x: "over there", y: null });
    assert.equal(nan.x, 0.5, "an unusable position falls back rather than becoming NaN");
    assert.equal(nan.y, 0.3);
  } finally {
    cleanup();
  }
});

test("text is capped and an unknown colour falls back instead of reaching the DOM", () => {
  const { n, cleanup } = store();
  try {
    const long = n.create({ text: "x".repeat(9000), color: "chartreuse" });
    assert.equal(long.text.length, 4000);
    assert.equal(long.color, "amber");
  } finally {
    cleanup();
  }
});

test("update patches only what was sent, and delete is final", () => {
  const { n, cleanup } = store();
  try {
    const made = n.create({ text: "first", x: 0.1, y: 0.1 });
    const moved = n.update(made.id, { x: 0.9 });
    assert.equal(moved.x, 0.9);
    assert.equal(moved.text, "first", "text survives a move");
    assert.equal(moved.y, 0.1);
    assert.ok(moved.updatedAt >= made.updatedAt);
    n.remove(made.id);
    assert.equal(n.list().length, 0);
    assert.throws(() => n.update(made.id, { text: "ghost" }), /no such note/);
    assert.throws(() => n.remove(made.id), /no such note/);
  } finally {
    cleanup();
  }
});

test("a garbled or hand-edited file loses the bad rows, not the good ones", () => {
  const { file, cleanup } = store();
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        notes: [
          { id: "n-aaaaaaaaaaaa", text: "good", color: "blue", x: 0.4, y: 0.4, w: 220, h: 170, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" },
          { id: "not-an-id", text: "bad" },
          "a string where an object should be",
          null,
        ],
      }),
    );
    const n = new Notes({ file, log: () => {} }).load();
    assert.equal(n.list().length, 1);
    assert.equal(n.list()[0].text, "good");
  } finally {
    cleanup();
  }
});

test("an unreadable file starts empty rather than throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-notes-"));
  try {
    const file = path.join(dir, "notes.json");
    fs.writeFileSync(file, "{ this is not json");
    const n = new Notes({ file, log: () => {} }).load();
    assert.equal(n.list().length, 0);
    assert.doesNotThrow(() => n.create({ text: "fresh" }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("read-only mode refuses writes", () => {
  const { file, cleanup } = store();
  try {
    const n = new Notes({ file, readOnly: true, log: () => {} }).load();
    assert.throws(() => n.create({ text: "no" }), NotesError);
  } finally {
    cleanup();
  }
});

test("the routes create, list, patch and delete", async () => {
  const t = await startTestApp();
  const key = t.app.csrf.key;
  try {
    const made = await t.request("POST", "/api/notes", { headers: { "x-console-key": key }, body: { text: "hello", x: 0.3, y: 0.7 } });
    assert.equal(made.status, 201, made.text);
    const id = made.json.id;
    const listed = await t.request("GET", "/api/notes");
    assert.equal(listed.status, 200);
    assert.equal(listed.json.length, 1);
    assert.equal(listed.json[0].text, "hello");

    const moved = await t.request("POST", `/api/notes/${id}`, { headers: { "x-console-key": key }, body: { x: 0.42 } });
    assert.equal(moved.status, 200);
    assert.equal(moved.json.x, 0.42);
    assert.equal(moved.json.text, "hello");

    const gone = await t.request("POST", `/api/notes/${id}/delete`, { headers: { "x-console-key": key }, body: {} });
    assert.equal(gone.status, 200);
    assert.equal((await t.request("GET", "/api/notes")).json.length, 0);

    // a made-up id is a 404, and a malformed one does not match the route at all
    const missing = await t.request("POST", "/api/notes/n-000000000000", { headers: { "x-console-key": key }, body: { text: "x" } });
    assert.equal(missing.status, 404);
    const malformed = await t.request("POST", "/api/notes/../../etc/passwd", { headers: { "x-console-key": key }, body: {} });
    assert.ok(malformed.status === 404 || malformed.status === 400, `got ${malformed.status}`);
  } finally {
    await t.close();
  }
});

test("a note POST without the CSRF key is refused", async () => {
  const t = await startTestApp();
  try {
    const r = await t.request("POST", "/api/notes", { body: { text: "sneaky" } });
    assert.ok(r.status === 403 || r.status === 401, `got ${r.status}`);
    assert.equal((await t.request("GET", "/api/notes")).json.length, 0);
  } finally {
    await t.close();
  }
});
