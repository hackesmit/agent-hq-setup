#!/usr/bin/env python3
"""The write half of the truths store (bead hq-5mja, design 4.2).

Invoked only by spawn-as-owner.sh as `write-truths <project> <rev> <parent>`
with a JSON payload on stdin built by server/src/projects/truths.js:

  {project, rev, parent, sha256, trailer, truths_b64, markdown_b64, markdown_path}

It re-checks everything at this side of the trust boundary (the console's own
checks protect its users, not this script), then commits exactly one path with
the Hq-Truths-Rev trailer. The commit is built with plumbing (hash-object from
the payload bytes, a private index, commit-tree with an explicit parent) and
installed with `update-ref <branch> <new> <old>` as a compare-and-swap, so a
successful write is ATOMICALLY bound to the MAC-bound parent: no interleaved
committer can detach the trailer (lucy round 2, 2026-08-19). The worktree file
is written afterwards through an O_NOFOLLOW directory-fd walk, so a symlink
planted or swapped at any component can neither receive the bytes nor matter
to what was committed. The vault mirror is a projection: written best effort
after the commit, never a reason to fail one.

Exit codes (the contract in truths.js wrapperError):
  0 committed        3 stale revision        4 repo HEAD moved (check or CAS)
  5 payload refused  1 anything else (git unusable, worktree sync failed)
"""

import base64
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import time

MAX_PAYLOAD = 8 * 1024 * 1024
MAX_ENTRIES = 500
MAX_TEXT = 2000
MAX_SOURCE = 200
KINDS = {"term", "truth", "assumption", "constraint"}
ENTRY_KEYS = {"id", "kind", "text", "confirmed", "added", "source"}
ENTRY_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
PROJECT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
PARENT_RE = re.compile(r"^[0-9a-f]{7,64}$")
MIRROR_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,200}$")


def refuse(why):
    print(f"write-truths: refused: {why}", file=sys.stderr)
    sys.exit(5)


def fail(why):
    print(f"write-truths: {why}", file=sys.stderr)
    sys.exit(1)


def git(hq, *args, input=None, env=None):
    full_env = None
    if env:
        full_env = {**os.environ, **env}
    return subprocess.run(
        ["git", "-C", hq, *args], capture_output=True, input=input, timeout=20, env=full_env
    )


def out(r):
    return r.stdout.decode("utf-8", "replace").strip()


def err(r):
    return (r.stderr or r.stdout or b"").decode("utf-8", "replace").strip()[-300:]


def take_lock(hq):
    """One writer at a time, covering the whole check-commit-sync span. The
    lock file lives inside .git so it can never become repo content. The
    repo-wide /run/lock/hq-git.lock from the design is a provisioning item and
    layers on top at the console side; the update-ref CAS below is the
    correctness guarantee against committers that take neither lock."""
    lock = open(os.path.join(hq, ".git", "hq-truths.lock"), "a+")
    deadline = time.monotonic() + 20
    while True:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return lock
        except OSError:
            if time.monotonic() >= deadline:
                fail("another truths write is holding the lock")
            time.sleep(0.1)


