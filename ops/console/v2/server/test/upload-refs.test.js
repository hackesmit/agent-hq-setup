// Upload references (COMPILATION-v2 item 10).
//
// The value of a reference over a path is that turning one back into a path is a gate
// somebody has to pass, so most of this file is about the ways that gate must refuse.
// The containment case in particular is not defending against today's code, which builds
// paths carefully; it is defending against a store row that has been corrupted, restored
// from elsewhere, or hand-edited, at which point the recorded path is attacker-shaped
// input and nothing else stands between it and a read.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REF_SCHEME, parseRef, refFor, renderManifest, resolve } from "../src/upload/refs.js";
import { UploadState } from "../src/upload/store.js";
import { tmpDir } from "./helpers.js";

const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** An inbox with one real committed file in it. */
function inbox(overrides = {}) {
  const dir = tmpDir();
  const filesDir = path.join(dir, "files");
  fs.mkdirSync(filesDir, { recursive: true });
  const filePath = path.join(filesDir, "note.txt");
  fs.writeFileSync(filePath, "hello");
  const row = {
    id: ID,
    name: "note.txt",
    path: filePath,
    size: 5,
    sha256: "abc",
    state: UploadState.committed,
    expiresAt: null,
    ...overrides,
  };
  return { dir, filesDir, filePath, row, store: { get: (id) => (id === row.id ? row : null) } };
}

test("a reference round-trips, and nothing else parses as one", () => {
  assert.equal(refFor(ID), `${REF_SCHEME}${ID}`);
  assert.equal(parseRef(refFor(ID)), ID);
  for (const bad of [
    null,
    undefined,
    42,
    "",
    ID,
    "hqconsole://upload/",
    "hqconsole://upload/not-a-uuid",
    "hqconsole://upload/../../etc/passwd",
    `hqconsole://uploads/${ID}`,
    `file://${ID}`,
    `${REF_SCHEME}${ID}/extra`,
    `${REF_SCHEME}${ID.toUpperCase()}`,
  ]) {
    assert.equal(parseRef(/** @type {any} */ (bad)), null, `${JSON.stringify(bad)} should not parse`);
  }
});

test("a committed, present, unexpired upload resolves to its real path", () => {
  const h = inbox();
  const out = resolve(refFor(ID), h);
  assert.equal(out.ok, true);
  assert.equal(out.id, ID);
  assert.equal(out.path, fs.realpathSync(h.filePath));
});

test("every reason to refuse is distinguishable, because the caller has to say why", () => {
  assert.match(resolve("nonsense", inbox()).reason, /not an upload reference/);

  const missing = inbox();
  missing.store = { get: () => null };
  assert.match(resolve(refFor(ID), missing).reason, /no such upload/);

  for (const state of [UploadState.inProgress, UploadState.failed, UploadState.deleted]) {
    const h = inbox({ state });
    const out = resolve(refFor(ID), h);
    assert.equal(out.ok, false);
    assert.match(out.reason, /not committed/);
  }

  const expired = inbox({ expiresAt: new Date(1000).toISOString() });
  assert.match(resolve(refFor(ID), expired, {}).reason, /expired/);
  // Still good just before the boundary.
  const live = inbox({ expiresAt: new Date(10_000).toISOString() });
  assert.equal(resolve(refFor(ID), { ...live, now: () => 9_999 }).ok, true);

  const gone = inbox();
  fs.unlinkSync(gone.filePath);
  assert.match(resolve(refFor(ID), gone).reason, /its file is gone/);
});

test("a row pointing outside the inbox is refused, however it got there", () => {
  // The row is the untrusted input in this test, not the reference.
  const outside = tmpDir();
  const target = path.join(outside, "secret.txt");
  fs.writeFileSync(target, "not yours");

  const direct = inbox({ path: target });
  const out = resolve(refFor(ID), direct);
  assert.equal(out.ok, false);
  assert.match(out.reason, /outside the inbox/);

  // And through a symlink planted inside the inbox, which is the version that would
  // survive a naive string prefix check.
  const h = inbox();
  const link = path.join(h.filesDir, "link.txt");
  fs.symlinkSync(target, link);
  const viaLink = { ...h, row: { ...h.row, path: link } };
  viaLink.store = { get: () => viaLink.row };
  const linked = resolve(refFor(ID), viaLink);
  assert.equal(linked.ok, false);
  assert.match(linked.reason, /outside the inbox/);
});

test("a sibling directory whose name merely starts with the inbox name is not inside it", () => {
  // The exact reason containment uses path.relative rather than startsWith.
  const h = inbox();
  const sibling = `${h.filesDir}-elsewhere`;
  fs.mkdirSync(sibling, { recursive: true });
  const trap = path.join(sibling, "x.txt");
  fs.writeFileSync(trap, "nope");
  const spoofed = { ...h, row: { ...h.row, path: trap } };
  spoofed.store = { get: () => spoofed.row };
  const out = resolve(refFor(ID), spoofed);
  assert.equal(out.ok, false);
  assert.match(out.reason, /outside the inbox/);
});

test("the manifest states provenance without issuing an instruction", () => {
  const text = renderManifest([
    { ref: refFor(ID), name: "invoice.pdf", ok: true, path: "/inbox/files/invoice.pdf", size: 12, sha256: "ff" },
  ]);
  assert.match(text, /invoice\.pdf/);
  assert.match(text, /\/inbox\/files\/invoice\.pdf/);
  assert.match(text, new RegExp(ID));
  // Factual framing. An imperative reads as an out-of-band directive, which is the shape
  // that trips a model's own injection defences and gets the block treated as suspicious
  // rather than used.
  assert.match(text, /written by whoever sent them/);
  assert.doesNotMatch(text, /\b(do not|never|you must|ignore)\b/i);
});

test("an unavailable file is listed with its reason and no path at all", () => {
  const text = renderManifest([
    { ref: refFor(ID), name: "gone.pdf", ok: false, reason: "upload has expired" },
  ]);
  assert.match(text, /gone\.pdf: unavailable \(upload has expired\)/);
  assert.doesNotMatch(text, /path:/);
  assert.equal(renderManifest([]), "", "nothing to say means nothing is said");
  assert.equal(renderManifest(null), "");
});
