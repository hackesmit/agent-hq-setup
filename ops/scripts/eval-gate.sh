#!/usr/bin/env bash
# eval-gate.sh <repo-dir> <base> <target>
# Chatbot eval gate (hq-43e6.3). A repo that ships a chatbot lists, in
# evals/prompt-files.txt, the files that decide how the bot behaves (prompt,
# tool definitions, model, call parameters, client tool loop). When a merge of
# <target> into <base> touches one of those files, or the list itself, this
# refuses unless the bot's eval passed on exactly that content: the eval writes
# state/evals/<repo>/<H>.json with pass:true only when every case passed, and H
# is a hash of the listed files AS THEY WILL BE after the merge.
#
# H: each list line is trimmed (CR, leading and trailing whitespace, a leading
# "./"); a last line without a newline still counts; empty
# lines and lines starting with # are skipped. For each remaining path, in file
# order, the line "<path> <sha256hex(content)>\n", or "<path> missing\n" when
# the file does not exist; H = sha256hex of the concatenation. Contract one-liner
# (run at the repo root; must give the same H):
#   sed 's/\r$//;s/^[[:space:]]*//;s/[[:space:]]*$//;s#^\./##' evals/prompt-files.txt | grep -v '^#' | grep -v '^$' |
#   while IFS= read -r p || [ -n "$p" ]; do if [ -f "$p" ]; then s=$(sha256sum < "$p" | cut -d' ' -f1); else s=missing; fi;
#   printf '%s %s\n' "$p" "$s"; done | sha256sum | cut -d' ' -f1
# Computed here from git blobs of the would-be merge result, so a merge that pulls
# in someone else's prompt change needs a fresh eval too. Symlinks are not
# supported in the list (git hashes the link text, the one-liner the target).
# A list with no paths hashes the empty stream. Directory lines are refused.
#
# Exit 0: no list, nothing listed changed, a matching receipt, or HQ_EVAL_BLOCK=0.
# Exit 6: refuse (reason on stderr). Fails CLOSED once a list exists on either
# side: a merge result that cannot be built for any reason other than a content
# conflict (which the real merge then reports) refuses too.
set -uo pipefail
repo="${1:?repo dir}"; base="${2:?base}"; target="${3:?target}"
HQ="${HQ_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
EVAL_DIR="${HQ_EVAL_DIR:-$HQ/state/evals}"
g=(git -C "$repo")
LIST=evals/prompt-files.txt

refuse(){ echo "eval-gate: $1" >&2; if [ "${HQ_EVAL_BLOCK:-1}" = 0 ]; then echo "eval-gate: HQ_EVAL_BLOCK=0, merging anyway" >&2; exit 0; fi; exit 6; }
# Not a chatbot repo unless the list exists on one side; only then is anything enforced.
"${g[@]}" cat-file -e "$base:$LIST" 2>/dev/null || "${g[@]}" cat-file -e "$target:$LIST" 2>/dev/null || exit 0
mt="$("${g[@]}" merge-tree --write-tree "$base" "$target" 2>/dev/null)"; mrc=$?
tree="$(printf '%s\n' "$mt" | head -1)"
# merge-tree exits 1 on a content conflict: the real merge fails and reports it.
[ "$mrc" = 1 ] && { echo "eval-gate: merge conflict, leaving it to the merge" >&2; exit 0; }
[ "$mrc" = 0 ] && [ -n "$tree" ] || refuse "could not build the merge result (merge-tree rc=$mrc); refusing rather than skipping"

trimlist(){ sed 's/\r$//;s/^[[:space:]]*//;s/[[:space:]]*$//;s#^\./##' | grep -v '^#' | grep -v '^$'; }
# Removing the list is itself a change to the bot's gate: refuse it like one.
if ! list="$("${g[@]}" show "$tree:$LIST" 2>/dev/null)"; then
  refuse "the merge deletes $LIST, which turns the chatbot eval gate off"
fi
# A UTF-8 BOM would glue itself to the first path, which then never matches.
printf '%s' "$list" | head -c3 | grep -q $'\xef\xbb\xbf' && refuse "$LIST starts with a UTF-8 BOM; save it without one"
paths="$(printf '%s\n' "$list" | trimlist)"
# Listed paths from BOTH sides, so a path dropped from the list in the same merge still counts.
base_paths="$("${g[@]}" show "$base:$LIST" 2>/dev/null | trimlist)"

# Files only, checked before anything can pass: a directory line would never
# match the per-file diff, so changes under it would go unseen.
# Canonical repo-relative spellings only (no /, ./, ../, // left after the
# one ./ the trim drops): any other spelling would never match git's diff.
while IFS= read -r p; do
  [ -n "$p" ] || continue
  printf '%s' "$p" | grep -Eq '(^/)|(^|/)\.{1,2}(/|$)|//' && refuse "$LIST has a non-canonical path ($p); write it as git prints it"
  [ "$("${g[@]}" cat-file -t "$tree:$p" 2>/dev/null)" = tree ] && refuse "$LIST lists a directory ($p); list files only"
done <<<"$( { printf '%s\n' "$paths"; printf '%s\n' "$base_paths"; } )"

# --no-renames: a rename shows both paths, so moving a listed file is a change to it.
# -z: never quoted, so a path with accents (core.quotePath) still matches the list.
changed="$("${g[@]}" diff --no-renames --name-only -z "$base" "$tree" 2>/dev/null | tr '\0' '\n')"
hits="$( { printf '%s\n' "$paths"; printf '%s\n' "$base_paths"; echo "$LIST"; } | sort -u | grep -Fxf - <(printf '%s\n' "$changed") || true)"
[ -n "$hits" ] || exit 0

h="$(while IFS= read -r p; do
       [ -n "$p" ] || continue   # an empty list hashes the empty stream, like the one-liner
       if [ "$("${g[@]}" cat-file -t "$tree:$p" 2>/dev/null)" = blob ]; then
         s="$("${g[@]}" show "$tree:$p" | sha256sum | cut -d' ' -f1)"
       else s=missing; fi
       printf '%s %s\n' "$p" "$s"
     done <<<"$paths" | sha256sum | cut -d' ' -f1)"

for f in "$EVAL_DIR"/*/"$h".json; do
  [ -f "$f" ] || continue
  if [ "$(jq -r '.pass == true and .hash == $h' --arg h "$h" "$f" 2>/dev/null)" = true ]; then
    echo "eval-gate: eval receipt found for the chatbot files ($f)" >&2; exit 0
  fi
done

echo "eval-gate: the merge changes chatbot behavior files without a passing eval on that content:" >&2
printf '%s\n' "$hits" | sed 's/^/  /' >&2
refuse "expected receipt: $EVAL_DIR/<repo>/$h.json with pass:true (run the repo's eval on the branch, rebased on the default)"
