#!/usr/bin/env bash
# spawn-as-owner.sh: the single owner-context entry point for the console services.
#
# hqconsole (server, runner) may run exactly this script as owner through one sudoers
# rule; everything it can do is an allowlisted verb below. It never takes a free-form
# command. Design: docs/superpowers/specs/2026-08-17-console-v2-design.md, section 3
# (trust boundary: "hqconsole never writes into ~/hq"; repo mutations go through this
# wrapper) and section 3b.
#
# Usage: spawn-as-owner.sh <verb> [args...]
#   ctl <ctl-verb> [args...]        ops/console/ctl.sh with a verb from CTL_VERBS
#   bd <bd-args...>                 bd in the hq repo (create/list/show/comment/update/ready/close)
#   bd-rig <rig> <bd-args...>       bd inside a rig checkout
#   hw                              ops/console/hw.py JSON
#   usage [args...]                 ops/console/usage.py JSON
#   stack                           ops/console/collectors/stack.py JSON (read-only inventory+evidence)
#   flow                            ops/console/collectors/flow.py JSON (read-only ledger flow metrics)
#   services                        services/jobs/automations status JSON (read-only; policy from
#                                   the guard-protected ops/projects/console/*.json)
#   understudy                      tools/understudy report JSON: one silent predict/grade tick
#                                   plus scores (writes only state/understudy/*.jsonl)
#   service-logs <id> [n]           last n log lines for an allowlisted, logs-enabled entry
#   service-restart <id>            restart an allowlisted restartable entry (systemd-user/docker only)
#   mail-switch <disabled|log-only> <on|off>   toggle the two hq-mail kill-switch flag files
#   spawn <spawn.sh args...>        ops/scripts/spawn.sh
#   finish <id> [--confirm]         ops/scripts/finish.sh
#   snooze <when> --id <id>         ops/scripts/snooze.sh
#   wake <id>                       ops/scripts/wake.sh: revive one snoozed session now
#                                   (the Now page wake now button; wake.sh is a no-op, exit 3,
#                                   for a session that is not snoozed)
#   vault-read <relative.md>        read a markdown file from the vault replica (read-only);
#                                   also <dir>/flows/<name>.mmd, an authored Mermaid chart
#   vault-flows <vault-dir>         list <vault-dir>/flows/*.mmd as name<TAB>mtime<TAB>title lines
#                                   (title from a first-line "%% title:" comment; read-only)
#   git-log <repo-dir> [n]          recent commits (read-only)
#   git-diffstat <repo-dir> <base> [head]   per-file added/removed line counts for a merge
#                                   (read-only, names and counts only, never file contents)
#   git-commit-only <repo-dir> <path> <message>   commit ONE path (truths, projects.json), nothing else staged
#   write-truths <project> <rev> <parent>   land ops/projects/<project>/truths.json from a JSON
#                                   payload on stdin and commit it with the Hq-Truths-Rev
#                                   trailer (write-truths.py; exit 3 stale, 4 moved, 5 refused)
#   truths-audit [n] [since]        JSON lines ({"head"} first, then one per commit+path) for
#                                   commits touching a truths file, since the given sha when
#                                   present (truths-audit.py, read-only; the console verifies)
#   errors list                     Errors tab: incident files, fixer pane lookup and the 24h
#                                   fingerprint volume from state/mail.db as JSON (read-only)
#   errors resolve <incident-id>    mark one incident resolved (atomic rewrite of
#                                   state/errors/incidents/<id>.json; errors-verbs.py)
#   claude-meta SID                 Capri (the meta terminal): exec claude with the PINNED argv
#                                   of proposal 19 inside the transient user scope hq-meta-SID,
#                                   under the caller's PTY; refused unless meta-check passes
#   meta-check [SID]                proposal 19 refusal rules 1 to 4 as JSON {ok, reasons[]}
#   meta-snapshot SID [after]       persistence snapshot (user units, crontab, at, shell files)
#                                   plus backups under the meta state dir, JSON; "after" skips
#                                   the backups (close-time view)
#   meta-scopes                     JSON list of hq-meta-*.scope units
#   meta-stop SID                   stop hq-meta-SID.scope (SIGTERM, then SIGKILL), JSON
#   meta-revert SID KIND NAME       undo one item the session added (unit|cron|at|autostart|stop)
#                                   or restore a changed file from the snapshot backup (restore)
#   meta-integrity                  canaries.sh + cage-integrity diff as JSON
#   probe                           prints who am i (for provisioning checks)
# Runner verbs (hq-runner only; see runner/PROTOCOL.md and runner/src/tmux.js):
#   tmux-list                       one tab-separated line per pane (read-only)
#   tmux-capture <pane>             screen plus 2000 lines of scrollback (read-only)
#   tmux-pipe <pane> <fifo>         pipe-pane -o into a FIFO the RUNNER created
#   tmux-unpipe <pane>              stop that pipe
#   tmux-send <pane>                send-keys -l with bytes read from stdin (max 64 KB)
#   term-new <name> <cwd> <cols> <rows> [--env K=V ...] -- <argv...>
#                                   start an allowlisted argv in a detached session on the
#                                   hqterm tmux server (own user scope, survives the runner)
#   term-attach <name>              exec a tmux client for it under the caller's PTY
#   term-has <name> | term-kill <name>   is it alive / end it
#   term-fg <name>                  the foreground program of its pane (read-only)
#   pty-spawn <cwd> [--env K=V ...] -- <argv...>
#                                   exec an allowlisted argv as owner in <cwd>, under
#                                   the caller's PTY. This is how the runner owns the
#                                   terminal while owner owns the process.
# Exit codes: 0 ok, 2 usage/allowlist refusal, else the underlying command's.
set -uo pipefail
HQ="${HQ_ROOT:-/home/owner/hq}"
CTL="$HQ/ops/console/ctl.sh"
CTL_VERBS="ask await answer cmd cancel park-mark resolve requests clear req-snooze req-unsnooze sink name whoami focus phase log-change tasks dispatch dispatch-batch kill finish-check finish state ear-wake register-term"
BD_VERBS="create list show comment update ready close prime graph epic dep label priority"
export HOME=/home/owner
# nvm-installed CLIs (bd) live under a versioned dir that differs per box; pick the newest present
NVM_BIN="$(ls -d /home/owner/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
export PATH="/home/owner/.local/bin:${NVM_BIN:+$NVM_BIN:}/usr/local/bin:/usr/bin:/bin"

