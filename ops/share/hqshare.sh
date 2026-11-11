#!/usr/bin/env bash
# hqshare.sh: move arbitrary files between hqbox, the laptop (dan), the desktop
# and the phone. Not just vault notes: any file, any direction.
#
# Built on Taildrop, which ships inside the Tailscale client that is ALREADY on
# every one of those machines. That matters more than it sounds: no install, no
# account, no open port, no cloud, and no third-party software on the two
# Windows boxes. Transfers are direct and end-to-end encrypted over the tailnet.
#
#   hqshare send <path>... [--to <device>]   push files to a device (default dan)
#   hqshare inbox [--watch]                  pull anything sent TO hqbox
#   hqshare devices                          who is on the tailnet right now
#   hqshare hub                              print the shared folder path
#
# Received files land in ~/hq/share/inbox/. Directory sends are packed into a
# throwaway archive under a private mktemp dir and deleted afterwards, so
# nothing accumulates in the repo and two concurrent sends cannot collide.
#
# On Windows, files you send arrive in the Tailscale client's inbox; the client
# saves them to the folder set under Preferences (Downloads by default). To send
# FROM Windows, right-click a file, "Send with Tailscale", pick hqbox, then run
# `hqshare inbox` here (or leave `hqshare inbox --watch` running).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="${HQ_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
SHARE="$HQ/share"
INBOX="$SHARE/inbox"
die(){ echo "hqshare: $1" >&2; exit "${2:-1}"; }

TS="${HQ_TAILSCALE:-tailscale}"
command -v "$TS" >/dev/null || die "tailscale not found" 2

