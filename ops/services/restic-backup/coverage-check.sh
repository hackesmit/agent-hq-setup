#!/usr/bin/env bash
# coverage-check.sh [include exclude required]: prove the restic lists cover
# every required path (hq-pgbpq.2). Defaults are the repo copies beside this
# script; pass /etc/restic/include.txt /etc/restic/exclude.txt (readable copies)
# to check the installed lists. Exit 1 on any uncovered path.
# Restic itself decides what the excludes drop: each required path is run
# through `restic backup --dry-run` against a throwaway local repository with
# the real exclude file, and every file under it (find -xdev) must appear in
# that dry run, except files under a rebuildable name in REBUILDABLE.
# Also uncovered, before restic runs: a missing required path, one no include
# line holds, a symlink anywhere on its path, include root and above (restic
# keeps the link, not the target), another filesystem than its include root,
# or a mount point inside it (the backup runs --one-file-system).
# Fail-closed on unreadable or empty lists, and when restic cannot run.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
INC="${1:-$HERE/include.txt}"; EXC="${2:-$HERE/exclude.txt}"; REQ="${3:-$HERE/required.txt}"
export REBUILDABLE="${REBUILDABLE:-node_modules .next __pycache__ .venv}"
for f in "$INC" "$EXC" "$REQ"; do
  [ -f "$f" ] && [ -r "$f" ] || { echo "ERROR cannot read $f"; exit 1; }
done
lines() { grep -vE '^[[:space:]]*(#|$)' "$1" || true; }
mapfile -t incs < <(lines "$INC"); mapfile -t reqs < <(lines "$REQ")
[ "${#incs[@]}" -gt 0 ] || { echo "ERROR no include lines in $INC"; exit 1; }
[ "${#reqs[@]}" -gt 0 ] || { echo "ERROR no required paths in $REQ"; exit 1; }
command -v restic >/dev/null || { echo "ERROR restic not installed"; exit 1; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export RESTIC_REPOSITORY="$T/repo" RESTIC_PASSWORD=coverage-check RESTIC_CACHE_DIR="$T/cache"
restic init >/dev/null 2>&1 || { echo "ERROR cannot init a scratch restic repo"; exit 1; }
mapfile -t mounts < <(findmnt -rn -o TARGET | sed 's/\\x20/ /g')

bad=0
for p in "${reqs[@]}"; do
  p="${p%/}"; root=""
  for i in "${incs[@]}"; do
    i="${i%/}"
    case "$p/" in "$i"/*) root="${i:-/}"; break ;; esac
  done
  if [ -z "$root" ]; then echo "UNCOVERED $p: no include line holds it"; bad=1; continue; fi
  if [ ! -e "$p" ] && [ ! -L "$p" ]; then echo "UNCOVERED $p: does not exist, nothing to prove"; bad=1; continue; fi
  link=""; q="$p"
  while [ -n "$q" ]; do [ -L "$q" ] && link="$q"; q="${q%/*}"; done
  if [ -n "$link" ]; then echo "UNCOVERED $p: $link is a symlink (restic keeps the link, not the target)"; bad=1; continue; fi
  if [ "$(stat -c %d "$p")" != "$(stat -c %d "$root")" ]; then
    echo "UNCOVERED $p: other filesystem than $root (--one-file-system)"; bad=1; continue
  fi
  inner=""
  for m in "${mounts[@]}"; do case "$m/" in "$p"/?*) inner="$m" ;; esac; done
  if [ -n "$inner" ]; then echo "UNCOVERED $p: $inner is mounted inside it (--one-file-system skips it)"; bad=1; continue; fi

  # What should be saved: every file, minus rebuildable directories and
  # directories with a valid CACHEDIR.TAG (the backup runs --exclude-caches,
  # which is how uv venvs such as state/avancevenv stay out).
  find "$p" -xdev -type f -print0 2>/dev/null | python3 -I -c '
import sys, os
skip = set(os.environ["REBUILDABLE"].split())
sig = b"Signature: 8a477f597d28d172789f06886806bc55"
files = [f for f in sys.stdin.buffer.read().split(b"\0") if f]
caches = []
for f in files:
    if f.endswith(b"/CACHEDIR.TAG"):
        try:
            if open(f, "rb").read(len(sig)) == sig: caches.append(f[:-len(b"CACHEDIR.TAG")])
        except OSError: pass
for c in caches: sys.stderr.write("note " + c.decode("utf-8", "replace") + ": cache-tagged, left out on purpose (--exclude-caches)\n")
for f in files:
    if any(f.startswith(c) and f != c + b"CACHEDIR.TAG" for c in caches): continue
    if not skip.intersection(f.decode("utf-8", "surrogateescape").split("/")):
        sys.stdout.buffer.write(f + b"\0")' >"$T/want" 2>"$T/notes" || { echo "ERROR listing $p"; bad=1; continue; }
  cat "$T/notes"
  # What restic would save with the real excludes.
  restic backup --dry-run --json -vv --one-file-system --exclude-caches \
      --exclude-file "$EXC" "$p" 2>"$T/err" | python3 -I -c '
import sys, json
for line in sys.stdin:
    try: m = json.loads(line)
    except ValueError: continue
    if m.get("message_type") == "verbose_status" and m.get("action") in ("new", "unchanged", "modified"):
        item = m.get("item", "")
        if not item.endswith("/"): sys.stdout.buffer.write(item.encode("utf-8", "surrogateescape") + b"\0")' >"$T/got"
  rc=("${PIPESTATUS[@]}")
  if [ "${rc[0]}" != 0 ] && [ "${rc[0]}" != 3 ]; then
    echo "ERROR restic dry run on $p failed (exit ${rc[0]}): $(tail -1 "$T/err")"; bad=1; continue
  fi
  missing=$(python3 -I - "$T/want" "$T/got" <<'PY'
import sys, os
want = set(open(sys.argv[1], "rb").read().split(b"\0")) - {b""}
got = set(open(sys.argv[2], "rb").read().split(b"\0")) - {b""}
# A file deleted between the listing and the dry run (live state) is not a gap.
miss = sorted(f for f in want - got if os.path.lexists(f))
print(len(miss), len(want), (miss[0].decode("utf-8", "replace") if miss else ""))
PY
)
  read -r nmiss nwant first <<<"$missing"
  if [ "$nmiss" != 0 ]; then echo "UNCOVERED $p: restic would skip $nmiss of $nwant files (first: $first)"; bad=1; continue; fi
  echo "covered $p (include $root, restic saves all $nwant files)"
done
exit "$bad"
