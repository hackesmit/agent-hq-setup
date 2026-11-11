import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeProject } from "../src/projects/registry.js";
import {
  assumptionCards,
  StaleRevision,
  TRAILER_KEY,
  TruthsError,
  TruthsStore,
  canonicalBytes,
  emptyDoc,
  loadTruthsKey,
  normalizeEntries,
  parseDoc,
  parseTrailer,
  renderTruthsMarkdown,
  sha256Hex,
  trailerLine,
  trailerMac,
  verifyTrailer,
} from "../src/projects/truths.js";

const CFG = { hqRoot: "/home/owner/hq", rigsDir: "/home/owner/hq/rigs", devNoAuth: true };
const KEY = crypto.createHash("sha256").update("test key").digest();
const NOW = Date.parse("2026-08-18T12:00:00.000Z");
const PROJECT = normalizeProject(
  {
    id: "acme-dashboard",
    name: "Orbit Acme dashboard",
    kind: "rig",
    path: "/home/owner/hq/rigs/acme-dashboard",
    hub: "01 Projects/acme-dashboard/_index.md",
  },
  CFG,
);

const entry = (over = {}) => ({ id: "e1", kind: "truth", text: "Vercel prod deploys on a push to main", confirmed: true, source: "xd-207", ...over });

function fakeWrapper(handler) {
  const calls = [];
  return {
    calls,
    argv: (verb, args = []) => ({ cmd: "bash", args: ["/opt/spawn-as-owner.sh", verb, ...args] }),
    async call(verb, args = [], opts = {}) {
      calls.push({ verb, args, opts });
      const r = (await handler(verb, args)) || {};
      return { code: r.code == null ? 0 : r.code, stdout: r.stdout || "", stderr: r.stderr || "" };
    },
  };
}

/**
 * A stand-in for the `write-truths` wrapper verb: it does exactly what the verb
 * spec says the wrapper does, into an in-memory filesystem.
 */
function fakeVerb(disk, over = {}) {
  const seen = [];
  const exec = async (cmd, args, input) => {
    seen.push({ cmd, args, input });
    if (over.code) return { code: over.code, stdout: "", stderr: over.stderr || "" };
    const payload = JSON.parse(input);
    const bytes = Buffer.from(payload.truths_b64, "base64");
    if (sha256Hex(bytes) !== payload.sha256) return { code: 5, stderr: "sha mismatch" };
    const doc = JSON.parse(bytes.toString("utf8"));
    if (doc.rev !== payload.rev) return { code: 5, stderr: "rev in payload does not match the file" };
    const onDisk = disk.get(PROJECT.truthsPath);
    const currentRev = onDisk ? JSON.parse(onDisk).rev : 0;
    if (currentRev !== payload.rev - 1) return { code: 3, stderr: "stale revision" };
    disk.set(PROJECT.truthsPath, bytes.toString("utf8"));
    disk.set(payload.markdown_path, Buffer.from(payload.markdown_b64, "base64").toString("utf8"));
    disk.set("__commit__", `console v2 truths: ${payload.project} rev ${payload.rev}\n\n${payload.trailer}\n`);
    return { code: 0, stdout: "" };
  };
  return { exec, seen };
}

function store(disk, over = {}) {
  const wrapper =
    over.wrapper || fakeWrapper((verb) => (verb === "git-log" ? { stdout: "deadbeefcafe0123\t1755500000\tD\tsubject\n" } : { code: 2 }));
  const fake = fakeVerb(disk, over);
  const s = new TruthsStore({
    cfg: CFG,
    wrapper,
    key: KEY,
    now: () => NOW,
    readFile: (f) => {
      if (!disk.has(f)) {
        const e = new Error("ENOENT");
        e.code = "ENOENT";
        throw e;
      }
      return disk.get(f);
    },
    exec: over.exec || fake.exec,
  });
  return { s, wrapper, fake };
}

test("canonical bytes are a function of the value, not of key order", () => {
  const a = canonicalBytes({ project: "p", rev: 1, updatedAt: null, entries: [entry()] });
  const b = canonicalBytes({
    entries: [{ source: "xd-207", confirmed: true, text: entry().text, kind: "truth", id: "e1" }],
    updatedAt: null,
    rev: 1,
    project: "p",
  });
  assert.equal(a.toString(), b.toString());
  assert.equal(a[a.length - 1], 0x0a, "the file ends in a newline");
  assert.match(a.toString(), /\n {2}"rev": 1/, "and is indented for a readable diff");
});

