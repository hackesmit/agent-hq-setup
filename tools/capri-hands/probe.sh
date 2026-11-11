#!/usr/bin/env bash
# Live probe of Capri hands from hqbox (hq-63nvj.1 DoD). Waits until the owner has not
# touched George for IDLE seconds, so it never types into a window he is using.
# usage: probe.sh OUTDIR [IDLE=180] [MAXWAIT=7200]
set -u
OUT=$1; IDLE=${2:-180}; MAXWAIT=${3:-7200}
mkdir -p "$OUT"; LOG=$OUT/probe.log
h() { printf '%s' "$1" | ssh george 'cd C:\Users\owner\capri-hands && python -m hands call -'; }
say() { echo "== $(date -u +%FT%TZ) $*" | tee -a "$LOG"; }
shot() { local s n; s=$(h "{\"action\":\"screenshot\",\"hwnd\":$1}"); echo "$s" >>"$LOG"; n=$(jq -r .name <<<"$s")
  ssh george "cd C:\\Users\\owner\\capri-hands && python -m hands get $n" >"$OUT/$2"; file "$OUT/$2" | tee -a "$LOG"; }
wait_idle() { local t0=$SECONDS i
  while :; do i=$(h '{"action":"list_windows"}' | jq -r '.idle_s // 0'); [ "${i%.*}" -ge "$IDLE" ] && break
    [ $((SECONDS - t0)) -ge "$MAXWAIT" ] && { say "gave up: the owner active for ${MAXWAIT}s"; exit 3; }; sleep 30; done
  say "the owner idle ${i}s, acting"; }
title_of() { h '{"action":"list_windows"}' | jq -r --argjson w "$1" '.windows[] | select(.hwnd==$w) | .title'; }

wait_idle
say "notepad: open"; before=$(h '{"action":"list_windows"}' | jq -c '[.windows[] | select(.exe=="Notepad.exe") | .hwnd]')
h '{"action":"open_app","name":"notepad"}' | tee -a "$LOG"; sleep 2.5
np=$(h '{"action":"list_windows"}' | jq -r --argjson b "$before" '[.windows[] | select(.exe=="Notepad.exe" and (.hwnd as $x | $b | index($x) | not))][0].hwnd // empty')
[ -n "$np" ] || { say "no new Notepad window (opened as a tab?), stop"; exit 4; }
say "notepad: type into hwnd $np"; h "{\"action\":\"type_text\",\"hwnd\":$np,\"text\":\"Capri hands probe hq-63nvj.6 ok\"}" | tee -a "$LOG"
sleep 0.4; shot "$np" notepad.png
say "notepad: clear and close"; h "{\"action\":\"key\",\"hwnd\":$np,\"combo\":\"ctrl+a\"}" >>"$LOG"; h "{\"action\":\"key\",\"hwnd\":$np,\"combo\":\"delete\"}" >>"$LOG"
h "{\"action\":\"key\",\"hwnd\":$np,\"combo\":\"ctrl+w\"}" | tee -a "$LOG"

say "browser: open https://example.com"; h '{"action":"open_url","url":"https://example.com"}' | tee -a "$LOG"; sleep 4
bw=$(h '{"action":"list_windows"}' | jq -r '[.windows[] | select(.title | startswith("Example Domain"))][0].hwnd // empty')
say "browser window: ${bw:-none} $( [ -n "$bw" ] && title_of "$bw")"
if [ -n "$bw" ]; then shot "$bw" example.png; h "{\"action\":\"key\",\"hwnd\":$bw,\"combo\":\"ctrl+w\"}" | tee -a "$LOG"; fi

ms() { h '{"action":"media_status"}' | jq -c '.current as $c | {current: $c, status: ([.sessions[] | select(.app == $c)][0].status)}'; }
say "media: before $(ms)"
h '{"action":"media","command":"mute"}' | tee -a "$LOG"
h '{"action":"media","command":"play_pause"}' | tee -a "$LOG"; sleep 2; say "after play_pause 1: $(ms)"
h '{"action":"media","command":"play_pause"}' | tee -a "$LOG"; sleep 2; say "after play_pause 2: $(ms)"
h '{"action":"media","command":"mute"}' | tee -a "$LOG"
say "done"
