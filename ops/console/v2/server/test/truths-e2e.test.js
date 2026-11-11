// TruthsStore against the REAL write-truths verb and a real (temporary) git
// repo: the payload the client builds and the contract the verb enforces are
// two halves of one design, so this is where they meet. Unit behaviour of each
// half lives in projects-truths.test.js and runner/test/write-truths.test.js.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeProject } from "../src/projects/registry.js";
import { StaleRevision, TruthsStore, auditTruths, parseAuditHead, parseAuditLines, sha256Hex, verifyTrailer } from "../src/projects/truths.js";
import { Wrapper } from "../src/wrapper.js";

const WRAPPER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "runner",
  "spawn-as-owner.sh",
);
const KEY = crypto.createHash("sha256").update("e2e test key").digest();
const NOW = Date.parse("2026-08-18T12:00:00.000Z");

function makeHq() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-truths-e2e-"));
  const hq = path.join(dir, "hq");
  fs.mkdirSync(hq, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", hq, ...args]).toString();
  git("init", "-q");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(hq, "README.md"), "e2e\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  return { dir, hq, git, head: () => git("rev-parse", "HEAD").trim() };
}

test("a client write lands through the real verb with a trailer verifyTrailer accepts", async () => {
  const env = makeHq();
  try {
    const cfg = {
      hqRoot: env.hq,
      rigsDir: path.join(env.hq, "rigs"),
      devNoAuth: true,
      wrapperPath: WRAPPER_PATH,
      wrapperSudo: false,
    };
    const project = normalizeProject(
      { id: "demo", name: "Demo", kind: "other", path: env.hq, hub: "01 Projects/demo/_index.md" },
      cfg,
    );
    const store = new TruthsStore({ cfg, wrapper: new Wrapper(cfg), key: KEY, now: () => NOW });

    const parentBefore = env.head();
    const doc = await store.write(project, {
      rev: 0,
      entries: [{ kind: "truth", text: "pushing main deploys to Vercel", confirmed: true, source: "xd-1" }],
    });
    assert.equal(doc.rev, 1);
    assert.equal(doc.entries.length, 1);
    assert.equal(doc.entries[0].added, new Date(NOW).toISOString());

    // the commit is exactly one path, and the trailer binds parent + bytes
    const show = env.git("show", "--stat", "--format=", "HEAD");
    assert.ok(show.includes("ops/projects/demo/truths.json"), show);
    assert.ok(!show.includes("README"), "nothing else may ride along");
    const message = env.git("log", "-1", "--format=%B");
    const bytes = fs.readFileSync(project.truthsPath);
    const verdict = verifyTrailer(message, {
      key: KEY,
      projectId: "demo",
      repoPath: project.truthsRepoPath,
      parentCommit: parentBefore,
      contentSha256: sha256Hex(bytes),
      previousRevision: 0,
    });
    assert.deepEqual(verdict, { ok: true, reason: null, revision: 1 });

    // the mirror follows
    const mirror = fs.readFileSync(path.join(env.hq, "outbox", "vault", project.truthsMirrorRel), "utf8");
    assert.match(mirror, /^# Truths: Demo/);
    assert.match(mirror, /pushing main deploys to Vercel/);

    // a stale second write is refused client-side before any process runs
    await assert.rejects(
      () => store.write(project, { rev: 0, entries: [] }),
      (e) => e instanceof StaleRevision && e.status === 409,
    );

    // and the next honest write advances on top of the verb's commit
    const doc2 = await store.write(project, { rev: 1, entries: doc.entries.concat([{ kind: "assumption", text: "the API stays v1" }]) });
    assert.equal(doc2.rev, 2);
    assert.equal(JSON.parse(fs.readFileSync(project.truthsPath, "utf8")).rev, 2);
    assert.match(env.git("log", "-1", "--format=%B"), /Hq-Truths-Rev: 2 [0-9a-f]{64}/);
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

test("a trailer written by the real verb fails verification under a different parent or bytes", async () => {
  const env = makeHq();
  try {
    const cfg = {
      hqRoot: env.hq,
      rigsDir: path.join(env.hq, "rigs"),
      devNoAuth: true,
      wrapperPath: WRAPPER_PATH,
      wrapperSudo: false,
    };
    const project = normalizeProject({ id: "demo", name: "Demo", kind: "other", path: env.hq }, cfg);
    const store = new TruthsStore({ cfg, wrapper: new Wrapper(cfg), key: KEY, now: () => NOW });
    const parent = env.head();
    await store.write(project, { rev: 0, entries: [{ kind: "truth", text: "t" }] });
    const message = env.git("log", "-1", "--format=%B");
    const bytes = fs.readFileSync(project.truthsPath);
    const base = { key: KEY, projectId: "demo", repoPath: project.truthsRepoPath, contentSha256: sha256Hex(bytes) };
    assert.equal(verifyTrailer(message, { ...base, parentCommit: "f".repeat(40) }).ok, false, "wrong parent");
    assert.equal(
      verifyTrailer(message, { ...base, parentCommit: parent, contentSha256: sha256Hex(Buffer.from("tampered")) }).ok,
      false,
      "tampered bytes",
    );
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

test("the audit verb + auditTruths: wrapper commits verify, an out-of-band edit is flagged", async () => {
  const env = makeHq();
  try {
    const cfg = {
      hqRoot: env.hq,
      rigsDir: path.join(env.hq, "rigs"),
      devNoAuth: true,
      wrapperPath: WRAPPER_PATH,
      wrapperSudo: false,
    };
    const project = normalizeProject({ id: "demo", name: "Demo", kind: "other", path: env.hq }, cfg);
    const wrapper = new Wrapper(cfg);
    const store = new TruthsStore({ cfg, wrapper, key: KEY, now: () => NOW });
    await store.write(project, { rev: 0, entries: [{ kind: "truth", text: "one" }] });
    await store.write(project, { rev: 1, entries: [{ kind: "truth", text: "one" }, { kind: "term", text: "two" }] });

    const audit = async () => {
      const r = await wrapper.call("truths-audit", ["50"], { timeout: 30000 });
      assert.equal(r.code, 0, r.stderr);
      return auditTruths(parseAuditLines(r.stdout), { key: KEY });
    };
    assert.deepEqual(await audit(), [], "two wrapper commits must verify cleanly");

    // an out-of-band edit: a worker (or a shell) commits the file directly
    const fpath = project.truthsPath;
    const doc = JSON.parse(fs.readFileSync(fpath, "utf8"));
    doc.entries.push({ id: "evil", kind: "truth", text: "planted", confirmed: true, added: null, source: null });
    doc.rev += 1;
    fs.writeFileSync(fpath, JSON.stringify(doc, null, 2) + "\n");
    env.git("add", "--", "ops/projects/demo/truths.json");
    env.git("commit", "-q", "-m", "totally normal commit");

    const violations = await audit();
    assert.equal(violations.length, 1, JSON.stringify(violations));
    assert.equal(violations[0].project, "demo");
    assert.match(violations[0].reason, /no Hq-Truths-Rev trailer/);

    // a copied trailer from the rev-2 commit fails too: the MAC binds parent and bytes
    const message = env.git("log", "--format=%B", "-3").split("\n").find((l) => l.startsWith("Hq-Truths-Rev:"));
    doc.rev += 1;
    fs.writeFileSync(fpath, JSON.stringify(doc, null, 2) + "\n");
    env.git("add", "--", "ops/projects/demo/truths.json");
    env.git("commit", "-q", "-m", `stolen\n\n${message}`);
    const again = await audit();
    assert.equal(again.length, 2, JSON.stringify(again));
    assert.match(again[0].reason + again[1].reason, /does not verify/);
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

test("the audit cursor: head is reported, and since-sha limits the range without losing violations", async () => {
  const env = makeHq();
  try {
    const cfg = {
      hqRoot: env.hq,
      rigsDir: path.join(env.hq, "rigs"),
      devNoAuth: true,
      wrapperPath: WRAPPER_PATH,
      wrapperSudo: false,
    };
    const project = normalizeProject({ id: "demo", name: "Demo", kind: "other", path: env.hq }, cfg);
    const wrapper = new Wrapper(cfg);
    const store = new TruthsStore({ cfg, wrapper, key: KEY, now: () => NOW });
    await store.write(project, { rev: 0, entries: [{ kind: "truth", text: "one" }] });
    const afterFirst = env.head();
    await store.write(project, { rev: 1, entries: [{ kind: "truth", text: "one" }, { kind: "term", text: "two" }] });

    const full = await wrapper.call("truths-audit", ["500"], { timeout: 30000 });
    assert.equal(full.code, 0, full.stderr);
    assert.deepEqual(parseAuditHead(full.stdout), { head: env.head(), truncated: false }, "the head line names the scanned HEAD");
    assert.equal(parseAuditLines(full.stdout).length, 2);

    const ranged = await wrapper.call("truths-audit", ["500", afterFirst], { timeout: 30000 });
    assert.equal(ranged.code, 0, ranged.stderr);
    assert.equal(parseAuditLines(ranged.stdout).length, 1, "since-sha excludes the already-audited commit");

    const badCursor = await wrapper.call("truths-audit", ["500", "deadbeefdeadbeef"], { timeout: 30000 });
    assert.equal(badCursor.code, 0);
    assert.equal(parseAuditLines(badCursor.stdout).length, 2, "an unresolvable cursor falls back to a full scan");

    // a filled window flags itself so the console holds the cursor
    const tight = await wrapper.call("truths-audit", ["1"], { timeout: 30000 });
    assert.equal(tight.code, 0);
    assert.equal(parseAuditHead(tight.stdout).truncated, true, "a filled window must announce truncation");
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});
