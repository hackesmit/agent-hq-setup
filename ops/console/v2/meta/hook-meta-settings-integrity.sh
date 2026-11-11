#!/usr/bin/env bash
# PreToolUse hook (Bash|Write|Edit|MultiEdit|NotebookEdit): meta-terminal
# settings-integrity gate.
#
# Console v2, spec section 3b. The meta terminal is uncaged but permission-prompted:
# every mutating tool call asks the owner before it runs. The one way that property can
# be lost from inside the session is a permission rule that pre-approves a tool. An
# "always allow" answer PERSISTS an allow rule into a settings file and the running
# process applies it immediately, so an asynchronous watcher is too late: the very
# next tool call would already run unprompted.
#
# So this hook runs synchronously in the tool-call path. At session start it records
# the sha256 of every settings file that can grant permissions; on every later call it
# recomputes them and blocks (exit 2) if anything changed, appeared, or disappeared.
# Because the check is inside the call path, a second mutation cannot slip through
# between the persisted rule and the runner's revert.
#
# Watched:
#   ~/.claude/settings.json                 (user settings, loaded by --setting-sources user)
#   <project>/.claude/settings.local.json   (where "always allow" answers land)
#   <project>/.claude/settings.json         (present or not; appearing is a change)
#   $HQ_META_SETTINGS                       (the meta settings file itself)
#
# Environment (the runner sets these; the defaults are the provisioned layout):
#   HQ_META_STATE     base dir for per-session state, default
#                     /var/lib/hqconsole/meta/sessions ; this hook uses
#                     $HQ_META_STATE/<session-id>/ and writes ONLY there
#   HQ_META_SID       the runner's session id; names the state dir (else the
#                     payload's session_id)
#   HQ_META_SETTINGS  default /var/lib/hqconsole/meta/meta-settings.json
#   HQ_META_PROJECT   project dir override (else CLAUDE_PROJECT_DIR, else the
#                     payload's cwd, else ~/hq)
#
# Ownership note: /var/lib/hqconsole/meta is owned by hqconsole and is read-only to
# owner, so the meta session cannot replace the hook that checks it or the settings
# it checks. The per-session state dir under $HQ_META_STATE is the one path the
# runner creates with owner write access, and it is the only path this hook writes.
#
# Failure policy: this is a security gate on the highest-privilege session on the box,
# with the owner sitting at the keyboard, so it fails CLOSED. An unusable state dir, an
# unreadable settings file or a missing meta settings file blocks and says why; the
# runner surfaces that as a card rather than letting an unverifiable session mutate
# the cage. Speed matters (it is on every call): four sha256sum forks, no python, no
# background work, measured well under 50 ms.
set -uo pipefail

HQ_META_PAYLOAD="$(cat)" || HQ_META_PAYLOAD=""

STATE_BASE="${HQ_META_STATE:-/var/lib/hqconsole/meta/sessions}"
META_SETTINGS="${HQ_META_SETTINGS:-/var/lib/hqconsole/meta/meta-settings.json}"

json_str() { # <key> ; first string value for that key in the payload, no forks
  local re="\"$1\"[[:space:]]*:[[:space:]]*\"([^\"]*)\""
  [[ "$HQ_META_PAYLOAD" =~ $re ]] && printf '%s' "${BASH_REMATCH[1]}"
  return 0
}

# The runner names the session (HQ_META_SID, set on the scope by the wrapper) and its
# pre-start snapshot leaves the baseline in that dir. claude's own session_id is a
# different id the runner never learns, so it is only the fallback for the test suite.
sid="${HQ_META_SID:-}"
[ -n "$sid" ] || sid="$(json_str session_id)"
sid="${sid//[^A-Za-z0-9._-]/}"
[ -n "$sid" ] || sid="unknown-session"

proj="${HQ_META_PROJECT:-${CLAUDE_PROJECT_DIR:-}}"
[ -n "$proj" ] || proj="$(json_str cwd)"
[ -n "$proj" ] || proj="$HOME/hq"
proj="${proj%/}"

SDIR="$STATE_BASE/$sid"
BASELINE="$SDIR/settings-baseline.sha256"
# markers live in flags/ (owner-writable, created by the runner); the session dir itself is read-only
mkdir -p "$SDIR/flags" 2>/dev/null || true
MARKER="$SDIR/flags/INTEGRITY_FAILED"

HINT="The meta terminal is uncaged only because every mutation needs your keypress. Close the session from the console, let it reconcile, and start a new one."

