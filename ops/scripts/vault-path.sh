#!/usr/bin/env bash
# vault-path.sh - print THIS machine's Obsidian vault root.
# The vault is at ~/vault on hqbox; another machine can override it (ops/.vault-path or
# HQ_VAULT), so vault scripts ask here instead of hardcoding a layout.
# Resolution order:
#   1. $HQ_VAULT           - explicit override, wins everywhere
#   2. ops/.vault-path     - machine-local, gitignored, first non-comment line
#   3. a known layout that actually exists on disk
#   4. ~/vault even if absent, so callers report the real path they looked for
set -uo pipefail
HQ="${HQ_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
DEFAULT="$HOME/vault"

if [ -n "${HQ_VAULT:-}" ]; then
  printf '%s\n' "$HQ_VAULT"; exit 0
fi

if [ -f "$HQ/ops/.vault-path" ]; then
  p="$(grep -v '^[[:space:]]*#' "$HQ/ops/.vault-path" | grep -v '^[[:space:]]*$' | head -n1 | sed 's/[[:space:]]*$//')"
  if [ -n "$p" ]; then printf '%s\n' "$p"; exit 0; fi
fi

for c in "$DEFAULT"; do
  if [ -d "$c" ]; then printf '%s\n' "$c"; exit 0; fi
done

printf '%s\n' "$DEFAULT"