# A symlinked share/inbox would let `tailscale file get` write anywhere, so the
# directories must be real and must resolve back inside HQ before anything is
# written into them.
# Sets REAL_DIR rather than printing it: `die` inside a command substitution
# exits only the SUBSHELL, so a printing version would let a rejected path fall
# through as an empty string instead of stopping the run.
under_hq(){ # <canonical path>
  [ "$1" = "$HQ_REAL" ] && return 0
  case "$1/" in "$HQ_REAL"/*) return 0;; esac
  return 1
}
ensure_dir(){ # <path>, sets REAL_DIR
  local p="$1" anc
  # Check the nearest EXISTING ancestor before creating anything. mkdir -p
  # happily follows a symlinked parent, so validating only the leaf would build
  # the tree outside HQ first and reject it afterwards, having already written.
  anc="$p"
  while [ ! -e "$anc" ]; do anc="$(dirname -- "$anc")"; done
  [ ! -L "$anc" ] || die "refusing to use $p: ancestor $anc is a symlink" 3
  anc="$(cd "$anc" && pwd -P)" || die "cannot resolve $p" 3
  under_hq "$anc" || die "refusing to use $p: ancestor resolves outside HQ ($anc)" 3
  [ ! -L "$p" ] || die "refusing to use $p: it is a symlink" 3
  mkdir -p "$p" || die "cannot create $p" 3
  REAL_DIR="$(cd "$p" && pwd -P)" || die "cannot resolve $p" 3
  under_hq "$REAL_DIR" || die "refusing to use $p: it resolves outside HQ ($REAL_DIR)" 3
  # The canonical path is what gets handed to tailscale, so the receive cannot
  # be redirected by a symlink swapped in afterwards. A residual race remains if
  # something rewrites the canonical directory itself mid-run, which needs HQ
  # write access, at which point it could simply write to HQ directly.
}
HQ_REAL="$(cd "$HQ" && pwd -P)" || die "cannot resolve HQ root" 3

cmd="${1:-}"; shift 2>/dev/null || true

case "$cmd" in
send)
  to="dan"; files=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --to) to="${2:-}"; shift;;
      *) files+=("$1");;
    esac; shift
  done
  [ "${#files[@]}" -gt 0 ] || die "usage: hqshare send <path>... [--to <device>]" 2
  # no leading '-': an option-shaped name would be read as a flag by grep and by
  # tailscale rather than as a device
  printf '%s' "$to" | grep -qE '^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$' \
    || die "bad device name: $to" 2
  "$TS" status 2>/dev/null | awk '{print $2}' | grep -qx -- "$to" \
    || die "no tailnet device named '$to' (try: hqshare devices)" 2

  # private staging, removed on any exit: archives are transfer artifacts, not
  # content, and leaving them in the repo would fill the disk one send at a time
  stage="$(mktemp -d)" || die "cannot create staging dir" 3
  trap 'rm -rf "$stage"' EXIT

  rc=0
  for f in "${files[@]}"; do
    [ -e "$f" ] || { echo "hqshare: no such path: $f" >&2; rc=1; continue; }
    # absolute path: a relative name beginning with '-' would be read as an
    # option by the tools below
    abs="$(readlink -f -- "$f")" || { echo "hqshare: cannot resolve $f" >&2; rc=1; continue; }
    sendme="$abs"
    if [ -d "$abs" ]; then
      # Taildrop sends files, not trees. Note the `--`: without it a directory
      # named like a tar option is interpreted AS one, and tar options include
      # --checkpoint-action=exec=..., which runs commands.
      sendme="$stage/$(basename -- "$abs").tar.gz"
      if ! tar -czf "$sendme" -C "$(dirname -- "$abs")" -- "$(basename -- "$abs")"; then
        echo "hqshare: could not archive $abs" >&2; rc=1; continue
      fi
      echo "hqshare: packed $(basename -- "$abs")/ into $(basename -- "$sendme")"
    fi
    # keep tailscale's stderr: it carries the actionable reason (the first run
    # here failed with "Access denied", whose fix was one documented command,
    # and swallowing it turned a 10-second fix into a debugging session)
    if err="$("$TS" file cp -- "$sendme" "$to:" 2>&1)"; then
      echo "sent $(basename -- "$sendme") -> $to"
    else
      echo "hqshare: failed to send $(basename -- "$sendme") to $to" >&2
      [ -n "$err" ] && printf '  %s\n' "$err" >&2
      rc=1
    fi
  done
  exit $rc
  ;;
inbox)
  watch=0
  while [ $# -gt 0 ]; do case "$1" in --watch) watch=1;; esac; shift; done
  ensure_dir "$INBOX"; INBOX="$REAL_DIR"
  PULL_ERR=""
  pull(){
    # `file get` prints nothing when the inbox is empty, so count to report
    # honestly, and keep stderr: "empty" and "cannot receive" must not look
    # alike. The reason goes into PULL_ERR rather than being printed, so watch
    # mode can log a transition instead of the same line every 10 seconds.
    local before after n err
    before="$(find "$INBOX" -type f | wc -l)"
    if ! err="$("$TS" file get --conflict=rename "$INBOX" 2>&1)"; then
      PULL_ERR="${err:-unknown error}"
      return 1
    fi
    PULL_ERR=""
    after="$(find "$INBOX" -type f | wc -l)"
    n=$(( after - before ))
    [ "$n" -gt 0 ] && echo "$(date '+%H:%M:%S') received $n file(s) into $INBOX"
    return 0
  }
  if [ "$watch" = 1 ]; then
    echo "hqshare: watching the Taildrop inbox, saving into $INBOX"
    last=""
    while :; do
      if pull; then
        [ -n "$last" ] && echo "hqshare: receiving again"
        last=""
      elif [ "$PULL_ERR" != "$last" ]; then
        # log only when the failure STARTS or its reason changes
        echo "hqshare: cannot receive: $PULL_ERR (retrying every 10s)" >&2
        last="$PULL_ERR"
      fi
      sleep 10
    done
  fi
  pull || die "cannot receive: $PULL_ERR" 1
  echo "inbox: $INBOX ($(find "$INBOX" -type f | wc -l) file(s))"
  ;;
devices)
  "$TS" status 2>/dev/null | awk 'NF {printf "  %-18s %-9s %s\n", $2, $4, ($5=="-" ? "idle" : $5" "$6)}'
  ;;
hub)
  ensure_dir "$SHARE"; echo "$REAL_DIR"
  ;;
""|help|-h|--help)
  sed -n '2,23p' "$SCRIPT_DIR/hqshare.sh" | sed 's/^# \{0,1\}//'
  ;;
*)
  die "unknown subcommand: $cmd (try: hqshare help)" 2
  ;;
esac
