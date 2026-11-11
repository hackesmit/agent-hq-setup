#!/usr/bin/env bash
# Stubbed-ssh tests for george.sh (hq-63nvj.2). No George needed.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"; G="$DIR/../scripts/george.sh"
fail=0
ok(){ printf 'PASS  %s\n' "$1"; }
no(){ printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }
eq(){ [ "$2" = "$3" ] && ok "$1" || no "$1" "got=$2 want=$3"; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
export HQ_STATE_DIR="$T/state"
# stub ssh: logs stdin and argv, replies per $STUB_MODE
cat >"$T/ssh" <<'S'
#!/usr/bin/env bash
cmd="$*"; in=""; [[ "$cmd" == *"call -"* ]] && in=$(cat)
printf '%s\t%s\n' "$cmd" "$in" >>"$STUB_LOG"
case "$STUB_MODE" in
  down) echo "ssh: connect timed out" >&2; exit 255 ;;
  norun) echo "hands is not running on 127.0.0.1:47615" >&2; exit 1 ;;
esac
case "$cmd" in
  *"hands get"*) printf '\x89PNG\r\n\x1a\nfake' ;;
  *) case "$in" in
       *list_windows*) echo '{"ok":true,"windows":[{"hwnd":77,"title":"Notepad - x","pid":1,"exe":"Notepad.exe","foreground":true}],"idle_s":5}' ;;
       *screenshot*) echo '{"ok":true,"name":"shot-20261104-120000-001.png","width":1,"height":1}' ;;
       *'"bogus"'*) echo '{"ok":false,"error":"unknown"}'; exit 1 ;;
       *'"action":"powershell"'*fail*) echo '{"ok":true,"exit_code":2,"stdout":"","stderr":"x"}' ;;
       *'"action":"powershell"'*) echo '{"ok":true,"exit_code":0,"stdout":"Wednesday\r\n","stderr":""}' ;;
       *) echo '{"ok":true}' ;;
     esac ;;
esac
S
chmod +x "$T/ssh"
export GEORGE_SSH="$T/ssh" STUB_LOG="$T/log" STUB_MODE=up
: >"$T/log"

