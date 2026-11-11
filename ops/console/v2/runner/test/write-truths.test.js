// The write-truths verb, exercised through the real spawn-as-owner.sh against
// a real (temporary) git repo. This is the only path that lands truths bytes in
// the repo as owner, so every refusal and every exit code of the contract in
// server/src/projects/truths.js (wrapperError) is asserted here.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WRAPPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "spawn-as-owner.sh");

function gitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
}

function makeHq() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-truths-verb-"));
  const hq = path.join(dir, "hq");
  fs.mkdirSync(hq, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", hq, ...args], { env: gitEnv() }).toString();
  git("init", "-q");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(hq, "README.md"), "test repo\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
  return { dir, hq, git, head: () => git("rev-parse", "HEAD").trim() };
}

function run(args, input, hq) {
  return new Promise((resolve) => {
    const child = execFile(
      "bash",
      [WRAPPER, ...args],
      { timeout: 15000, env: { ...gitEnv(), HQ_ROOT: hq } },
      (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input == null ? "" : input);
  });
}

function docBytes(project, rev) {
  const doc = {
    entries: [{ added: "2026-08-18T12:00:00.000Z", confirmed: false, id: "e1", kind: "truth", source: null, text: `truth at rev ${rev}` }],
    project,
    rev,
    updatedAt: "2026-08-18T12:00:00.000Z",
  };
  return Buffer.from(JSON.stringify(doc, null, 2) + "\n", "utf8");
}

function payload(project, rev, parent, over = {}) {
  const bytes = over.bytes || docBytes(project, rev);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  return JSON.stringify({
    project,
    rev,
    parent,
    sha256: over.sha256 || sha,
    trailer: over.trailer || `Hq-Truths-Rev: ${rev} ${"a".repeat(64)}`,
    truths_b64: bytes.toString("base64"),
    markdown_b64: Buffer.from(`# Truths: ${project}\n`, "utf8").toString("base64"),
    markdown_path: over.markdown_path === undefined ? `01 Projects/${project}/Truths.md` : over.markdown_path,
    ...(over.extra || {}),
  });
}

test("write-truths refuses malformed argv at the bash gate", async () => {
  const env = makeHq();
  try {
    for (const args of [
      ["write-truths", "../x", "1", "a".repeat(40)],
      ["write-truths", "p;x", "1", "a".repeat(40)],
      ["write-truths", "proj", "0", "a".repeat(40)],
      ["write-truths", "proj", "one", "a".repeat(40)],
      ["write-truths", "proj", "1", "not-hex"],
      ["write-truths", "-flag", "1", "a".repeat(40)],
    ]) {
      const r = await run(args, "{}", env.hq);
      assert.equal(r.code, 2, `${args.join(" ")} should die at the gate, got ${r.code}: ${r.stderr}`);
    }
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

test("happy path: rev 1 lands atomically, commits one path with the trailer, writes the mirror", async () => {
  const env = makeHq();
  try {
    const parent = env.head();
    const r = await run(["write-truths", "demo", "1", parent], payload("demo", 1, parent), env.hq);
    assert.equal(r.code, 0, r.stderr);
    const fpath = path.join(env.hq, "ops", "projects", "demo", "truths.json");
    assert.equal(JSON.parse(fs.readFileSync(fpath, "utf8")).rev, 1);
    assert.ok(!fs.existsSync(fpath + ".tmp"), "no temp file survives");
    const msg = env.git("log", "-1", "--format=%B");
    assert.match(msg, /^console: truths demo rev 1/);
    assert.match(msg, new RegExp(`Hq-Truths-Rev: 1 a{64}`));
    const show = env.git("show", "--stat", "--format=", "HEAD");
    assert.ok(show.includes("ops/projects/demo/truths.json"), show);
    assert.ok(!show.includes("README"), "only the truths path is in the commit");
    const mirror = path.join(env.hq, "outbox", "vault", "01 Projects", "demo", "Truths.md");
    assert.equal(fs.readFileSync(mirror, "utf8"), "# Truths: demo\n");
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

test("rev 2 advances; replaying rev 1 afterwards is exit 3 stale", async () => {
  const env = makeHq();
  try {
    let parent = env.head();
    assert.equal((await run(["write-truths", "demo", "1", parent], payload("demo", 1, parent), env.hq)).code, 0);
    parent = env.head();
    const two = await run(["write-truths", "demo", "2", parent], payload("demo", 2, parent), env.hq);
    assert.equal(two.code, 0, two.stderr);
    const replay = await run(["write-truths", "demo", "1", env.head()], payload("demo", 1, env.head()), env.hq);
    assert.equal(replay.code, 3, `stale must be exit 3, got ${replay.code}: ${replay.stderr}`);
    // a skipped revision is stale too: disk is at 2, a write at 4 must not land
    const skip = await run(["write-truths", "demo", "4", env.head()], payload("demo", 4, env.head()), env.hq);
    assert.equal(skip.code, 3);
    assert.equal(JSON.parse(fs.readFileSync(path.join(env.hq, "ops", "projects", "demo", "truths.json"), "utf8")).rev, 2);
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

test("a parent that is not HEAD is exit 4 and leaves the tree untouched", async () => {
  const env = makeHq();
  try {
    const stale = env.head();
    fs.writeFileSync(path.join(env.hq, "README.md"), "moved\n");
    env.git("add", "README.md");
    env.git("commit", "-q", "-m", "move HEAD");
    const r = await run(["write-truths", "demo", "1", stale], payload("demo", 1, stale), env.hq);
    assert.equal(r.code, 4, r.stderr);
    assert.ok(!fs.existsSync(path.join(env.hq, "ops", "projects", "demo", "truths.json")));
    assert.ok(!fs.existsSync(path.join(env.hq, "ops")), "a refused first write creates no directories at all");
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

test("payload refusals are exit 5 and nothing lands", async () => {
  const env = makeHq();
  try {
    const parent = env.head();
    const cases = [
      ["argv/payload project mismatch", payload("other", 1, parent)],
      ["argv/payload rev mismatch", payload("demo", 2, parent)],
      ["argv/payload parent mismatch", payload("demo", 1, "b".repeat(40))],
      ["sha mismatch", payload("demo", 1, parent, { sha256: "0".repeat(64) })],
      ["bad trailer", payload("demo", 1, parent, { trailer: "Hq-Truths-Rev: 1 nothex" })],
      ["trailer rev mismatch", payload("demo", 1, parent, { trailer: `Hq-Truths-Rev: 9 ${"a".repeat(64)}` })],
      ["doc rev mismatch", payload("demo", 1, parent, { bytes: docBytes("demo", 7) })],
      ["doc project mismatch", payload("demo", 1, parent, { bytes: docBytes("other", 1) })],
      ["not json at all", "this is not json"],
    ];
    for (const [name, body] of cases) {
      const r = await run(["write-truths", "demo", "1", parent], body, env.hq);
      assert.equal(r.code, 5, `${name} must be exit 5, got ${r.code}: ${r.stderr}`);
    }
    assert.ok(!fs.existsSync(path.join(env.hq, "ops", "projects", "demo", "truths.json")));
    assert.equal(env.head(), parent, "no commit may land for a refused payload");
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

test("hooks neither block nor ride along: the commit is built with plumbing", async () => {
  const env = makeHq();
  try {
    const hook = path.join(env.hq, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\ntouch \"$PWD/hook-ran\"\nexit 1\n", { mode: 0o755 });
    const parent = env.head();
    const r = await run(["write-truths", "demo", "1", parent], payload("demo", 1, parent), env.hq);
    assert.equal(r.code, 0, `a hostile pre-commit hook must not block the verb, got ${r.code}: ${r.stderr}`);
    assert.ok(!fs.existsSync(path.join(env.hq, "hook-ran")), "the hook must not even run");
    assert.match(env.git("log", "-1", "--format=%B"), /Hq-Truths-Rev: 1/);
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

test("a mirror path that escapes the outbox is refused without failing the write", async () => {
  const env = makeHq();
  try {
    const outside = path.join(env.dir, "outside.md");
    const parent = env.head();
    const r = await run(
      ["write-truths", "demo", "1", parent],
      payload("demo", 1, parent, { markdown_path: "../../../outside.md" }),
      env.hq,
    );
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /mirror not written/);
    assert.ok(!fs.existsSync(outside), "nothing may land outside outbox/vault");
    assert.ok(fs.existsSync(path.join(env.hq, "ops", "projects", "demo", "truths.json")));
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

// ---------- lucy review 2026-08-19 ----------

test("lucy: a symlinked project directory is refused, nothing lands outside the repo", async () => {
  const env = makeHq();
  try {
    const outside = path.join(env.dir, "elsewhere");
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(path.join(env.hq, "ops", "projects"), { recursive: true });
    fs.symlinkSync(outside, path.join(env.hq, "ops", "projects", "demo"));
    const parent = env.head();
    const r = await run(["write-truths", "demo", "1", parent], payload("demo", 1, parent), env.hq);
    assert.equal(r.code, 5, `a symlinked dir must be refused, got ${r.code}: ${r.stderr}`);
    assert.match(r.stderr, /not a plain directory/);
    assert.deepEqual(fs.readdirSync(outside), [], "nothing may land through the symlink");
    assert.equal(env.head(), parent);
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

test("lucy 2: a symlinked ops/ with a missing tail creates nothing outside the repo", async () => {
  const env = makeHq();
  try {
    const outside = path.join(env.dir, "elsewhere");
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(env.hq, "ops"));
    const parent = env.head();
    const r = await run(["write-truths", "demo", "1", parent], payload("demo", 1, parent), env.hq);
    assert.equal(r.code, 5, `a symlinked ops/ must be refused, got ${r.code}: ${r.stderr}`);
    assert.deepEqual(fs.readdirSync(outside), [], "no directory may be created through the symlink");
    assert.equal(env.head(), parent);
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

test("lucy 2: duplicate entry ids and malformed field types are refused", async () => {
  const env = makeHq();
  try {
    const parent = env.head();
    const entry = { id: "e1", kind: "truth", text: "x", confirmed: false, added: null, source: null };
    const bad = [
      [{ ...entry }, { ...entry, kind: "assumption" }], // duplicate id
      [{ ...entry, confirmed: "yes" }],
      [{ ...entry, added: 123 }],
      [{ ...entry, source: "s".repeat(201) }],
      [{ ...entry, extraField: "smuggled" }],
    ];
    for (const entries of bad) {
      const bytes = Buffer.from(JSON.stringify({ project: "demo", rev: 1, updatedAt: null, entries }) + "\n");
      const r = await run(["write-truths", "demo", "1", parent], payload("demo", 1, parent, { bytes }), env.hq);
      assert.equal(r.code, 5, `${JSON.stringify(entries).slice(0, 70)} must be exit 5, got ${r.code}: ${r.stderr}`);
    }
    assert.equal(env.head(), parent);
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

test("lucy: garbage entries are refused even when the hash and rev are honest", async () => {
  const env = makeHq();
  try {
    const parent = env.head();
    const bad = [
      { entries: "not-an-array" },
      { entries: [{ id: "e1", kind: "opinion", text: "x" }] },
      { entries: [{ id: "e1", kind: "truth", text: "" }] },
      { entries: [{ id: "e1", kind: "truth", text: "x".repeat(2001) }] },
      { entries: [{ id: "../up", kind: "truth", text: "x" }] },
      { entries: [null] },
    ];
    for (const body of bad) {
      const bytes = Buffer.from(JSON.stringify({ project: "demo", rev: 1, updatedAt: null, ...body }) + "\n");
      const r = await run(["write-truths", "demo", "1", parent], payload("demo", 1, parent, { bytes }), env.hq);
      assert.equal(r.code, 5, `${JSON.stringify(body).slice(0, 60)} must be exit 5, got ${r.code}: ${r.stderr}`);
    }
    assert.equal(env.head(), parent);
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

test("lucy: two concurrent same-rev writes: exactly one commits, the loser is stale, the tree is clean", async () => {
  const env = makeHq();
  try {
    const parent = env.head();
    const a = run(["write-truths", "demo", "1", parent], payload("demo", 1, parent), env.hq);
    const b = run(["write-truths", "demo", "1", parent], payload("demo", 1, parent), env.hq);
    const [ra, rb] = await Promise.all([a, b]);
    const codes = [ra.code, rb.code].sort();
    assert.deepEqual(codes, [0, 3], `expected one commit and one stale, got ${codes} (${ra.stderr} | ${rb.stderr})`);
    const fpath = path.join(env.hq, "ops", "projects", "demo", "truths.json");
    assert.equal(JSON.parse(fs.readFileSync(fpath, "utf8")).rev, 1);
    const status = env.git("status", "--porcelain", "--", "ops", "README.md");
    assert.equal(status.trim(), "", `the tree must be clean after the duel, got: ${status}`);
    assert.equal(env.git("log", "--format=%s", "-5").trim().split("\n").filter((s) => s.startsWith("console: truths")).length, 1);
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

test("lucy: the update-ref CAS refuses when the branch cannot move, leaving no trace", async () => {
  // The compare-and-swap is what binds a successful write to the MAC-bound
  // parent. A held ref lock stands in for any interleaved committer: the swap
  // cannot happen, so the verb must exit 4 with the worktree untouched.
  const env = makeHq();
  try {
    let parent = env.head();
    assert.equal((await run(["write-truths", "demo", "1", parent], payload("demo", 1, parent), env.hq)).code, 0);
    const before = fs.readFileSync(path.join(env.hq, "ops", "projects", "demo", "truths.json"));
    parent = env.head();
    const ref = env.git("symbolic-ref", "HEAD").trim(); // refs/heads/<branch>
    const lockPath = path.join(env.hq, ".git", ...ref.split("/")) + ".lock";
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "");
    const r = await run(["write-truths", "demo", "2", parent], payload("demo", 2, parent), env.hq);
    assert.equal(r.code, 4, `a blocked CAS is exit 4, got ${r.code}: ${r.stderr}`);
    assert.match(r.stderr, /repo moved during the write/);
    const after = fs.readFileSync(path.join(env.hq, "ops", "projects", "demo", "truths.json"));
    assert.deepEqual(after, before, "the worktree keeps the rev 1 bytes");
    fs.rmSync(lockPath);
    assert.ok(!env.git("log", "--format=%s", "-3").includes("truths demo rev 2"), "rev 2 never landed");
    // and the same write goes through once the ref is free again
    assert.equal((await run(["write-truths", "demo", "2", parent], payload("demo", 2, parent), env.hq)).code, 0);
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});
