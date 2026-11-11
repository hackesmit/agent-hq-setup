#!/usr/bin/env bash
# Fixture: PASS and FLAG paths of session-eval-run.sh file no bead; weekly job files only on a repeated cause.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; S="$HERE/.."
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/ops/scripts" "$T/ops/metrics" "$T/bin"
cp "$S/session-eval-run.sh" "$S/session_eval_cause.py" "$T/ops/scripts/"
printf '#!/bin/sh\nexit 0\n' > "$T/ops/scripts/notify.sh"; chmod +x "$T/ops/scripts/notify.sh"
printf '#!/bin/sh\necho "$@" >> "%s/bd.calls"\n' "$T" > "$T/bin/bd"; chmod +x "$T/bin/bd"
fail() { echo "FAIL: $1"; exit 1; }
echo '{"packet":"x"}' > "$T/p.json"
run() { # $1 = model reply
  printf '#!/bin/sh\ncat <<"EOF2"\n%s\nEOF2\n' "$1" > "$T/bin/claude"; chmod +x "$T/bin/claude"
  PATH="$T/bin:$PATH" HOME="$T" bash "$T/ops/scripts/session-eval-run.sh" "$T/p.json" m hq "sid$2"; }
run '{"verdict":"PASS","confidence":0.9,"summary":"ok"}' 1
run '{"verdict":"FLAG","confidence":0.6,"summary":"drift","concerns":["Scope drift!"]}' 2
[ ! -e "$T/bd.calls" ] || fail "PASS or FLAG filed a bead"
grep -q 'verdict=FLAG.*detail=scope drift.cause=wrong-target$' "$T/ops/metrics/session-eval.log" || fail "FLAG concern not mapped to a class"
# a class from the list is kept, with the free detail beside it (hq-oq30g.1)
run '{"verdict":"FLAG","summary":"s","cause":"unverified-claim","detail":"no test run"}' 4
grep -q 'sid=sid4.*detail=no test run.cause=unverified-claim$' "$T/ops/metrics/session-eval.log" || fail "listed class not kept"
# an off-list cause maps by keyword; nothing matching lands in other
run '{"verdict":"FLAG","summary":"s","cause":"Edits in sibling worktree"}' 5
grep -q 'sid=sid5.*cause=wrong-target$' "$T/ops/metrics/session-eval.log" || fail "off-list cause not mapped"
run '{"verdict":"FLAG","summary":"s","cause":"public legal defaults"}' 6
grep -q 'sid=sid6.*cause=other$' "$T/ops/metrics/session-eval.log" || fail "unmatched cause not other"
grep -q 'sid=sid1.*cause=none$' "$T/ops/metrics/session-eval.log" || fail "PASS cause not none"
# fail-open: the class module missing still logs the verdict
mv "$T/ops/scripts/session_eval_cause.py" "$T/cause.bak"
run '{"verdict":"FLAG","summary":"s","cause":"x"}' 7
grep -q 'sid=sid7.*cause=other$' "$T/ops/metrics/session-eval.log" || fail "missing module blocked the log"
mv "$T/cause.bak" "$T/ops/scripts/session_eval_cause.py"
run '{"verdict":"ESCALATE","confidence":0.9,"summary":"bad","concerns":["leak"]}' 3
grep -q 'session-eval ESCALATE' "$T/bd.calls" || fail "ESCALATE filed no bead"
# weekly: one cause once -> nothing; twice -> a draft
L="$T/w.log"; N=$(date -Iseconds)
printf '%s\tsid=aaaaaaaa1\tmodel=m\tverdict=FLAG\tconf=0.5\ta\tcause=x\n' "$N" > "$L"
SESSION_EVAL_LOG="$L" bash "$S/session-eval-weekly.sh" --dry-run | grep -q 'no bead' || fail "single cause filed"
printf '%s\tsid=bbbbbbbb2\tmodel=m\tverdict=FLAG\tconf=0.5\tb\tcause=x\n' "$N" >> "$L"
SESSION_EVAL_LOG="$L" bash "$S/session-eval-weekly.sh" --dry-run | grep -q 'WOULD FILE' || fail "repeated cause not drafted"
# keyword map over old free-form causes (fixture taken from the 2026-10-30..11-06 log)
while IFS='|' read -r want cause; do
  got="$(python3 "$S/session_eval_cause.py" "$cause" | cut -f1)"
  [ "$got" = "$want" ] || fail "map '$cause' gave $got, want $want"
done <<'MAP'
unverified-claim|unverified green claim
unverified-claim|suiteclaim unverified
unverified-claim|pipe masks exit code
unverified-claim|test edited to pass
wrong-target|crossworktree mutation
wrong-target|reviewer scope drift
wrong-target|unscoped git add a
wrong-target|outofscope live access
live-side-effect|leftover docker container
live-side-effect|test leaked into live tmux
secret-handling|overbroad secret grep
review-process|samevendor review on security surface
review-process|approve before gaps closed
hook-friction|unexplained hook blocks
other|public legal defaults
MAP
# weekly: old free-form variants of one problem fold into one class; old and new lines mix
printf '%s\tsid=cccccccc3\tmodel=m\tverdict=FLAG\tconf=0.5\tc\tcause=unverified test fix\n' "$N" > "$L"
printf '%s\tsid=dddddddd4\tmodel=m\tverdict=FLAG\tconf=0.5\td\tdetail=no proof\tcause=unverified-claim\n' "$N" >> "$L"
printf '%s\tsid=eeeeeeee5\tmodel=m\tverdict=FLAG\tconf=0.5\te\tcause=public legal defaults\n' "$N" >> "$L"
O="$(SESSION_EVAL_LOG="$L" bash "$S/session-eval-weekly.sh" --dry-run)"
echo "$O" | grep -q 'Cause: unverified-claim (2 sessions)' || fail "old and new lines not folded by class"
echo "$O" | grep -q 'other' && fail "single other cause reported as a repeat"
echo PASS
