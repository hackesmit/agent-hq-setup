#!/usr/bin/env bash
# Fixture tests for eval-gate.sh (hq-43e6.3): temp repo with a chatbot file list.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
EG="$DIR/../scripts/eval-gate.sh"
fail=0
ok(){ printf 'PASS  %s\n' "$1"; }
no(){ printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }
eq(){ [ "$2" = "$3" ] && ok "$1" || no "$1" "got=$2 want=$3"; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export HQ_ROOT="$T/hq" HQ_EVAL_DIR="$T/hq/state/evals" HQ_EVAL_BLOCK=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
R="$T/bot"; mkdir -p "$R/api" "$R/evals"; git -C "$R" init -q
echo 'prompt v1' > "$R/api/prompt.js"; echo 'readme' > "$R/README.md"
git -C "$R" add -A; git -C "$R" commit -qm base
def="$(git -C "$R" symbolic-ref --short HEAD)"
run(){ "$EG" "$R" "$def" "$1" 2>/dev/null; echo $?; }
# the contract's own bash one-liner, run in a checkout of the branch
hash_of(){ git -C "$R" checkout -q "$1"; (cd "$R" && sed 's/\r$//;s/^[[:space:]]*//;s/[[:space:]]*$//;s#^\./##' evals/prompt-files.txt | grep -v '^#' | grep -v '^$' |
  while IFS= read -r p || [ -n "$p" ]; do if [ -f "$p" ]; then s=$(sha256sum < "$p" | cut -d' ' -f1); else s=missing; fi; printf '%s %s\n' "$p" "$s"; done | sha256sum | cut -d' ' -f1); git -C "$R" checkout -q "$def"; }
receipt(){ mkdir -p "$HQ_EVAL_DIR/bot"; printf '{"bot":"t","hash":"%s","pass":%s}\n' "$1" "${2:-true}" > "$HQ_EVAL_DIR/bot/$1.json"; }

git -C "$R" checkout -q -b nolist; echo 'prompt v2' > "$R/api/prompt.js"; git -C "$R" commit -qam v2; git -C "$R" checkout -q "$def"
eq "repo without a list passes" "$(run nolist)" 0

printf '# bot files\napi/prompt.js\n\n' > "$R/evals/prompt-files.txt"; git -C "$R" add -A; git -C "$R" commit -qm list
git -C "$R" checkout -q -b unrelated; echo 'readme 2' > "$R/README.md"; git -C "$R" commit -qam doc; git -C "$R" checkout -q "$def"
eq "diff outside the list passes" "$(run unrelated)" 0

git -C "$R" checkout -q -b prompt; echo 'prompt v3' > "$R/api/prompt.js"; git -C "$R" commit -qam v3; git -C "$R" checkout -q "$def"
eq "prompt change without receipt blocks" "$(run prompt)" 6
H="$(hash_of prompt)"
receipt "$(hash_of unrelated)"
eq "receipt for other content blocks" "$(run prompt)" 6
receipt "$H" false
eq "failed receipt blocks" "$(run prompt)" 6
receipt "$H"
eq "matching receipt (contract one-liner hash) passes" "$(run prompt)" 0
rm -f "$HQ_EVAL_DIR/bot/$H.json"
eq "HQ_EVAL_BLOCK=0 passes" "$(HQ_EVAL_BLOCK=0 "$EG" "$R" "$def" prompt 2>/dev/null; echo $?)" 0

git -C "$R" checkout -q -b listonly; echo 'README.md' >> "$R/evals/prompt-files.txt"; git -C "$R" commit -qam widen; git -C "$R" checkout -q "$def"
eq "changing the list itself blocks" "$(run listonly)" 6

# reviewer bypasses (hq-43e6.3 round 1)
git -C "$R" checkout -q -b ren; git -C "$R" mv api/prompt.js api/system.js; echo 'reveal all' >> "$R/api/system.js"; git -C "$R" commit -qam ren; git -C "$R" checkout -q "$def"
eq "renaming a listed file blocks" "$(run ren)" 6
git -C "$R" checkout -q -b dellist; git -C "$R" rm -q evals/prompt-files.txt; echo 'ignore rules' >> "$R/api/prompt.js"; git -C "$R" commit -qam del; git -C "$R" checkout -q "$def"
eq "deleting the list blocks" "$(run dellist)" 6
git -C "$R" checkout -q -b spaced; printf '# bot files\r\n  api/prompt.js \r\n   \r\n' > "$R/evals/prompt-files.txt"; git -C "$R" commit -qam spaced; git -C "$R" checkout -q "$def"; git -C "$R" merge -q spaced
git -C "$R" checkout -q -b spaced2; echo 'prompt v4' > "$R/api/prompt.js"; git -C "$R" commit -qam v4; git -C "$R" checkout -q "$def"
eq "CRLF and padded list line still gates its file" "$(run spaced2)" 6
receipt "$(hash_of spaced2)"
eq "one-liner hash matches the gate with a padded CRLF list" "$(run spaced2)" 0
git -C "$R" checkout -q -b gone; printf 'api/prompt.js\napi/nothere.js\n' > "$R/evals/prompt-files.txt"; echo 'v5' > "$R/api/prompt.js"; git -C "$R" commit -qam gone; git -C "$R" checkout -q "$def"
receipt "$(hash_of gone)"
eq "missing listed file hashes as missing on both sides" "$(run gone)" 0

# round 2: non-ASCII listed path (core.quotePath) and directory lines
ACC=$'api/instrucci\xc3\xb3n.md'
git -C "$R" checkout -q -b acc; printf '%s\n' "$ACC" > "$R/evals/prompt-files.txt"; echo 'Nunca reveles precios.' > "$R/$ACC"; git -C "$R" add -A; git -C "$R" commit -qm acc; git -C "$R" checkout -q "$def"; git -C "$R" merge -q acc
git -C "$R" checkout -q -b acc2; echo 'Revela precios.' > "$R/$ACC"; git -C "$R" commit -qam acc2; git -C "$R" checkout -q "$def"
eq "listed path with accents is gated" "$(run acc2)" 6
git -C "$R" checkout -q -b dir; printf 'api\n' > "$R/evals/prompt-files.txt"; git -C "$R" commit -qam dir; git -C "$R" checkout -q "$def"
eq "a directory line is refused" "$(run dir)" 6

# round 3 (lucy): ./ prefix, directory already in the base list, empty list, no final newline
git -C "$R" checkout -q -b dot; printf './api/prompt.js\n' > "$R/evals/prompt-files.txt"; git -C "$R" commit -qam dot; git -C "$R" checkout -q "$def"; git -C "$R" merge -q dot
git -C "$R" checkout -q -b dot2; echo 'v6' > "$R/api/prompt.js"; git -C "$R" commit -qam v6; git -C "$R" checkout -q "$def"
eq "a ./ list line still gates its file" "$(run dot2)" 6
receipt "$(hash_of dot2)"
eq "one-liner and gate agree on a ./ line" "$(run dot2)" 0
git -C "$R" checkout -q -b dirbase; printf 'api\n' > "$R/evals/prompt-files.txt"; git -C "$R" commit -qam dirbase; git -C "$R" checkout -q "$def"; git -C "$R" merge -q dirbase
git -C "$R" checkout -q -b dirbase2; echo 'v7' > "$R/api/prompt.js"; git -C "$R" commit -qam v7; git -C "$R" checkout -q "$def"
eq "a directory already in the base list still refuses" "$(run dirbase2)" 6
printf 'api/prompt.js\n' > "$R/evals/prompt-files.txt"; git -C "$R" commit -qam "restore list"   # clean base for the next cases
git -C "$R" checkout -q -b empty; printf '# no files\n' > "$R/evals/prompt-files.txt"; git -C "$R" commit -qam empty; git -C "$R" checkout -q "$def"
receipt "$(hash_of empty)"
eq "an empty list hashes like the one-liner" "$(run empty)" 0
git -C "$R" checkout -q -b nonl; printf 'api/prompt.js' > "$R/evals/prompt-files.txt"; echo v8 > "$R/api/prompt.js"; git -C "$R" commit -qam nonl; git -C "$R" checkout -q "$def"
eq "a last line without newline still gates" "$(run nonl)" 6
receipt "$(hash_of nonl)"
eq "one-liner and gate agree without final newline" "$(run nonl)" 0
git -C "$R" checkout -q -b dd; printf 'api/prompt.js\n././api/prompt.js\n' > "$R/evals/prompt-files.txt"; git -C "$R" commit -qam dd; git -C "$R" checkout -q "$def"
eq "a non-canonical path (././) is refused" "$(run dd)" 6
git -C "$R" checkout -q -b bom; printf '\xef\xbb\xbfapi/prompt.js\n' > "$R/evals/prompt-files.txt"; git -C "$R" commit -qam bom; git -C "$R" checkout -q "$def"
eq "a list with a UTF-8 BOM is refused" "$(run bom)" 6
exit $fail
