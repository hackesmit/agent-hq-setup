#!/usr/bin/env bash
# wake-resume.sh: run once after boot (hq-wake-resume.service, hq-1nkg.11). The snooze timers
# hq-wake-<id> are transient systemd units (hq-1nkg.2), so a reboot drops them while the
# registry keeps status=snoozed and wake_at. This walks those rows: a past wake_at is woken
# now (wake.sh <id>), a future one gets its timer recreated. Safe to run any time: a second
# run only recreates timers. Exit 1 if any wake or reschedule failed, so the unit's OnFailure
# alert fires; the remaining rows are still handled.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGSH="$SCRIPT_DIR/session-registry.sh"
HQ="${HQ_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
SYSTEMD_RUN="${HQ_SYSTEMD_RUN:-systemd-run}"
SYSTEMCTL="${HQ_SYSTEMCTL:-systemctl}"
. "$SCRIPT_DIR/lib/wake-schedule.sh"   # hq_schedule_wake

# console-term rows belong to the runner, which wakes them itself (ctl register-term --snoozed):
# touching them would open a duplicate pane. Handle exactly the kinds snooze.sh can snooze
# (worker, interactive). wake_at is passed through raw so one bad row cannot sink the run.
rows="$("$REGSH" list --status snoozed --json 2>/dev/null | python3 -c 'import json,sys
for e in json.load(sys.stdin):
    w = e.get("wake_at")
    if e.get("kind") != "console-term" and w not in (None, ""):
        print(e["id"])' 2>/dev/null)" || { echo "wake-resume: registry unreadable" >&2; exit 1; }

woke=0; resched=0; failed=0
while IFS= read -r id; do
  [ -n "${id:-}" ] || continue
  case "$id" in *[!A-Za-z0-9_.-]*) echo "wake-resume: skipping odd id: $id" >&2; failed=$((failed + 1)); continue;; esac
  # hq-1nkg.17: read the row and the clock per row, not once before the loop, so a wake that
  # finished meanwhile (no longer snoozed) is skipped and a wake_at that has just passed is woken.
  wake_at="$("$REGSH" get "$id" 2>/dev/null | python3 -c 'import json,sys
e = json.load(sys.stdin)
w = e.get("wake_at")
print(w if e.get("status") == "snoozed" and w not in (None, "") else "")' 2>/dev/null)"
  [ -n "$wake_at" ] || { echo "no longer snoozed $id"; continue; }
  now="$(date +%s)"
  case "$wake_at" in ''|*[!0-9]*) echo "wake-resume: skipping $id, bad wake_at '$wake_at'" >&2; failed=$((failed + 1)); continue;; esac
  if [ "$wake_at" -le "$now" ]; then
    "$SCRIPT_DIR/wake.sh" "$id" >/dev/null 2>&1; wrc=$?
    # 3 = another wake already revived this row (hq-1nkg.15): not a failure, not a new wake
    if [ "$wrc" = 0 ]; then woke=$((woke + 1)); echo "woke overdue $id"
    elif [ "$wrc" = 3 ]; then echo "already revived $id"
    else failed=$((failed + 1)); echo "wake-resume: wake.sh $id failed" >&2; fi
  else
    hq_schedule_wake "$id" "$wake_at"; src=$?
    if [ "$src" = 0 ]; then resched=$((resched + 1)); echo "rescheduled $id @ $wake_at"
    elif [ "$src" = 3 ]; then echo "skipped $id, a wake is in progress"
    else failed=$((failed + 1)); echo "wake-resume: could not schedule hq-wake-$id" >&2; fi
  fi
done <<EOF
$rows
EOF

echo "wake-resume: woke $woke, rescheduled $resched, failed $failed"
[ "$failed" = 0 ]
