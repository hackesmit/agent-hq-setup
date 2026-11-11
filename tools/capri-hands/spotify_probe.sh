#!/usr/bin/env bash
# Live probe of spotify_play (hq-63nvj.3 DoD): five tries of "Bohemian Rhapsody Queen",
# Spotify closed before the first; each warm try first plays a decoy song, so the
# confirm (now-playing is our uri and playing) proves this call switched the song.
# Then COLD extra tries, each with Spotify killed first. Waits until the owner is idle.
# usage: spotify_probe.sh OUTDIR [IDLE=60] [MAXWAIT=7200] [COLD=3]
set -u
OUT=$1; IDLE=${2:-60}; MAXWAIT=${3:-7200}; COLD=${4:-3}
mkdir -p "$OUT"; LOG=$OUT/probe.log
Q='{"action":"spotify_play","query":"Bohemian Rhapsody Queen"}'
h() { printf '%s' "$1" | ssh george 'cd C:\Users\owner\capri-hands && python -m hands call -'; }
say() { echo "== $(date -u +%FT%TZ) $*" | tee -a "$LOG"; }
spot() { h '{"action":"list_windows"}' | jq -r '[.windows[] | select(.exe=="Spotify.exe")][0].hwnd // empty'; }
shot() { local w s n; w=$(spot); [ -n "$w" ] || { say "no Spotify window for $1"; return; }
  s=$(h "{\"action\":\"screenshot\",\"hwnd\":$w}"); n=$(jq -r .name <<<"$s")
  ssh george "cd C:\\Users\\owner\\capri-hands && python -m hands get $n" >"$OUT/$1"; say "shot $1 $(file -b "$OUT/$1")"; }
kill_spotify() { ssh george 'taskkill /F /IM Spotify.exe' >/dev/null 2>&1
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    ssh george 'tasklist /FI "IMAGENAME eq Spotify.exe" /NH' | grep -qi spotify.exe || { say "Spotify closed"; return; }; sleep 1
  done; say "Spotify did not close"; exit 5; }
wait_idle() { local t0=$SECONDS i
  while :; do i=$(h '{"action":"list_windows"}' | jq -r '.idle_s // 0'); [ "${i%.*}" -ge "$IDLE" ] && break
    [ $((SECONDS - t0)) -ge "$MAXWAIT" ] && { say "gave up: the owner active for ${MAXWAIT}s"; exit 3; }; sleep 20; done
  say "the owner idle ${i}s, acting"; }
try() { local t0 t1 r; t0=$(date +%s.%N); r=$(h "$Q"); t1=$(date +%s.%N)
  say "$1: $(jq -c '{ok,track,artists,uri,cold,playing,ms,error}' <<<"$r") wall_s=$(echo "$t1 - $t0" | bc)"; shot "$1.png"; }

wait_idle
kill_spotify; try try1
for i in 2 3 4 5; do
  say "decoy: $(h '{"action":"spotify_play","query":"Under Pressure Queen David Bowie"}' | jq -c '{ok,track,uri}')"
  try "try$i"
done
for i in $(seq 1 "$COLD"); do kill_spotify; try "cold$i"; done
say "done"
