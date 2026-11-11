#!/usr/bin/env bash
# Disk monitor: runs as a tmux window, checks every 60s. Pings urgent once if disk free
# drops below the threshold (re-arms when it clears). The old "runaway agents" process-count
# alarm was removed 2026-07-16 - not needed in the hands-on workspace model.
# Every tick touches state/heartbeat/monitor; the mail poller reports the loop dead if it
# stops (ops/mail/heartbeats.json, hq-fgg3.6). --once runs a single tick (tests).
DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="${HQ_ROOT:-$(cd "$DIR/../.." && pwd)}"
HB="$HQ/state/heartbeat/monitor"
MIN_FREE_GB=5
alerted_disk=0
mkdir -p "$(dirname "$HB")" 2>/dev/null || true

while true; do
  touch "$HB" 2>/dev/null || true   # a heartbeat must never kill the loop
  count=$(pgrep -fc "claude" 2>/dev/null || echo 0)   # shown in the window, not alerted on
  free_gb=$(df -BG --output=avail "$HOME" | tail -1 | tr -dc '0-9')

  if [ "${free_gb:-999}" -lt "$MIN_FREE_GB" ]; then
    if [ "$alerted_disk" -eq 0 ]; then
      # arm only on a delivered alert: a failed push (ntfy down) retries next tick,
      # and the loop never dies on it (no set -e here, hq-fgg3.14)
      if "$DIR/notify.sh" urgent "Disk low" "${free_gb}GB free (threshold ${MIN_FREE_GB}GB)"; then
        alerted_disk=1
      fi
    fi
  else
    alerted_disk=0
  fi

  printf '%s claude=%s free=%sGB\n' "$(date +%H:%M:%S)" "$count" "$free_gb"
  [ "${1:-}" = "--once" ] && break
  sleep 60
done