die() { echo "spawn-as-owner: $*" >&2; exit 2; }
inlist() { local x="$1"; shift; local w; for w in $*; do [ "$w" = "$x" ] && return 0; done; return 1; }
safe_word() { [[ "$1" =~ ^[A-Za-z0-9._/-]+$ ]]; }
in_hq() { local p; p="$(realpath -m -- "$1")"; [[ "$p" == "$HQ" || "$p" == "$HQ"/* ]]; }

# --- runner verb helpers -----------------------------------------------------
# A pane id is tmux's own opaque handle. Anything else is refused before it can
# reach a tmux command line.
pane_ok() { [[ "${1:-}" =~ ^%[0-9]+$ ]]; }

# The FIFO the runner streams a pane through. The runner creates it (as
# hqconsole, in a directory it owns) and only then names it here; this side
# checks that it is an existing FIFO under an allowed root, so a swapped path
# or a symlink cannot turn pipe-pane into a writer of arbitrary files.
FIFO_ROOTS="/run/hqconsole /run/hqconsole-panes /tmp/hqconsole-panes"
fifo_ok() {
  local p r
  p="$(realpath -e -- "${1:-}" 2>/dev/null)" || return 1
  [[ "$p" =~ ^/[A-Za-z0-9._/-]+$ ]] || return 1
  [ -p "$p" ] || return 1
  for r in $FIFO_ROOTS; do [[ "$p" == "$r"/* ]] && return 0; done
  return 1
}

# Environment a console session may carry. PATH, LD_*, NODE_OPTIONS, SUDO_* and
# everything else that decides where code or credentials come from is absent on
# purpose; this script sets PATH and HOME itself.
env_allowed() {
  case "${1:-}" in
    TERM|LANG|LC_ALL|COLUMNS|LINES|HQ_BEAD|HQ_RIG) return 0;;
    HQ_CONSOLE_*|CLAUDE_*) return 0;;
  esac
  return 1
}

# What the console is allowed to start under a PTY. A free-form argv here would
# be arbitrary uncaged execution as owner, which is exactly what the wrapper
# exists to prevent.
pty_argv0_ok() {
  case "${1:-}" in
    claude|bash) return 0;;
    "$HQ/ops/scripts/spawn.sh"|"$HQ/ops/scripts/finish.sh"|"$HQ/ops/scripts/snooze.sh") return 0;;
  esac
  return 1
}

# --- Capri (meta terminal) helpers ------------------------------------------
# The meta dir is fixed in production: sudo resets the environment, so HQ_META_DIR
# only matters for the test suite, which runs this script without sudo.
META_DIR="${HQ_META_DIR:-/var/lib/hqconsole/meta}"
META_SETTINGS="$META_DIR/meta-settings.json"
META_STATE="$META_DIR/sessions"
META_AUDIT="$META_DIR/audit.jsonl"
META_PY="$(dirname "$(realpath "$0")")/meta-verbs.py"
# Which claude setting sources Capri loads. HARDCODED EMPTY in production (bead
# hq-ngef): --setting-sources '' loads ONLY the pinned root-owned --settings
# file, so the owner-writable ~/.claude/settings.json (and project/local
# settings) are never read at exec. That closes the read-it-twice TOCTOU where a
# owner process could swap a file between meta-check's validation and claude's
# own read. This is a SECURITY BOUNDARY, so it is not environment-overridable in
# production: the HQ_META_SETTING_SOURCES override is honoured ONLY in test mode
# (HQ_META_DIR set), exactly like HQ_META_TRUSTED_UID -- sudo resets the
# environment in production, so the override cannot reach a real launch. Loading
# user/project/local for real would need a trusted non-owner-writable snapshot,
# never a live source; rule 1 in meta-check is a tripwire, not a licence to.
if [ -n "${HQ_META_DIR:-}" ]; then
  META_SETTING_SOURCES="${HQ_META_SETTING_SOURCES:-}"   # test seam only
else
  META_SETTING_SOURCES=""                                # production: fixed empty
fi
# absolute tools for the meta verbs: nothing security-relevant resolves through PATH
PY3=/usr/bin/python3
SYSTEMD_RUN=/usr/bin/systemd-run
# owner's user manager (systemd --user, crontab) needs the runtime dir and bus;
# sudo from hqconsole does not carry them.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
sid_ok() { [[ "${1:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$ ]]; }

# --- persistent console terminal helpers ---------------------------------------
# No config file (the release only ships *.sh and *.py next to this wrapper):
# the server options ride in on the start-server command itself. Invisible
# plumbing: no prefix key, no status line, mouse wheel scrolls the history.
TMUXT=(/usr/bin/tmux -L hqterm -f /dev/null)
TERM_OPTS=(\; set -g exit-empty off \; set -g prefix None \; set -g prefix2 None \; unbind-key -a
  \; set -g status off \; set -g mouse on \; set -g history-limit 50000 \; set -sg escape-time 0
  \; set -g default-terminal tmux-256color \; set -ga terminal-overrides ",xterm-256color:Tc"
  \; set -g set-clipboard on \; set -g destroy-unattached off \; set -g window-size latest
  \; set -g aggressive-resize on \; set -g focus-events on)
term_name_ok() { [[ "${1:-}" =~ ^hqt-[A-Za-z0-9]{1,40}$ ]]; }
# Start the hqterm server in its own transient user scope if it is not running.
# The scope is what keeps it out of hq-runner.service's cgroup: a server forked
# straight from a runner call would die with the runner, which is the bug.
term_server() {
  # Never a bare `tmux start-server` here: that would fork the server into the
  # caller's cgroup. The scope is active exactly while the server process lives.
  [ -S "$XDG_RUNTIME_DIR/bus" ] || return 1
  systemctl --user is-active --quiet hq-term-tmux.scope && return 0
  "$SYSTEMD_RUN" --user --scope --collect --quiet --unit hq-term-tmux -- "${TMUXT[@]}" start-server "${TERM_OPTS[@]}" || return 1
  systemctl --user is-active --quiet hq-term-tmux.scope
}
verb="${1:-}"; shift 2>/dev/null || true
case "$verb" in
  probe) id -un; exit 0;;
  ctl)
    v="${1:-}"; shift 2>/dev/null || true
    inlist "$v" $CTL_VERBS || die "ctl verb not allowed: $v"
    exec bash "$CTL" "$v" "$@";;
  bd)
    v="${1:-}"; inlist "$v" $BD_VERBS || die "bd verb not allowed: $v"
    cd "$HQ" || die "no hq"; exec bd "$@";;
  bd-rig)
    rig="${1:-}"; shift 2>/dev/null || true
    [[ "$rig" =~ ^[A-Za-z0-9._-]+$ ]] && [[ "$rig" != .* ]] && [ -d "$HQ/rigs/$rig/.git" ] || die "bad rig: $rig"
    rigdir="$(realpath -m -- "$HQ/rigs/$rig")"; [[ "$rigdir" == "$HQ/rigs/"* ]] || die "bad rig: $rig"
    v="${1:-}"; inlist "$v" $BD_VERBS || die "bd verb not allowed: $v"
    cd "$rigdir" || die "no rig dir"; exec bd "$@";;
  hw) exec python3 "$HQ/ops/console/hw.py" "$@";;
  usage) exec python3 "$HQ/ops/console/usage.py" "$@";;
  stack) exec python3 "$HQ/ops/console/collectors/stack.py" --hq "$HQ";;
  flow) exec python3 "$HQ/ops/console/collectors/flow.py" --hq "$HQ";;
  services) exec python3 "$HQ/ops/console/collectors/services.py" "$HQ" status;;
  understudy)
    cd "$HQ/tools/understudy" || die "no understudy dir"
    HQ_ROOT="$HQ" exec python3 -m understudy report;;
  service-logs)
    sid="${1:-}"; n="${2:-50}"
    [[ "$sid" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || die "bad service id"
    [[ "$n" =~ ^[1-9][0-9]{0,2}$ ]] || die "bad count"
    exec python3 "$HQ/ops/console/collectors/services.py" "$HQ" logs "$sid" "$n";;
  service-restart)
    sid="${1:-}"
    [[ "$sid" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || die "bad service id"
    exec python3 "$HQ/ops/console/collectors/services.py" "$HQ" restart "$sid";;
  mail-switch)
    sw="${1:-}"; onoff="${2:-}"
    [[ "$sw" =~ ^(disabled|log-only)$ ]] || die "bad switch"
    [[ "$onoff" =~ ^(on|off)$ ]] || die "bad state"
    exec python3 "$HQ/ops/console/collectors/services.py" "$HQ" mail-switch "$sw" "$onoff";;
  spawn) exec bash "$HQ/ops/scripts/spawn.sh" "$@";;
  finish) exec bash "$HQ/ops/scripts/finish.sh" "$@";;
  snooze) exec bash "$HQ/ops/scripts/snooze.sh" "$@";;
  wake)
    [ $# -eq 1 ] && sid_ok "$1" || die "wake wants one session id"
    exec bash "$HQ/ops/scripts/wake.sh" "$1";;
  vault-read)
    # read-only access to the vault on hqbox (the ob-sync replica at ~/vault; the old
    # vault-bridge mirror is retired) or the outbox on the laptop, for the project page
    f="${1:-}"; base="${HQ_VAULT_MIRROR:-/home/owner/vault}"
    [ -d "$base" ] || base="$HQ/outbox/vault"
    p="$(realpath -m -- "$base/$f")"; [[ "$p" == "$base"/* ]] && [ -f "$p" ] || die "no such vault file"
    case "$p" in *.md) ;; */flows/*.mmd) ;; *) die "only markdown";; esac
    exec cat -- "$p";;
  vault-flows)
    # the authored process charts of one project (bead hq-c4pl0.4): names, dates and
    # titles only; the console reads a chart's source through vault-read
    d="${1:-}"; base="${HQ_VAULT_MIRROR:-/home/owner/vault}"
    [ -d "$base" ] || base="$HQ/outbox/vault"
    [ -n "$d" ] || die "no vault dir"
    dir="$(realpath -m -- "$base/$d/flows")"; [[ "$dir" == "$base"/* ]] || die "bad vault dir"
    [ -d "$dir" ] || exit 0
    for f in "$dir"/*.mmd; do
      [ -f "$f" ] || continue
      real="$(realpath -- "$f")"; [[ "$real" == "$base"/* ]] || continue
      n="$(basename -- "$f" .mmd)"; [[ "$n" =~ ^[a-z0-9-]+$ ]] || continue
      t="$(head -n 1 -- "$f" | sed -n 's/^%%[[:space:]]*title:[[:space:]]*//p' | tr -d '\t\r' | cut -c1-200)"
      printf '%s\t%s\t%s\n' "$n" "$(stat -c %Y -- "$f")" "$t"
    done
    exit 0;;
  calendar)
    # Upcoming calendar as JSON. Runs as owner because the Google grant lives in
    # owner's home at mode 600 and hqconsole cannot traverse it; copying the
    # credential somewhere hqconsole could read would be a second thing to leak.
    # Read only: the helper has no write path and the only argument it takes is a
    # day count, which it clamps itself.
    n="${1:-7}"
    [[ "$n" =~ ^[0-9]{1,2}$ ]] || die "bad day count"
    exec "$PY3" "$HQ/ops/console/v2/runner/calendar.py" "$n";;
  git-log)
    d="${1:-}"; n="${2:-20}"; in_hq "$d" && [ -d "$d/.git" ] || die "bad repo dir"
    [[ "$n" =~ ^[0-9]+$ ]] || die "bad count"
    exec git -C "$d" log --no-decorate --format='%H%x09%ct%x09%an%x09%s' -n "$n";;
  git-diffstat)
    # Names and line counts only, never file CONTENTS: the console shows what a merge
    # would touch, and reading the diff itself stays a terminal job.
    #
    # --no-ext-diff and --no-textconv are load-bearing, not tidiness. A repository can
    # configure its OWN diff driver (diff.external, or a textconv filter named through
    # .gitattributes), and git would then execute it. Since a worker writes inside the
    # repo it is working in, that is a path from "agent edits a config file" to "arbitrary
    # command runs as owner" straight through this sudo boundary. Both flags refuse it.
    #
    # Revisions are resolved to commit hashes FIRST, so what reaches the diff is a
    # 40-character object id rather than a caller-supplied string, and --end-of-options
    # keeps a name that looks like a flag from being read as one.
    d="${1:-}"; base="${2:-}"; head="${3:-HEAD}"
    in_hq "$d" && [ -d "$d/.git" ] || die "bad repo dir"
    safe_word "$base" && safe_word "$head" || die "bad revision"
    base_sha="$(git -C "$d" rev-parse --verify --quiet --end-of-options "$base^{commit}")" || die "unknown revision: $base"
    head_sha="$(git -C "$d" rev-parse --verify --quiet --end-of-options "$head^{commit}")" || die "unknown revision: $head"
    # Captured, not piped: piping into head closes the stream and kills git with SIGPIPE,
    # which would either mask a real failure or cut a record in half. This keeps git's
    # exit status and truncates on a line boundary.
    out="$(git -C "$d" --no-optional-locks diff --no-ext-diff --no-textconv --numstat --no-renames "$base_sha" "$head_sha" --)" || die "diff failed"
    printf '%s\n' "$out" | head -n 5000
    exit 0;;
  git-commit-only)
    d="${1:-}"; p="${2:-}"; m="${3:-}"
    in_hq "$d" && [ -d "$d/.git" ] || die "bad repo dir"
    safe_word "$p" && [[ "$p" != /* && "$p" != *..* ]] || die "bad path"
    case "$p" in ops/projects/*|ops/projects.json) ;; *) die "path not allowed for commit-only: $p";; esac
    [ -n "$m" ] || die "empty message"
    exec git -C "$d" commit --only -m "$m" -- "$p";;
  write-truths)
    proj="${1:-}"; rev="${2:-}"; parent="${3:-}"
    [[ "$proj" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "bad project"
    [[ "$rev" =~ ^[1-9][0-9]{0,8}$ ]] || die "bad rev"
    [[ "$parent" =~ ^[0-9a-f]{7,64}$ ]] || die "bad parent"
    # The helper ships next to this script in the release tree, so the pair
    # activates together and $HQ never decides which code runs as owner.
    exec python3 "$(dirname "$(realpath "$0")")/write-truths.py" "$HQ" "$proj" "$rev" "$parent";;
  truths-audit)
    n="${1:-50}"; since="${2:-}"
    [[ "$n" =~ ^[1-9][0-9]{0,2}$ ]] || die "bad count"
    [ -z "$since" ] || [[ "$since" =~ ^[0-9a-f]{7,64}$ ]] || die "bad since sha"
    [ -d "$HQ/.git" ] || die "no hq repo"
    exec python3 "$(dirname "$(realpath "$0")")/truths-audit.py" "$HQ" "$n" ${since:+"$since"};;
  errors)
    # The Errors tab (bead hq-hsl2.3). The helper ships next to this script, like
    # write-truths.py, so $HQ never decides which code runs as owner.
    sub="${1:-}"
    case "$sub" in
      list) [ $# -eq 1 ] || die "errors list takes no arguments"
        exec python3 "$(dirname "$(realpath "$0")")/errors-verbs.py" "$HQ" list;;
      resolve)
        iid="${2:-}"; [ $# -eq 2 ] || die "errors resolve takes one incident id"
        [[ "$iid" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || die "bad incident id"
        exec python3 "$(dirname "$(realpath "$0")")/errors-verbs.py" "$HQ" resolve "$iid";;
      *) die "errors verb not allowed: ${sub:-<none>}";;
    esac;;
  tmux-list)
    # Read-only inventory. The runner polls this to notice a pane that died,
    # which a pipe cannot tell it (a dead pane simply stops producing).
    exec tmux list-panes -a -F $'#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_dead}\t#{pane_current_command}\t#{pane_width}\t#{pane_height}\t#{pane_title}';;
  tmux-capture)
    pane_ok "${1:-}" || die "bad pane id: ${1:-<none>}"
    exec tmux capture-pane -p -e -S -2000 -t "$1";;
  tmux-pipe)
    pane_ok "${1:-}" || die "bad pane id: ${1:-<none>}"
    fifo_ok "${2:-}" || die "not a runner FIFO: ${2:-<none>}"
    # -o toggles the pipe off if this pane is already piped to the same
    # command, which is what makes a second attach reuse one stream. The path
    # passed the charset check above, so single quotes are safe here.
    exec tmux pipe-pane -o -t "$1" "cat >> '$2'";;
  tmux-unpipe)
    pane_ok "${1:-}" || die "bad pane id: ${1:-<none>}"
    exec tmux pipe-pane -t "$1";;
  tmux-send)
    pane_ok "${1:-}" || die "bad pane id: ${1:-<none>}"
    # The trailing X keeps command substitution from eating a trailing newline,
    # which is the Enter key. NUL bytes cannot survive a shell variable, so
    # Ctrl-Space is the one keystroke this path cannot carry.
    data="$(cat; printf X)"; data="${data%X}"
    [ "${#data}" -le 65536 ] || die "input too large"
    exec tmux send-keys -t "$1" -l -- "$data";;
  pty-spawn)
    cwd="${1:-}"; shift 2>/dev/null || true
    [ -n "$cwd" ] && in_hq "$cwd" && [ -d "$cwd" ] || die "cwd must be an existing directory under $HQ"
    envs=()
    while [ "${1:-}" = "--env" ]; do
      shift; kv="${1:-}"; shift 2>/dev/null || true
      [[ "$kv" =~ ^[A-Z][A-Z0-9_]*=.*$ ]] || die "bad env pair"
      env_allowed "${kv%%=*}" || die "env not allowed: ${kv%%=*}"
      envs+=("$kv")
    done
    [ "${1:-}" = "--" ] || die "pty-spawn wants -- before the argv"
    shift
    [ $# -ge 1 ] || die "empty argv"
    pty_argv0_ok "$1" || die "argv0 not allowed: $1"
    cd "$cwd" || die "cannot enter $cwd"
    # A login-ish environment: enough for claude and a shell, nothing that
    # points at another PATH or another home.
    export TERM="${TERM:-xterm-256color}" SHELL=/bin/bash USER=owner LOGNAME=owner
    exec env "${envs[@]}" "$@";;
  # --- persistent console terminals (tmux server "hqterm") ---------------------
  # The program lives in a tmux session on a dedicated server that runs in its
  # own transient user scope (hq-term-tmux.scope), outside hq-runner's cgroup,
  # so stopping the runner only drops the attached client. Names are hqt-<sid>.
  term-new)
    # term-new NAME CWD COLS ROWS [--env K=V ...] -- argv...
    name="${1:-}"; cwd="${2:-}"; cols="${3:-}"; rows="${4:-}"; shift 4 2>/dev/null || die "term-new wants name cwd cols rows"
    term_name_ok "$name" || die "bad term name"
    [ -n "$cwd" ] && in_hq "$cwd" && [ -d "$cwd" ] || die "cwd must be an existing directory under $HQ"
    [[ "$cols" =~ ^[0-9]{1,4}$ && "$rows" =~ ^[0-9]{1,4}$ ]] || die "bad geometry"
    tenv=(-e "PATH=$PATH" -e "HOME=$HOME" -e SHELL=/bin/bash -e USER=owner -e LOGNAME=owner -e "HQ_ROOT=$HQ")
    while [ "${1:-}" = "--env" ]; do
      shift; kv="${1:-}"; shift 2>/dev/null || true
      [[ "$kv" =~ ^[A-Z][A-Z0-9_]*=.*$ ]] || die "bad env pair"
      env_allowed "${kv%%=*}" || die "env not allowed: ${kv%%=*}"
      tenv+=(-e "$kv")
    done
    [ "${1:-}" = "--" ] || die "term-new wants -- before the argv"
    shift
    [ $# -ge 1 ] || die "empty argv"
    pty_argv0_ok "$1" || die "argv0 not allowed: $1"
    term_server || die "hqterm tmux server did not start"
    "${TMUXT[@]}" has-session -t "=$name" 2>/dev/null && die "term $name already exists"
    exec "${TMUXT[@]}" new-session -d -s "$name" -c "$cwd" -x "$cols" -y "$rows" "${tenv[@]}" -- "$@";;
  term-attach)
    [ $# -eq 1 ] && term_name_ok "$1" || die "term-attach wants one term name"
    export TERM="${TERM:-xterm-256color}"
    exec "${TMUXT[@]}" attach-session -t "=$1";;
  term-has)
    [ $# -eq 1 ] && term_name_ok "$1" || die "term-has wants one term name"
    exec "${TMUXT[@]}" has-session -t "=$1" 2>/dev/null;;
  term-fg)
    # Read-only: the name of the program in the foreground of the term's pane
    # (tmux pane_current_command). Capri say types only into claude (hq-ymxzt.3).
    [ $# -eq 1 ] && term_name_ok "$1" || die "term-fg wants one term name"
    exec "${TMUXT[@]}" display-message -p -t "=$1:" '#{pane_current_command}';;
  term-kill)
    [ $# -eq 1 ] && term_name_ok "$1" || die "term-kill wants one term name"
    exec "${TMUXT[@]}" kill-session -t "=$1";;
  # --- Capri, the meta terminal (proposal 19) ---------------------------------
  # Everything below runs as owner against owner's OWN user manager, crontab and
  # shell files. The owner-side logic lives in meta-verbs.py next to this script
  # (root-owned, installed by activate.sh); this side only validates shapes.
  meta-check)
    [ $# -le 1 ] || die "meta-check takes at most one sid"
    [ $# -eq 0 ] || sid_ok "$1" || die "bad sid"
    exec env "HQ_META_SETTING_SOURCES=$META_SETTING_SOURCES" "$PY3" "$META_PY" check "$@";;
  meta-snapshot)
    # SID alone: the pre-start snapshot, which also writes the backups the
    # restore kind copies from. "SID after": the close-time view, no backups.
    { [ $# -eq 1 ] || { [ $# -eq 2 ] && [ "$2" = "after" ]; }; } && sid_ok "$1" || die "meta-snapshot wants one sid, optionally followed by after"
    exec "$PY3" "$META_PY" snapshot "$@";;
  meta-scopes)
    [ $# -eq 0 ] || die "meta-scopes takes no args"
    exec "$PY3" "$META_PY" scopes;;
  meta-stop)
    [ $# -eq 1 ] && sid_ok "$1" || die "meta-stop wants one sid"
    exec "$PY3" "$META_PY" stop "$1";;
  meta-revert)
    [ $# -eq 3 ] || die "meta-revert wants sid kind name"
    sid_ok "$1" || die "bad sid"
    case "$2" in unit|cron|at|autostart|stop|restore) ;; *) die "bad revert kind: $2";; esac
    [ ${#3} -le 1024 ] || die "name too long"
    exec "$PY3" "$META_PY" revert "$1" "$2" "$3";;
  meta-integrity)
    [ $# -eq 0 ] || die "meta-integrity takes no args"
    exec "$PY3" "$META_PY" integrity;;
  claude-meta)
    # The argv is PINNED here: the caller names a session id and nothing else. A
    # free-form claude behind the sudo rule would be arbitrary uncaged execution as
    # owner, so no flag, no extra word, no env pair is accepted.
    [ $# -eq 1 ] || die "claude-meta wants exactly one sid and no flags"
    sid_ok "$1" || die "bad sid"
    sid="$1"
    chk="$(env "HQ_META_SETTING_SOURCES=$META_SETTING_SOURCES" "$PY3" "$META_PY" check "$sid" 2>&1)" || die "meta-check failed: $chk"
    case "$chk" in *'"ok": true'*) ;; *) die "refused by meta-check: $chk";; esac
    [ -S "$XDG_RUNTIME_DIR/bus" ] || die "owner's user manager is not available (loginctl enable-linger owner)"
    cd "$HQ" || die "no hq"
    export TERM="${TERM:-xterm-256color}" SHELL=/bin/bash USER=owner LOGNAME=owner
    exec "$SYSTEMD_RUN" --user --scope --collect --quiet --unit "hq-meta-$sid" \
      --setenv "HQ_META_STATE=$META_STATE" \
      --setenv "HQ_META_SID=$sid" \
      --setenv "HQ_META_SETTINGS=$META_SETTINGS" \
      --setenv "HQ_META_AUDIT=$META_AUDIT" \
      --setenv "HQ_META_PROJECT=$HQ" \
      -- claude --setting-sources "$META_SETTING_SOURCES" \
             --add-dir "$HQ" \
             --settings "$META_SETTINGS" \
             --dangerously-skip-permissions;;
  *) die "verb not allowed: ${verb:-<none>}";;
esac
