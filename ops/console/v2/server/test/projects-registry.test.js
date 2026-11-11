import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Registry, RegistryError, inside, normalizeProject, parseRegistry } from "../src/projects/registry.js";

const CFG = { hqRoot: "/home/owner/hq", rigsDir: "/home/owner/hq/rigs" };

test("inside() accepts the root and its children and rejects a sibling prefix", () => {
  assert.equal(inside("/a/b", "/a/b"), true);
  assert.equal(inside("/a/b", "/a/b/c"), true);
  assert.equal(inside("/a/b", "/a/bc"), false);
  assert.equal(inside("/a/b", "/a"), false);
});

test("the hq entry reads bd in the hq repo", () => {
  const p = normalizeProject({ id: "hq", name: "HQ", kind: "other", path: "/home/owner/hq", hub: "01 Projects/hq/_index.md" }, CFG);
  assert.deepEqual(p.beadSource, { mode: "hq", rig: null });
  assert.equal(p.gitDir, "/home/owner/hq");
  assert.equal(p.truthsRepoPath, "ops/projects/hq/truths.json");
  assert.equal(p.truthsPath, "/home/owner/hq/ops/projects/hq/truths.json");
  assert.equal(p.knowledgePath, "01 Projects/hq/Knowledge.md");
  assert.equal(p.truthsMirrorRel, "01 Projects/hq/Truths.md");
});

test("a rig entry reads bd through bd-rig with the directory name as the rig", () => {
  const p = normalizeProject(
    { id: "acme-dashboard", kind: "rig", path: "/home/owner/hq/rigs/acme-dashboard", hub: "01 Projects/acme-dashboard/_index.md" },
    CFG,
  );
  assert.deepEqual(p.beadSource, { mode: "rig", rig: "acme-dashboard" });
  assert.equal(p.gitDir, "/home/owner/hq/rigs/acme-dashboard");
  assert.equal(p.decisionsPath, "/home/owner/hq/rigs/acme-dashboard/DECISIONS.md");
});

test("a project with no checkout, and one inside hq that is not a repo, get no bd and no git", () => {
  const client = normalizeProject({ id: "studioco-digital", kind: "client", path: null, hub: "01 Projects/studioco-digital/_index.md" }, CFG);
  assert.deepEqual(client.beadSource, { mode: "none", rig: null });
  assert.equal(client.gitDir, null);
  assert.equal(client.decisionsPath, null);

  const svc = normalizeProject({ id: "hq-mail", kind: "service", path: "/home/owner/hq/ops/mail", hub: "01 Projects/hq/_index.md" }, CFG);
  assert.deepEqual(svc.beadSource, { mode: "none", rig: null });
  assert.equal(svc.gitDir, null, "ops/mail is not its own repo, so git-log must not be called for it");
});

test("two projects sharing a hub folder do not collide in the vault mirror", () => {
  const hq = normalizeProject({ id: "hq", path: "/home/owner/hq", hub: "01 Projects/hq/_index.md" }, CFG);
  const mail = normalizeProject({ id: "hq-mail", kind: "service", hub: "01 Projects/hq/_index.md" }, CFG);
  assert.equal(hq.truthsMirrorRel, "01 Projects/hq/Truths.md");
  assert.equal(mail.truthsMirrorRel, "01 Projects/hq/Truths-hq-mail.md");
  assert.notEqual(hq.truthsMirrorPath, mail.truthsMirrorPath);
});

test("defaults fill in for every optional field", () => {
  const p = normalizeProject({ id: "x" }, CFG);
  assert.equal(p.name, "x");
  assert.equal(p.kind, "other");
  assert.equal(p.status, "active");
  assert.equal(p.path, null);
  assert.equal(p.goal, null);
  assert.equal(p.targetDate, null);
  assert.deepEqual(p.milestones, []);
  assert.deepEqual(p.deploys, []);
  assert.equal(p.hub, null);
  assert.equal(p.truthsMirrorRel, null);
});

test("a bad shape is refused rather than half-applied", () => {
  assert.throws(() => normalizeProject({ id: "../etc" }, CFG), RegistryError);
  assert.throws(() => normalizeProject({ id: "ok", kind: "wat" }, CFG), RegistryError);
  assert.throws(() => normalizeProject({ id: "ok", status: "wat" }, CFG), RegistryError);
  assert.throws(() => normalizeProject({ id: "ok", path: "/etc" }, CFG), /outside HQ_ROOT/);
  assert.throws(() => parseRegistry({}, CFG), /no `projects` array/);
  assert.throws(() => parseRegistry({ projects: [] }, CFG), /lists no projects/);
  assert.throws(() => parseRegistry({ projects: [{ id: "a" }, { id: "a" }] }, CFG), /duplicate project id/);
});

test("deploys keep their url so the card has a link before the phase 2 collector", () => {
  const p = normalizeProject({ id: "d", deploys: [{ provider: "vercel", project: "p", url: "https://x" }] }, CFG);
  assert.deepEqual(p.deploys, [{ provider: "vercel", project: "p", url: "https://x" }]);
});

