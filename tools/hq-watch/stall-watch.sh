#!/usr/bin/env bash
# stall-watch.sh: passive worker-stall detection (field survey item 7,
# pattern: ccmanager state hooks, Gas Town's Witness).
#
# HQ relied on a stuck worker ASKING for help; a silently hung one sat
# unnoticed until the owner looked. This watches instead: every pass, hash the
# tail of each watched pane; a pane whose output has not changed for STALL_S
# while still running a live session earns ONE low-priority ping, re-armed
# only after output moves again. Read-only against tmux; writes only under
# state/watch/ (plus its heartbeat).
#
# What it watches (console v2, hq-fgg3.4). Two kinds of pane, on every tmux
# server in STALL_TMUX_SOCKETS (default "default hqterm"). The hq session lives
# on whichever server hq.sh ran under, and hq-runner keeps its console
# terminals on the hqterm server (`tmux -L hqterm`, owned by owner).
#   work  panes in the hq:work window: spawn.sh/term.sh workers. Headless
#         `claude -p` output, so a quiet pane with claude alive is stalled.
#   term  sessions named hqt-*: the console terminals hq-runner starts. These
#         are interactive Claude TUIs, so a quiet screen at the prompt is idle,
#         not stalled. A term pane counts only while it shows the busy marker
#         ("esc to interrupt"), and the spinner, timer and token lines are
#         dropped before hashing, so "stalled" means busy with no real output.
#
# Run: bash tools/hq-watch/stall-watch.sh          (one pass, cron-friendly)
#      bash tools/hq-watch/stall-watch.sh --loop   (resident, 5 min cadence)
# Env: STALL_S (900), INTERVAL (300), STALL_TMUX_SOCKETS ("default hqterm"),
#      STALL_TERM_PREFIX (hqt-), HQ_ROOT.
set -uo pipefail
HQ="${HQ_ROOT:-$HOME/hq}"
STATE="$HQ/state/watch"
STALL_S="${STALL_S:-900}"
INTERVAL="${INTERVAL:-300}"
SOCKETS="${STALL_TMUX_SOCKETS:-default hqterm}"
PREFIX="${STALL_TERM_PREFIX:-hqt-}"
BUSY_RE='esc to interrupt'
# spinner, elapsed-time and token-counter lines move every second on a busy TUI
NOISE_RE='esc to interrupt|[0-9]s · |tokens|[0-9]+m [0-9]+s'
mkdir -p "$STATE"
# one watcher at a time; a second instance exits instead of double-pinging
exec 9>"$STATE/.lock"
flock -n 9 || { echo "stall-watch: another instance holds the lock"; exit 0; }

# every watched pane, one per line, TAB separated: <socket> <kind> <pane_id> <tty> <session>
# Tabs, not spaces: session and window names are free text ("my task"), and a
# space-split read would shift pane and tty into the wrong fields.
TAB=$'\t'
list_watched() {
  local sock
  for sock in $SOCKETS; do
    tmux -L "$sock" list-panes -a -F "#{pane_id}${TAB}#{pane_tty}${TAB}#{pane_dead}${TAB}#{session_name}${TAB}#{window_name}" 2>/dev/null |
    while IFS="$TAB" read -r pane tty dead ses win; do
      [ "$dead" = 1 ] && continue
      if [ "$ses" = hq ] && [ "$win" = work ]; then printf '%s\t%s\t%s\t%s\t%s\n' "$sock" work "$pane" "$tty" "$ses"
      elif [ "${ses#"$PREFIX"}" != "$ses" ]; then printf '%s\t%s\t%s\t%s\t%s\n' "$sock" term "$pane" "$tty" "$ses"
      fi
    done
  done
}

pass() {
  local now; now="$(date +%s)"
  # liveness: the mail poller reports this loop dead when the file goes stale
  # (ops/mail/heartbeats.json, hq-fgg3.6); never fatal
  mkdir -p "$HQ/state/heartbeat" 2>/dev/null && touch "$HQ/state/heartbeat/stall-watch" 2>/dev/null || true
  local seen=" "
  local sock kind pane tty ses
  while IFS="$TAB" read -r sock kind pane tty ses; do
    [ -n "$pane" ] || continue
    # pane ids are per tmux server, so the socket is part of the state key
    local key="${sock}_${pane#%}"
    seen="$seen$key "
    # liveness by tty, not pane_current_command: workers run claude as a
    # child of bash, so the pane command reads "bash" either way. A tty
    # with no claude/node on it is a finished worker, not a stalled one.
    local cmd
    cmd="$(ps -o comm= -t "$tty" 2>/dev/null | grep -Em1 'claude|node' || true)"
    if [ -z "$cmd" ]; then rm -f "$STATE/$key".*; continue; fi
    local tail_ hash file since pinged
    # -J joins wrapped lines: on a narrow pane the busy marker wraps and would
    # otherwise never match BUSY_RE
    tail_="$(tmux -L "$sock" capture-pane -J -t "$pane" -p 2>/dev/null | tail -40)"
    if [ "$kind" = term ]; then
      # an interactive terminal at its prompt is idle, not stalled
      if ! grep -q "$BUSY_RE" <<<"$tail_"; then rm -f "$STATE/$key".*; continue; fi
      tail_="$(grep -Ev "$NOISE_RE" <<<"$tail_")"
    fi
    hash="$(md5sum <<<"$tail_" | cut -d' ' -f1)"
    file="$STATE/${key}.hash"; since="$STATE/${key}.since"; pinged="$STATE/${key}.pinged"
    if [ -f "$file" ] && [ "$(cat "$file")" = "$hash" ]; then
      local t0; t0="$(cat "$since" 2>/dev/null || echo "$now")"
      if [ $((now - t0)) -ge "$STALL_S" ]; then
        # exclusive create claims the episode; only the claimant notifies
        if ( set -o noclobber; : > "$pinged" ) 2>/dev/null; then
          echo "stall-watch: $(date +%FT%T) stalled $kind $ses pane $pane ($sock) quiet $(( (now - t0) / 60 ))m"
          "$HQ/ops/scripts/notify.sh" low "Worker may be stalled" \
            "$kind $ses pane $pane quiet for $(( (now - t0) / 60 ))m (cmd: $cmd). Look, snooze, or kill." || true
        fi
      fi
    else
      echo "$hash" > "$file"; echo "$now" > "$since"; rm -f "$pinged"
    fi
  done < <(list_watched)
  # tidy state for panes that are no longer watched
  local f k
  for f in "$STATE"/*.hash; do
    [ -e "$f" ] || continue
    k="$(basename "$f" .hash)"
    case "$seen" in *" $k "*) ;; *) rm -f "$STATE/$k".* ;; esac
  done
}

if [ "${1:-}" = "--loop" ]; then
  while true; do pass; sleep "$INTERVAL"; done
else
  pass
fi
