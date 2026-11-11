#!/usr/bin/env bash
# (hq-1nkg.13: bad id refused before any write; a failed schedule exits 1 and keeps the session active)
# snooze.sh <when> [--id ID] [--reason "..."]
# S2: persist a blocked session (status=snoozed + wake_at), schedule its revival with a
# one-shot systemd user timer (hq-wake-<id>.timer, via systemd-run --user), free its tokens by
# killing the tmux window. The timer is transient: a reboot drops it, but wake_at stays in the
# registry, so wake.sh <id> by hand (or the console) still revives it. (hq-1nkg.2)
# <when>: "for 3 days" | "until sunday" | "until 2026-07-20 09:00" (GNU date -d).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGSH="$SCRIPT_DIR/session-registry.sh"
. "$SCRIPT_DIR/lib/tmux-server.sh"   # hq_kill_registry_window (hq-1nkg.1)
. "$SCRIPT_DIR/lib/wake-schedule.sh" # hq_schedule_wake (hq-1nkg.11)
HQ="${HQ_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
BD="${HQ_BD:-bd}"
SYSTEMD_RUN="${HQ_SYSTEMD_RUN:-systemd-run}"
SYSTEMCTL="${HQ_SYSTEMCTL:-systemctl}"
die(){ echo "snooze: $1" >&2; exit "${2:-1}"; }

when=""; id=""; reason=""
while [ $# -gt 0 ]; do
  case "$1" in
    --id) id="${2:-}"; shift;;
    --reason) reason="${2:-}"; shift;;
    --*) die "unknown arg: $1" 2;;
    *) if [ -z "$when" ]; then when="$1"; else reason="$1"; fi;;
  esac; shift
done
[ -n "$when" ] || die "usage: snooze.sh <when> [--id ID] [--reason \"...\"]" 2

# resolve session (given, or the sole active one)
if [ -z "$id" ]; then
  ids="$("$REGSH" list --status active --json 2>/dev/null | python3 -c 'import json,sys
[print(e["id"]) for e in json.load(sys.stdin)]' 2>/dev/null)"
  n="$(printf '%s\n' "$ids" | grep -c . || true)"
  [ "$n" = 1 ] || die "specify --id (active: $(echo $ids))" 2
  id="$(printf '%s' "$ids" | tr -d '[:space:]')"
fi
entry="$("$REGSH" get "$id" 2>/dev/null)" || die "no such session: $id" 2
getf(){ printf '%s' "$entry" | python3 -c "import json,sys; print(json.load(sys.stdin).get('$1',''))"; }
bead="$(getf bead)"; window="$(getf tmux_window)"
prev_status="$(getf status)"; prev_wake="$(getf wake_at)"; [ "$prev_wake" = None ] && prev_wake=""

# the id becomes a unit name: refuse a bad one before anything is written (hq-1nkg.13)
case "$id" in *[!A-Za-z0-9_.-]*) die "id not usable as a unit name: $id" 2;; esac

# parse <when> -> future epoch
norm="$(printf '%s' "$when" | sed -E 's/^(until|for)[[:space:]]+//I')"
wake_epoch="$(date -d "$norm" +%s 2>/dev/null)" || die "cannot parse <when>: '$when'" 2
[ "$wake_epoch" -gt "$(date +%s)" ] || die "<when> is not in the future: '$when'" 2

# persist
"$REGSH" update "$id" --status snoozed --wake-at "$wake_epoch" >/dev/null || die "registry update failed"
"$BD" comment "$bead" "snoozed until $when${reason:+ — $reason}" >/dev/null 2>&1 || true

# schedule revival: one-shot systemd user timer that runs wake.sh <id> at wake_epoch.
# A re-snooze replaces the old timer (systemd-run refuses a unit name that is still loaded).
scheduled="skipped"
if [ -z "${HQ_NO_SCHEDULE:-}" ]; then
  unit="hq-wake-$id"
  hq_schedule_wake "$id" "$wake_epoch"; src=$?
  if [ "$src" = 3 ]; then
    # a wake of this id is in flight (holds wake-<id>.lock): do not touch its timer; fail like a refused schedule
    "$REGSH" update "$id" --status "$prev_status" --wake-at "$prev_wake" >/dev/null 2>&1 || true
    echo "snooze: FAILED to schedule $unit (a wake of $id is in progress, lock held); $id restored to $prev_status, window kept" >&2
    exit 1
  elif [ "$src" = 0 ]; then
    scheduled="$unit.timer @ $(date -d "@$wake_epoch" '+%Y-%m-%d %H:%M:%S %Z')"
  else
    # no wake is scheduled: keep the window and the session alive, restore the prior status and wake_at, exit nonzero
    "$REGSH" update "$id" --status "$prev_status" --wake-at "$prev_wake" >/dev/null 2>&1 || true
    echo "snooze: FAILED to schedule $unit (systemd-run --user refused it); $id restored to $prev_status, window kept" >&2
    exit 1
  fi
fi

# notify + free the session
[ -x "$HQ/ops/scripts/notify.sh" ] && "$HQ/ops/scripts/notify.sh" low "snooze" \
  "$id snoozed until $when${reason:+: $reason}" >/dev/null 2>&1 || true
# on the server that holds =hq (default or hqterm), never by prefix (hq-1nkg.1)
if [ -z "${HQ_NO_TMUX:-}" ] && [ -n "$window" ]; then
  hq_kill_registry_window "$window" || true
fi

"$SCRIPT_DIR/console.sh" log-change "snoozed $bead until $when${reason:+: $reason}" \
  --session "$id" >/dev/null 2>&1 || true

echo "snoozed $id until $when (wake_at=$wake_epoch); schedule: $scheduled"
