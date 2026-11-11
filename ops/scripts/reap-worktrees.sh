#!/usr/bin/env bash
# reap-worktrees.sh (hq-8hsr.1): weekly sweeper for the worktrees and registry rows
# finish.sh never saw. A clean finish removes its own worktree and deregisters its
# session; a killed pane, a crashed worker or a hand-made worktree leaves both behind
# and nothing else reaps them. hqbox carries about 40 dead acme-dashboard-XXXX
# directories from the mid-August swarm for exactly that reason.
#
# Destructive, so the plan is the default and --apply is the exception:
#   reap-worktrees.sh                 print the plan, change nothing
#   reap-worktrees.sh --rig chesski   plan for one rig only
#   reap-worktrees.sh --apply         remove what the plan lists as REAP
#
# A worktree is reaped only when ALL of these hold:
#   1. it is not the rig's own canonical checkout and not the workspace root itself
#   2. it is not locked and not an agent worktree under .claude/worktrees
#   3. git status --porcelain inside it is empty (no uncommitted or untracked work)
#   4. its HEAD is a branch (never detached) that is a true ancestor of the rig default
#   5. no registry session pointing at it is active with a live tmux target, and none
#      is parked in finishable (that state means the owner still has to rescue it)
# Anything failing one of those is listed under KEEP with the reason. The branch is
# deleted with git branch -d (never -D) after the worktree comes out, and the registry
# rows pointing at it are marked done through session-registry.sh, the single writer.
# A removal that fails leaves the registry row alone and makes the run exit 1.
#
# Seams (used by the fixture test, harmless in production):
#   HQ_ROOT           workspace root to scan (default: the ancestor holding ops/scripts)
#   HQ_STATE_DIR      registry and report location (default: HQ_ROOT/state)
#   HQ_REGISTRY_SH    path to session-registry.sh (default: next to this script)
#   HQ_TMUX_WINDOWS   live tmux targets (whitespace separated), instead of asking tmux
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# The workspace root is the nearest ancestor that actually holds ops/scripts, so the
# script works from ops/scripts, from a proposal directory, or from anywhere else in
# the tree. HQ_ROOT overrides it outright (the fixture test relies on that).
default_hq_root() {
  local d="$SCRIPT_DIR"
  while [ "$d" != "/" ] && [ -n "$d" ]; do
    if [ -d "$d/ops/scripts" ]; then printf '%s\n' "$d"; return 0; fi
    d="$(dirname "$d")"
  done
  ( cd "$SCRIPT_DIR/../.." && pwd )
}

HQ="${HQ_ROOT:-$(default_hq_root)}"
RIGS_DIR="$HQ/rigs"
STATE_DIR="${HQ_STATE_DIR:-$HQ/state}"
REGSH="${HQ_REGISTRY_SH:-$SCRIPT_DIR/session-registry.sh}"
PROJECTS_JSON="$HQ/ops/projects.json"
REPORT="$STATE_DIR/reaper/latest.txt"
NL="
"

apply=0
only_rig=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=1 ;;
    --rig) only_rig="${2:-}"; shift ;;
    --out) REPORT="${2:-}"; shift ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "reap-worktrees: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

# ---- live tmux targets ----------------------------------------------------
# Mirrors session-registry.sh reconcile: a session is live when its recorded target is
# either a window name (#S:#W) or a pane id (%N) that tmux still lists. The list is
# kept ONE TOKEN PER LINE and matched on newline boundaries; a space-delimited match
# over newline-delimited tmux output only ever matches the first and last entries,
# which would read every other live pane as dead (review round one, blocker 1).
live_list=""
live_known=0
if [ -n "${HQ_TMUX_WINDOWS+x}" ]; then
  # accept spaces, tabs or newlines from the seam; normalize to one token per line
  live_list="$(printf '%s\n' $HQ_TMUX_WINDOWS)"
  live_known=1
elif command -v tmux >/dev/null 2>&1; then
  w="$(tmux list-windows -a -F '#S:#W' 2>/dev/null)"
  p="$(tmux list-panes -a -F '#{pane_id}' 2>/dev/null)"
  if [ -n "$w" ] || [ -n "$p" ]; then
    live_list="$(printf '%s\n%s\n' "$w" "$p")"
    live_known=1
  fi
fi

