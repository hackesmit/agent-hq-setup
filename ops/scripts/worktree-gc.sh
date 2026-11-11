#!/usr/bin/env bash
# worktree-gc.sh [--apply]  — prune worker worktrees, safely.
# Removes a worktree ONLY when ALL hold:
#   1. clean tree           (git status --porcelain empty)
#   2. merged               (branch is an ancestor of the rig's default branch, OR
#                            git cherry finds a patch-id equivalent for every commit —
#                            so SQUASH-merges are detected, not leaked forever)
#   3. past TTL             (worktree dir older than HQ_WT_TTL_HOURS, default 72)
#   4. no live tmux client  (no pane's cwd is inside the worktree)
# Dry-run by default: prints what it WOULD remove. Pass --apply to actually remove.
# A naive "merged == ancestor" GC leaks every squash-merged branch; condition 2 fixes that.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="$(cd "$DIR/../.." && pwd)"
TTL_HOURS="${HQ_WT_TTL_HOURS:-72}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

# panes' current paths (empty if tmux not running)
PANE_PATHS="$(tmux list-panes -a -F '#{pane_current_path}' 2>/dev/null || true)"

default_branch() {
  local r="$1"
  if git -C "$r" rev-parse --verify -q main >/dev/null 2>&1; then echo main
  elif git -C "$r" rev-parse --verify -q master >/dev/null 2>&1; then echo master
  else git -C "$r" symbolic-ref --short HEAD 2>/dev/null || echo main; fi
}

now="$(date +%s)"
removed=0; kept=0

for rig in "$HQ"/rigs/*/; do
  # Canonical clones ONLY: a real clone has .git as a DIRECTORY; a worktree has it as
  # a file. Skipping worktree dirs (which live under rigs/) stops us from ever seeing —
  # and removing — another rig's canonical main tree.
  [ -d "$rig/.git" ] || continue
  git -C "$rig" rev-parse --git-dir >/dev/null 2>&1 || continue
  def="$(default_branch "$rig")"
  main_top="$(readlink -f "$(git -C "$rig" rev-parse --show-toplevel 2>/dev/null)")"

  # iterate linked worktrees (skip the main working tree = the rig itself)
  git -C "$rig" worktree list --porcelain 2>/dev/null | awk '
    /^worktree /{wt=$2} /^branch /{br=$2} /^$/{if(wt){print wt"\t"br; wt="";br=""}}
    END{if(wt)print wt"\t"br}' | while IFS=$'\t' read -r wt br; do
    [ -n "$wt" ] || continue
    [ "$(readlink -f "$wt")" = "$main_top" ] && continue               # main working tree
    br="${br#refs/heads/}"
    [ "$br" = "$def" ] && continue                                     # never GC the default branch
    reasons=""

    # 1. clean
    if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then reasons="$reasons dirty"; fi
    # 2. merged (ancestor OR patch-id equivalent for all commits)
    merged=0
    if [ -n "$br" ]; then
      if git -C "$rig" merge-base --is-ancestor "$br" "$def" 2>/dev/null; then merged=1
      elif ! git -C "$rig" cherry "$def" "$br" 2>/dev/null | grep -q '^+'; then merged=1; fi
    fi
    [ "$merged" -eq 1 ] || reasons="$reasons not-merged"
    # 3. TTL
    mt="$(stat -c %Y "$wt" 2>/dev/null || echo "$now")"
    age_h=$(( (now - mt) / 3600 ))
    [ "$age_h" -ge "$TTL_HOURS" ] || reasons="$reasons young(${age_h}h)"
    # 4. no live tmux client rooted in the worktree
    if printf '%s\n' "$PANE_PATHS" | grep -qF "$wt"; then reasons="$reasons live-pane"; fi

    if [ -z "$reasons" ]; then
      if [ "$APPLY" -eq 1 ]; then
        if git -C "$rig" worktree remove "$wt" 2>/dev/null; then
          echo "REMOVED  $wt  ($br, merged into $def, ${age_h}h)"
        else
          echo "FAILED   $wt  (git worktree remove errored)"
        fi
      else
        echo "would-remove  $wt  ($br, merged into $def, ${age_h}h)"
      fi
    else
      echo "keep     $wt  ($br) —$reasons"
    fi
  done
done
exit 0
