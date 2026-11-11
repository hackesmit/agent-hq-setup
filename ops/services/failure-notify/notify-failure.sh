#!/usr/bin/env bash
# notify-failure.sh <unit> <user|system>
#
# Called through OnFailure= by hq-failure-notify@.service (user units) and
# hq-failure-notify-system@.service (system units, runs as owner). Sends one
# urgent notify for a failing unit with its last journal line, and rate-limits
# repeats of the same unit so a flapping timer (for example console-build
# losing a race with hub-sync) does not page on every run. The next alert
# after the window says how many failures were suppressed.
#
# HQ_FAILURE_NOTIFY_WINDOW  repeat window in seconds (default 86400 = 24 h)
# HQ_FAILURE_NOTIFY_STATE   stamp directory (default ~/hq/state/unit-failure)
set -uo pipefail
UNIT="${1:?usage: notify-failure.sh <unit> <user|system>}"
SCOPE="${2:-user}"
HQ="${HQ_ROOT:-$HOME/hq}"
STATE="${HQ_FAILURE_NOTIFY_STATE:-$HQ/state/unit-failure}"
WINDOW="${HQ_FAILURE_NOTIFY_WINDOW:-86400}"
mkdir -p "$STATE" 2>/dev/null || true

now="$(date +%s)"
stamp="$STATE/${UNIT//\//_}.stamp"
last=0; suppressed=0
if [ -f "$stamp" ]; then
  read -r last suppressed <"$stamp" || true
  last="${last:-0}"; suppressed="${suppressed:-0}"
fi
if [ $((now - last)) -lt "$WINDOW" ]; then
  echo "$last $((suppressed + 1))" >"$stamp"
  echo "suppressed repeat failure of $UNIT (alerted $((now - last))s ago)"
  exit 0
fi
if [ "$SCOPE" = "system" ]; then
  j=(journalctl -u "$UNIT"); hint="journalctl -u $UNIT"
else
  j=(journalctl --user -u "$UNIT"); hint="journalctl --user -u $UNIT"
fi
# last line the unit itself wrote, skipping systemd's own bookkeeping lines
lastline="$("${j[@]}" -n 30 --no-pager -o cat 2>/dev/null \
  | grep -v -E "^${UNIT//./\\.}: |^(Starting|Started|Finished|Stopped|Failed to start) " \
  | tail -n 1 | cut -c1-200)"
extra=""
[ "$suppressed" -gt 0 ] && extra=" ($suppressed more failures were suppressed since the last alert)"

msg="$SCOPE unit $UNIT failed on $(hostname -s)$extra. Last log: ${lastline:-none}. See: $hint"
# Deliver first, arm the dedupe window only after a delivery succeeded. A failed
# delivery leaves the stamp untouched (so the next failure alerts again) and
# exits nonzero so the failed notify unit is itself visible in systemctl --failed.
attempts="${HQ_FAILURE_NOTIFY_ATTEMPTS:-3}"
delay="${HQ_FAILURE_NOTIFY_RETRY_SLEEP:-5}"
for ((n = 1; n <= attempts; n++)); do
  if "$HQ/ops/scripts/notify.sh" urgent "HQ unit failed: $UNIT" "$msg"; then
    echo "$now 0" >"$stamp"
    exit 0
  fi
  echo "notify attempt $n/$attempts for $UNIT failed" >&2
  [ "$n" -lt "$attempts" ] && sleep "$delay"
done
echo "could not deliver failure alert for $UNIT; dedupe window not armed" >&2
exit 1
