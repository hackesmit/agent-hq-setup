#!/usr/bin/env bash
# worktree-report.sh [--json] [--rigs-dir DIR]: read-only report of rig worktrees.
# One line per linked worktree: path, branch, bead (from state/sessions.json), pane alive,
# commits ahead of the rig default, last-commit age, dirty, size. A worktree is flagged
# SAFE when merged (ancestor of default, or every commit patch-id equivalent via
# git cherry, so squash merges count) AND clean AND no live pane. Removes nothing.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="${HQ_ROOT:-$(cd "$DIR/../.." && pwd)}"
[ -d "$HQ/rigs" ] || HQ="$HOME/hq"  # run from a hq worktree: rigs/ and state/ live in the main checkout
JSON=0; RIGS="$HQ/rigs"
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON=1 ;;
    --rigs-dir) RIGS="$2"; shift ;;
    *) echo "usage: worktree-report.sh [--json] [--rigs-dir DIR]" >&2; exit 2 ;;
  esac
  shift
done
SESS="${HQ_SESSIONS_JSON:-$HQ/state/sessions.json}"

# pane cwds from the default tmux server and the hqterm server, plus every process cwd
# (a dev server or claude started outside tmux still holds the worktree). Reading another
# user's /proc/<pid>/cwd needs root; without it the scan is partial and nothing is SAFE.
PROCS_FULL=false
if PROC_CWDS="$(sudo -n bash -c 'for c in /proc/[0-9]*/cwd; do readlink "$c" 2>/dev/null; done' 2>/dev/null)"; then PROCS_FULL=true
else PROC_CWDS="$(for c in /proc/[0-9]*/cwd; do readlink "$c" 2>/dev/null; done)"; fi
PANES="$( { tmux list-panes -a -F '#{pane_current_path}' 2>/dev/null
            tmux -L hqterm list-panes -a -F '#{pane_current_path}' 2>/dev/null
            printf '%s\n' "$PROC_CWDS"; } | sort -u)"

default_branch() { # main, master, or origin's HEAD; anything else is unknown (empty), never SAFE
  local r="$1" o
  if git -C "$r" rev-parse --verify -q main >/dev/null 2>&1; then echo main
  elif git -C "$r" rev-parse --verify -q master >/dev/null 2>&1; then echo master
  elif o="$(git -C "$r" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)"; then echo "$o"
  fi
}

bead_for() { # worktree path -> bead id from the session registry
  [ -r "$SESS" ] || return 0
  jq -r --arg p "$1" '(.sessions // .) | (if type=="object" then [.[]] else . end)
    | map(select(.worktree==$p)) | last | .bead // empty' "$SESS" 2>/dev/null
}

DISPOSABLE='(^|/)(node_modules|\.next|dist|build|out|\.turbo|\.vite|\.cache|coverage|__pycache__|\.pytest_cache|\.venv|venv|test-results|playwright-report|graphify-out|\.vercel)/?$|\.(log|pyc|tsbuildinfo)$'
now="$(date +%s)"
rows="$(mktemp)"; trap 'rm -f "$rows"' EXIT
seen=""