fail() { # <reason> ; write the marker the runner watches, then block
  local reason="$1"
  if [ -d "$SDIR" ] && [ -w "$SDIR" ]; then
    printf '%s\n' "$reason" > "$MARKER" || true
  fi
  printf 'Blocked (meta settings integrity): %s\n%s\n' "$reason" "$HINT" >&2
  exit 2
}

# Already failed once: stay failed for the rest of the session.
if [ -f "$MARKER" ]; then
  fail "$(head -c 400 "$MARKER" 2>/dev/null | head -n1)"
fi

mkdir -p "$SDIR" 2>/dev/null || true
if [ ! -d "$SDIR" ] || [ ! -w "$SDIR" ]; then
  printf 'Blocked (meta settings integrity): session state dir %s is missing or not writable, so settings integrity cannot be verified.\n%s\n' \
    "$SDIR" "$HINT" >&2
  exit 2
fi

if [ ! -f "$META_SETTINGS" ]; then
  fail "the meta settings file $META_SETTINGS is missing, so the permission configuration this session runs under cannot be verified"
fi

FILES=(
  "$HOME/.claude/settings.json"
  "$proj/.claude/settings.local.json"
  "$proj/.claude/settings.json"
  "$META_SETTINGS"
)

# One sha256sum call for the whole watched set (a fork per file was most of this
# hook's cost, and it runs on every mutating tool call). Absent or unreadable files
# get a sentinel, so "appeared" and "disappeared" are ordinary hash changes.
snapshot() {
  local f h p
  local -a present=()
  local -A H=()
  for f in "${FILES[@]}"; do
    [ -f "$f" ] && [ -r "$f" ] && present+=("$f")
  done
  if [ "${#present[@]}" -gt 0 ]; then
    while read -r h p; do
      [ -n "${p:-}" ] && H["$p"]="$h"
    done < <(sha256sum -- "${present[@]}" 2>/dev/null)
  fi
  for f in "${FILES[@]}"; do
    if [ ! -e "$f" ]; then printf 'MISSING  %s\n' "$f"
    else printf '%s  %s\n' "${H[$f]:-UNREADABLE}" "$f"; fi
  done
}

# ---- first invocation for this session: record the baseline and pass ----
# The baseline is written by the runner (as hqconsole) BEFORE the session starts,
# into a session dir the session user cannot write (0755 hqconsole); the hook only
# reads it. A missing or unreadable baseline therefore fails CLOSED. Self-baselining
# exists only for the test harness (HQ_META_ALLOW_SELF_BASELINE=1). The failure
# marker the runner watches goes into $SDIR/flags/ (the one owner-writable subdir,
# created by the runner 1770 hqconsole:owner); its absence is never trusted.
if [ ! -f "$BASELINE" ]; then
  if [ "${HQ_META_ALLOW_SELF_BASELINE:-0}" != 1 ]; then
    fail "session-start settings baseline is missing from $SDIR (deleted or never written); refusing every mutating tool call"
  fi
  tmp="$SDIR/.baseline.$$"
  if ! snapshot > "$tmp"; then
    rm -f "$tmp" || true
    fail "could not record the session-start settings baseline in $SDIR"
  fi
  mv -f "$tmp" "$BASELINE" || fail "could not install the session-start settings baseline in $SDIR"
  exit 0
fi

# ---- later invocations: recompute and compare ----
declare -A WAS=()
while read -r h p; do
  [ -n "${p:-}" ] || continue
  WAS["$p"]="$h"
done < "$BASELINE"

declare -A NOW=()
while read -r h p; do
  [ -n "${p:-}" ] || continue
  NOW["$p"]="$h"
done < <(snapshot)

reasons=""
add() { reasons="${reasons:+$reasons; }$1"; }

for f in "${FILES[@]}"; do
  now="${NOW[$f]-UNREADABLE}"
  old="${WAS[$f]-}"
  if [ -z "$old" ]; then
    add "$f is not in the session-start baseline (the watched set changed mid-session)"
    continue
  fi
  unset 'WAS[$f]'
  [ "$now" = "$old" ] && continue
  if [ "$old" = "MISSING" ]; then
    add "$f appeared after session start (a permission rule may have been persisted there)"
  elif [ "$now" = "MISSING" ]; then
    add "$f disappeared after session start"
  elif [ "$now" = "UNREADABLE" ]; then
    add "$f became unreadable after session start"
  else
    add "$f changed after session start (was ${old:0:12}, now ${now:0:12})"
  fi
done

for leftover in "${!WAS[@]}"; do
  add "$leftover was in the session-start baseline but is no longer being watched"
done

[ -z "$reasons" ] || fail "$reasons"
exit 0
