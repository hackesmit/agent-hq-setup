#!/usr/bin/env bash
# inventory.sh (hq-8cry.1): hermetic fixture tree with a lockfile rig, a
# Dockerfile rig, a bare rig (finding), a worktree dir and a symlink (both
# ignored). Host sections are skipped; one real run checks the host sections.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "ok   $1"; }
bad() { fail=$((fail + 1)); echo "FAIL $1"; }
eq()  { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (want '$1', got '$2')"; fi; }

R="$T/rigs"
for n in alpha beta gamma alpha-1234; do mkdir -p "$R/$n/.git"; done
ln -s alpha "$R/alpha-link"
echo '{}' >"$R/alpha/package-lock.json"
mkdir -p "$R/alpha/node_modules/x" "$R/alpha/backend"
echo '{}' >"$R/alpha/node_modules/x/package-lock.json"
echo 'flask==3.0' >"$R/alpha/backend/requirements.txt"
printf 'FROM --platform=linux/amd64 node:20-alpine AS build\nFROM build AS test\nFROM nginx:1.27\nFROM scratch\n' >"$R/beta/Dockerfile"
echo '{}' >"$R/beta/yarn.lock"
echo 'x' >"$R/gamma/README.md"
echo '{}' >"$R/alpha-1234/package-lock.json"
# a worktree has a .git file, not a directory
mkdir -p "$R/delta"; echo 'gitdir: x' >"$R/delta/.git"

OUT="$T/out/inventory.json"
HQ="$T" HQ_INV_NO_HOST=1 bash "$REPO/ops/security/inventory.sh" --out "$OUT" >/dev/null
rc=$?
eq 0 "$rc" "exit 0"
jq empty "$OUT" 2>/dev/null; eq 0 "$?" "valid json"
eq "alpha alpha-1234 beta gamma" "$(jq -r '[.rigs[].name]|sort|join(" ")' "$OUT")" "rigs: main checkouts with .git dir, no symlink, no worktree file"
eq '["package-lock.json"]' "$(jq -c '.rigs[]|select(.name=="alpha")|.lockfiles' "$OUT")" "node_modules lockfile skipped"
eq '["backend/requirements.txt"]' "$(jq -c '.rigs[]|select(.name=="alpha")|.requirements' "$OUT")" "requirements.txt found in subdir"
eq '["node:20-alpine","nginx:1.27"]' "$(jq -c '.rigs[]|select(.name=="beta")|.dockerfiles[0].base_images' "$OUT")" "base images: stage aliases and scratch dropped"
eq '["gamma"]' "$(jq -c '[.findings[].rig]' "$OUT")" "bare rig recorded as finding"
eq "no-lockfile" "$(jq -r '.findings[0].kind' "$OUT")" "finding kind"
eq '[]' "$(jq -c '.docker_images' "$OUT")" "host sections skipped on request"

# real host run (best effort: docker may be absent in CI)
OUT2="$T/out/host.json"
HQ="$T" bash "$REPO/ops/security/inventory.sh" --out "$OUT2" >/dev/null
if command -v dpkg-query >/dev/null; then
  [ "$(jq '.dpkg_packages|length' "$OUT2")" -gt 0 ] && ok "dpkg packages listed" || bad "dpkg packages empty"
fi
for k in "$(jq -r '.. | strings' "$OUT" | grep -ciE 'password|secret|token|api[_-]?key')"; do eq 0 "$k" "no secret-looking strings"; done
if grep -q $'\xe2\x80\x94' "$REPO/ops/security/inventory.sh" "$0"; then bad "no em dash"; else ok "no em dash"; fi

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
