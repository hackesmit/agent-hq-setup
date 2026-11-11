#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

[[ -f "$repo_root/ops/scripts/notify.sh" ]] || fail "ops/scripts/notify.sh does not exist"
[[ -x "$repo_root/ops/scripts/notify.sh" ]] || fail "ops/scripts/notify.sh is not executable"
[[ -f "$repo_root/ops/templates/bead.md" ]] || fail "ops/templates/bead.md does not exist"

echo "PASS"
