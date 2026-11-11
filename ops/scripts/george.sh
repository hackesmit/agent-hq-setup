#!/usr/bin/env bash
# george.sh: drive the owner's PC (George) through the Capri hands daemon (hq-63nvj.2).
# Every action is one JSON object piped over stdin to `python -m hands call -` on George,
# so typed text never appears on a command line. Exit: 0 ok, 1 hands refused the action,
# 2 usage, 3 George unreachable or hands not running.
# Env: GEORGE_SSH (ssh command, default "ssh -o ConnectTimeout=8 -o BatchMode=yes george"),
#      HQ_STATE_DIR (default ~/hq/state; screenshots land in $HQ_STATE_DIR/george/shots).
set -uo pipefail
SSH=${GEORGE_SSH:-"ssh -o ConnectTimeout=8 -o BatchMode=yes george"}
STATE=${HQ_STATE_DIR:-$HOME/hq/state}
HANDS='cd C:\Users\owner\capri-hands && python -m hands'

usage() { cat >&2 <<U
usage: george.sh <cmd> [args]
  open [--screen N] [--new] <url|app>
                      http(s) url opens in the browser, anything else is an app name;
                      --screen N opens a new browser window on monitor N, --new a new window
  type <text...>      type text into the focused window (stdin if no args)
  key <combo>         ctrl+l, enter, alt+f4 ...
  click <x> <y> [left|right|middle] [double]
  shot [title]        screenshot (a window by title substring, else the screen); prints the png path
  windows             list windows and idle seconds
  focus <title>       bring a window to the front
  media <cmd>         play_pause next prev volume_up volume_down mute status
  spotify <query>     open Spotify and search for the query (best effort)
  audio               list outputs and inputs (default flags)
  audio out|in [--role N] <name>   make a device the default (fuzzy name: speakers, hyperx);
                      --role 0 console, 1 multimedia, 2 communications (default: all three)
  volume [N|up|down|mute|unmute]   no argument reads the level
  monitors            list monitors (index 1 is the primary)
  move [--max] <monitor> <title>   move a window (title substring) to a monitor
  settings <page>     open a Settings page (bluetooth, sound, display, night light, ms-settings:...)
  ps [--timeout S] [script...]     run PowerShell in the owner's session (stdin if no script);
                      exit 0 only when the script exits 0
U
  exit 2; }

offline() { echo "george.sh: George is unreachable or hands is not running ($1)" >&2; exit 3; }

# act JSON: send one action, print the reply, map failures to exit codes.
act() {
  local out rc
  out=$(printf '%s' "$1" | $SSH "$HANDS call -" 2>/tmp/george.err.$$); rc=$?
  local err; err=$(cat /tmp/george.err.$$ 2>/dev/null); rm -f /tmp/george.err.$$
  if [ "$rc" -eq 255 ] || [ -z "$out" ]; then offline "${err:-no reply}"; fi
  if [[ "$err" == *"not running"* || "$err" == *"no token"* ]]; then offline "$err"; fi
  printf '%s\n' "$out"
  [ "$(jq -r '.ok // false' <<<"$out" 2>/dev/null)" = true ]
}

