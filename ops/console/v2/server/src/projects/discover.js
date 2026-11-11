// Repositories the registry has not been told about.
//
// the owner: "It should automatically update when we create new GitHub repos. Those
// should be added as projects so it should read from that."
//
// ops/projects.json is hand-maintained and guard-protected, so a new repo is
// invisible until somebody remembers to write it down, and an agent cannot write
// it down at all. Two things follow from that, and they decide the whole design:
//
//   1. Discovery MERGES, it never replaces. Everything a person wrote about a
//      project (its goal, its hub, its milestones, its kind) is knowledge the
//      filesystem does not have, and a scan that overwrote it would destroy the
//      thing the file exists for.
//   2. Discovery cannot write the file. It reports what it found, the console
//      shows it, and adding it stays the owner's keystroke. A registry an agent can
//      edit is a registry an agent can point somewhere else.
//
// The scan is local rather than an account listing on purpose. It needs no
// credential, it finds every repo actually being worked on, and its blind spot is
// honest and narrow: a repo that exists on the remote and has never been cloned
// here does not appear, and could not have been worked on either.

import fs from "node:fs";
import path from "node:path";
import { ID_RE } from "./registry.js";

/**
 * Is this ".git" the pointer of a linked WORKTREE?
 *
 * A worktree's .git is a file reading "gitdir: ...", pointing inside the parent
 * repo's worktrees directory. Being a file is not on its own enough to decide, which
 * is exactly why this reads it: `git clone --separate-git-dir` leaves a gitfile too,
 * and that is a real repository the registry has not been told about. Only the
 * worktrees segment git writes for a linked checkout means "another view of a repo
 * that already lives somewhere else".
 */
export function gitdirTarget(text) {
  const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(String(text || ""));
  if (!m) return "";
  return m[1].replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Does this admin directory belong to a linked worktree, and to THIS checkout?
 *
 * Shape alone is not proof: `git clone --separate-git-dir=/tmp/meta/worktrees/x`
 * produces a path ending in /worktrees/x for a repository of its own (lucy round 2).
 * Git writes a "gitdir" file inside a real linked worktree's admin directory holding
 * the absolute path of the checkout's .git file, so asking for that backlink and
 * checking it points back here is the actual test rather than a resemblance to one.
 */
export function isLinkedWorktree(gitPath, pointerText, readFile) {
  const target = gitdirTarget(pointerText);
  if (!target || !/\/worktrees\/[^/]+$/.test(target)) return false;
  const backlink = String(readFile(path.join(target, "gitdir")) || "").trim();
  if (!backlink) return false;
  return path.resolve(backlink) === path.resolve(gitPath);
}

/** A repo found on disk that the registry does not list. */
export function discoverRigs(rigsDir, known, deps = {}) {
  const readdir = deps.readdir || ((d) => fs.readdirSync(d, { withFileTypes: true }));
  const exists = deps.exists || ((p) => fs.existsSync(p));
  const isFile =
    deps.isFile ||
    ((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
  // Reads both the checkout's .git pointer and the backlink inside whatever it points
  // at. A gitfile is one short line; the cap is only so a stray large file sitting at
  // either path cannot be read into memory on every scan.
  const readGitFile =
    deps.readGitFile ||
    ((p) => {
      try {
        return fs.readFileSync(p, "utf8").slice(0, 4096);
      } catch {
        return "";
      }
    });
  const knownIds = new Set(known.map((p) => p.id));
  // A project already listed by PATH is the same project under another name, so
  // matching on both stops a rename producing a phantom.
  const knownPaths = new Set(known.map((p) => path.resolve(p.path || "")).filter(Boolean));

  let entries;
  try {
    entries = readdir(rigsDir);
  } catch {
    // No rigs directory is not an error: a fresh install has none yet.
    return [];
  }

  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory || !entry.isDirectory()) continue;
    const name = entry.name;
    // Skipping dotted names keeps .git, .cache and friends out.
    if (name.startsWith(".")) continue;
    if (!ID_RE.test(name)) continue;
    const full = path.join(rigsDir, name);
    const gitPath = path.join(full, ".git");
    if (!exists(gitPath)) continue;
    // A worktree is a checkout of a repo already listed, not a new project. HQ spawns
    // one per worker, so a busy rig leaves dozens behind, and reporting each one
    // buried the single real finding under 48 copies of acme-dashboard (2026-08-24),
    // which is the whole reason this test exists. It reads the pointer rather than
    // guessing from the directory name, so a repo genuinely called hq-tools is not
    // taken for a worktree of hq, and a --separate-git-dir clone still gets reported.
    if (isFile(gitPath) && isLinkedWorktree(gitPath, readGitFile(gitPath), readGitFile)) continue;
    if (knownIds.has(name) || knownPaths.has(path.resolve(full))) continue;
    found.push({ id: name, path: full });
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/** A listed project whose path no longer exists: marked, never dropped. */
export function missingProjects(known, deps = {}) {
  const exists = deps.exists || ((p) => fs.existsSync(p));
  return known
    .filter((p) => p.path && !exists(p.path))
    .map((p) => ({ id: p.id, path: p.path }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The line the owner would paste to adopt a discovered repo.
 *
 * A ready-made entry rather than instructions, because the whole friction being
 * removed is having to remember the shape of the file.
 */
export function adoptionSnippet(found) {
  return JSON.stringify(
    {
      id: found.id,
      name: found.id,
      kind: "rig",
      status: "active",
      path: found.path,
      beadPrefix: found.id.slice(0, 2),
      hub: `01 Projects/${found.id}/_index.md`,
      goal: "",
    },
    null,
    2,
  );
}
