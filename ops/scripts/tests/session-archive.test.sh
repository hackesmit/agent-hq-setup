#!/usr/bin/env bash
# session-archive.test.sh (hq-0yagv.1): fixture test for session-archive.sh.
# Run: bash session-archive.test.sh   (exit 0 = pass)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SA="${SA_SH:-$HERE/../session-archive.sh}"
[ -x "$SA" ] || { echo "FAIL cannot find $SA"; exit 1; }
R="$(mktemp -d)"; trap 'chmod -R u+rw "$R" 2>/dev/null; rm -rf "$R"' EXIT
export SA_SRC="$R/src" SA_DEST="$R/dest"
fail=0
ok() { echo "ok   $1"; }
no() { echo "FAIL $1"; fail=1; }
run() { "$SA" "$@" >"$R/out" 2>"$R/err"; echo $?; }
snap() { (cd "$SA_DEST" && find . -name '*.zst' -printf '%p %s %T@\n' | sort); }
srcsnap() { (cd "$SA_SRC" && find . -type f -exec sha256sum {} + | sort; find . -printf '%p %T@\n' | sort); }

mkdir -p "$SA_SRC/projects/p1/sub/subagents" "$SA_SRC/projects/p1/sub/tool-results" "$SA_SRC/todos" "$SA_DEST"
chmod 0700 "$SA_DEST"
printf 'line1\nline2\n' > "$SA_SRC/projects/p1/a.jsonl"
head -c 100000 /dev/urandom > "$SA_SRC/projects/p1/sub/tool-results/blob.txt"
echo '{}' > "$SA_SRC/projects/p1/sub/subagents/agent-1.jsonl"
echo '[]' > "$SA_SRC/todos/t.json"
echo 'hist' > "$SA_SRC/history.jsonl"

before="$(srcsnap)"
[ "$(run)" = 0 ] && ok "first run exits 0" || no "first run: $(cat "$R/err")"
[ "$(run --verify)" = 0 ] && ok "verify passes after first run" || no "verify: $(cat "$R/err")"
s1="$(snap)"
[ "$(run)" = 0 ] && [ "$(snap)" = "$s1" ] && ok "rerun changes no archive file" || no "rerun changed archive"
[ "$(srcsnap)" = "$before" ] && ok "source untouched" || no "source modified"
[ "$(stat -c %a "$SA_DEST/manifest.tsv")" = 600 ] && [ "$(stat -c %a "$SA_DEST/projects/p1")" = 700 ] \
  && [ "$(stat -c %a "$SA_DEST/projects/p1/a.jsonl.zst")" = 600 ] && ok "modes 0700/0600" || no "modes"
grep -q $'^projects/p1/a.jsonl\t12\t' "$SA_DEST/manifest.tsv" && ok "manifest row" || no "manifest row"
grep -q "disk use" "$R/out" && ok "disk use printed" || no "disk use missing"

# grew: append -> replaced, still one copy
echo line3 >> "$SA_SRC/projects/p1/a.jsonl"
[ "$(run)" = 0 ] && [ "$(zstd -dc "$SA_DEST/projects/p1/a.jsonl.zst")" = "$(cat "$SA_SRC/projects/p1/a.jsonl")" ] \
  && [ "$(ls "$SA_DEST"/projects/p1/a.jsonl* | wc -l)" = 1 ] && ok "grown file replaced" || no "grown file"

# diverged: same length class but different head -> both kept
printf 'XXXXX\nline2\nline3\nmore\n' > "$SA_SRC/projects/p1/a.jsonl"
[ "$(run)" = 0 ] && [ "$(ls "$SA_DEST"/projects/p1/a.jsonl* | wc -l)" = 2 ] && ok "diverged keeps both" || no "diverged"
s2="$(snap)"; [ "$(run)" = 0 ] && [ "$(snap)" = "$s2" ] && ok "diverged rerun idempotent" || no "diverged rerun"

# shrunk: truncate -> both kept, original archive copy intact
printf 'line1\n' > "$SA_SRC/projects/p1/sub/subagents/agent-1.jsonl.tmp"; mv "$SA_SRC/projects/p1/sub/subagents/agent-1.jsonl.tmp" "$SA_SRC/projects/p1/sub/subagents/agent-1.jsonl"
printf 'aaaa\nbbbb\ncccc\n' > "$SA_SRC/projects/p1/b.jsonl"; run >/dev/null
printf 'aaaa\n' > "$SA_SRC/projects/p1/b.jsonl"
[ "$(run)" = 0 ] && grep -q shrank "$R/err" && [ "$(zstd -dc "$SA_DEST/projects/p1/b.jsonl.zst" | wc -c)" = 15 ] \
  && [ "$(ls "$SA_DEST"/projects/p1/b.jsonl* | wc -l)" = 2 ] && ok "shrunk keeps both copies" || no "shrunk"

# unreadable source -> non-zero
if [ "$(id -u)" != 0 ]; then
  echo secret > "$SA_SRC/projects/p1/locked.jsonl"; chmod 000 "$SA_SRC/projects/p1/locked.jsonl"
  [ "$(run)" != 0 ] && grep -q unreadable "$R/err" && ok "unreadable source exits non-zero" || no "unreadable"
  rm -f "$SA_SRC/projects/p1/locked.jsonl"
fi

# archive dir missing / not writable -> exit 2, nothing created
SA_DEST="$R/nodir" "$SA" >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && [ ! -e "$R/nodir" ] && ok "missing archive dir exits 2" || no "missing dir rc=$rc"
mkdir "$R/ro"; chmod 500 "$R/ro"
if [ "$(id -u)" != 0 ]; then SA_DEST="$R/ro" "$SA" >/dev/null 2>&1; [ $? = 2 ] && ok "unwritable archive exits 2" || no "unwritable"; fi

# low disk and size cap
SA_MIN_FREE_GB=99999999 "$SA" >/dev/null 2>&1; [ $? = 2 ] && ok "low disk exits 2" || no "low disk"
SA_MAX_GB=0 "$SA" >/dev/null 2>&1; [ $? = 3 ] && ok "size cap exits 3" || no "size cap"

# verify accepts a source whose current bytes live in a kept-both copy (review round 1, B1)
[ "$(run --verify)" = 0 ] && ok "verify passes after diverge and shrink" || no "verify after diverge: $(cat "$R/err")"

# a held lock refuses a second run
exec 8> "$SA_DEST/.lock"; flock -n 8
[ "$(run)" = 2 ] && grep -q "holds" "$R/err" && ok "concurrent run refused" || no "lock not enforced"
exec 8>&-

# a missing or symlinked projects dir fails instead of archiving nothing
mkdir -p "$R/empty"; SA_SRC="$R/empty" "$SA" >/dev/null 2>&1; [ $? = 1 ] && ok "missing projects dir exits 1" || no "missing projects dir"
mkdir -p "$R/linked"; ln -s "$SA_SRC/projects" "$R/linked/projects"
SA_SRC="$R/linked" "$SA" >/dev/null 2>&1; [ $? = 1 ] && ok "symlinked projects dir exits 1" || no "symlinked projects dir"

# verify detects a damaged archive
printf 'junk' | zstd -q -c > "$SA_DEST/todos/t.json.zst"
[ "$(run --verify)" != 0 ] && ok "verify catches corruption" || no "verify missed corruption"

[ "$fail" = 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$fail"
