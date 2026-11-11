#!/usr/bin/env bash
# lucy-bg.sh (hq-4npjr.14): start a lucy review detached and return at once.
# A review_sizing call must never wait on a review (it hit the 1200 s timeout on
# 2026-11-04). This wrapper forks lucy into the background; when lucy ends, it
# comments the result on the bead and emits a review_verdict event:
#   VERDICT: SHIP            -> verdict=approve
#   VERDICT: REVISE | BLOCK  -> verdict=block
#   exit 4 to 7, no VERDICT  -> verdict=lucy-did-not-run (the coordinator then uses
#                               the substitute reviewer rule, CLAUDE.md invariant 6)
# One run per bead per UTC day: a second call prints "already started" and starts
# nothing, so a retried review_sizing never spends on lucy twice.
#
# The child runs in its OWN transient systemd user unit (systemd-run --user), not
# under the caller: hq-orchestrator.service is Type=oneshot KillMode=control-group,
# so a setsid child left in its cgroup died when the runner's run ended and the
# verdict was lost (round 1 review of hq-4npjr.14). systemd-run starts the unit with
# a clean environment, so PATH, HOME, LANG and every HQ_*, LUCY_* and PROTON_PASS_*
# variable is passed on. No user manager (no systemd-run or no user bus): falls
# back to setsid with a warning, which survives only outside a systemd service.
#
# Usage: lucy-bg.sh --bead ID [lucy args ...]     (args pass to lucy; --bead is added)
#   A worker branch: lucy-bg.sh --bead ID --rig R --base main --branch <branch> "<change + DoD>"
#   Every call needs a parsed, non-empty --branch or --diff-file value, with or without
#   --rig, and every valued option needs a real operand (not empty, not "-"-shaped);
#   anything else is refused here, at once (exit 2, no mark, no fork), and in --child
#   too: the child runs from $ROOT, whose working tree is never the caller's, so it
#   never reviews a working tree (hq-40n2x.1, hq-40n2x.2).
# Env (tests): HQ_ROOT, HQ_LUCY_BIN, HQ_ORCH_RUN, HQ_BD, HQ_ORCH_DIR
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${HQ_ROOT:-$(cd "$HERE/../.." && pwd)}"
LUCY="${HQ_LUCY_BIN:-$HERE/lucy.sh}"
ORUN="${HQ_ORCH_RUN:-$HERE/orchestrator-run.sh}"
BD="${HQ_BD:-bd}"
D="${HQ_ORCH_DIR:-$ROOT/state/orchestrator}"

bead=""; args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --bead) [ $# -ge 2 ] || { echo "lucy-bg: --bead needs an ID" >&2; exit 2; }
            bead="$2"; shift 2;;
    --child) child=1; shift;;
    *) args+=("$1"); shift;;
  esac
done
[[ "$bead" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "lucy-bg: --bead ID required" >&2; exit 2; }
child="${child:-}"
# Structural scan, mirroring review.sh: each valued option consumes the next token,
# which must exist, be non-empty and not start with "-". Only a parsed non-empty
# --branch or --diff-file value passes; a bare flag word, an empty value or one a
# preceding option swallowed does not (hq-40n2x.2). Unknown --options are left to
# review.sh and never satisfy the guard. The --child path runs the same scan.
sbranch=""; sdiff=""; set -- ${args[@]+"${args[@]}"}
while [ $# -gt 0 ]; do
  case "$1" in
    --rig|--base|--branch|--model|--effort|--diff-file|--self-test-response)
      if [ $# -lt 2 ] || [ -z "$2" ] || [[ "$2" == -* ]]; then
        echo "lucy-bg: refused: $1 needs a value" >&2; exit 2
      fi
      case "$1" in --branch) sbranch="$2";; --diff-file) sdiff="$2";; esac
      shift 2;;
    *) shift;;
  esac
done
if [ -z "$sbranch" ] && [ -z "$sdiff" ]; then
  echo "lucy-bg: refused: needs a --branch <worker branch> or --diff-file value; the child runs from $ROOT, never in the caller's tree" >&2
  exit 2
fi

if [ -z "$child" ]; then
  mkdir -p "$D/lucy-started" || exit 1
  mark="$D/lucy-started/$bead-$(date -u +%Y-%m-%d)"
  if ! ( set -o noclobber; echo "$$ $(date -u +%FT%TZ)" >"$mark" ) 2>/dev/null; then
    echo "lucy-bg: already started for $bead today; nothing started"
    exit 0
  fi
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  out="$D/lucy-started/$bead-$stamp.out"
  self="$HERE/$(basename "$0")"
  unit="lucy-bg-$(printf '%s' "$bead" | tr -c 'A-Za-z0-9_-' '-')-$stamp-$$"
  envs=()
  while IFS= read -r name; do envs+=("--setenv=$name"); done < <(
    compgen -e | grep -E '^(PATH|HOME|USER|LANG|LC_ALL|HQ_[A-Za-z0-9_]*|LUCY_[A-Za-z0-9_]*|PROTON_PASS_[A-Za-z0-9_]*)$')
  if command -v systemd-run >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1 &&
     systemd-run --user --quiet --collect --unit="$unit" --working-directory="$ROOT" \
       -p StandardInput=null -p "StandardOutput=append:$out" -p "StandardError=append:$out" \
       "${envs[@]}" -- "$self" --child --bead "$bead" ${args[@]+"${args[@]}"}; then
    echo "lucy-bg: started for $bead in unit $unit (output $out)"
  else
    echo "lucy-bg: no systemd user manager; falling back to setsid (dies with a oneshot caller)" >&2
    setsid nohup "$self" --child --bead "$bead" ${args[@]+"${args[@]}"} >"$out" 2>&1 </dev/null &
    echo "lucy-bg: started for $bead (output $out)"
  fi
  exit 0
fi

# child: run lucy in the foreground of this detached process
text="$("$LUCY" --bead "$bead" ${args[@]+"${args[@]}"} 2>&1)"; rc=$?
# keep the whole review on stdout (the unit appends it to the .out file); the bead
# comment below holds only the last 40 lines, which lost findings on hq-an7jw.4
printf '%s\n' "$text"
line="$(printf '%s\n' "$text" | grep -oE 'VERDICT[^A-Za-z0-9]*(SHIP|REVISE|BLOCK)\b' | tail -1)"
v="$(printf '%s' "$line" | grep -oE '(SHIP|REVISE|BLOCK)$')"
if [ "$rc" -eq 0 ] && [ "$v" = SHIP ]; then verdict=approve
elif [ "$rc" -eq 0 ] && { [ "$v" = REVISE ] || [ "$v" = BLOCK ]; }; then verdict=block
else verdict=lucy-did-not-run; fi
if [ "$verdict" = lucy-did-not-run ]; then
  note="Lucy-Result: lucy did not run (exit $rc); use the substitute reviewer rule (invariant 6)"
else
  note="Lucy-Result: VERDICT $v"
fi
"$BD" comment "$bead" "$note"$'\n'"$(printf '%s\n' "$text" | tail -40)" >/dev/null 2>&1 || true
"$ORUN" emit review_verdict "bead=$bead" "verdict=$verdict" source=lucy >/dev/null
