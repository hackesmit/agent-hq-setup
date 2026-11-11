#!/usr/bin/env bash
# bell.sh: ring the owner's terminal when something needs him.
#
# hqbox is headless: no sound server, no aplay/paplay, and the only playback
# device is the box's own card, which nobody is listening to. So the bell is not
# played HERE. It writes a BEL (0x07) to every attached tmux client tty, and the
# terminal emulator on the far end of that connection makes the sound, wherever
# the owner is sitting. tmux is already set up for it: bell-action any,
# monitor-bell on, visual-bell off, so the byte passes through untouched and
# tmux additionally flags the window (window-status-bell-style reverse) as a
# persistent visual marker for a bell that was missed.
#
# usage: bell.sh ["<short status message>"]
#   HQ_NO_BELL=1        seam: suppress entirely (tests MUST set this, see below)
#   HQ_BELL_TTYS="a b"  seam: ring these targets instead of asking tmux, so the
#                       ringing itself is testable against ordinary files
#   HQ_BELL_NO_PUSH=1   skip the away push below (the caller pushes urgent itself)
#   HQ_NOTIFY=path      the notifier the away push goes through (tests stub it)
#
# When no terminal takes the bell (nobody attached, or every tty write failed)
# the ring would go into the void, so the message goes to the phone instead as a
# quiet ntfy push (notify.sh away). the owner, 2026-09-30: a question must reach him
# with no terminal open, not wait for its P0 escalation.
#
# TEST SEAM IS NOT OPTIONAL. On 2026-08-12 the console suites pushed 88 real
# ntfy notifications because ctl.sh ask had no way to stub its notifier. A
# suite that rings 60 bells is the same bug wearing a different hat.
set -uo pipefail
MSG="${1:-}"

[ -z "${HQ_NO_BELL:-}" ] || exit 0

away() {
  [ -z "${HQ_BELL_NO_PUSH:-}" ] || return 0
  # HQ_NO_BELL: notify.sh must never ring back into this script
  HQ_NO_BELL=1 "${HQ_NOTIFY:-$(dirname "$0")/../scripts/notify.sh}" away "HQ needs you" \
    "${MSG:-a terminal needs you}" >/dev/null 2>&1 || true
}

if [ -n "${HQ_BELL_TTYS:-}" ]; then
  # set -f before splitting: the value is deliberately unquoted so spaces
  # separate targets, but WITHOUT this a value containing a glob would expand
  # to matching filenames and the write below would truncate each one to a
  # single byte. Word splitting is wanted here; pathname expansion never is.
  set -f
  # shellcheck disable=SC2086
  ttys="$(printf '%s\n' $HQ_BELL_TTYS)"
  set +f
else
  command -v tmux >/dev/null || exit 0
  [ -z "${HQ_NO_TMUX:-}" ] || exit 0
  ttys="$(tmux list-clients -F '#{client_tty}' 2>/dev/null | sort -u)"
fi
[ -n "$ttys" ] || { away; exit 0; }   # nobody attached: push instead of ringing the void

rung=0
while IFS= read -r tty; do
  [ -n "$tty" ] || continue
  # A detached or dead tty must not take the whole ping down, and must not
  # print either: the redirection is what fails, so it has to be wrapped -- a
  # trailing 2>/dev/null is set up too late to catch bash's own error.
  if { printf '\a' > "$tty"; } 2>/dev/null; then rung=$((rung + 1)); fi
done <<EOF
$ttys
EOF
[ "$rung" -gt 0 ] || away

# Status-line note so a missed bell still says what wanted attention.
#
# tmux display-message treats its argument as a FORMAT, and #(...) is expanded
# by RUNNING the enclosed shell command. This text comes from question bodies,
# which are hostile input, so `ctl.sh ask '#(touch /tmp/pwned)'` was arbitrary
# command execution as the owner until this escape existed (verified: the file was
# created, asynchronously, a second or two after the bell). ## is tmux's literal
# '#', so escaping every '#' neutralises #(), #{} and #[]. Control characters go
# too, so a message cannot rewrite the status line with escape sequences.
if [ -n "$MSG" ] && [ -z "${HQ_BELL_TTYS:-}" ] && [ -z "${HQ_NO_TMUX:-}" ]; then
  safe="$(printf '%s' "$MSG" | tr -d '\000-\037' | sed 's/#/##/g')"
  tmux display-message -d 4000 "BELL: $safe" 2>/dev/null || true
fi

echo "rang $rung"
