#!/usr/bin/env bash
# hub-sync: the credential-holding half of git-sync on hqbox (design 3b, P0.7).
#
# Runs as the system user hqsync (unit: hq-hub-sync.service + .timer, or --watch).
# It is the only process on the box that holds the GitHub PAT. It keeps one bare
# mirror per repo under $MIRRORS and moves commits both ways:
#
#   origin (GitHub)  <--fetch/push-->  mirror (/var/lib/hqsync/mirrors/NAME.git)  <--fetch/push-->  owner's checkouts
#
# owner-context git (workers, git-sync.sh, the console wrapper) talks only to
# the mirror over a local path, so no credential is ever readable as owner.
# Per cycle, per repo, under the shared hqgit lock:
#   1. fetch origin into the mirror with FAST-FORWARD-ONLY refspecs (no '+'), so a
#      mirror branch that owner-context advanced and that origin also moved is
#      never clobbered: it stays diverged and gets reported.
#   2. push to origin the refs origin should follow: the default branch, autofix/*
#      and refs/dolt/* (beads sync lives on the git remote). git push is a no-op
#      when origin already has them; a non-fast-forward is reported, never forced.
# Config: $REPOS_CONF lines "NAME URL DEFAULT_BRANCH". Credentials: git credential
# store at $CRED_FILE (0600 hqsync), never printed. Heartbeat: writes $HEARTBEAT.
#
# Usage: hub-sync.sh [--watch] [--init NAME URL BRANCH]
set -uo pipefail
MIRRORS="${HUB_MIRRORS:-/var/lib/hqsync/mirrors}"
REPOS_CONF="${HUB_REPOS_CONF:-/var/lib/hqsync/repos.conf}"
CRED_FILE="${HUB_CRED_FILE:-/var/lib/hqsync/cred/store}"
LOCK="${HUB_LOCK:-/run/lock/hqgit/hq-git.lock}"
HEARTBEAT="${HUB_HEARTBEAT:-/var/lib/hqsync/heartbeat}"
STATUS="${HUB_STATUS:-/var/lib/hqsync/status.json}"
BACKUP_FILE="${HUB_CRED_BACKUP:-$CRED_FILE.bak}"
SEED_FILE="${HUB_CRED_SEED:-}"
AUTH_STATE="${HUB_AUTH_STATE:-/var/lib/hqsync/auth-fail}"
export GIT_TERMINAL_PROMPT=0
declare -A REPO_STATE
CYCLE_AUTH_ERR=""
CYCLE_OK=0
AUTH_FAILING=0 AUTH_SINCE="" AUTH_ERR=""
INTERVAL="${HUB_INTERVAL:-45}"