test("the real ops/projects.json parses and every entry resolves", () => {
  const reg = new Registry(CFG);
  const all = reg.list();
  assert.ok(all.length >= 5, `expected the registry to list the rigs, got ${all.length}`);
  const ids = all.map((p) => p.id);
  for (const want of ["hq", "acme-dashboard", "gym-tracker", "chesski", "fintrack-portfolio"]) {
    assert.ok(ids.includes(want), `registry is missing ${want}`);
  }
  for (const p of all) {
    if (p.path) assert.ok(inside(CFG.hqRoot, p.path), `${p.id} path escaped hq`);
    assert.equal(path.isAbsolute(p.truthsPath), true);
  }
  assert.equal(reg.get("acme-dashboard").beadSource.mode, "rig");
  assert.equal(reg.get("nope"), null);
  assert.equal(reg.get("../../etc/passwd"), null);
});

test("a cached registry survives a file that goes missing or unparseable", () => {
  let body = JSON.stringify({ projects: [{ id: "a", path: "/home/owner/hq" }] });
  let stamp = 1;
  const reg = new Registry(CFG, {
    file: "/nowhere/projects.json",
    readFile: () => body,
    statFile: () => ({ mtimeMs: stamp, size: body.length }),
  });
  assert.equal(reg.list().length, 1);
  body = "{ not json";
  stamp = 2;
  assert.equal(reg.list().length, 1, "a half-written file must keep the last good registry");
  const cold = new Registry(CFG, {
    file: "/nowhere/projects.json",
    readFile: () => "{ not json",
    statFile: () => ({ mtimeMs: 1, size: 1 }),
  });
  assert.throws(() => cold.list(), /cannot parse/);
});

test("terminalDir: declared path wins, rigs/<id> is the fallback, and no directory means null", async () => {
  const { terminalDir } = await import("../src/projects/registry.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-terminaldir-"));
  const cfg = { hqRoot: dir, rigsDir: path.join(dir, "rigs") };
  fs.mkdirSync(path.join(dir, "rigs", "gym-tracker"), { recursive: true });
  fs.mkdirSync(path.join(dir, "ops", "mail"), { recursive: true });
  try {
    assert.equal(terminalDir({ id: "hq-mail", path: path.join(dir, "ops", "mail") }, cfg), path.join(dir, "ops", "mail"));
    assert.equal(terminalDir({ id: "gym-tracker", path: null }, cfg), path.join(dir, "rigs", "gym-tracker"));
    assert.equal(terminalDir({ id: "acme-financial", path: null }, cfg), null, "a service with no checkout is not spawnable");
    assert.equal(terminalDir({ id: "gone", path: path.join(dir, "nowhere") }, cfg), null, "a declared path that is not on disk is not spawnable");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("beadLabel: a project with no db of its own claims its hq-ledger slice, and a bad label is refused", () => {
  const p = normalizeProject(
    { id: "nonprofit-a", kind: "client", path: "/home/owner/hq/bunkers/nonprofit-a", beadLabel: "nonprofit-a" },
    CFG,
  );
  assert.equal(p.beadLabel, "nonprofit-a");
  assert.deepEqual(p.beadSource, { mode: "hq", rig: null }, "a labeled project reads the hq db");
  const rig = normalizeProject({ id: "chesski", kind: "rig", path: "/home/owner/hq/rigs/chesski", beadLabel: "chesski" }, CFG);
  assert.deepEqual(rig.beadSource, { mode: "rig", rig: "chesski" }, "an own db wins over the label");
  assert.throws(() => normalizeProject({ id: "x", kind: "client", beadLabel: "bad label!" }, CFG), RegistryError);
});

test("ledger hq: a rig checkout that keeps its beads in the hq ledger reads the hq db, anything else is refused", () => {
  const p = normalizeProject(
    { id: "acme-avance", kind: "client", path: "/home/owner/hq/rigs/acme-avance", beadLabel: "acme-avance", ledger: "hq" },
    CFG,
  );
  assert.deepEqual(p.beadSource, { mode: "hq", rig: null });
  assert.ok(p.gitDir, "commits still come from the rig checkout");
  assert.throws(
    () => normalizeProject({ id: "y", kind: "rig", path: "/home/owner/hq/rigs/y", ledger: "rig" }, CFG),
    RegistryError,
  );
});

test("sphere and client: classified and attributed when declared, null when absent, refused when junk", () => {
  const p = normalizeProject(
    { id: "acme-dashboard", kind: "rig", path: "/home/owner/hq/rigs/acme-dashboard", sphere: "work", client: "Orbit Acme" },
    CFG,
  );
  assert.equal(p.sphere, "work");
  assert.equal(p.client, "Orbit Acme");
  const bare = normalizeProject({ id: "chesski", kind: "rig", path: "/home/owner/hq/rigs/chesski" }, CFG);
  assert.equal(bare.sphere, null, "no sphere means unclassified, never a guessed bucket");
  assert.equal(bare.client, null);
  const blank = normalizeProject({ id: "x", kind: "client", client: "  " }, CFG);
  assert.equal(blank.client, null, "a whitespace client is unset, not an empty label");
  assert.throws(() => normalizeProject({ id: "x", kind: "client", sphere: "hobby" }, CFG), RegistryError);
});
