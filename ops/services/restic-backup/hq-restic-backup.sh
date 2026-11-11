#!/usr/bin/env bash
# hq-restic-backup.sh: restic backup of hqbox to George (the desktop) over sftp.
# Closes the backup item of hq-k3zj / hq-1pso. Runs as root from
# hq-restic-backup.timer every hour and decides for itself whether to work:
#   - a snapshot newer than MIN_AGE_H hours exists: nothing to do
#   - George is unreachable (it is a desktop, it sleeps): skip quietly
# Every run leaves /var/lib/hq-health/backup.json for the console, which shows
# it on the Machines tab and raises the alert when no snapshot has succeeded
# for two days (ops/console/v2/server/src/machineAlerts.js).
# Canonical copy: ops/services/restic-backup/ in the hq repo; installed copy:
# /usr/local/sbin/hq-restic-backup, lists in /etc/restic/.
# The repository password lives in /etc/restic/hqbox.pass and in Proton Pass
# (Personal / "Repo Password"). Without it the snapshots are unreadable.
set -uo pipefail

MIN_AGE_H=20
STATE=/var/lib/hq-restic
HEALTH=/var/lib/hq-health
KEY=/home/owner/.ssh/id_ed25519_george
SSH=(ssh -i "$KEY" -o UserKnownHostsFile=/home/owner/.ssh/known_hosts
     -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=15 owner@george)
export RESTIC_REPOSITORY="sftp:owner@george:/C:/Users/owner/Backups/hqbox-restic"
export RESTIC_PASSWORD_FILE=/etc/restic/hqbox.pass
export RESTIC_CACHE_DIR=/var/cache/restic
RESTIC=(restic -o "sftp.command=${SSH[*]} -s sftp")

mkdir -p "$STATE"
now=$(date +%s)
last=$(cat "$STATE/last-success" 2>/dev/null || echo 0)

iso() { [ "$1" -gt 0 ] 2>/dev/null && date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }

# The console's view of this job. Rewritten on every run, including the runs
# that find nothing to do, so the file never goes missing after a reboot.
report() {
  local ok attempt result
  ok=$(cat "$STATE/last-success" 2>/dev/null || echo 0)
  attempt=$(cat "$STATE/last-attempt" 2>/dev/null || echo 0)
  result=$(cat "$STATE/last-result" 2>/dev/null || echo "")
  install -d -m 755 "$HEALTH"
  OK=$(iso "$ok") ATTEMPT=$(iso "$attempt") RESULT="$result" python3 -c '
import json, os
e = os.environ
print(json.dumps({"target": "george", "last_success_at": e["OK"] or None,
                  "last_attempt_at": e["ATTEMPT"] or None, "last_result": e["RESULT"]}))' > "$HEALTH/backup.json.tmp" \
    && chmod 644 "$HEALTH/backup.json.tmp" && mv "$HEALTH/backup.json.tmp" "$HEALTH/backup.json"
}
attempt() { echo "$now" > "$STATE/last-attempt"; echo "$1" > "$STATE/last-result"; report; }

if [ "${1:-}" != "--force" ] && [ $(( now - last )) -lt $(( MIN_AGE_H * 3600 )) ]; then
  report
  exit 0
fi

if ! "${SSH[@]}" "exit 0" >/dev/null 2>&1; then
  echo "george unreachable, skipping"
  attempt "skipped: george unreachable"
  exit 0
fi

# Flush the Minecraft world to disk so the region files are consistent.
docker exec minecraft rcon-cli save-all flush >/dev/null 2>&1 || echo "minecraft flush skipped"

"${RESTIC[@]}" backup --files-from /etc/restic/include.txt \
  --exclude-file /etc/restic/exclude.txt --exclude-caches --one-file-system --tag hqbox
rc=$?
# 3 = snapshot written but some files could not be read (they changed mid-run).
if [ "$rc" -ne 0 ] && [ "$rc" -ne 3 ]; then
  echo "restic backup failed rc=$rc"
  attempt "failed: restic exit $rc"
  exit "$rc"
fi
date +%s > "$STATE/last-success"
attempt "ok"

"${RESTIC[@]}" forget --tag hqbox --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune \
  || echo "forget/prune failed (snapshot itself is fine)"
# A full metadata check once a week.
if [ "$(date +%u)" = 7 ]; then
  "${RESTIC[@]}" check || attempt "snapshot ok, but restic check failed"
fi
exit 0
