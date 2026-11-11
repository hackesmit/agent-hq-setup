#!/usr/bin/env bash
# Point hq and every rig's main checkout at ops/githooks (pre-push secret scan,
# force-push guard). Idempotent. Skips a repo that already has its own
# core.hooksPath (e.g. unfortunate-sports-resort), and says so.
# Usage: githooks-install.sh [--dry]
set -u
HQ="$(cd "$(dirname "$0")/../.." && pwd)"
[ "$(basename "$(dirname "$HQ")")" = worktrees ] && HQ="$(cd "$HQ/../../.." && pwd)"
want="$HQ/ops/githooks"
dry=0; [ "${1:-}" = --dry ] && dry=1
for r in "$HQ" "$HQ"/rigs/*/; do
  r="${r%/}"
  [ -L "$r" ] && continue
  [ -d "$r/.git" ] || continue   # main checkouts only; worktrees share the config
  cur="$(git -C "$r" config --local core.hooksPath || true)"
  if [ "$cur" = "$want" ]; then echo "ok    $r"
  elif [ -n "$cur" ]; then echo "skip  $r (own hooksPath: $cur)"
  elif [ $dry = 1 ]; then echo "would $r"
  else git -C "$r" config --local core.hooksPath "$want" && echo "set   $r"; fi
done