test("the MAC binds every field, so a copied trailer fails", () => {
  const bytes = canonicalBytes({ project: "acme-dashboard", rev: 4, updatedAt: null, entries: [] });
  const base = {
    projectId: "acme-dashboard",
    repoPath: "ops/projects/acme-dashboard/truths.json",
    revision: 4,
    parentCommit: "aaaa1111",
    contentSha256: sha256Hex(bytes),
  };
  const msg = `truths\n\n${trailerLine(KEY, base)}\n`;
  assert.deepEqual(verifyTrailer(msg, { key: KEY, ...base }), { ok: true, reason: null, revision: 4 });

  // the same trailer replayed onto a different parent commit
  assert.equal(verifyTrailer(msg, { key: KEY, ...base, parentCommit: "bbbb2222" }).ok, false);
  // onto different file bytes
  assert.equal(verifyTrailer(msg, { key: KEY, ...base, contentSha256: sha256Hex(Buffer.from("other")) }).ok, false);
  // onto another project's file
  assert.equal(verifyTrailer(msg, { key: KEY, ...base, projectId: "chesski" }).ok, false);
  // under a different key (a worker cannot read the console's key)
  assert.equal(verifyTrailer(msg, { key: crypto.randomBytes(32), ...base }).ok, false);
});

test("a commit with no trailer, or a revision that did not advance, is an out-of-band edit", () => {
  const base = { projectId: "p", repoPath: "ops/projects/p/truths.json", revision: 3, parentCommit: "aaa", contentSha256: "bbb" };
  const worker = verifyTrailer("worker edits truths by hand", { key: KEY, ...base });
  assert.equal(worker.ok, false);
  assert.match(worker.reason, /no Hq-Truths-Rev trailer/);

  const msg = `x\n\n${trailerLine(KEY, base)}`;
  const replay = verifyTrailer(msg, { key: KEY, ...base, previousRevision: 3 });
  assert.equal(replay.ok, false);
  assert.match(replay.reason, /did not advance/);
  assert.equal(verifyTrailer(msg, { key: KEY, ...base, previousRevision: 2 }).ok, true);
});

test("the trailer parser takes the last well formed line and ignores noise", () => {
  assert.equal(parseTrailer("nothing here"), null);
  assert.equal(parseTrailer(`${TRAILER_KEY}: 2 short`), null);
  const mac = "a".repeat(64);
  assert.deepEqual(parseTrailer(`s\n\n${TRAILER_KEY}: 1 ${"b".repeat(64)}\n${TRAILER_KEY}: 2 ${mac}\n`), { revision: 2, mac });
});

test("the MAC message separates its fields so a project id cannot swallow the path", () => {
  const a = trailerMac(KEY, { projectId: "a", repoPath: "b", revision: 1, parentCommit: "c", contentSha256: "d" });
  const b = trailerMac(KEY, { projectId: "a\nb", repoPath: "", revision: 1, parentCommit: "c", contentSha256: "d" });
  assert.notEqual(a, b);
});

test("entries are validated, ids are minted, and `added` is set by the server", () => {
  const out = normalizeEntries([{ kind: "assumption", text: "  Supabase RLS is on  " }], { now: "2026-08-18T12:00:00.000Z" });
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "Supabase RLS is on");
  assert.equal(out[0].confirmed, false);
  assert.equal(out[0].added, "2026-08-18T12:00:00.000Z");
  assert.match(out[0].id, /^[0-9a-f]{12}$/);
  assert.equal(out[0].source, null);

  const kept = normalizeEntries([{ id: "e1", kind: "truth", text: "t", added: "1999-01-01T00:00:00.000Z" }], {
    now: "2026-08-18T12:00:00.000Z",
    existing: [{ id: "e1", kind: "truth", text: "t", confirmed: false, added: "2026-01-01T00:00:00.000Z", source: null }],
  });
  assert.equal(kept[0].added, "2026-01-01T00:00:00.000Z", "a client cannot backdate an existing entry");

  assert.throws(() => normalizeEntries("nope", { now: "x" }), /must be an array/);
  assert.throws(() => normalizeEntries([{ kind: "opinion", text: "t" }], { now: "x" }), /term\|truth\|assumption\|constraint/);
  assert.throws(() => normalizeEntries([{ kind: "truth", text: "   " }], { now: "x" }), /must not be empty/);
  assert.throws(() => normalizeEntries([{ kind: "truth", text: "x", id: "../etc" }], { now: "x" }), /not a safe slug/);
  assert.throws(
    () => normalizeEntries([{ kind: "truth", text: "a", id: "d" }, { kind: "truth", text: "b", id: "d" }], { now: "x" }),
    /duplicate entry id/,
  );
  assert.throws(() => normalizeEntries([{ kind: "truth", text: "x".repeat(2001) }], { now: "x" }), /longer than 2000/);
  assert.throws(() => normalizeEntries(new Array(501).fill({ kind: "truth", text: "t" }), { now: "x" }), /too many entries/);
});

