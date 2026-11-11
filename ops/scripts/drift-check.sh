#!/usr/bin/env bash
# drift-check.sh [--json] [--boot] [--only a,b] [--notify] [--list]
#
# Declared versus running (hq-fgg3.1). The checks live in drift_check.py beside
# this file; this wrapper adds --notify for the boot unit: on drift it sends ONE
# urgent notify (ops/scripts/notify.sh) with the first items and exits 0, so the
# alert is not doubled by OnFailure. It exits non-zero only when the checker
# itself breaks (2 usage, 3 manifest unreadable) or the notify cannot be sent,
# which is what OnFailure is for.
#
# Exit codes without --notify: 0 clean, 1 drift, 2 usage, 3 manifest unreadable.
# Declarations: ops/config/runtime.json. Where it runs: hq-drift-boot.timer
# (boot), the daily [HQ-DIGEST] (ops/mail/hq_mail/drift.py), the weekly stack
# review (ops/reviews/weekly-stack-review.sh) and finish.sh (refuses a merge
# that adds a drift item; HQ_DRIFT_BLOCK=0 overrides).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
notify=0; args=()
for a in "$@"; do
  case "$a" in
    --notify) notify=1 ;;
    *) args+=("$a") ;;
  esac
done
if [ "$notify" = 0 ]; then
  exec python3 "$HERE/drift_check.py" "${args[@]+"${args[@]}"}"
fi
out="$(python3 "$HERE/drift_check.py" "${args[@]+"${args[@]}"}" 2>&1)"; rc=$?
printf '%s\n' "$out"
case "$rc" in
  0) exit 0 ;;
  1) n="$(printf '%s\n' "$out" | grep -c '^  \[[A-Z]*\] ')"
     body="$(printf '%s\n' "$out" | grep '^  \[[A-Z]*\] ' | head -5 | cut -c3-200)"
     "${HQ_NOTIFY:-$HERE/notify.sh}" urgent "Drift at boot: $n item(s)" \
       "$body
Full list: ops/scripts/drift-check.sh" || { echo "drift-check: notify failed" >&2; exit 4; }
     exit 0 ;;
  *) exit "$rc" ;;
esac
