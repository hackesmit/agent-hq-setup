#!/usr/bin/env bash
# console-probe.sh: one probe of the HQ console listener, pushed to Uptime Kuma.
#
# Why a push and not a Kuma TCP monitor (hq-aukwy, 2026-11-05): the Kuma container
# cannot reach the box's tailnet address (a connect from inside it times out), and the
# console's whois gate resets every peer that is not the owner's, hqbox included, so no
# HTTP check from this box can pass anyway. This script runs on the host every 60 s,
# checks that the listener accepts a TCP connection, and pushes up or down to Kuma with
# the live release sha from the server's health file, so the Kuma history shows each
# deploy restart next to the uptime. No push for a while also turns the monitor down.
#
# Env (all optional): KUMA_ENV (file holding KUMA_CONSOLE_PUSH_TOKEN), KUMA_PUSH_BASE,
# CONSOLE_PROBE_HOST, CONSOLE_PROBE_PORT, CONSOLE_HEALTH_FILE.
set -uo pipefail

ENV_FILE="${KUMA_ENV:-$HOME/hq/state/secrets/uptime-kuma.env}"
# shellcheck disable=SC1090
[ -r "$ENV_FILE" ] && . "$ENV_FILE"
TOKEN="${KUMA_CONSOLE_PUSH_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  echo "console-probe: no KUMA_CONSOLE_PUSH_TOKEN in $ENV_FILE" >&2
  exit 2
fi
HOST="${CONSOLE_PROBE_HOST:-$(tailscale ip -4 2>/dev/null | head -1)}"
PORT="${CONSOLE_PROBE_PORT:-8790}"
HEALTH="${CONSOLE_HEALTH_FILE:-/var/lib/hqconsole/state/health.json}"
PUSH_BASE="${KUMA_PUSH_BASE:-http://127.0.0.1:3001/api/push}"

start=$(date +%s%3N)
if [ -n "$HOST" ] && timeout 5 bash -c "exec 3<>/dev/tcp/$HOST/$PORT" 2>/dev/null; then
  status=up
else
  status=down
fi
ping=$(( $(date +%s%3N) - start ))

sha=$(jq -r '.sha // empty' "$HEALTH" 2>/dev/null | cut -c1-7)
since=$(jq -r '.at // empty' "$HEALTH" 2>/dev/null)
msg="release ${sha:-unknown} since ${since:-unknown}"

curl -fsS -m 10 -G "$PUSH_BASE/$TOKEN" \
  --data-urlencode "status=$status" \
  --data-urlencode "msg=$msg" \
  --data-urlencode "ping=$ping" >/dev/null
