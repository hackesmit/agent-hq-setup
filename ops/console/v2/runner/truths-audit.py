#!/usr/bin/env python3
"""Read-only audit feed for the truths trailer detector (design 4.2).

Invoked by spawn-as-owner.sh as `truths-audit [n]`. Walks the last N commits
of $HQ that touched ops/projects/*/truths.json and prints one JSON line per
(commit, path):

  {"sha", "parent", "message", "path", "project", "contentSha256"}

Nothing is judged here: verification needs the MAC key, which only the console
(hqconsole) may read, so this side only reports what the history contains.
Merges are compared against their FIRST parent: that is the parent the trailer
MAC binds, so a merge that changes a truths file relative to it is exactly the
kind of commit the console must look at.
"""

import hashlib
import json
import re
import subprocess
import sys

PATHSPEC = "ops/projects/*/truths.json"
PATH_RE = re.compile(r"^ops/projects/([A-Za-z0-9][A-Za-z0-9._-]{0,63})/truths\.json$")


def git(hq, *args):
    return subprocess.run(["git", "-C", hq, *args], capture_output=True, timeout=30)


def text(r):
    return r.stdout.decode("utf-8", "replace")


def main():
    if len(sys.argv) < 2:
        print("truths-audit: usage: truths-audit.py <hq> [n] [since-sha]", file=sys.stderr)
        sys.exit(1)
    hq = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 50
    since = sys.argv[3] if len(sys.argv) > 3 else ""

    head = git(hq, "rev-parse", "HEAD")
    if head.returncode != 0:
        # An empty repo (no commits yet) is a quiet audit, not a failure.
        sys.exit(0)

    rng = []
    if since and re.fullmatch(r"[0-9a-f]{7,64}", since):
        # A cursor that no longer resolves (history rewritten, clone replaced)
        # falls back to the bounded full scan rather than failing the audit.
        if git(hq, "cat-file", "-e", f"{since}^{{commit}}").returncode == 0:
            rng = [f"{since}..HEAD"]

    log = git(hq, "log", "--full-history", "-n", str(n), "--format=%H", *rng, "--", PATHSPEC)
    if log.returncode != 0:
        print(f"truths-audit: git log failed: {text(log)[-200:]}", file=sys.stderr)
        sys.exit(1)
    shas = text(log).split()

    # The console persists head as its cursor once the batch is processed, so
    # the next audit covers <cursor>..HEAD instead of a fixed lookback window
    # that a long outage could scroll a violation out of (lucy round 2). When
    # the window itself truncated (n commits returned, older ones unseen), the
    # cursor must NOT advance or the unseen ones are skipped forever: the flag
    # tells the console to hold it and raise a backlog card instead.
    print(json.dumps({"head": text(head).strip(), "truncated": len(shas) >= n}))

    for sha in shas:
        meta = git(hq, "show", "-s", "--format=%P%x1f%B", sha)
        if meta.returncode != 0:
            continue
        parents_raw, _, message = text(meta).partition("\x1f")
        parents = parents_raw.split()
        parent = parents[0] if parents else ""
        if parent:
            diff = git(hq, "diff-tree", "--no-commit-id", "--name-only", "-r", f"{sha}^", sha, "--", PATHSPEC)
        else:
            diff = git(hq, "show", "--format=", "--name-only", sha, "--", PATHSPEC)
        if diff.returncode != 0:
            continue
        for path in text(diff).split("\n"):
            m = PATH_RE.match(path.strip())
            if not m:
                continue
            blob = git(hq, "show", f"{sha}:{path.strip()}")
            # A deleted truths file has no blob at this commit; report it with
            # an empty hash so the console can still flag the deletion.
            digest = hashlib.sha256(blob.stdout).hexdigest() if blob.returncode == 0 else ""
            print(
                json.dumps(
                    {
                        "sha": sha,
                        "parent": parent,
                        "message": message.rstrip("\n"),
                        "path": path.strip(),
                        "project": m.group(1),
                        "contentSha256": digest,
                    }
                )
            )
    sys.exit(0)


if __name__ == "__main__":
    main()
