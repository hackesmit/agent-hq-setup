// Repos the registry has not been told about. The rules under test are the two
// that make this safe to run automatically: it merges rather than replaces, and a
// worktree or an already-listed repo is never reported as new.
import test from "node:test";
import assert from "node:assert/strict";
import { adoptionSnippet, discoverRigs, isLinkedWorktree, missingProjects } from "../src/projects/discover.js";

const dir = (...names) => names.map((n) => ({ name: n, isDirectory: () => true }));
const withGit = (...paths) => {
  const set = new Set(paths);
  return (p) => set.has(p);
};
// A worktree's .git is a FILE pointing into the parent repo's worktrees dir; a
// clone's is a directory. Tests that do not care pass neither dep, which makes every
// .git a directory (a clone). worktreesAt makes the named paths real worktrees.
const gitFileAt = (...paths) => {
  const set = new Set(paths);
  return (p) => set.has(p);
};
// Files by path. A REAL linked worktree is two files: the checkout's .git pointer,
// and the backlink git writes inside the admin dir naming that same .git.
const files = (map) => (p) => map[p] ?? "";
const realWorktree = (checkoutGit, adminDir) => ({
  [checkoutGit]: "gitdir: " + adminDir + "\n",
  [adminDir + "/gitdir"]: checkoutGit + "\n",
});

test("finds a repo the registry does not list", () => {
  const found = discoverRigs(
    "/rigs",
    [{ id: "chesski", path: "/rigs/chesski" }],
    { readdir: () => dir("chesski", "newthing"), exists: withGit("/rigs/chesski/.git", "/rigs/newthing/.git") },
  );
  assert.deepEqual(found, [{ id: "newthing", path: "/rigs/newthing" }]);
});

test("a directory that is not a repo is not a project", () => {
  const found = discoverRigs("/rigs", [], {
    readdir: () => dir("notarepo", "real"),
    exists: withGit("/rigs/real/.git"),
  });
  assert.deepEqual(found.map((f) => f.id), ["real"]);
});

test("a worker worktree is not a new project", () => {
  // spawn.sh makes ~/hq/rigs/<rig>-<suffix> per worker. Those are checkouts of a
  // repo already listed, and reporting each one buried the real finding under 48
  // copies of acme-dashboard on the live box (2026-08-24).
  const known = [{ id: "acme-dashboard", path: "/rigs/acme-dashboard" }];
  const found = discoverRigs("/rigs", known, {
    readdir: () => dir("acme-dashboard", "acme-dashboard-4f2a", "chesski-ck-a3c", "brand-new"),
    exists: withGit(
      "/rigs/acme-dashboard/.git",
      "/rigs/acme-dashboard-4f2a/.git",
      "/rigs/chesski-ck-a3c/.git",
      "/rigs/brand-new/.git",
    ),
    isFile: gitFileAt("/rigs/acme-dashboard-4f2a/.git", "/rigs/chesski-ck-a3c/.git"),
    readGitFile: files({
      ...realWorktree("/rigs/acme-dashboard-4f2a/.git", "/rigs/acme-dashboard/" + ".git/worktrees/4f2a"),
      ...realWorktree("/rigs/chesski-ck-a3c/.git", "/rigs/chesski/" + ".git/worktrees/ck-a3c"),
    }),
  });
  // Only the genuinely new clone is left: the rig itself is listed, and both
  // checkouts are worktrees whatever their suffix looks like.
  assert.deepEqual(
    found.map((f) => f.id),
    ["brand-new"],
  );
});

test("a --separate-git-dir clone has a gitfile too, and IS a discovery", () => {
  // lucy (2026-08-24): "the .git is a file" over-matches. That is why the pointer is
  // read: this one points at a plain git dir, not into a repo's worktrees, so it is a
  // repository of its own that nobody has told the registry about.
  const found = discoverRigs("/rigs", [], {
    readdir: () => dir("newrepo"),
    exists: withGit("/rigs/newrepo/.git"),
    isFile: gitFileAt("/rigs/newrepo/.git"),
    readGitFile: files({ "/rigs/newrepo/.git": "gitdir: /tmp/new-meta\n" }),
  });
  assert.deepEqual(found.map((f) => f.id), ["newrepo"]);
});