is_live_target() {   # $1 = recorded tmux target
  [ "$live_known" = 1 ] || return 0          # unknown: treat as live, reap nothing on its account
  [ -n "$1" ] || return 1
  case "$NL$live_list$NL" in *"$NL$1$NL"*) return 0 ;; esac
  return 1
}

# ---- registry snapshot ----------------------------------------------------
# Read through session-registry.sh, the single writer; never by editing ctl.sh or the
# json by hand. Lines: id, status, tmux target, worktree path (tab separated).
REG_ROWS=""
if [ -x "$REGSH" ]; then
  REG_ROWS="$(HQ_STATE_DIR="$STATE_DIR" "$REGSH" list --json 2>/dev/null | python3 -c '
import json, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    rows = []
for r in rows:
    print("\t".join([str(r.get("id", "")), str(r.get("status", "")),
                     str(r.get("tmux_window", "")), str(r.get("worktree", ""))]))
' 2>/dev/null)"
fi
TAB="$(printf '\t')"
closed_ids=" "

# Which registry row, if any, still has a claim on this worktree? An active row with a
# live pane is an occupied worktree; a finishable row is one finish.sh could not close,
# so the owner still has to rescue it and the worktree stays put either way.
worktree_holder() {   # $1 = worktree path; echoes the KEEP reason
  local id st win rwt
  while IFS="$TAB" read -r id st win rwt; do
    [ -n "${id:-}" ] || continue
    [ "$rwt" = "$1" ] || continue
    case "$st" in
      finishable) echo "session $id is finishable, waiting on the owner"; return 0 ;;
      active) if is_live_target "$win"; then echo "session $id is still live"; return 0; fi ;;
    esac
  done <<REGEOF
$REG_ROWS
REGEOF
  return 1
}

# ---- default branch of a rig ---------------------------------------------
# origin/HEAD is the authority; then main, then master, then a defaultBranch field if
# ops/projects.json ever grows one. NEVER the canonical checkout's current branch: a
# rig parked on a long-lived feature branch would otherwise make that branch "the
# default" and any worktree merged only into it would be reaped, with git branch -d
# agreeing because it measures against the same parked HEAD (review round one,
# blocker 2). A rig whose default cannot be resolved is skipped, not guessed.
rig_default_branch() {   # $1 = rig checkout, $2 = rig name
  local d
  d="$(git -C "$1" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)"
  if [ -n "$d" ] && git -C "$1" rev-parse --verify --quiet "refs/heads/${d#origin/}" >/dev/null 2>&1; then
    printf '%s\n' "${d#origin/}"; return 0
  fi
  for d in main master; do
    if git -C "$1" rev-parse --verify --quiet "refs/heads/$d" >/dev/null 2>&1; then
      printf '%s\n' "$d"; return 0
    fi
  done
  if [ -f "$PROJECTS_JSON" ]; then
    d="$(RIG="$2" PJ="$PROJECTS_JSON" python3 -c '
import json, os, sys
try:
    doc = json.load(open(os.environ["PJ"]))
except Exception:
    sys.exit(0)
rig = os.environ["RIG"]
for p in doc.get("projects", []):
    path = str(p.get("path", ""))
    if path.rstrip("/").endswith("/" + rig) or p.get("id") == rig or p.get("name") == rig:
        b = p.get("defaultBranch") or p.get("default_branch") or ""
        if b:
            print(b)
        break
' 2>/dev/null)"
    if [ -n "$d" ] && git -C "$1" rev-parse --verify --quiet "refs/heads/$d" >/dev/null 2>&1; then
      printf '%s\n' "$d"; return 0
    fi
  fi
  return 1
}

# ---- plan -----------------------------------------------------------------
plan=""
add() { plan="$plan$1"$'\n'; }

n_reap=0; n_keep=0; n_prune=0; n_rows=0
removed=0; branches_deleted=0; rows_closed=0; failures=0

stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mode="dry run"; [ "$apply" = 1 ] && mode="apply"
add "reap-worktrees: $mode  $stamp  root $HQ"

[ -d "$RIGS_DIR" ] || add "no rigs directory at $RIGS_DIR; nothing to scan"

