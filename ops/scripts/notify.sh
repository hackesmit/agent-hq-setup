#!/usr/bin/env bash
# usage: notify.sh <urgent|default|low> "<title>" "<message>"
#
# Curated + presence-aware. ONE rule:
#   - `urgent`  -> ALWAYS pushes (real emergencies: panic, canary failure, disk low).
#   - anything else -> pushes ONLY when you're AWAY. "Away" = no tmux client attached-and-
#     active in the last ~2 min (and no fresh state/presence marker). So while you're at the
#     terminal you get nothing but emergencies; step away and the "needs you"/blocked pings
#     come through. No desktop presence-updater required — it reads live tmux activity.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$DIR/../.env" 2>/dev/null || true
PRIORITY="${1:-default}"; TITLE="${2:-HQ}"; MSG="${3:-}"
PRESENCE="$DIR/../../state/presence"
# Orchestrator events (hq-4npjr.3): a few titles are events, not just pings.
# Emitted before any early exit, fail-open, and never changes the exit status.
# shellcheck disable=SC1091
. "$DIR/lib/orchestrator-event.sh" 2>/dev/null || orch_emit() { return 0; }
case "$TITLE" in
  "Task done")      orch_emit worker_done "" "$MSG" ;;
  "Review verdict") orch_emit review_verdict "" "$MSG" ;;
  "Merge ready")    orch_emit merge_ready "" "$MSG" ;;
esac

present() {
  local now act mt; now="$(date +%s)"
  # attached tmux client active in the last 120s == you're at the machine
  act="$(tmux list-clients -F '#{client_activity}' 2>/dev/null | sort -rn | head -1)"
  [ -n "$act" ] && [ $((now - act)) -lt 120 ] && return 0
  # optional desktop presence marker (a per-minute timer touching state/presence)
  if [ -f "$PRESENCE" ]; then
    mt="$(stat -c %Y "$PRESENCE" 2>/dev/null || echo 0)"
    [ $((now - mt)) -lt 90 ] && return 0
  fi
  return 1
}

# Routing policy (the owner, 2026-08-12): ntfy is for crucial/critical ONLY.
#   urgent  -> ring his terminal AND push ntfy (P0: panic, canary)
#   default -> ring his terminal only ("a terminal needs you")
#   low     -> neither; these are FYI and already land in the ledger
# The bell writes BEL to every attached tmux client tty, so it sounds on
# whatever machine he is attached FROM (this box is headless and silent).
#
# HQ_NO_NOTIFY is an UNCONDITIONAL test seam, urgent included. Exempting
# urgent was the first draft and it was wrong: a hermetic test that fires an
# urgent notification would still curl ntfy for real, which is exactly the
# 2026-08-12 bug (88 real notifications from a test run) wearing a hat.
# Production never sets this; only test harnesses do.
if [ -n "${HQ_NO_NOTIFY:-}" ]; then exit 0; fi
[ "$PRIORITY" = "low" ] && exit 0
# HQ_NO_BELL lets a caller that already rang (ctl.sh ask --urgent) suppress
# the second ring without suppressing the push.
"$DIR/../console/bell.sh" "$TITLE: $MSG" >/dev/null 2>&1 || true
if [ "$PRIORITY" != "urgent" ]; then exit 0; fi
# present() is retained but no longer gates delivery: presence decided WHERE
# a ping went, and priority decides that now.
[ -n "${NTFY_TOPIC:-}" ] || exit 0
# Exit status (hq-fgg3.14): 0 when the push was delivered (or nothing needed
# pushing: low, non-urgent, no topic, HQ_NO_NOTIFY), nonzero when the ntfy push
# failed (server down, network out, HTTP error). One attempt, bounded by
# --max-time, no retry here: callers that need delivery (notify-failure.sh,
# hq_mail's outbox) retry themselves, and fire-and-forget callers ignore the
# status with `|| true`. NTFY_SERVER overrides the server for tests.
# --fail alone passes a 3xx (curl does not follow it), so the HTTP code must
# also be 2xx.
code="$(curl -sS --fail --connect-timeout 5 --max-time 10 -o /dev/null -w '%{http_code}' \
    -H "Title: $TITLE" -H "Priority: $PRIORITY" -d "$MSG" \
    "${NTFY_SERVER:-https://ntfy.sh}/$NTFY_TOPIC" 2>/dev/null)"; rc=$?
case "$rc:$code" in
  0:2??) exit 0 ;;
esac
echo "notify.sh: ntfy delivery failed (curl rc $rc, http ${code:-none})" >&2
exit 1
