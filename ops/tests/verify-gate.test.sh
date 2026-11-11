#!/usr/bin/env bash
# Fixture tests for hook-verify-gate.sh: no close path skips the receipt gate.
#
# Until hq-pgbpq.12 (2026-11-03) the gate matched only `bd close <first-literal-id>`.
# A code bead with no receipt still closed through `bd done` (an alias), through
# `bd close -r "..." <id>` (a flag before the id), as the second id of a multi-id
# close, through `bd update --status closed`, `bd batch`, `bd duplicate`,
# `bd supersede`, or a raw `bd sql` write. bd 1.3's own close policy does not help:
# it checks open children and blockers, never receipts.
#
# Part 1 drives a stub `bd` over fake ledgers (fast, every path). Part 2 builds a REAL
# ledger with the bd on PATH (or $VERIFY_GATE_BD) and proves the same thing against
# the real `bd show` output, so a bd upgrade that changes that output fails here.
# VERIFY_GATE_SKIP_REAL=1 skips part 2 (it costs about 20s for `bd init`).
#
# Usage: bash ops/tests/verify-gate.test.sh
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="$(cd "$DIR/../.." && pwd)"
GATE="$HQ/ops/scripts/hook-verify-gate.sh"
REAL_BD="${VERIFY_GATE_BD:-$(command -v bd || true)}"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

fail=0
ok() { printf 'ok   %s\n' "$1"; }
no() { printf 'FAIL %s (%s)\n' "$1" "${2:-}"; fail=1; }

# gate <hq-dir> <command> -> prints the exit code. HOME is swapped so the hook's
# own PATH prepend ($HOME/.local/bin) cannot put the real bd ahead of the stub.
gate() {
  CMD="$2" python3 -c 'import json,os; print(json.dumps({"tool_name":"Bash","tool_input":{"command":os.environ["CMD"]}}))' \
    | HOME="$T/home" CLAUDE_PROJECT_DIR="$1" PATH="$T/bin:$PATH" bash "$GATE" >"$T/out" 2>&1
  echo $?
}
expect() { # <name> <want> <hq-dir> <command>
  local got; got="$(gate "$3" "$4")"
  if [ "$got" = "$2" ]; then ok "$1"; else no "$1" "got=$got want=$2: $(head -c 200 "$T/out")"; fi
}

