#!/usr/bin/env bash
# hub-auth-alert: the owner-side half of the hub-sync auth alert (hq-7llgp.1).
#
# hub-sync runs as hqsync under ProtectHome and must never run owner's code (design 3b),
# so it cannot call notify.sh. It publishes "auth" in its world-readable status.json:
#   {"failing_cycles": N, "since": "<UTC start of this outage>", "error": "<repo op: git error>"}
# This script runs as owner (git-sync calls it every cycle), reads that block and sends
# ONE notify.sh default per outage once N reaches HUB_AUTH_ALERT_AFTER. The outage's
# identity is "since": hub-sync keeps it through non-auth failures and clears it only on a
# real success, so a network blip or a missed reset cannot produce a second alert. A
# failed notify is retried on the next run. Missing or unreadable status.json: silent
# (hub-sync liveness is the dead-man check's job, not this one).
#
# HUB_STATUS            status file (default /var/lib/hqsync/status.json)
# HUB_AUTH_ALERT_STATE  state file (default $HQ/state/hub-auth-alert)
# HUB_AUTH_ALERT_AFTER  consecutive refused cycles before the alert (default 3)
# HUB_NOTIFY            notifier (default $HQ/ops/scripts/notify.sh)
set -uo pipefail
HQ="$(cd "$(dirname "$0")/../../.." && pwd)"
STATUS="${HUB_STATUS:-/var/lib/hqsync/status.json}"
STATE="${HUB_AUTH_ALERT_STATE:-$HQ/state/hub-auth-alert}"
AFTER="${HUB_AUTH_ALERT_AFTER:-3}"
NOTIFY="${HUB_NOTIFY:-$HQ/ops/scripts/notify.sh}"

# one field per line (a tab separator would collapse an empty field and shift the rest)
mapfile -t f < <(jq -r '.auth // empty | (.failing_cycles // 0 | tostring), (.since // "" | tostring | gsub("[\\n\\r]"; " ")), (.error // "" | tostring | gsub("[\\n\\r]"; " "))' "$STATUS" 2>/dev/null)
[ "${#f[@]}" -eq 3 ] || exit 0
n="${f[0]}" since="${f[1]}" err="${f[2]}"
[[ "$n" =~ ^[0-9]+$ ]] || exit 0
[ "$n" -ge "$AFTER" ] && [ -n "$since" ] || exit 0
[ "$(cat "$STATE" 2>/dev/null)" = "$since" ] && exit 0
if "$NOTIFY" default "hub-sync: GitHub auth failing" "${err:-credential refused} (no sync to GitHub since $since, $n cycles; one alert until it recovers)" >/dev/null 2>&1; then
  printf '%s\n' "$since" >"$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"
  echo "hub-auth-alert: alerted for outage since $since ($n cycles)"
else
  echo "hub-auth-alert: notify failed, will retry next run" >&2
fi