log() { printf '%s hub-sync %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { log "FATAL $*"; exit 1; }
# Read-only helper: only "get" reaches the store. The stock "store" helper also runs
# "erase" when GitHub rejects one request, which emptied $CRED_FILE on 2026-11-03 and
# stopped every sync for 12 h. No erase, no store: the file is only ever read.
gitc() { git -c credential.helper= -c "credential.helper=!f() { [ \"\$1\" = get ] && git credential-store --file $(printf %q "$CRED_FILE") get; }; f" "$@"; }

# heal_cred: an empty or missing store is re-seeded from the last good backup, else from
# $SEED_FILE (the owner store, if hqsync can read it). A good store refreshes the backup.
heal_cred() {
  if [ -s "$CRED_FILE" ]; then
    cmp -s "$CRED_FILE" "$BACKUP_FILE" 2>/dev/null || { cp -f "$CRED_FILE" "$BACKUP_FILE.tmp" && chmod 0600 "$BACKUP_FILE.tmp" && mv -f "$BACKUP_FILE.tmp" "$BACKUP_FILE"; } 2>/dev/null || true
    return 0
  fi
  local src
  for src in "$BACKUP_FILE" "$SEED_FILE"; do
    [ -n "$src" ] && [ -s "$src" ] || continue
    if cp -f "$src" "$CRED_FILE.tmp" 2>/dev/null && chmod 0600 "$CRED_FILE.tmp" && mv -f "$CRED_FILE.tmp" "$CRED_FILE"; then
      log "HEALED credential store (was empty or missing), re-seeded from $src"
      return 0
    fi
  done
  log "credential store empty and no seed available"
}

# is_auth_err TEXT: git output that means GitHub refused our credentials
is_auth_err() { printf '%s' "$1" | grep -qiE 'authentication failed|could not read (username|password)|invalid username or password|bad credentials|terminal prompts disabled|returned error: 40[13]'; }

# auth_track: one call per cycle, under the lock. Counts consecutive cycles in which GitHub
# refused our credentials and publishes the count in status.json ("auth"). hub-sync sends
# no alert itself: it runs as hqsync under ProtectHome and must never run owner's code
# (design 3b). The owner side (hub-auth-alert.sh, from git-sync) reads status.json and
# notifies once per outage. Only a real success (a fetch or push that reached GitHub)
# ends an outage; a cycle that failed for another reason (DNS, refused, timeout) leaves
# the count and its start time unchanged, so a network blip cannot re-arm the alert.
auth_track() {
  local c="" s="" e=""
  [ -r "$AUTH_STATE" ] && { IFS=' ' read -r c s; IFS= read -r e; } <"$AUTH_STATE"
  [[ "$c" =~ ^[0-9]+$ ]] || c=0
  [[ "$s" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || s=""
  if [ -n "$CYCLE_AUTH_ERR" ]; then
    c=$((c + 1))
    [ "$c" -eq 1 ] && s=""
    e="$(printf '%s' "$CYCLE_AUTH_ERR" | tr -d '\000-\037"\\' | cut -c1-200)"
  elif [ "$CYCLE_OK" -eq 1 ]; then
    c=0 s="" e=""
  fi
  # since = when this outage began; it is the outage's identity for the owner-side alert
  [ "$c" -gt 0 ] && [ -z "$s" ] && s="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  AUTH_FAILING="$c" AUTH_SINCE="$s" AUTH_ERR="$e"
  printf '%s %s\n%s\n' "$c" "$s" "$e" >"$AUTH_STATE.tmp" 2>/dev/null && mv -f "$AUTH_STATE.tmp" "$AUTH_STATE" 2>/dev/null || true
}

init_repo() {
  local name="$1" url="$2" branch="$3"
  local dir="$MIRRORS/$name.git"
  if [ ! -d "$dir" ]; then
    mkdir -p "$MIRRORS" || die "mkdir $MIRRORS"
    gitc clone --bare --quiet "$url" "$dir" || die "clone $name from origin failed"
    git -C "$dir" config core.sharedRepository group || die "sharedRepository $name"
    git -C "$dir" config receive.denyNonFastForwards true || die "denyNonFastForwards $name"
    git -C "$dir" config remote.origin.fetch 'refs/heads/*:refs/heads/*' || die "fetch refspec $name"
    git -C "$dir" config --add remote.origin.fetch 'refs/dolt/*:refs/dolt/*' || die "dolt refspec $name"
    # forced shadow of origin's tips: what GitHub really has, independent of local pushes
    git -C "$dir" config --add remote.origin.fetch '+refs/heads/*:refs/hub-origin/*' || die "shadow refspec $name"
    git -C "$dir" symbolic-ref HEAD "refs/heads/$branch" || die "HEAD $name"
    chmod -R g+rwX "$dir" || true
    find "$dir" -type d -exec chmod g+s {} + || true
    log "initialised mirror $name from origin ($branch)"
  fi
  if ! grep -q "^$name " "$REPOS_CONF" 2>/dev/null; then
    printf '%s %s %s\n' "$name" "$url" "$branch" >>"$REPOS_CONF" || die "cannot write $REPOS_CONF"
  fi
}

# forward_refs NAME DIR BRANCH: push the refs origin should follow.
forward_refs() {
  local name="$1" dir="$2" branch="$3" ref out
  local pushlist=()
  for ref in "refs/heads/$branch" $(git -C "$dir" for-each-ref --format='%(refname)' 'refs/heads/autofix/*' 'refs/dolt/*'); do
    git -C "$dir" rev-parse -q --verify "$ref" >/dev/null 2>&1 || continue
    pushlist+=("$ref:$ref")
  done
  [ ${#pushlist[@]} -gt 0 ] || return 0
  if ! out=$(gitc -C "$dir" push --porcelain --quiet origin "${pushlist[@]}" 2>&1); then
    log "PUSH FAILED $name: $(printf '%s' "$out" | grep -E '^(!|error|fatal)' | head -3 | tr '\n' ' ')"
    is_auth_err "$out" && CYCLE_AUTH_ERR="$name push: $(printf '%s' "$out" | grep -iE 'fatal|error' | head -1 | cut -c1-160)"
    if printf '%s' "$out" | grep -qE 'non-fast-forward|fetch first'; then REPO_STATE[$name]="diverged"; else REPO_STATE[$name]="push-failed"; fi
    return 1
  fi
  CYCLE_OK=1
  printf '%s\n' "$out" | grep -E '^ ' | sed "s/^/$name pushed: /" | head -5
  return 0
}

# merge_origin NAME DIR BRANCH: the mirror's default branch carries commits origin does
# not have (pushed by owner-context) AND origin moved underneath (a real divergence:
# origin's tip is not an ancestor of the mirror branch). Merge origin's tip
# (refs/hub-origin/BRANCH) INTO the mirror branch in a throwaway worktree. Local history
# is never rewritten: every local commit and merge keeps its sha and its tree (a rebase,
# even with --rebase-merges, recreates merges without the changes amended into them,
# hq-fgg3.13 review). The result is a fast-forward of origin, so the next forward pushes
# it, and owner-side checkouts are then simply behind and fast-forward. A conflicting
# merge is aborted, nothing moves, and the repo stays "diverged" for a human.
merge_origin() {
  local name="$1" dir="$2" branch="$3" tmp new old
  git -C "$dir" rev-parse -q --verify "refs/hub-origin/$branch" >/dev/null 2>&1 || return 1
  old="$(git -C "$dir" rev-parse "refs/heads/$branch")" || return 1
  tmp="$(mktemp -d /tmp/hub-merge.XXXXXX)" || return 1
  if ! git -C "$dir" worktree add --detach --quiet "$tmp" "$old" 2>/dev/null; then rmdir "$tmp" 2>/dev/null; return 1; fi
  if git -C "$tmp" -c user.name=hub-sync -c user.email=hub-sync@hqbox merge --quiet --no-ff --no-edit \
       -m "hub-sync: merge origin/$branch into $name/$branch (both boxes moved)" "refs/hub-origin/$branch" >/dev/null 2>&1; then
    new="$(git -C "$tmp" rev-parse HEAD)"
    # compare-and-swap: only move the branch if nobody pushed to the mirror meanwhile
    if git -C "$dir" update-ref "refs/heads/$branch" "$new" "$old"; then
      log "merged origin into $name/$branch ($new)"
      git -C "$dir" worktree remove --force "$tmp" >/dev/null 2>&1 || true
      return 0
    fi
  fi
  git -C "$tmp" merge --abort >/dev/null 2>&1 || true
  git -C "$dir" worktree remove --force "$tmp" >/dev/null 2>&1 || true
  return 1
}

sync_repo() {
  local name="$1" url="$2" branch="$3" out
  local dir="$MIRRORS/$name.git"
  [ -d "$dir" ] || { log "no mirror for $name (run --init)"; REPO_STATE[$name]="missing"; return 0; }
  REPO_STATE[$name]="ok"
  # A hub-sync killed mid-merge leaves its throwaway /tmp/hub-merge.* (or older
  # /tmp/hub-rebase.*) worktree registered, and the dir still exists, so a bare prune
  # would not drop it. Cycles are serialised by the hqgit lock, so any such worktree
  # left at the start of a cycle is stale: remove it, then prune.
  local wt
  for wt in $(git -C "$dir" worktree list --porcelain 2>/dev/null | sed -n 's#^worktree \(/tmp/hub-\(merge\|rebase\)\.[A-Za-z0-9]*\)$#\1#p'); do
    git -C "$dir" worktree remove --force "$wt" >/dev/null 2>&1 || rm -rf "$wt"
  done
  git -C "$dir" worktree prune >/dev/null 2>&1 || true
  # older mirrors (before the shadow refspec existed) get it added on the fly. Fixed-string
  # match: as a regex the '*' and '+' never matched the stored value, so the refspec was
  # re-added every cycle (68k copies per mirror by 2026-10-19, hq-h2ww). More than one
  # copy is collapsed back to one.
  local shadow='+refs/heads/*:refs/hub-origin/*' nshadow
  nshadow=$(git -C "$dir" config --get-all remote.origin.fetch | grep -cxF -- "$shadow")
  if [ "${nshadow:-0}" -ne 1 ]; then
    [ "${nshadow:-0}" -gt 1 ] && git -C "$dir" config --unset-all --fixed-value remote.origin.fetch "$shadow"
    git -C "$dir" config --add remote.origin.fetch "$shadow" || true
  fi
  # fetch first (fast-forward only), then forward what the mirror has that origin lacks; pushing
  # before fetching would be rejected with "fetch first" whenever origin is simply ahead
  if out=$(gitc -C "$dir" fetch --no-progress origin 2>&1); then
    CYCLE_OK=1
  else
    if printf '%s' "$out" | grep -qE 'rejected|non-fast-forward'; then
      CYCLE_OK=1   # a ref rejection means GitHub answered: the credential worked
      # A rejection is normal when the mirror is simply AHEAD of origin (owner-context
      # pushed, origin has not got it yet): fetching origin's older tip would move the
      # branch backwards. The forced shadow ref still updated, so compare against it and
      # merge origin in only on a real divergence; otherwise forward_refs pushes the tip as is,
      # merge commits included (hq-fgg3.13).
      if git -C "$dir" merge-base --is-ancestor "refs/hub-origin/$branch" "refs/heads/$branch" 2>/dev/null; then
        REPO_STATE[$name]="ok"
      elif merge_origin "$name" "$dir" "$branch"; then
        REPO_STATE[$name]="ok"
      else
        log "DIVERGED $name (mirror and origin both moved, merge of origin not clean): $(printf '%s' "$out" | grep rejected | head -1)"
        REPO_STATE[$name]="diverged"
      fi
    else
      log "FETCH FAILED $name: $(printf '%s' "$out" | tail -1)"
      is_auth_err "$out" && CYCLE_AUTH_ERR="$name fetch: $(printf '%s' "$out" | tail -1 | cut -c1-160)"
      REPO_STATE[$name]="fetch-failed"
    fi
  fi
  forward_refs "$name" "$dir" "$branch" || true
}

sync_all() {
  [ -r "$REPOS_CONF" ] || { log "no repos.conf at $REPOS_CONF"; return 0; }
  exec 9>"$LOCK" || { log "cannot open lock $LOCK"; return 0; }
  if ! flock -w 60 9; then log "lock held for over 60s, skipping cycle"; return 0; fi
  heal_cred
  CYCLE_AUTH_ERR="" CYCLE_OK=0
  while read -r name url branch; do
    [ -n "${name:-}" ] && [ "${name#\#}" = "$name" ] || continue
    sync_repo "$name" "$url" "$branch"
  done <"$REPOS_CONF"
  # results, auth state, heartbeat and status.json are all written before the lock is
  # released, so two cycles (timer plus --watch) can never interleave their state writes
  auth_track
  date +%s >"$HEARTBEAT" || true
  # status.json is read by the console's Machines collector (a diverged or failing repo becomes
  # a card) and by hub-auth-alert.sh on the owner side ("auth": consecutive refused cycles)
  {
    printf '{"at":"%s","repos":{' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    local first=1 n
    for n in "${!REPO_STATE[@]}"; do
      [ $first -eq 1 ] || printf ','
      printf '"%s":"%s"' "$n" "${REPO_STATE[$n]}"; first=0
    done
    printf '},"auth":{"failing_cycles":%s,"since":"%s","error":"%s"}}\n' "$AUTH_FAILING" "$AUTH_SINCE" "$AUTH_ERR"
  } >"$STATUS.tmp" && mv -f "$STATUS.tmp" "$STATUS" || true
  flock -u 9
}

case "${1:-}" in
  --init) shift; [ $# -eq 3 ] || die "usage: --init NAME URL BRANCH"; init_repo "$1" "$2" "$3" ;;
  --watch) log "watching every ${INTERVAL}s"; while true; do sync_all; sleep "$INTERVAL"; done ;;
  "") sync_all ;;
  *) die "unknown arg $1" ;;
esac