# ------------------------------------------------------------ part 1: stub ----
FAKE="$T/hq"
mkdir -p "$FAKE/.beads" "$FAKE/rigs/rigx/.beads" "$T/bin" "$T/home"
cat > "$T/bin/bd" <<'EOS'
#!/usr/bin/env bash
# stub bd: `bd show <id>` succeeds only in the ledger that holds <id>.txt; a short id
# resolves like bd's own partial match when exactly one <prefix>-<short>* file exists
[ "${1:-}" = "show" ] && [ -n "${2:-}" ] || exit 1
f="$PWD/.beads/$2.txt"
if [ ! -r "$f" ]; then
  m=( "$PWD"/.beads/*-"$2"*.txt )
  [ "${#m[@]}" = 1 ] && [ -r "${m[0]}" ] || exit 1
  f="${m[0]}"
fi
cat "$f"
EOS
chmod +x "$T/bin/bd"
bead() { # <ledger-dir> <id> <files-owned> [receipt]
  { printf '%s - fixture   [P2 - OPEN]\nDESCRIPTION\n  Files owned: %s\n' "$2" "$3"
    [ -n "${4:-}" ] && printf 'COMMENTS\n  Verification: %s\n' "$4"
  } > "$1/.beads/$2.txt"
}
bead "$FAKE" hq-code "ops/scripts/x.sh"
bead "$FAKE" hq-good "ops/scripts/x.sh" "code - bash ops/tests/x.test.sh - 4 passed"
bead "$FAKE" hq-docs "docs/notes.md"
bead "$FAKE" hq-dup "ops/scripts/y.py" "not run - duplicate of hq-good"
bead "$FAKE/rigs/rigx" rx-code.1 "src/app.ts"
# a Proof contract whose real receipt bd show wrapped inside `copy-check`, next to the
# unfilled template line bd 1.3 now renders with its `<result>` placeholder intact
cat > "$FAKE/.beads/hq-wrap.txt" <<'EOS'
hq-wrap - fixture   [P2 - CLOSED]
DESCRIPTION
  Files owned: src/guide.ts
  - Proof: copy-check on the guide exits 0; vitest exits 0
  - Verification receipt emitted before close: Verification: code - copy-check +
  vitest + build - <result>
COMMENTS
  Verification: code - copy-
  check src/guide.ts exit 0 plus vitest 12 passed - ok
EOS
# a code bead with no receipt that is ALREADY closed: an import row cannot close it again
cat > "$FAKE/.beads/hq-shut.txt" <<'EOS'
hq-shut - fixture   [P2 - CLOSED]
DESCRIPTION
  Files owned: ops/scripts/z.sh
EOS
cat > "$FAKE/.beads/hq-tmplonly.txt" <<'EOS'
hq-tmplonly - fixture   [P2 - OPEN]
DESCRIPTION
  Files owned: src/guide.ts
  - Proof: copy-check on the guide exits 0
  - Verification receipt emitted before close: Verification: code - copy-check +
  vitest + build - <result>
EOS

# a code bead with no receipt is blocked on EVERY close path
for c in \
  "bd close hq-code" \
  "bd done hq-code" \
  'bd close -r "fixed it" hq-code' \
  "bd close --reason=x hq-code" \
  "bd close hq-good hq-code" \
  "bd --actor me close hq-code" \
  "bd -C /tmp close hq-code" \
  "~/.local/bin/bd close hq-code" \
  "BEADS_ACTOR=x bd close hq-code" \
  "cd /tmp && bd close hq-code && echo ok" \
  'bash -c "bd close hq-code"' \
  "bd update hq-code --status closed" \
  "bd update hq-code -s closed" \
  "bd update --status=closed hq-code" \
  "bd update hq-code -sclosed" \
  "bd update hq-code --status closed --force" \
  "bd update hq-code --status done" \
  'bd update hq-code --status "$S"' \
  "bd batch <<'EOF'
close hq-code finished
EOF" \
  "bd batch <<'EOF'
update hq-code status=closed
EOF" \
  "printf 'close hq-code x\\n' | bd batch" \
  "bd duplicate hq-code --of hq-good" \
  "bd supersede hq-code --with hq-good" \
  "bd sql \"UPDATE issues SET status='closed' WHERE id='hq-code'\"" \
  "bd close rx-code.1" \
  "bd update rx-code.1 --status closed" \
  "bd close hq-tmplonly" \
  $'bd close \\\nhq-code' \
  $'bd close -r x \\\n  hq-good \\\n  hq-code' \
  "bd todo done hq-code" \
  "bd todo --actor me done hq-code --reason x" \
  "bd close code" \
  "bd done code" \
  "bd update code --status closed" \
  "bd todo done code" \
  $'bd cl\\\nose hq-code' \
  $'bd update hq-code --sta\\\ntus closed' \
  $'bd update hq-code --status clo\\\nsed'
do
  expect "blocks: $(printf '%s' "$c" | tr '\n' ' ')" 2 "$FAKE" "$c"
done

# a close whose bead the gate cannot name fails closed
for c in \
  'bd close "$ID"' \
  'for b in hq-1 hq-2; do bd close $b; done' \
  "echo hq-code | xargs bd close" \
  "bd list -q | awk '{print \"close\",\$1}' | bd batch" \
  "bd batch -f $T/missing.txt" \
  "bd sql \"update issues set status='closed'\""
do
  expect "unresolved blocks: $c" 2 "$FAKE" "$c"
done
# round 2: short ids that resolve nowhere, epic close-eligible, unreadable imports
for c in \
  "bd close zzz" \
  "bd update zzz --status closed" \
  "bd epic close-eligible" \
  "bd epic close-eligible -r done" \
  "BD_LAST_TOUCHED_FALLBACK=1 bd close" \
  "bd import $T/missing.jsonl" \
  "cat $T/imp-close.jsonl | bd import -" \
  "bd import -i \"\$F\"" \
  "cd rigs/rigx && bd import"
do
  expect "unresolved blocks: $c" 2 "$FAKE" "$c"
done
# bd import: a row that moves an existing not-closed code bead to closed is a close
printf '%s\n' '{"_type":"issue","id":"hq-code","title":"fixture","status":"closed","updated_at":"2099-01-01T00:00:00Z"}' > "$T/imp-close.jsonl"
printf '%s\n' '{"_type":"memory","key":"k","value":"v"}' \
  '{"id":"hq-code","title":"fixture","status":"open"}' \
  '{"id":"hq-good","title":"fixture","status":"closed"}' \
  '{"id":"hq-shut","title":"fixture","status":"closed"}' \
  '{"id":"hq-brandnew","title":"fixture","status":"closed"}' \
  '{"id":"hq-code","title":"fixture","status":"tombstone"}' \
  'not json at all' > "$T/imp-noop.jsonl"
mkdir -p "$T/impdir/.beads" && cp "$T/imp-close.jsonl" "$T/impdir/.beads/issues.jsonl"
cp "$T/imp-noop.jsonl" "$FAKE/.beads/issues.jsonl"
for c in \
  "bd import $T/imp-close.jsonl" \
  "bd import -i $T/imp-close.jsonl" \
  "bd import --allow-stale $T/imp-close.jsonl" \
  "bd import - < $T/imp-close.jsonl" \
  "bd -C $T/impdir import" \
  "bd import - <<'EOF'
{\"id\":\"hq-code\",\"title\":\"x\",\"status\":\"closed\"}
EOF"
do
  expect "blocks: $(printf '%s' "$c" | tr '\n' ' ')" 2 "$FAKE" "$c"
done
# after a cd, pushd or popd a relative import path names a file the gate cannot see:
# the session cwd holds a same-named jsonl (rows closing nothing), the rig may not
for c in \
  "cd rigs/rigx && bd import .beads/issues.jsonl" \
  "cd rigs/rigx && bd import -i .beads/issues.jsonl" \
  "pushd rigs/rigx && bd import - < .beads/issues.jsonl" \
  "cd rigs/rigx; bd -C . import" \
  "(cd rigs/rigx && bd import .beads/issues.jsonl)" \
  'cd rigs/rigx && bash -c "bd import .beads/issues.jsonl"' \
  "popd && bd import .beads/issues.jsonl" \
  "builtin cd rigs/rigx && bd import .beads/issues.jsonl" \
  "command cd rigs/rigx && bd import .beads/issues.jsonl" \
  "sudo builtin cd rigs/rigx; bd import .beads/issues.jsonl" \
  "eval cd rigs/rigx; bd import .beads/issues.jsonl" \
  "eval 'cd rigs/rigx'; bd import .beads/issues.jsonl" \
  "eval builtin pushd rigs/rigx; bd import .beads/issues.jsonl" \
  "env -C rigs/rigx bd import .beads/issues.jsonl" \
  "env --chdir rigs/rigx bd import .beads/issues.jsonl" \
  "env --chdir=rigs/rigx bd import .beads/issues.jsonl" \
  "env -Crigs/rigx bd import .beads/issues.jsonl" \
  "env -i -C rigs/rigx bd import .beads/issues.jsonl"
do
  expect "unresolved blocks: $c" 2 "$FAKE" "$c"
done
printf 'close hq-code from a file\n' > "$T/ops.txt"
expect "blocks: bd batch -f <file naming the code bead>" 2 "$FAKE" "bd batch -f $T/ops.txt"
expect "blocks: bd batch < <file naming the code bead>" 2 "$FAKE" "bd batch < $T/ops.txt"

# no behavior regression: what passed before still passes
for c in \
  "bd close hq-good" \
  "bd done hq-good" \
  "bd update hq-good --status closed" \
  "bd close hq-docs" \
  "bd update hq-docs --status closed" \
  "bd duplicate hq-dup --of hq-good" \
  "bd close hq-wrap" \
  "bd close hq-nosuch" \
  "bd update hq-code --claim" \
  "bd update hq-code --status in_progress" \
  "bd update hq-code -s open" \
  "bd show hq-code" \
  'bd comment hq-code "will bd close hq-code later"' \
  "git commit -m 'bd close hq-code'" \
  'bd create "x" -d "done when bd update works"' \
  "bd batch <<'EOF'
update hq-code status=in_progress
close hq-good done
EOF" \
  "ls -la" \
  "bd close good" \
  "bd todo done hq-good" \
  'bd todo add "write the bd close docs"' \
  "bd todo" \
  "bd list --status closed" \
  "bd list --status=closed --json" \
  "echo bd close hq-code" \
  "grep -rn bd close notes/" \
  "rg 'bd close' ops/" \
  $'bd update hq-code \\\n  --claim' \
  "bd update code --claim" \
  "bd update code -s in_progress" \
  "bd epic close-eligible --dry-run" \
  "bd epic status" \
  "bd import $T/imp-noop.jsonl" \
  "bd import --dry-run $T/imp-close.jsonl" \
  "bd import" \
  "bd import .beads/issues.jsonl" \
  "cd rigs/rigx && bd import $T/imp-noop.jsonl" \
  "bd import .beads/issues.jsonl && cd rigs/rigx" \
  "cd rigs/rigx && bd -C $FAKE import .beads/issues.jsonl" \
  $'bd up\\\ndate hq-code --sta\\\ntus in_progress' \
  "bd export -o /tmp/x.jsonl"
do
  expect "passes: $(printf '%s' "$c" | tr '\n' ' ')" 0 "$FAKE" "$c"
done
# fd redirects are not bead ids (retro W45: 60 false unresolved blocks on `2>&1`)
for c in "bd close hq-good 2>&1" "bd close hq-good >/dev/null 2>&1" "bd close hq-good &>/dev/null" \
  "bd close hq-good -r done 2>&1 | tail -3" "bd close hq-good 2>/dev/null"
do
  expect "passes: $c" 0 "$FAKE" "$c"
done
expect "blocks, receipt not fd: bd close hq-code 2>&1" 2 "$FAKE" "bd close hq-code 2>&1"
got="$(HQ_VERIFY_BLOCK=0 gate "$FAKE" "bd update hq-code --status closed")"
[ "$got" = 0 ] && ok "HQ_VERIFY_BLOCK=0 is audit-only for update" || no "HQ_VERIFY_BLOCK=0 update" "got=$got"
got="$(HQ_VERIFY_BLOCK=0 gate "$FAKE" 'bd close "$ID"')"
[ "$got" = 0 ] && ok "HQ_VERIFY_BLOCK=0 is audit-only for unresolved" || no "HQ_VERIFY_BLOCK=0 unresolved" "got=$got"
gate "$FAKE" "bd close hq-good hq-code" >/dev/null
grep -q 'hq-code' "$T/out" && ! grep -q 'hq-good' "$T/out" \
  && ok "multi-id message names only the bead that lacks a receipt" \
  || no "multi-id message" "$(head -c 200 "$T/out")"
grep -q $'BLOCK\thq-code' "$FAKE/state/verify/gate.log" && ok "blocks are logged" || no "blocks are logged"

# ------------------------------------------------------------- part 2: real ----
if [ "${VERIFY_GATE_SKIP_REAL:-0}" = 1 ] || [ -z "$REAL_BD" ]; then
  printf 'skip real-bd part (%s)\n' "${REAL_BD:-no bd on PATH}"
else
  R="$T/real"; mkdir -p "$R" "$T/realbin"
  ln -s "$REAL_BD" "$T/realbin/bd"
  rb() { (cd "$R" && HOME="$T/home" BEADS_ACTOR=fixture BD_NON_INTERACTIVE=1 "$REAL_BD" "$@"); }
  git -C "$R" init -q
  if rb init --prefix fx --non-interactive -q >"$T/init.log" 2>&1; then
    printf 'real bd: %s\n' "$(rb version 2>/dev/null | head -1)"
    code="$(rb create "fixture code bead" -d "Files owned: ops/scripts/x.sh" -t task -p 2 --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
    docs="$(rb create "fixture docs bead" -d "Files owned: docs/x.md" -t task -p 2 --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
    realgate() { # <name> <want> <command>
      local got
      got="$(CMD="$3" python3 -c 'import json,os; print(json.dumps({"tool_name":"Bash","tool_input":{"command":os.environ["CMD"]}}))' \
        | HOME="$T/home" CLAUDE_PROJECT_DIR="$R" PATH="$T/realbin:$PATH" bash "$GATE" >"$T/out" 2>&1; echo $?)"
      if [ "$got" = "$2" ]; then ok "real: $1"; else no "real: $1" "got=$got want=$2: $(head -c 200 "$T/out")"; fi
    }
    realgate "code bead, no receipt: bd close blocks" 2 "bd close $code"
    realgate "code bead, no receipt: bd done blocks" 2 "bd done $code"
    realgate "code bead, no receipt: bd update --status closed blocks" 2 "bd update $code --status closed"
    realgate "docs bead, no receipt: bd update --status closed passes" 0 "bd update $docs --status closed"
    # round 2 paths, against real bd resolution and real JSONL
    short="${code#*-}"
    realgate "line continuation: bd close \\<newline> <id> blocks" 2 $'bd close \\\n'"$code"
    realgate "continuation inside a word: bd cl\\<newline>ose <id> blocks" 2 $'bd cl\\\nose '"$code"
    realgate "continuation inside a flag: --sta\\<newline>tus closed blocks" 2 "bd update $code "$'--sta\\\ntus closed'
    realgate "bd todo done <id> blocks" 2 "bd todo done $code"
    realgate "short id: bd close $short blocks" 2 "bd close $short"
    realgate "short id: bd update $short --status closed blocks" 2 "bd update $short --status closed"
    realgate "unresolvable short id blocks" 2 "bd close qqqqzz"
    realgate "bd epic close-eligible blocks" 2 "bd epic close-eligible"
    realgate "bd epic close-eligible --dry-run passes" 0 "bd epic close-eligible --dry-run"
    printf '{"_type":"issue","id":"%s","title":"fixture code bead","status":"closed","updated_at":"2099-01-01T00:00:00Z"}\n' "$code" > "$T/rimp-close.jsonl"
    printf '{"_type":"issue","id":"%s","title":"fixture code bead","status":"open"}\n{"_type":"issue","id":"fx-newrow","title":"new","status":"closed"}\n' "$code" > "$T/rimp-noop.jsonl"
    realgate "bd import of a row closing the code bead blocks" 2 "bd import $T/rimp-close.jsonl"
    realgate "bd import of rows closing nothing passes" 0 "bd import $T/rimp-noop.jsonl"
    # a cd moves the relative path: the session cwd's same-named file closes nothing
    mkdir -p "$R/sub" && cp "$T/rimp-noop.jsonl" "$R/same.jsonl" && cp "$T/rimp-close.jsonl" "$R/sub/same.jsonl"
    realgate "bd import same.jsonl from the session cwd passes" 0 "bd import same.jsonl"
    realgate "cd sub && bd import same.jsonl blocks" 2 "cd sub && bd import same.jsonl"
    for c in "builtin cd sub && bd import same.jsonl" "command cd sub && bd import same.jsonl" \
             "eval cd sub; bd import same.jsonl" "env -C sub bd import same.jsonl" \
             "env --chdir=sub bd import same.jsonl"; do
      realgate "$c blocks" 2 "$c"
    done
    realgate "bd update --claim passes" 0 "bd update $short --claim"
    rb comment "$code" "Verification: code - bash ops/tests/verify-gate.test.sh - all ok" >/dev/null 2>&1
    realgate "code bead with a receipt comment: bd close passes" 0 "bd close $code"
    realgate "code bead with a receipt comment: bd update --status closed passes" 0 "bd update $code --status closed"
    realgate "code bead with a receipt comment: short-id close passes" 0 "bd close $short"
    realgate "code bead with a receipt comment: bd import closing it passes" 0 "bd import $T/rimp-close.jsonl"
    # and bd itself still closes through the update path once the gate allows it
    rb update "$code" --status closed >/dev/null 2>&1
    st="$(rb show "$code" --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); d=d[0] if isinstance(d,list) else d; print(d.get("status"))')"
    [ "$st" = closed ] && ok "real: bd update --status closed closes the bead" || no "real: update closes" "status=$st"
  else
    no "real bd init" "$(tail -3 "$T/init.log")"
  fi
fi

[ "$fail" = 0 ] && echo "ALL PASS" || echo "SOME FAILED"
exit "$fail"