test("a real repo whose name merely looks like a worktree of a listed rig is reported", () => {
  // The name is not evidence: hq-tools is not a worktree of hq. Both of these carry a
  // .git DIRECTORY, so both are repos, and hiding them is hiding the card's whole job.
  const found = discoverRigs("/rigs", [{ id: "hq", path: "/hq" }, { id: "chesski", path: "/rigs/chesski" }], {
    readdir: () => dir("hq-tools", "hq-beef", "chesski-4f2a"),
    exists: withGit("/rigs/hq-tools/.git", "/rigs/hq-beef/.git", "/rigs/chesski-4f2a/.git"),
  });
  assert.deepEqual(
    found.map((f) => f.id),
    ["chesski-4f2a", "hq-beef", "hq-tools"],
  );
});

test("a separate-git-dir whose path merely LOOKS like a worktree is still a discovery", () => {
  // lucy round 2: `git clone --separate-git-dir=/tmp/meta/worktrees/newrepo` ends in
  // /worktrees/<name> without being a worktree at all. The backlink settles it, and
  // this one has none pointing back at the checkout.
  const found = discoverRigs("/rigs", [], {
    readdir: () => dir("sneaky"),
    exists: withGit("/rigs/sneaky/.git"),
    isFile: gitFileAt("/rigs/sneaky/.git"),
    readGitFile: files({ "/rigs/sneaky/.git": "gitdir: /tmp/meta/worktrees/sneaky\n" }),
  });
  assert.deepEqual(found.map((f) => f.id), ["sneaky"]);
});

test("a worktree admin dir that backlinks elsewhere does not vouch for this checkout", () => {
  const found = discoverRigs("/rigs", [], {
    readdir: () => dir("borrowed"),
    exists: withGit("/rigs/borrowed/.git"),
    isFile: gitFileAt("/rigs/borrowed/.git"),
    readGitFile: files({
      "/rigs/borrowed/.git": "gitdir: /rigs/chesski/" + ".git/worktrees/other\n",
      ["/rigs/chesski/" + ".git/worktrees/other/gitdir"]: "/rigs/somewhere-else/.git\n",
    }),
  });
  assert.deepEqual(found.map((f) => f.id), ["borrowed"]);
});

test("isLinkedWorktree wants the backlink, not a pathname that resembles one", () => {
  const admin = "/repo/" + ".git/worktrees/w1";
  const checkout = "/rigs/w1/.git";
  const good = files(realWorktree(checkout, admin));
  assert.equal(isLinkedWorktree(checkout, good(checkout), good), true);
  assert.equal(isLinkedWorktree(checkout, "gitdir: /tmp/new-meta", files({})), false, "a separate git dir is not one");
  assert.equal(isLinkedWorktree(checkout, "gitdir: " + admin, files({})), false, "the shape alone proves nothing");
  assert.equal(
    isLinkedWorktree(checkout, "gitdir: " + admin, files({ [admin + "/gitdir"]: "/rigs/other/.git" })),
    false,
    "a backlink to another checkout is not this one",
  );
  assert.equal(isLinkedWorktree(checkout, "not a pointer", files({})), false);
  assert.equal(isLinkedWorktree(checkout, "", files({})), false);
  assert.equal(isLinkedWorktree(checkout, null, files({})), false);
});

test("a project already listed by PATH is not rediscovered under another name", () => {
  const found = discoverRigs("/rigs", [{ id: "renamed", path: "/rigs/onthedisk" }], {
    readdir: () => dir("onthedisk"),
    exists: withGit("/rigs/onthedisk/.git"),
  });
  assert.deepEqual(found, []);
});

test("hidden and malformed directory names are skipped", () => {
  const found = discoverRigs("/rigs", [], {
    readdir: () => dir(".git", ".cache", "UPPER", "ok-name"),
    exists: () => true,
  });
  assert.deepEqual(found.map((f) => f.id), ["ok-name"]);
});

test("no rigs directory is not an error", () => {
  const found = discoverRigs("/nope", [], {
    readdir: () => {
      throw new Error("ENOENT");
    },
  });
  assert.deepEqual(found, []);
});

test("a project whose path has gone is marked, never dropped", () => {
  const gone = missingProjects(
    [{ id: "here", path: "/rigs/here" }, { id: "gone", path: "/rigs/gone" }, { id: "nopath", path: "" }],
    { exists: withGit("/rigs/here") },
  );
  assert.deepEqual(gone, [{ id: "gone", path: "/rigs/gone" }]);
});

test("the adoption snippet is a valid registry entry, not instructions", () => {
  const snippet = JSON.parse(adoptionSnippet({ id: "newthing", path: "/rigs/newthing" }));
  assert.equal(snippet.id, "newthing");
  assert.equal(snippet.path, "/rigs/newthing");
  assert.equal(snippet.kind, "rig");
  assert.equal(snippet.status, "active");
  assert.ok(snippet.hub.includes("newthing"));
});
