# ops/scripts/lib/tmux-server.sh: find and target the tmux session named exactly hq.
# Sourced (never run) by spawn.sh, term.sh, wake.sh, finish.sh, snooze.sh, panic.sh and hq.sh.
#
# Which tmux server holds the hq session (console v2, hq-fgg3.4; shared lib, hq-1nkg.1).
# hq.sh starts `hq` on whatever server its caller's tmux resolves to: the default one, or
# hq-runner's hqterm server (`tmux -L hqterm`) when it ran from a console terminal; a call from
# the console itself has no $TMUX. Find the server with a session named exactly hq (`=hq`,
# because a bare `-t hq` prefix-matches hq-errors) and point tmux, and any child that runs
# tmux (term-retile.sh), at it by exporting $TMUX. The console's own terminals are separate
# hqt-* sessions on hqterm that hq-runner owns; nothing here creates or kills those.
#
# HQ_TMUX_SERVERS overrides the candidate socket names (default: "default hqterm"). Only the
# tests set it, to point at scratch servers.

hq_tmux_server(){
  local s
  tmux has-session -t '=hq' 2>/dev/null && return 0
  for s in ${HQ_TMUX_SERVERS:-default hqterm}; do
    if tmux -L "$s" has-session -t '=hq' 2>/dev/null; then
      export TMUX="${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$s,0,0"; return 0
    fi
  done
  return 1
}

# hq_kill_registry_window <tmux_window>: kill the pane (or window) a registry row recorded,
# on the server that holds hq, and only when it belongs to the hq session. A pane id (%NN) is
# global to one server and is reused after a restart, so it must be listed in =hq first; a
# stale id that now points at hq-errors or a console terminal is left alone.
# Returns 1 when no hq session exists anywhere (nothing is touched), else 0.
hq_kill_registry_window(){
  local w="${1:-}" sess rest
  [ -n "$w" ] || return 0
  hq_tmux_server || return 1
  case "$w" in
    %*)
      # list-panes, not display-message: with no client, display-message on a missing pane
      # prints nothing and still exits 0
      # hq-bg holds the headless workers (spawn.sh, hq-4npjr.4); a pane there is ours too
      { tmux list-panes -s -t '=hq' -F '#{pane_id}' 2>/dev/null
        tmux list-panes -s -t '=hq-bg' -F '#{pane_id}' 2>/dev/null; } | grep -qxF -- "$w" || return 0
      tmux kill-pane -t "$w" >/dev/null 2>&1 || true
      tmux select-layout -t '=hq:work' tiled >/dev/null 2>&1 || true   # re-tile survivors
      ;;
    *:*)
      sess="${w%%:*}"; sess="${sess#=}"; rest="${w#*:}"
      [ "$sess" = hq ] || return 0
      tmux kill-window -t "=hq:$rest" >/dev/null 2>&1 || true
      ;;
  esac
  return 0
}

# hq_kill_hq_sessions: kill every session named exactly hq, on the caller's server and on
# each candidate server (panic.sh). Never a prefix match, so hq-errors survives.
hq_kill_hq_sessions(){
  local s
  tmux kill-session -t '=hq' 2>/dev/null || true
  for s in ${HQ_TMUX_SERVERS:-default hqterm}; do
    tmux -L "$s" kill-session -t '=hq' 2>/dev/null || true
  done
  return 0
}
