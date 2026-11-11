#!/usr/bin/env bash
# hq-disk-health.sh: one S.M.A.R.T. reading of hqbox's NVMe, written where the
# console can read it. smartctl needs root and the console's hw.py runs as
# owner, so this root timer leaves a small world-readable report instead:
# /var/lib/hq-health/disk.json, shown on the console's Machines tab and judged
# by its alert rules (ops/console/v2/server/src/machineAlerts.js).
# Canonical copy: ops/services/disk-health/ in the hq repo; installed copy:
# /usr/local/sbin/hq-disk-health.
set -uo pipefail
DEV="${1:-/dev/nvme0}"
OUT=/var/lib/hq-health
install -d -m 755 "$OUT"
# smartctl's exit status is a bit mask that is non-zero for a merely unhappy
# drive, so the JSON is what gets judged, not the status.
smartctl -j -H -A -i "$DEV" 2>/dev/null | DEV="$DEV" python3 -c '
import json, os, sys, time
try:
    j = json.load(sys.stdin)
except Exception:
    sys.exit(1)
log = j.get("nvme_smart_health_information_log") or {}
if not log:
    sys.exit(1)
print(json.dumps({
    "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "device": os.environ["DEV"],
    "model": j.get("model_name", ""),
    "passed": (j.get("smart_status") or {}).get("passed"),
    "temp_c": log.get("temperature"),
    "used_pct": log.get("percentage_used"),
    "spare_pct": log.get("available_spare"),
    "spare_threshold_pct": log.get("available_spare_threshold"),
    "power_on_hours": log.get("power_on_hours"),
    "unsafe_shutdowns": log.get("unsafe_shutdowns"),
    "media_errors": log.get("media_errors"),
}))' > "$OUT/disk.json.tmp" || { rm -f "$OUT/disk.json.tmp"; echo "no usable smartctl output for $DEV"; exit 1; }
chmod 644 "$OUT/disk.json.tmp"
mv "$OUT/disk.json.tmp" "$OUT/disk.json"
