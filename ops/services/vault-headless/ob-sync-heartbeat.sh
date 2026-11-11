#!/usr/bin/env bash
# Liveness proof for ob-sync.service (hq-fgg3.20).
#
# OnFailure= pages when the ob process dies. It does not catch a sync that
# stalls or keeps failing while the process stays up. This script runs from
# ob-sync-heartbeat.timer and stamps state/heartbeat/ob-sync with the time of
# the LAST PROVEN SUCCESSFUL SYNC, not with "now". The poller
# (hq_mail.heartbeat, entry "ob-sync" in ops/mail/heartbeats.json) then reports
# LoopDead when that time is older than stale_after.
#
# The signal: `ob sync --continuous` logs the exact line "Fully synced" once per
# successful cycle (about every 30s while connected, and after each completed
# upload or delete). In the journal it only ever follows "Connection
# successful" or a completed transfer, never "Disconnected from server",
# "Waiting to connect" or an Error, so it is emitted by ob itself on success.
# Vault file mtimes are not used: the vault can be quiet for hours.
#
# Exit 0 when the journal was read, whether or not it held a success line (no
# success means no stamp, and the poller reports the stale heartbeat). Exit 1
# only when the journal cannot be read, so the timer unit fails and
# failure-notify pages: the prover itself is broken.
#
# Env (tests): OB_SYNC_JOURNAL_FILE reads journal lines (journalctl -o
# short-unix format) from a file instead of journalctl. HQ_HEARTBEAT_DIR
# overrides the heartbeat directory (default $HQ_DIR/state/heartbeat, HQ_DIR
# default ~/hq). OB_SYNC_NOW overrides the clock.
set -uo pipefail

UNIT="ob-sync.service"
HQ_DIR="${HQ_DIR:-$HOME/hq}"
HB_DIR="${HQ_HEARTBEAT_DIR:-$HQ_DIR/state/heartbeat}"
HB="$HB_DIR/ob-sync"
NOW="${OB_SYNC_NOW:-$(date +%s)}"

if [ -n "${OB_SYNC_JOURNAL_FILE:-}" ]; then
  journal="$(cat -- "$OB_SYNC_JOURNAL_FILE")" || {
    echo "ob-sync-heartbeat: cannot read $OB_SYNC_JOURNAL_FILE" >&2; exit 1; }
else
  # 6h bounds the read; a success older than that is long past any grace.
  journal="$(journalctl --user -u "$UNIT" --since "-6h" -o short-unix --no-pager -q)" || {
    echo "ob-sync-heartbeat: journalctl failed for $UNIT" >&2; exit 1; }
fi

# A success dated more than SKEW seconds in the future (clock stepped forward,
# then corrected) is ignored, never clamped to now: clamping would re-stamp
# fresh liveness on every run for as long as that line stays in the future.
SKEW=120
limit=$((NOW + SKEW))

# short-unix line: "<epoch.usec> <host> ob[<pid>]: <message>". Match the
# message exactly so a file path containing the words cannot count. Take the
# newest valid success.
last="$(printf '%s\n' "$journal" \
  | awk -v lim="$limit" '$0 ~ /^[0-9]+(\.[0-9]+)? [^ ]+ [^ ]+: Fully synced$/ {
        s = int($1); if (s <= lim && s > t) t = s }
      END { if (t != "") print t }')"

if [ -z "$last" ]; then
  echo "ob-sync-heartbeat: no valid 'Fully synced' in the last 6h; heartbeat left as is"
  exit 0
fi

mkdir -p "$HB_DIR" || { echo "ob-sync-heartbeat: cannot create $HB_DIR" >&2; exit 1; }
prev=0
[ -e "$HB" ] && prev="$(stat -c %Y "$HB" 2>/dev/null || echo 0)"
# Never-backwards applies only among valid times: a heartbeat dated in the
# future (written under a stepped clock) is replaced by the newest valid success.
[ "$prev" -gt "$limit" ] && prev=0
if [ "$last" -le "$prev" ]; then
  echo "ob-sync-heartbeat: last success $last not newer than heartbeat $prev; unchanged"
  exit 0
fi
touch -d "@$last" "$HB" || { echo "ob-sync-heartbeat: cannot stamp $HB" >&2; exit 1; }
echo "ob-sync-heartbeat: stamped last success $last ($((NOW - last))s ago)"