for rig in "$RIGS"/*/; do
  rig="${rig%/}"
  [ -d "$rig/.git" ] || continue
  top="$(readlink -f "$rig")"
  def="$(default_branch "$rig")"
  while read -r wt; do
    wt="$(readlink -f "$wt")"
    [ "$wt" = "$top" ] && continue
    [ -d "$wt" ] || continue
    case " $seen " in *" $wt "*) continue ;; esac
    seen="$seen $wt"
    br="$(git -C "$wt" symbolic-ref --short -q HEAD || echo '(detached)')"
    # Fail closed: any git error, or a default branch that does not resolve here, makes the
    # worktree "unknown", which is never SAFE (a root-owned or corrupt worktree reads as empty).
    unknown=false; ahead=0; merged=false; dirty=0
    if [ -z "$def" ] || ! git -C "$wt" rev-parse --verify -q "$def" >/dev/null 2>&1; then unknown=true; fi
    if [ "$unknown" = false ]; then
      if ahead="$(git -C "$wt" rev-list --count "$def..HEAD" 2>/dev/null)"; then
        if [ "$ahead" = 0 ]; then merged=true
        elif git -C "$wt" merge-base --is-ancestor HEAD "$def" 2>/dev/null; then merged=true
        elif [ -n "$(git -C "$wt" rev-list --merges "$def..HEAD" 2>/dev/null)" ]; then merged=false  # cherry skips merges
        elif ch="$(git -C "$wt" cherry "$def" HEAD 2>/dev/null)"; then
          printf '%s\n' "$ch" | grep -q '^+' || merged=true
        else unknown=true; fi
      else unknown=true; ahead=0; fi
    fi
    if st="$(git -C "$wt" status --porcelain 2>/dev/null)"; then
      dirty="$(printf '%s' "$st" | grep -c . || true)"
      # A worktree remove deletes ignored files too. Every ignored file counts as dirty except
      # this explicit list of rebuildable outputs (dependency, build and cache dirs, logs).
      ign="$(git -C "$wt" ls-files --others --ignored --exclude-standard --directory 2>/dev/null \
        | grep -Ev "$DISPOSABLE" | grep -c . || true)"
      dirty=$(( dirty + ign ))
    else unknown=true; fi
    ts="$(git -C "$wt" log -1 --format=%ct 2>/dev/null || echo "$now")"
    age=$(( (now - ts) / 86400 ))
    kb="$(du -sk "$wt" 2>/dev/null | cut -f1)"
    pane=false
    # exact path or a path below it, never a sibling that shares a prefix (x-1 vs x-10)
    if [ -n "$PANES" ] && printf '%s\n' "$PANES" | grep -q -x -F -e "$wt" -e "$wt/"; then pane=true; fi
    if [ "$pane" = false ] && [ -n "$PANES" ] && printf '%s\n' "$PANES" | grep -q "^$(printf '%s' "$wt" | sed 's/[]\/$*.^[]/\\&/g')/"; then pane=true; fi
    [ "$pane" = false ] && [ "$PROCS_FULL" = false ] && unknown=true  # partial process scan
    safe=false
    [ "$unknown" = false ] && [ "$merged" = true ] && [ "$dirty" = 0 ] && [ "$pane" = false ] && safe=true
    jq -cn --arg path "$wt" --arg rig "$(basename "$rig")" --arg branch "$br" \
      --arg bead "$(bead_for "$wt")" --argjson pane "$pane" --argjson ahead "${ahead:-0}" \
      --argjson age "$age" --argjson merged "$merged" --argjson dirty "$dirty" \
      --argjson kb "${kb:-0}" --argjson safe "$safe" --argjson unknown "$unknown" \
      '{path:$path,rig:$rig,branch:$branch,bead:$bead,pane_alive:$pane,ahead:$ahead,
        last_commit_age_days:$age,merged:$merged,dirty_files:$dirty,size_kb:$kb,
        safe_to_remove:$safe,unknown:$unknown}' >> "$rows"
  done < <(git -C "$rig" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
done

summary() {
  jq -s '{total:length,
    merged_clean:(map(select(.merged and .dirty_files==0))|length),
    safe_to_remove:(map(select(.safe_to_remove))|length),
    unmerged:(map(select((.merged|not) and (.unknown|not)))|length),
    unknown:(map(select(.unknown))|length),
    dirty:(map(select(.dirty_files>0))|length),
    size_kb:(map(.size_kb)|add // 0)}' "$rows"
}

if [ "$JSON" = 1 ]; then
  jq -s --argjson s "$(summary)" '{summary:$s, worktrees:.}' "$rows"
else
  jq -r '[(if .safe_to_remove then "SAFE" elif .unknown then "UNKNOWN" else "keep" end), .path, .branch,
          (if .bead=="" then "-" else .bead end), "pane=" + (if .pane_alive then "yes" else "no" end),
          "ahead=\(.ahead)", "age=\(.last_commit_age_days)d",
          (if .merged then "merged" else "UNMERGED" end), "dirty=\(.dirty_files)",
          "\(.size_kb/1024|floor)M"] | @tsv' "$rows"
  summary | jq -r '"total=\(.total) merged+clean=\(.merged_clean) safe_to_remove=\(.safe_to_remove) unmerged=\(.unmerged) unknown=\(.unknown) dirty=\(.dirty) size=\(.size_kb/1048576*10|floor/10)G"'
fi