# One worktree record out of git worktree list --porcelain, decided and (with --apply)
# acted on. Clears wt so the next record starts from a blank slate.
flush_record() {
  [ -n "$wt" ] || return 0
  local reason="" branch_short="" held="" dirty id st win rwt
  branch_short="${wtbranch#refs/heads/}"
  if [ "$wt" = "$rigdir" ] || [ "$wt" = "$HQ" ]; then
    wt=""; return 0                       # canonical checkout: never listed, never touched
  fi
  if [ "$wtprunable" = 1 ] || [ ! -d "$wt" ]; then
    add "  PRUNE $wt (administrative entry, directory is gone)"
    n_prune=$((n_prune + 1)); prune_here=1; wt=""; return 0
  fi
  case "$wt" in */.claude/worktrees/*) reason="agent worktree, out of scope" ;; esac
  [ -n "$reason" ] || [ "$wtlocked" = 0 ] || reason="locked"
  [ -n "$reason" ] || [ "$wtdetached" = 0 ] || reason="detached HEAD"
  [ -n "$reason" ] || [ -n "$branch_short" ] || reason="no branch recorded"
  [ -n "$reason" ] || [ "$branch_short" != "$default" ] || reason="sits on the default branch"
  if [ -z "$reason" ]; then
    dirty="$(git -C "$wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    if [ -z "$dirty" ]; then reason="status unreadable"
    elif [ "$dirty" != 0 ]; then reason="dirty: $dirty uncommitted or untracked paths"; fi
  fi
  if [ -z "$reason" ]; then
    if ! git -C "$rigdir" merge-base --is-ancestor "refs/heads/$branch_short" "refs/heads/$default" >/dev/null 2>&1; then
      reason="branch $branch_short is not merged into $default"
    fi
  fi
  if [ -z "$reason" ]; then
    held="$(worktree_holder "$wt")" && reason="$held"
  fi
  if [ -n "$reason" ]; then
    add "  KEEP  $wt ($reason)"
    n_keep=$((n_keep + 1)); wt=""; return 0
  fi
  add "  REAP  $wt  branch $branch_short (merged into $default, clean, no live session)"
  n_reap=$((n_reap + 1))
  if [ "$apply" = 1 ]; then
    if git -C "$rigdir" worktree remove "$wt" >/dev/null 2>&1; then
      removed=$((removed + 1))
      add "        removed worktree"
      if git -C "$rigdir" branch -d "$branch_short" >/dev/null 2>&1; then
        branches_deleted=$((branches_deleted + 1))
        add "        deleted branch $branch_short"
      else
        add "        branch $branch_short kept (git branch -d refused it)"
      fi
      while IFS="$TAB" read -r id st win rwt; do
        [ -n "${id:-}" ] || continue
        [ "$rwt" = "$wt" ] || continue
        [ "$st" = "done" ] && continue
        if HQ_STATE_DIR="$STATE_DIR" "$REGSH" update "$id" --status done >/dev/null 2>&1; then
          rows_closed=$((rows_closed + 1)); closed_ids="$closed_ids$id "
          add "        registry row $id marked done"
        fi
      done <<REGEOF
$REG_ROWS
REGEOF
    else
      # the worktree is still there, so its registry row still describes reality
      add "        remove FAILED, left in place with its registry row untouched"
      failures=$((failures + 1))
    fi
  fi
  wt=""
}

for rigdir in "$RIGS_DIR"/*; do
  [ -d "$rigdir" ] || continue
  rig="$(basename "$rigdir")"
  [ -z "$only_rig" ] || [ "$rig" = "$only_rig" ] || continue
  # A canonical rig checkout has a .git DIRECTORY; a worktree has a .git FILE, so this
  # skips the leftovers themselves and asks their owning repo about them instead.
  [ -d "$rigdir/.git" ] || continue

  default="$(rig_default_branch "$rigdir" "$rig")"
  if [ -z "$default" ]; then
    add "rig $rig: no origin/HEAD, no main, no master and no defaultBranch in projects.json; skipped"
    continue
  fi
  add "rig $rig (default $default)"

  # git worktree list --porcelain: blank-line separated records
  wt=""; wtbranch=""; wtdetached=0; wtlocked=0; wtprunable=0; prune_here=0
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) flush_record; wt="${line#worktree }"; wtbranch=""; wtdetached=0; wtlocked=0; wtprunable=0 ;;
      "branch "*)   wtbranch="${line#branch }" ;;
      "detached")   wtdetached=1 ;;
      "locked"*)    wtlocked=1 ;;
      "prunable"*)  wtprunable=1 ;;
      "")           flush_record ;;
    esac
  done < <(git -C "$rigdir" worktree list --porcelain 2>/dev/null)
  flush_record

  if [ "$apply" = 1 ] && [ "$prune_here" = 1 ]; then
    git -C "$rigdir" worktree prune >/dev/null 2>&1 || true
  fi
done

# ---- registry rows whose tmux target is gone ------------------------------
# Independent of the worktrees: a session can outlive its directory and the reverse.
# Only active rows are swept; finishable is the owner's queue, not the reaper's.
add "registry"
while IFS="$TAB" read -r id st win rwt; do
  [ -n "${id:-}" ] || continue
  [ "$st" = "active" ] || continue
  case "$closed_ids" in *" $id "*) continue ;; esac
  is_live_target "$win" && continue
  add "  CLOSE $id (tmux target ${win:-none} is gone)"
  n_rows=$((n_rows + 1))
  if [ "$apply" = 1 ]; then
    HQ_STATE_DIR="$STATE_DIR" "$REGSH" update "$id" --status done >/dev/null 2>&1 \
      && rows_closed=$((rows_closed + 1))
  fi
done <<REGEOF
$REG_ROWS
REGEOF
[ "$live_known" = 1 ] || add "  (tmux not reachable; every active row treated as live)"

# ---- per-session state files (hq-1nkg.7) ------------------------------------
# launch-<id>.sh, launch-<id>-wake.sh and wake-<id>.lock (hq-1nkg.17) are keyed by registry id: remove them when the
# registry row is done or gone, keep them for active and finishable rows. With an
# unreadable or empty registry nothing is removed. touched-<claude-session-uuid> files
# cannot be mapped to a registry id, so they go by age (TOUCHED_MAX_AGE_DAYS, default 7,
# a live session rewrites its file on every mutation).
add "state files"
n_files=0
if [ -n "$REG_ROWS" ] && [ -d "$STATE_DIR" ]; then
  for f in "$STATE_DIR"/launch-s-*.sh "$STATE_DIR"/wake-*.lock; do
    [ -f "$f" ] || continue
    # spawn.sh writes the launcher before it registers the session: keep anything fresh
    [ -z "$(find "$f" -mmin -10 2>/dev/null)" ] || continue
    b="${f##*/}"; b="${b#launch-}"; b="${b#wake-}"; b="${b%.sh}"; b="${b%.lock}"; b="${b%-wake}"
    keep=0
    while IFS="$TAB" read -r id st win rwt; do
      [ "${id:-}" = "$b" ] || continue
      case "$st" in done|closed|deregistered) ;; *) keep=1 ;; esac
    done <<REGEOF
