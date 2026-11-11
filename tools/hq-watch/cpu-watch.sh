#!/usr/bin/env bash
# cpu-watch: a witness for the "WSL is eating 90% of my CPU" spikes.
#
# The spikes happen on the desktop after hours of uptime and are gone by the
# time anyone opens top, so nobody has ever seen WHICH process it was. This
# loop samples the 1-minute load every INTERVAL seconds and, the moment it
# crosses the threshold, writes a full snapshot to state/logs/cpu-watch.log:
# the real per-process CPU over one second (top's second frame, not ps's
# lifetime average), memory and swap, and the whole-VM view through
# `wsl.exe --system` so the WSLg system distro (pulseaudio, weston, the RDP
# audio path the Capri microphone rides on) is in the picture too. It pings
# the owner once per PING_COOLDOWN with the top three offenders, and every five
# minutes it logs one quiet heartbeat line so the log doubles as a timeline.
#
# Read-only: it never kills anything. Fail-open: a failed sample is skipped.
#
# Usage: cpu-watch.sh            one pass (snapshot only if the load is high)
#        cpu-watch.sh --loop     run forever (an hq.sh tmux window)
#        cpu-watch.sh --snapshot force one snapshot now, whatever the load
# Env:   INTERVAL (30), CPU_WATCH_LOAD (default: half the cores),
#        PING_COOLDOWN (3600), HQ_NO_NOTIFY=1 to stay silent.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="$(cd "$DIR/../.." && pwd)"
LOG="$HQ/state/logs/cpu-watch.log"
HB="$HQ/state/heartbeat/cpu-watch"
STAMP="$HQ/state/cpu-watch/last-ping"
INTERVAL="${INTERVAL:-30}"
PING_COOLDOWN="${PING_COOLDOWN:-3600}"
NCPU="$(nproc 2>/dev/null || echo 4)"
THRESH="${CPU_WATCH_LOAD:-$(awk -v n="$NCPU" 'BEGIN{printf "%.1f", n/2}')}"
mkdir -p "$(dirname "$LOG")" "$(dirname "$HB")" "$(dirname "$STAMP")"

ts() { date +%FT%T; }

# instantaneous per-process CPU: two reads of /proc/*/stat one second apart,
# so a burst shows as a burst. ps %cpu (and top's first frame) is a lifetime
# average and hides exactly the process that woke up an hour in.
top_frame() {
  python3 - <<'PY2' 2>/dev/null
import os, time
def snap():
    d = {}
    for pid in os.listdir('/proc'):
        if not pid.isdigit(): continue
        try:
            with open('/proc/%s/stat' % pid) as f: raw = f.read()
            comm = raw[raw.index('(')+1:raw.rindex(')')]
            f = raw[raw.rindex(')')+2:].split()
            d[pid] = (comm, int(f[11]) + int(f[12]))
        except Exception: pass
    return d
a = snap(); time.sleep(1.0); b = snap()
hz = os.sysconf('SC_CLK_TCK')
rows = []
for pid, (comm, t1) in b.items():
    t0 = a.get(pid, (comm, t1))[1]
    rows.append((100.0 * (t1 - t0) / hz, pid, comm))
rows.sort(reverse=True)
tot = sum(r[0] for r in rows)
print('-- per-process CPU over 1s (total %.0f%% of one core, %d cores) --' % (tot, os.cpu_count() or 0))
for pct, pid, comm in rows[:12]:
    if pct <= 0: break
    try: args = open('/proc/%s/cmdline' % pid, 'rb').read().replace(b'\0', b' ').decode('utf-8', 'replace')[:90]
    except Exception: args = ''
    print('%6.1f%%  %6s  %-15s %s' % (pct, pid, comm[:15], args))
PY2
}

vm_view() {
  # the Ubuntu pid namespace hides the WSLg system distro; wsl.exe --system
  # sees the whole VM. Absent (not WSL, interop off) it is simply skipped.
  command -v wsl.exe >/dev/null 2>&1 || return 0
  echo "-- whole-VM view (wsl.exe --system) --"
  timeout 20 wsl.exe --system -u root ps -eo pid,pcpu,etimes,rss,comm,args --sort=-pcpu 2>/dev/null \
    | tr -d '\r' | head -12 | cut -c1-150
}

snapshot() {
  local load="$1" why="$2"
  {
    echo "== $(ts) SNAPSHOT ($why) load1=$load threshold=$THRESH cores=$NCPU =="
    top_frame
    echo "-- memory --"; free -m | sed -n '2,3p'
    vm_view
    echo
  } >>"$LOG" 2>&1
}

offenders() {
  top_frame | sed -n '2,4p' | awk '{printf "%s %s; ", $3, $1}' | sed 's/; $//'
}

ping_once() {
  local load="$1"
  [ "${HQ_NO_NOTIFY:-0}" = 1 ] && return 0
  local last=0 now; now="$(date +%s)"
  [ -f "$STAMP" ] && last="$(cat "$STAMP" 2>/dev/null || echo 0)"
  [ $((now - last)) -lt "$PING_COOLDOWN" ] && return 0
  echo "$now" >"$STAMP"
  "$HQ/ops/scripts/notify.sh" default "WSL CPU spike" \
    "load $load on $NCPU cores; top: $(offenders). Snapshot in state/logs/cpu-watch.log" >/dev/null 2>&1 || true
}

pass() {
  local load; load="$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo 0)"
  date +%s >"$HB" 2>/dev/null || true
  if awk -v l="$load" -v t="$THRESH" 'BEGIN{exit !(l>=t)}'; then
    snapshot "$load" "load over threshold"
    ping_once "$load"
    return 1
  fi
  return 0
}

heartbeat_line() {
  local load; load="$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo "? ? ?")"
  local top1; top1="$(ps -eo pcpu,comm --sort=-pcpu 2>/dev/null | sed -n 2p | awk '{print $2" "$1"%"}')"
  echo "$(ts) load=$load top=${top1:-?}" >>"$LOG"
}

case "${1:-}" in
  --loop)
    echo "cpu-watch: every ${INTERVAL}s, snapshot when load1 >= $THRESH ($NCPU cores); log: $LOG"
    n=0
    while true; do
      pass || true
      n=$((n+1))
      [ $((n % (300 / INTERVAL) )) -eq 0 ] && heartbeat_line
      sleep "$INTERVAL"
    done ;;
  --snapshot)
    snapshot "$(cut -d' ' -f1 /proc/loadavg)" "forced"; tail -25 "$LOG" ;;
  *)
    pass && echo "cpu-watch: load $(cut -d' ' -f1 /proc/loadavg) under $THRESH; nothing recorded" ;;
esac
