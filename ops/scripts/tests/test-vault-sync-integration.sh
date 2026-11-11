#!/usr/bin/env bash
set -uo pipefail
HQ="$(cd "$(dirname "$0")/../../.." && pwd)"
grep -q "vault-lint.sh" "$HQ/ops/scripts/vault-sync.sh" || { echo "FAIL sync does not call vault-lint"; exit 1; }
grep -q -- "--no-graph" "$HQ/ops/scripts/vault-sync.sh" || { echo "FAIL sync missing --no-graph guard"; exit 1; }
grep -q "graphify" "$HQ/ops/scripts/vault-sync.sh"     || { echo "FAIL sync does not invoke graphify"; exit 1; }
bash -n "$HQ/ops/scripts/vault-sync.sh"                || { echo "FAIL sync syntax"; exit 1; }
echo "SYNC INTEGRATION OK"