need() { command -v jq >/dev/null || { echo "george.sh: jq required" >&2; exit 2; }; }
need
[ $# -ge 1 ] || usage
cmd=$1; shift

case "$cmd" in
  open)
    scr=""; new=false
    while [ $# -gt 0 ]; do case "$1" in
      --screen) [[ "${2:-}" =~ ^[0-9]+$ ]] || usage; scr=$2; shift 2 ;;
      --new) new=true; shift ;;
      *) break ;;
    esac; done
    [ $# -ge 1 ] || usage
    t="$*"
    if [[ "$t" =~ ^https?:// ]]; then
      act "$(jq -nc --arg u "$t" --arg s "$scr" --argjson n "$new" \
        '{action:"open_url",url:$u} + (if $s != "" then {monitor:($s|tonumber)} else {} end) + (if $n then {new_window:true} else {} end)')"
    else
      [ -z "$scr" ] && [ "$new" = false ] || { echo "george.sh: --screen and --new take a url" >&2; exit 2; }
      act "$(jq -nc --arg n "$t" '{action:"open_app",name:$n}')"
    fi ;;
  audio)
    case "${1:-}" in
      "") act '{"action":"audio_devices"}' ;;
      out|in) k=$1; shift; role=""
        if [ "${1:-}" = --role ]; then [[ "${2:-}" =~ ^[012]$ ]] || usage; role=$2; shift 2; fi
        [ $# -ge 1 ] || usage
        a=audio_output; [ "$k" = in ] && a=audio_input
        act "$(jq -nc --arg a "$a" --arg n "$*" --arg r "$role" '{action:$a,name:$n} + (if $r != "" then {role:($r|tonumber)} else {} end)')" ;;
      *) usage ;;
    esac ;;
  volume)
    case "${1:-}" in
      "") act '{"action":"volume"}' ;;
      up|down|mute|unmute) act "$(jq -nc --arg c "$1" '{action:"volume",command:$c}')" ;;
      *) [[ "$1" =~ ^[0-9]+$ ]] && [ $# -eq 1 ] || usage
         act "$(jq -nc --argjson l "$1" '{action:"volume",level:$l}')" ;;
    esac ;;
  monitors)
    act '{"action":"monitors"}' ;;
  move)
    mx=false; [ "${1:-}" = --max ] && { mx=true; shift; }
    [ $# -ge 2 ] && [[ "$1" =~ ^[0-9]+$ ]] || usage
    m=$1; shift
    act "$(jq -nc --argjson m "$m" --arg t "$*" --argjson x "$mx" '{action:"move_window",title:$t,monitor:$m,maximize:$x}')" ;;
  settings)
    [ $# -ge 1 ] || usage
    act "$(jq -nc --arg p "$*" '{action:"settings",page:$p}')" ;;
  ps)
    to=30; [ "${1:-}" = --timeout ] && { [[ "${2:-}" =~ ^[0-9]+$ ]] || usage; to=$2; shift 2; }
    if [ $# -ge 1 ]; then sc="$*"; else sc=$(cat); fi
    [ -n "$sc" ] || usage
    r=$(act "$(jq -nc --arg s "$sc" --argjson t "$to" '{action:"powershell",script:$s,timeout_s:$t}')"); rc=$?
    printf '%s\n' "$r"
    [ "$rc" -eq 0 ] || exit "$rc"
    [ "$(jq -r '.exit_code' <<<"$r")" = 0 ] ;;
  type)
    if [ $# -ge 1 ]; then t="$*"; else t=$(cat); fi
    [ -n "$t" ] || usage
    act "$(jq -nc --arg t "$t" '{action:"type_text",text:$t}')" ;;
  key)
    [ $# -eq 1 ] || usage
    act "$(jq -nc --arg c "$1" '{action:"key",combo:$c}')" ;;
  click)
    [ $# -ge 2 ] || usage
    [[ "$1" =~ ^[0-9]+$ && "$2" =~ ^[0-9]+$ ]] || usage
    btn=left; dbl=false
    for a in "${@:3}"; do case "$a" in left|right|middle) btn=$a ;; double) dbl=true ;; *) usage ;; esac; done
    act "$(jq -nc --argjson x "$1" --argjson y "$2" --arg b "$btn" --argjson d "$dbl" '{action:"click",x:$x,y:$y,button:$b,double:$d}')" ;;
  windows)
    act '{"action":"list_windows"}' ;;
  focus)
    [ $# -ge 1 ] || usage
    act "$(jq -nc --arg t "$*" '{action:"focus_window",title:$t}')" ;;
  media)
    [ $# -eq 1 ] || usage
    case "$1" in
      status) act '{"action":"media_status"}' ;;
      play_pause|next|prev|volume_up|volume_down|mute) act "$(jq -nc --arg c "$1" '{action:"media",command:$c}')" ;;
      *) usage ;;
    esac ;;
  shot)
    req='{"action":"screenshot"}'
    if [ $# -ge 1 ]; then
      w=$(act '{"action":"list_windows"}'); rc=$?; [ "$rc" -eq 0 ] || exit "$rc"
      hw=$(jq -r --arg t "$*" '[.windows[] | select(.title | ascii_downcase | contains($t | ascii_downcase))][0].hwnd // empty' <<<"$w")
      [ -n "$hw" ] || { echo "george.sh: no window matches '$*'" >&2; exit 1; }
      req=$(jq -nc --argjson h "$hw" '{action:"screenshot",hwnd:$h}')
    fi
    r=$(act "$req"); rc=$?
    [ "$rc" -eq 0 ] || { printf '%s\n' "$r" >&2; exit "$rc"; }
    name=$(jq -r '.name // empty' <<<"$r")
    [ -n "$name" ] || { echo "george.sh: no screenshot name in reply" >&2; exit 1; }
    mkdir -p "$STATE/george/shots"
    dest="$STATE/george/shots/$name"
    if ! $SSH "$HANDS get $name" >"$dest" 2>/dev/null || [ ! -s "$dest" ]; then rm -f "$dest"; offline "could not fetch $name"; fi
    echo "$dest" ;;
  spotify)
    [ $# -ge 1 ] || usage
    act '{"action":"open_app","name":"spotify"}' >/dev/null || exit $?
    sleep 3
    f=$(act '{"action":"focus_window","title":"Spotify"}') || { printf '%s\n' "$f"; exit 1; }
    h=$(jq -r '.hwnd' <<<"$f")
    act "$(jq -nc --argjson h "$h" '{action:"key",combo:"ctrl+k",hwnd:$h}')" >/dev/null || exit 1
    act "$(jq -nc --argjson h "$h" --arg t "$*" '{action:"type_text",text:$t,hwnd:$h}')" >/dev/null || exit 1
    act "$(jq -nc --argjson h "$h" '{action:"key",combo:"enter",hwnd:$h}')" ;;
  *) usage ;;
esac
