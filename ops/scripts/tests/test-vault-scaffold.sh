#!/usr/bin/env bash
set -uo pipefail
HQ="$(cd "$(dirname "$0")/../../.." && pwd)"
SC="$HQ/ops/scripts/vault-scaffold.sh"
OB="$HQ/outbox/vault"
rm -rf "$OB/02 Bunkers/testbunker" "$OB/01 Projects/testrig"
bash "$SC" testbunker --type bunker --tags "test,demo" --purpose "A test bunker." >/dev/null
f="$OB/02 Bunkers/testbunker/_index.md"
fail=0
[ -f "$f" ] || { echo "FAIL bunker hub not created"; fail=1; }
grep -q "# testbunker - Hub" "$f"        || { echo "FAIL name not substituted"; fail=1; }
grep -q "A test bunker." "$f"            || { echo "FAIL purpose not substituted"; fail=1; }
grep -q "{{" "$f"                        && { echo "FAIL leftover token"; fail=1; }
grep -qP '\d{4}-\d{2}-\d{2}' "$f"        || { echo "FAIL date not substituted"; fail=1; }
# idempotency: second call refuses
bash "$SC" testbunker --type bunker >/dev/null 2>&1; rc=$?
[ "$rc" = 3 ] || { echo "FAIL re-scaffold should exit 3, got $rc"; fail=1; }
# rig goes to 01 Projects
bash "$SC" testrig --type rig --purpose "A test rig." >/dev/null
[ -f "$OB/01 Projects/testrig/_index.md" ] || { echo "FAIL rig hub wrong tree"; fail=1; }
rm -rf "$OB/02 Bunkers/testbunker" "$OB/01 Projects/testrig"
[ "$fail" = 0 ] && echo "SCAFFOLD TEST OK" || exit 1