def open_project_dir(hq, project, create):
    """Walk hq/ops/projects/<project> with O_NOFOLLOW at every component. A
    symlink anywhere in the chain is a refusal, and the returned fd pins the
    real directory, so a swap after this point changes nothing. With
    create=False a missing component returns None instead of making
    directories: nothing on disk may change before the CAS decides the write
    happens at all (lucy verification pass)."""
    fd = os.open(os.path.realpath(hq), os.O_DIRECTORY)
    try:
        for comp in ("ops", "projects", project):
            try:
                nfd = os.open(comp, os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    os.close(fd)
                    return None
                os.mkdir(comp, 0o755, dir_fd=fd)
                nfd = os.open(comp, os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except OSError as e:
                refuse(f"ops/projects/{project}: component {comp!r} is not a plain directory ({e.strerror})")
            os.close(fd)
            fd = nfd
        return fd
    except SystemExit:
        raise
    except OSError as e:
        os.close(fd)
        refuse(f"cannot open ops/projects/{project}: {e.strerror}")


def read_via(dir_fd, name):
    try:
        f = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dir_fd)
    except FileNotFoundError:
        return None
    except OSError as e:
        refuse(f"{name} is not a plain file ({e.strerror})")
    with os.fdopen(f, "rb") as fh:
        return fh.read()


def write_via(dir_fd, name, data):
    tmp = name + ".tmp"
    f = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o644, dir_fd=dir_fd)
    with os.fdopen(f, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.rename(tmp, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)


def validate_entries(entries):
    if not isinstance(entries, list) or len(entries) > MAX_ENTRIES:
        refuse(f"entries must be a list of at most {MAX_ENTRIES}")
    seen = set()
    for e in entries:
        if not isinstance(e, dict):
            refuse("every entry must be an object")
        if set(e.keys()) - ENTRY_KEYS:
            refuse(f"entry carries unknown fields: {sorted(set(e.keys()) - ENTRY_KEYS)}")
        if e.get("kind") not in KINDS:
            refuse("entry kind must be term|truth|assumption|constraint")
        if not isinstance(e.get("text"), str) or not e["text"].strip() or len(e["text"]) > MAX_TEXT:
            refuse(f"entry text must be a non-empty string of at most {MAX_TEXT} characters")
        if not isinstance(e.get("id"), str) or not ENTRY_ID_RE.match(e["id"]):
            refuse("entry id is not a safe slug")
        if e["id"] in seen:
            refuse(f"duplicate entry id: {e['id']}")
        seen.add(e["id"])
        if not isinstance(e.get("confirmed"), bool):
            refuse("entry confirmed must be a boolean")
        if e.get("added") is not None and not isinstance(e["added"], str):
            refuse("entry added must be a string or null")
        if e.get("source") is not None and (not isinstance(e["source"], str) or len(e["source"]) > MAX_SOURCE):
            refuse(f"entry source must be a string of at most {MAX_SOURCE} characters, or null")


def main():
    if len(sys.argv) != 5:
        fail("usage: write-truths.py <hq> <project> <rev> <parent>")
    hq, project, rev_s, parent = sys.argv[1:5]
    if not PROJECT_RE.match(project):
        refuse("bad project id")
    if not re.match(r"^[1-9][0-9]{0,8}$", rev_s):
        refuse("bad revision")
    rev = int(rev_s)
    if not PARENT_RE.match(parent):
        refuse("bad parent sha")
    if not os.path.isdir(os.path.join(hq, ".git")):
        fail(f"{hq} is not a git repository")

    raw = sys.stdin.buffer.read(MAX_PAYLOAD + 1)
    if len(raw) > MAX_PAYLOAD:
        refuse("payload too large")
    try:
        p = json.loads(raw)
    except Exception:
        refuse("payload is not JSON")
    if not isinstance(p, dict):
        refuse("payload is not an object")

    # The payload must agree with argv: a mismatch means the two channels were
    # assembled by different callers, which is exactly what gets refused.
    if p.get("project") != project:
        refuse("payload project does not match argv")
    if p.get("rev") != rev:
        refuse("payload rev does not match argv")
    if p.get("parent") != parent:
        refuse("payload parent does not match argv")

    sha = str(p.get("sha256") or "")
    if not SHA_RE.match(sha):
        refuse("bad sha256")
    trailer = str(p.get("trailer") or "")
    if not re.match(rf"^Hq-Truths-Rev: {rev} [0-9a-f]{{64}}$", trailer):
        refuse("bad trailer line")
    try:
        content = base64.b64decode(str(p.get("truths_b64") or ""), validate=True)
    except Exception:
        refuse("truths_b64 does not decode")
    if hashlib.sha256(content).hexdigest() != sha:
        refuse("sha256 does not match the bytes")
    try:
        doc = json.loads(content)
    except Exception:
        refuse("truths bytes are not JSON")
    if not isinstance(doc, dict) or doc.get("project") != project or doc.get("rev") != rev:
        refuse("document project/rev do not match the write")
    validate_entries(doc.get("entries"))

    rel = f"ops/projects/{project}/truths.json"

    # Everything from the disk-revision read to the commit runs under one lock,
    # so two verb invocations never interleave their checks.
    lock = take_lock(hq)

    # Pin the real project directory before anything is judged. A missing dir
    # is a first write: nothing is created until the CAS has decided.
    dir_fd = open_project_dir(hq, project, create=False)

    # Stale check against the disk, independent of the console's own check.
    disk_rev = 0
    previous = None if dir_fd is None else read_via(dir_fd, "truths.json")
    if previous is not None:
        try:
            disk_rev = int(json.loads(previous).get("rev", 0))
        except Exception:
            refuse("the existing truths.json is unreadable; resolve by hand")
    if rev != disk_rev + 1:
        print(f"write-truths: stale: disk rev {disk_rev}, write rev {rev}", file=sys.stderr)
        sys.exit(3)

    head = git(hq, "rev-parse", "HEAD")
    if head.returncode != 0:
        fail(f"cannot read HEAD: {err(head)}")
    head_sha = out(head)
    if head_sha != parent and not head_sha.startswith(parent):
        print(f"write-truths: repo moved: HEAD is not the MAC-bound parent {parent[:12]}", file=sys.stderr)
        sys.exit(4)

    branch = git(hq, "symbolic-ref", "-q", "HEAD")
    if branch.returncode != 0 or not out(branch).startswith("refs/heads/"):
        fail("HEAD is not on a branch; refusing to write truths on a detached HEAD")
    ref = out(branch)

    # Build the commit from the PAYLOAD bytes with plumbing: what lands in
    # history never depends on the worktree, and hooks neither run nor block.
    blob = git(hq, "hash-object", "-w", "--stdin", input=content)
    if blob.returncode != 0:
        fail(f"hash-object failed: {err(blob)}")
    blob_sha = out(blob)

    idx = os.path.join(hq, ".git", "hq-truths-index")
    genv = {"GIT_INDEX_FILE": idx}
    try:
        r = git(hq, "read-tree", head_sha, env=genv)
        if r.returncode != 0:
            fail(f"read-tree failed: {err(r)}")
        r = git(hq, "update-index", "--add", "--cacheinfo", f"100644,{blob_sha},{rel}", env=genv)
        if r.returncode != 0:
            fail(f"update-index failed: {err(r)}")
        tree = git(hq, "write-tree", env=genv)
        if tree.returncode != 0:
            fail(f"write-tree failed: {err(tree)}")
        msg = f"console: truths {project} rev {rev}\n\n{trailer}\n"
        commit = git(hq, "commit-tree", out(tree), "-p", head_sha, input=msg.encode("utf-8"))
        if commit.returncode != 0:
            fail(f"commit-tree failed: {err(commit)}")
        # The compare-and-swap: the ref moves to the new commit only if it
        # still points at the MAC-bound parent. Nothing to roll back on
        # failure, because nothing outside the object store was touched.
        cas = git(hq, "update-ref", "-m", "write-truths", ref, out(commit), head_sha)
        if cas.returncode != 0:
            print(f"write-truths: repo moved during the write ({err(cas)[:120]}); retry against the new HEAD", file=sys.stderr)
            sys.exit(4)
    finally:
        try:
            os.unlink(idx)
        except OSError:
            pass

    # The commit is in. Sync the worktree file (through the pinned fd) and the
    # real index entry so `git status` stays clean. If the ref has ALREADY
    # moved past our commit (an out-of-band committer racing outside the lock),
    # the newer state owns the worktree: skip the sync with a warning and let
    # the audit flag the racer. A sync failure cannot be rolled back and must
    # not look like one: report loudly and exit 1 with the landed commit named.
    still_ours = git(hq, "rev-parse", ref)
    if still_ours.returncode == 0 and out(still_ours) != out(commit):
        print(
            f"write-truths: committed {out(commit)[:12]} but {ref} already moved to {out(still_ours)[:12]}; worktree left to the newer commit",
            file=sys.stderr,
        )
    else:
        if dir_fd is None:
            dir_fd = open_project_dir(hq, project, create=True)
        try:
            write_via(dir_fd, "truths.json", content)
        except OSError as e:
            fail(f"COMMITTED {out(commit)[:12]} but the worktree file could not be written ({e.strerror}); run git checkout -- {rel}")
        r = git(hq, "update-index", "--add", "--cacheinfo", f"100644,{blob_sha},{rel}")
        if r.returncode != 0:
            print(f"write-truths: index not refreshed ({err(r)[:120]}); git status will show {rel}", file=sys.stderr)
    if dir_fd is not None:
        os.close(dir_fd)
    lock.close()

    # The vault mirror, best effort. A bad path or full disk is a warning: the
    # committed file is the source of truth, the mirror only follows it.
    mirror = p.get("markdown_path")
    if mirror:
        try:
            mirror = str(mirror)
            if not MIRROR_RE.match(mirror) or ".." in mirror:
                raise ValueError("mirror path refused")
            md = base64.b64decode(str(p.get("markdown_b64") or ""), validate=True)
            root = os.path.realpath(os.path.join(hq, "outbox", "vault"))
            outp = os.path.realpath(os.path.join(root, mirror))
            if outp != root and not outp.startswith(root + os.sep):
                raise ValueError("mirror path escapes the outbox")
            os.makedirs(os.path.dirname(outp), exist_ok=True)
            tmp = outp + ".tmp"
            with open(tmp, "wb") as f:
                f.write(md)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, outp)
        except Exception as e:
            print(f"write-truths: mirror not written: {e}", file=sys.stderr)

    print(f"committed {rel} rev {rev}")
    sys.exit(0)


if __name__ == "__main__":
    main()