$REG_ROWS
REGEOF
    case "$closed_ids" in *" $b "*) keep=0 ;; esac
    [ "$keep" = 0 ] || continue
    add "  REMOVE $f (session $b is done or gone)"
    n_files=$((n_files + 1))
    [ "$apply" = 1 ] && rm -f "$f"
  done
fi
if [ -d "$STATE_DIR" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    add "  REMOVE $f (touched file idle over ${TOUCHED_MAX_AGE_DAYS:-7} days)"
    n_files=$((n_files + 1))
    [ "$apply" = 1 ] && rm -f "$f"
  done < <(find "$STATE_DIR" -maxdepth 1 -type f -name 'touched-*' -mtime "+${TOUCHED_MAX_AGE_DAYS:-7}" 2>/dev/null)
fi

if [ "$apply" = 1 ]; then
  add "summary: removed $removed worktrees, deleted $branches_deleted branches, closed $rows_closed registry rows, kept $n_keep, failed $failures"
else
  add "summary: $n_reap to remove, $n_prune stale entries to prune, $n_rows registry rows to close, $n_keep kept (dry run; re-run with --apply)"
fi

printf '%s' "$plan"
if [ -n "$REPORT" ]; then
  mkdir -p "$(dirname "$REPORT")" 2>/dev/null || true
  printf '%s' "$plan" > "$REPORT" 2>/dev/null || true
fi
[ "$failures" = 0 ] || exit 1
exit 0