out=$("$G" open https://example.com); eq "open url exit" $? 0
grep -q '"action":"open_url","url":"https://example.com"' "$T/log" && ok "open url json on stdin" || no "open url json"
"$G" open spotify >/dev/null; grep -q '"action":"open_app","name":"spotify"' "$T/log" && ok "open app json" || no "open app json"

: >"$T/log"; sec='pa$$ "quoted" `tick` ;rm -rf /'
"$G" type "$sec" >/dev/null; eq "type exit" $? 0
grep -qF 'rm -rf' <(cut -f1 "$T/log") && no "text leaked onto command line" || ok "typed text not on command line"
[ "$(cut -f2 "$T/log" | jq -r .text)" = "$sec" ] && ok "typed text intact via stdin json" || no "typed text json"
printf 'from stdin' | "$G" type >/dev/null; tail -1 "$T/log" | cut -f2 | grep -q 'from stdin' && ok "type reads stdin" || no "type stdin"

"$G" key ctrl+l >/dev/null; tail -1 "$T/log" | cut -f2 | grep -q '"combo":"ctrl+l"' && ok "key json" || no "key json"
"$G" click 10 20 right double >/dev/null; tail -1 "$T/log" | cut -f2 | jq -e '.x==10 and .y==20 and .button=="right" and .double==true' >/dev/null && ok "click json" || no "click json"
"$G" click a b >/dev/null 2>&1; eq "click bad args exit 2" $? 2
"$G" media mute >/dev/null; tail -1 "$T/log" | cut -f2 | grep -q '"command":"mute"' && ok "media json" || no "media json"
"$G" media nonsense >/dev/null 2>&1; eq "media bad exit 2" $? 2
"$G" focus Notepad >/dev/null; tail -1 "$T/log" | cut -f2 | grep -q '"title":"Notepad"' && ok "focus json" || no "focus json"

p=$("$G" shot); eq "shot exit" $? 0
[ "$p" = "$T/state/george/shots/shot-20261104-120000-001.png" ] && ok "shot prints path" || no "shot path" "$p"
[ "$(head -c4 "$p" | tail -c3)" = PNG ] && ok "shot png saved" || no "shot png"
p=$("$G" shot notepad); eq "shot by title exit" $? 0
grep -q '"hwnd":77' "$T/log" && ok "shot by title resolves hwnd" || no "shot hwnd"
"$G" shot nomatch >/dev/null 2>&1; eq "shot no window exit 1" $? 1

# hq-63nvj.13: audio, volume, monitors, move, settings, ps, open on a screen
last(){ tail -1 "$T/log" | cut -f2; }
"$G" audio >/dev/null; last | jq -e '.action=="audio_devices"' >/dev/null && ok "audio lists" || no "audio list"
"$G" audio out my speaker >/dev/null; last | jq -e '.action=="audio_output" and .name=="my speaker"' >/dev/null && ok "audio out json" || no "audio out"
"$G" audio in hyperx >/dev/null; last | jq -e '.action=="audio_input" and .name=="hyperx"' >/dev/null && ok "audio in json" || no "audio in"
"$G" audio out >/dev/null 2>&1; eq "audio out no name exit 2" $? 2
"$G" audio out --role 2 my speaker >/dev/null; last | jq -e '.action=="audio_output" and .role==2 and .name=="my speaker"' >/dev/null && ok "audio out role json" || no "audio out role"
"$G" audio out my speaker >/dev/null; last | jq -e 'has("role")|not' >/dev/null && ok "audio out no role means all" || no "audio out no role"
"$G" audio in --role 3 hyperx >/dev/null 2>&1; eq "audio in role 3 exit 2" $? 2
"$G" audio out --role 1 >/dev/null 2>&1; eq "audio out role no name exit 2" $? 2
"$G" volume 30 >/dev/null; last | jq -e '.action=="volume" and .level==30' >/dev/null && ok "volume level json" || no "volume level"
"$G" volume up >/dev/null; last | jq -e '.command=="up" and (has("level")|not)' >/dev/null && ok "volume up json" || no "volume up"
"$G" volume >/dev/null; last | jq -e '.=={"action":"volume"}' >/dev/null && ok "volume read json" || no "volume read"
"$G" volume loud >/dev/null 2>&1; eq "volume bad exit 2" $? 2
"$G" monitors >/dev/null; last | jq -e '.action=="monitors"' >/dev/null && ok "monitors json" || no "monitors"
"$G" move --max 2 Notepad - x >/dev/null; last | jq -e '.action=="move_window" and .monitor==2 and .title=="Notepad - x" and .maximize==true' >/dev/null && ok "move json" || no "move json"
"$G" move Notepad >/dev/null 2>&1; eq "move no monitor exit 2" $? 2
"$G" settings night light >/dev/null; last | jq -e '.action=="settings" and .page=="night light"' >/dev/null && ok "settings json" || no "settings"
"$G" open --screen 2 https://example.com >/dev/null; last | jq -e '.action=="open_url" and .monitor==2 and (has("new_window")|not)' >/dev/null && ok "open on screen json" || no "open screen"
"$G" open --new https://example.com >/dev/null; last | jq -e '.new_window==true and (has("monitor")|not)' >/dev/null && ok "open new window json" || no "open new"
"$G" open --screen 2 notepad >/dev/null 2>&1; eq "open app on screen exit 2" $? 2
: >"$T/log"; ps='Get-Date; "$env:USERNAME `n"'
out=$("$G" ps "$ps"); eq "ps exit 0" $? 0
grep -qF 'USERNAME' <(cut -f1 "$T/log") && no "script leaked onto command line" || ok "script not on command line"
[ "$(cut -f2 "$T/log" | jq -r .script)" = "$ps" ] && ok "script intact via stdin json" || no "script json"
[ "$(cut -f2 "$T/log" | jq -r .timeout_s)" = 30 ] && ok "ps default timeout" || no "ps timeout"
printf 'fail now' | "$G" ps --timeout 5 >/dev/null; eq "ps nonzero script exit 1" $? 1
tail -1 "$T/log" | cut -f2 | jq -e '.timeout_s==5 and .script=="fail now"' >/dev/null && ok "ps stdin and timeout" || no "ps stdin"
STUB_MODE=down "$G" ps Get-Date >/dev/null 2>&1; eq "ps offline exit 3" $? 3

"$G" frobnicate >/dev/null 2>&1; eq "unknown subcommand exit 2" $? 2
"$G" >/dev/null 2>&1; eq "no args exit 2" $? 2

STUB_MODE=down "$G" windows >/dev/null 2>"$T/e"; eq "offline exit 3" $? 3
grep -q 'unreachable' "$T/e" && ok "offline message clear" || no "offline message"
STUB_MODE=down "$G" shot >/dev/null 2>&1; eq "offline shot exit 3" $? 3
STUB_MODE=norun "$G" windows >/dev/null 2>"$T/e"; eq "hands down exit 3" $? 3
exit $fail
