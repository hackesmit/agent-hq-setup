#!/usr/bin/env bash
# Live probe of the hq-63nvj.13 actions from hqbox: audio devices, switch output and back,
# volume 30 and back, monitors, example.com on monitor 2, Bluetooth settings, powershell.
# It snapshots the output and input default per role, the level and mute before it changes
# anything, and the EXIT trap restores every one of them (each role to its own saved id, the
# level, then mute) even after a failure, then reads them back. Every required call and every
# readback is checked; the probe exits nonzero when any step or any restore failed, and the
# log names which. Fewer than two outputs: exit 2, nothing changed. Waits until the owner has not
# touched George for IDLE seconds (0 skips the wait), because it opens windows on his desktop.
# usage: system_probe.sh OUTDIR [IDLE=60] [MAXWAIT=7200]
# env: PROBE_GEORGE (george.sh to call, for tests), PROBE_SLEEP (seconds a window gets, 3)
set -u
OUT=$1; IDLE=${2:-60}; MAXWAIT=${3:-7200}
G=${PROBE_GEORGE:-"$(cd "$(dirname "$0")/../.." && pwd)/ops/scripts/george.sh"}
NAP=${PROBE_SLEEP:-3}
mkdir -p "$OUT"; LOG=$OUT/probe.log; : >"$LOG"
export HQ_STATE_DIR="$OUT/state"
say() { echo "== $(date -u +%FT%TZ) $*" | tee -a "$LOG"; }
g() { "$G" "$@" 2>>"$LOG" | tee -a "$LOG"; return "${PIPESTATUS[0]}"; }
FAILED=()
fail() { FAILED+=("$*"); say "FAIL: $*"; }
# need WHAT CMD...: a required step; on failure stop here, the trap restores.
need() { local w=$1; shift; g "$@" >/dev/null || { fail "$w (george.sh $* exit $?)"; exit 1; }; }
# check WHAT CMD...: a step that does not touch audio; a failure is recorded, the run goes on.
check() { local w=$1; shift; g "$@" >/dev/null || fail "$w (george.sh $* exit $?)"; }
ROLES=(console multimedia communications)
# state: one line, "<out console> <out multimedia> <out communications> <in x3> <level> <muted>"
state() {
  local d v; d=$("$G" audio 2>>"$LOG") || return 1; v=$("$G" volume 2>>"$LOG") || return 1
  jq -nr --argjson d "$d" --argjson v "$v" \
    '[($d.defaults.output, $d.defaults.input) | .console, .multimedia, .communications]
     + [$v.level, $v.muted] | map(if . == null then "none" else tostring end) | join(" ")'
}

if [ "$IDLE" -gt 0 ]; then
  t0=$SECONDS
  while :; do i=$("$G" windows | jq -r '.idle_s // 0'); [ "${i%.*}" -ge "$IDLE" ] 2>/dev/null && break
    [ $((SECONDS - t0)) -ge "$MAXWAIT" ] && { say "gave up: the owner active for ${MAXWAIT}s"; exit 3; }; sleep 20; done
  say "the owner idle ${i}s, acting"
fi

# ---- snapshot: nothing has changed yet, so a failure here just exits -----------------------
say "audio devices"; dev=$(g audio) || { say "FAIL: audio list"; exit 1; }
n=$(jq '.outputs | length' <<<"$dev")
if [ "${n:-0}" -lt 2 ]; then say "FAIL: ${n:-0} output device(s), the probe needs two; nothing changed"; exit 2; fi
snap=$(state) || { say "FAIL: snapshot read"; exit 1; }
read -r o_c o_m o_k i_c i_m i_k orig_vol orig_muted <<<"$snap"
if [ "$o_c" = none ] || ! [[ "$orig_vol" =~ ^[0-9]+$ ]] || ! [[ "$orig_muted" =~ ^(true|false)$ ]]; then
  say "FAIL: snapshot incomplete ($snap); nothing changed"; exit 1; fi
