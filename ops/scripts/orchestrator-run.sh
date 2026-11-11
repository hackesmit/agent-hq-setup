#!/usr/bin/env bash
# orchestrator-run.sh [run]                    handle every new orchestrator event, then exit
# orchestrator-run.sh emit <type> [k=v ...]    append one event and wake the runner
# orchestrator-run.sh spent                    today's orchestrator spend against the cap
#
# Event runner (hq-4npjr.2, docs/designs/2026-11-04-orchestrator.md sections 2
# and 5). hq-orchestrator.path starts hq-orchestrator.service on each new event;
# that runs this. One run at a time: a second run while one holds the lock exits
# 0, since the active run re-scans until no event is new and the path unit
# re-fires on the pending flag that emit leaves behind. Event schema, models,
# (Fable decides, Sonnet sorts, per ops/config/orchestrator.json),
# daily cap and the fail-closed rules: orchestrator_run.py beside this file.
# Env: HQ_ROOT, HQ_ORCH_DIR, HQ_ORCH_CAP_USD and HQ_ORCH_CALL_MAX_USD (0 = uncapped, the default; the owner 2026-11-04),
# HQ_ORCH_CALL_TIMEOUT_S (1200), HQ_ORCH_MAX_ATTEMPTS (3); tests also set
# HQ_ORCH_CLAUDE, HQ_ORCH_CTL, HQ_NOTIFY, HQ_USAGE_DB, HQ_ORCH_REQUESTS.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${HQ_ROOT:=$(cd "$HERE/../.." && pwd)}"; export HQ_ROOT
dir="${HQ_ORCH_DIR:-$HQ_ROOT/state/orchestrator}"
case "${1:-run}" in
  run)
    mkdir -p "$dir" || exit 3
    exec 9>"$dir/run.lock" || exit 3
    flock -n 9 || { echo "orchestrator-run: another run holds the lock"; exit 0; }
    python3 "$HERE/orchestrator_run.py" run ;;
  emit|spent) exec python3 "$HERE/orchestrator_run.py" "$@" ;;
  *) sed -n '2,4p' "$0" | sed 's/^# //' >&2; exit 2 ;;
esac
