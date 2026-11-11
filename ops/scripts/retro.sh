#!/usr/bin/env bash
# Weekly retro. Scheduled by hq-retro.timer (ops/services/retro/, Fridays
# 17:37 UTC, hq-fgg3.2); a failed run alerts through OnFailure=. Manual run:
# systemctl --user start hq-retro.service (or run this script directly).
set -euo pipefail
HQ="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$HQ"
export PATH="$HOME/.local/bin:$PATH"
# Audit bead sweep. The retro reviews the auto-filed audit beads keep-or-revert
# (CLAUDE.md, Ledger), so it closes the reviewed ones before the retro itself
# runs: both classes, per the owner's 2026-09-06 decision. Running the script with
# no flags stays a dry plan (ops/proposals/42-audit-bead-sweep).
if [ -x "$HQ/ops/scripts/audit-sweep.sh" ]; then
  "$HQ/ops/scripts/audit-sweep.sh" --close-revoked --apply || echo "retro: audit-sweep failed, continuing" >&2
fi

# Orchestrator usage line (hq-4npjr.7): the retro states it in its digest.
orch_line="$(python3 "$HQ/ops/scripts/orch_usage.py" retro 2>/dev/null || true)"

claude -p --dangerously-skip-permissions --strict-mcp-config --max-turns 60 "$(cat ops/templates/retro.md)

Include this line verbatim in the retro: ${orch_line:-Orchestrator usage unavailable.}"

# Save this week's digest and stack report into the console report store.
python3 "$HQ/ops/reports/backfill.py" --current || echo "retro: report publish failed, continuing" >&2