other=$(jq -r --arg o "$o_c" '[.outputs[] | select(.id != $o)][0].id' <<<"$dev")
say "before: output console=$o_c multimedia=$o_m communications=$o_k; input console=$i_c multimedia=$i_m communications=$i_k; level $orig_vol muted $orig_muted"

restore() {
  local rc=$? r id saved=("$o_c" "$o_m" "$o_k")
  trap - EXIT
  say "restore: each output role to its saved id, level $orig_vol, muted $orig_muted"
  for r in 0 1 2; do id=${saved[$r]}
    [ "$id" = none ] && continue
    g audio out --role "$r" "$id" >/dev/null || fail "restore output ${ROLES[$r]} (exit $?)"; done
  g volume "$orig_vol" >/dev/null || fail "restore level (exit $?)"
  if [ "$orig_muted" = true ]; then g volume mute >/dev/null || fail "restore mute (exit $?)"; fi
  local now; now=$(state) || { fail "readback after restore"; now=""; }
  say "after: $now"
  if [ -n "$now" ] && [ "$now" != "$snap" ]; then
    local a b k names=(output.console output.multimedia output.communications input.console
      input.multimedia input.communications level muted)
    read -ra a <<<"$snap"; read -ra b <<<"$now"
    for k in "${!names[@]}"; do [ "${a[$k]:-}" = "${b[$k]:-}" ] || fail "after restore ${names[$k]} is ${b[$k]:-?}, was ${a[$k]:-?}"; done
  fi
  if [ ${#FAILED[@]} -gt 0 ]; then say "probe FAILED (${#FAILED[@]}): $(IFS=';'; echo "${FAILED[*]}")"; exit 1; fi
  [ "$rc" -eq 0 ] || { say "probe FAILED: exit $rc"; exit "$rc"; }
  say "probe passed"; exit 0
}
trap restore EXIT

# ---- audio ----------------------------------------------------------------------------------
say "switch output to $other"; need "switch output" audio out "$other"
now=$(state) || { fail "readback after switch"; exit 1; }; read -r c m k _ <<<"$now"
[ "$c $m $k" = "$other $other $other" ] || { fail "after switch the defaults are $c $m $k, expected $other"; exit 1; }
say "switch back by id"; need "switch back" audio out "$o_c"
c=$(state | cut -d' ' -f1); [ "$c" = "$o_c" ] || { fail "after switch back the console default is $c"; exit 1; }

say "volume 30"; need "volume 30" volume 30
v=$("$G" volume 2>>"$LOG" | jq -c '{level,muted}'); say "read: $v"
[ "$(jq -r .level <<<"$v")" = 30 ] || { fail "level after volume 30 is $(jq -r .level <<<"$v")"; exit 1; }

# ---- the rest: recorded, the run goes on ------------------------------------------------------
say "monitors"; check "monitors" monitors
say "example.com on monitor 2"; r=$(g open --screen 2 https://example.com) || fail "open on monitor 2"
bw=$(jq -r '.hwnd // empty' <<<"${r:-}" 2>/dev/null)
sleep "$NAP"; check "screenshot" shot; [ -n "$bw" ] && check "screenshot of the window" shot Example
if [ -n "$bw" ] && g focus Example >/dev/null; then say "close the probe tab"; g key ctrl+w >/dev/null; fi
say "bluetooth settings"; check "settings bluetooth" settings bluetooth; sleep "$NAP"
sw=$("$G" windows | jq -r '[.windows[] | select(.exe=="ApplicationFrameHost.exe" and (.title|test("Settings|Configuraci")))][0].hwnd // empty')
say "settings window: ${sw:-none}"; check "screenshot of settings" shot
say "powershell Get-Date"; check "powershell" ps 'Get-Date -Format o; $env:USERNAME; [Environment]::UserInteractive'
say "close settings"
[ -n "$sw" ] && "$G" ps "Stop-Process -Name SystemSettings -ErrorAction SilentlyContinue" >/dev/null
say "steps done"