test("an absent or unreadable file reads as rev 0 rather than an error", () => {
  const disk = new Map();
  const { s } = store(disk);
  assert.deepEqual(s.read(PROJECT), emptyDoc("acme-dashboard"));
  assert.deepEqual(parseDoc("p", null), emptyDoc("p"));
  assert.throws(() => parseDoc("p", "{ broken"), TruthsError);
});

test("a write lands the canonical bytes, the mirror and a verifying trailer", async () => {
  const disk = new Map();
  const { s, wrapper, fake } = store(disk);
  const doc = await s.write(PROJECT, {
    rev: 0,
    entries: [entry(), entry({ id: "e2", kind: "assumption", text: "Charts are Chart.js from a CDN", confirmed: false, source: null })],
  });

  assert.equal(doc.rev, 1);
  assert.equal(doc.updatedAt, "2026-08-18T12:00:00.000Z");
  assert.equal(doc.entries.length, 2);

  const [call] = fake.seen;
  assert.deepEqual(call.args, ["/opt/spawn-as-owner.sh", "write-truths", "acme-dashboard", "1", "deadbeefcafe0123"]);
  const payload = JSON.parse(call.input);
  assert.equal(payload.markdown_path, "01 Projects/acme-dashboard/Truths.md");
  assert.equal(payload.parent, "deadbeefcafe0123");

  // the trailer the wrapper committed verifies against exactly what landed
  const bytes = Buffer.from(disk.get(PROJECT.truthsPath), "utf8");
  const v = verifyTrailer(disk.get("__commit__"), {
    key: KEY,
    projectId: "acme-dashboard",
    repoPath: "ops/projects/acme-dashboard/truths.json",
    parentCommit: "deadbeefcafe0123",
    contentSha256: sha256Hex(bytes),
    previousRevision: 0,
  });
  assert.deepEqual(v, { ok: true, reason: null, revision: 1 });

  const md = disk.get("01 Projects/acme-dashboard/Truths.md");
  assert.match(md, /# Truths: Orbit Acme dashboard/);
  assert.match(md, /Vercel prod deploys on a push to main \(confirmed, source: xd-207/);
  assert.match(md, /Charts are Chart\.js from a CDN \(unconfirmed/);
  assert.match(md, /single writer/);
  assert.equal(wrapper.calls.filter((c) => c.verb === "git-log").length, 1, "HEAD is read once per write");
});

test("a stale revision is refused as 409 before anything is spawned", async () => {
  const disk = new Map();
  const { s, fake } = store(disk);
  await s.write(PROJECT, { rev: 0, entries: [entry()] });
  assert.equal(s.read(PROJECT).rev, 1);
  await assert.rejects(
    () => s.write(PROJECT, { rev: 0, entries: [entry({ text: "a racing edit" })] }),
    (e) => {
      assert.ok(e instanceof StaleRevision);
      assert.equal(e.status, 409);
      assert.equal(e.expected, 1);
      assert.equal(e.got, 0);
      return true;
    },
  );
  assert.equal(fake.seen.length, 1, "the losing write never reached the wrapper");
  assert.equal(s.read(PROJECT).rev, 1, "and never changed the file");
});

test("revisions advance one at a time under concurrent writes", async () => {
  const disk = new Map();
  const { s } = store(disk);
  await s.write(PROJECT, { rev: 0, entries: [entry()] });
  const results = await Promise.allSettled([
    s.write(PROJECT, { rev: 1, entries: [entry({ text: "first" })] }),
    s.write(PROJECT, { rev: 1, entries: [entry({ text: "second" })] }),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const bad = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1, "exactly one of two writers at the same rev wins");
  assert.equal(bad.length, 1);
  assert.ok(bad[0].reason instanceof StaleRevision);
  assert.equal(s.read(PROJECT).rev, 2);
});

test("rev must be an integer and the entries must be present", async () => {
  const { s } = store(new Map());
  await assert.rejects(() => s.write(PROJECT, { rev: "one", entries: [] }), /rev must be a non-negative integer/);
  await assert.rejects(() => s.write(PROJECT, { rev: -1, entries: [] }), /rev must be a non-negative integer/);
  await assert.rejects(() => s.write(PROJECT, { rev: 0 }), /entries must be an array/);
});

test("the verb's exit codes map onto statuses the UI can act on", async () => {
  for (const [code, status] of [
    [3, 409],
    [4, 409],
    [5, 500],
    [2, 502],
  ]) {
    const { s } = store(new Map(), { code, stderr: "refused" });
    await assert.rejects(
      () => s.write(PROJECT, { rev: 0, entries: [entry()] }),
      (e) => {
        assert.equal(e.status, status, `exit ${code} should be ${status}`);
        return true;
      },
    );
  }
});

test("a HEAD that cannot be read stops the write instead of committing an unbound MAC", async () => {
  const wrapper = fakeWrapper(() => ({ code: 1, stderr: "not a repo" }));
  const { s, fake } = store(new Map(), { wrapper });
  await assert.rejects(() => s.write(PROJECT, { rev: 0, entries: [entry()] }), /cannot read HEAD/);
  assert.equal(fake.seen.length, 0);
});

test("an empty document still renders a usable mirror in ASCII", () => {
  const md = renderTruthsMarkdown(emptyDoc("chesski"));
  assert.match(md, /# Truths: chesski/);
  assert.match(md, /No entries yet\./);
  // U+2013 en dash, U+2014 em dash, U+2022 bullet: none of them belong in a vault note
  const decorations = new RegExp("[\\u2013\\u2014\\u2022]");
  assert.equal(decorations.test(md), false, "ASCII punctuation only");
});

test("the key is generated at 0600 on first use and read back afterwards", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hqconsole-truthskey-"));
  const file = path.join(dir, "meta", "truths.key");
  try {
    const first = loadTruthsKey({ env: { CONSOLE_TRUTHS_KEY: file } });
    assert.equal(first.length, 32);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "the key must not be group or world readable");
    const second = loadTruthsKey({ env: { CONSOLE_TRUTHS_KEY: file } });
    assert.equal(second.toString("hex"), first.toString("hex"), "the key is stable across restarts");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unwritable key path fails in production and falls back to a dev key on a laptop", () => {
  const unwritable = "/hqconsole-nope-" + process.pid + "/truths.key";
  assert.throws(() => loadTruthsKey({ env: { CONSOLE_TRUTHS_KEY: unwritable }, devNoAuth: false }), /cannot create/);
  const key = loadTruthsKey({ env: { CONSOLE_TRUTHS_KEY: unwritable }, devNoAuth: true, log: () => {} });
  assert.equal(key.length, 32);
});

// ---------- unconfirmed-assumption cards ----------

test("assumptionCards: only unconfirmed assumptions become decide cards, stable ids, no ctl semantics", () => {
  const doc = {
    project: "acme-dashboard",
    rev: 4,
    updatedAt: "2026-08-18T10:00:00.000Z",
    entries: [
      { id: "a1", kind: "assumption", text: "the feed is daily", confirmed: false, added: "2026-08-17T10:00:00.000Z", source: "xd-3" },
      { id: "a2", kind: "assumption", text: "confirmed one", confirmed: true, added: "2026-08-17T10:00:00.000Z", source: null },
      { id: "t1", kind: "truth", text: "not an assumption", confirmed: false, added: null, source: null },
      { id: "c1", kind: "constraint", text: "also not", confirmed: false, added: null, source: null },
    ],
  };
  const files = { [PROJECT.truthsPath]: JSON.stringify(doc) };
  const readFile = (f) => {
    if (files[f] === undefined) {
      const e = new Error("ENOENT");
      e.code = "ENOENT";
      throw e;
    }
    return files[f];
  };
  const now = Date.parse("2026-08-18T12:00:00.000Z");
  const missing = normalizeProject({ id: "gym-tracker", name: "gym", kind: "rig", path: "/home/owner/hq/rigs/gym-tracker" }, CFG);
  const cards = assumptionCards([PROJECT, missing], { readFile, now });
  assert.equal(cards.length, 1, "one unconfirmed assumption, one card, a missing file none");
  const c = cards[0];
  assert.equal(c.id, "truths-acme-dashboard-a1");
  assert.equal(c.kind, "decide");
  assert.equal(c.severity, "P2");
  assert.equal(c.state, "open");
  assert.equal(c.rig, "acme-dashboard");
  assert.equal(c.link, "/projects/acme-dashboard");
  assert.equal(c.ageSeconds, 26 * 3600);
  assert.match(c.question, /Unconfirmed assumption: the feed is daily/);
  assert.deepEqual(c.meta, { truths: true, project: "acme-dashboard", entryId: "a1", rev: 4 });
});

test("assumptionCards: an unreadable truths file drops its project, never the stream", () => {
  const bad = (f) => (f === PROJECT.truthsPath ? "{not json" : JSON.stringify({ project: "gym-tracker", rev: 1, updatedAt: null, entries: [{ id: "z1", kind: "assumption", text: "ok", confirmed: false, added: null, source: null }] }));
  const other = normalizeProject({ id: "gym-tracker", name: "gym", kind: "rig", path: "/home/owner/hq/rigs/gym-tracker" }, CFG);
  const cards = assumptionCards([PROJECT, other], { readFile: bad, now: 0 });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].rig, "gym-tracker");
  assert.equal(cards[0].ageSeconds, 0, "a missing added never yields a negative or NaN age");
});
