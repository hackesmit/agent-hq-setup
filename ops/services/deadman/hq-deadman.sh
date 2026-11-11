#!/usr/bin/env bash
# hq-deadman.sh [user|system]
#
# Dead-man's switch for every HQ timer (hq-pgbpq.7). OnFailure= alerts cover a
# unit that runs and fails; this covers a timer that silently stops running or
# never succeeds. Each timer in ops/config/timer-cadence.json has a grace in
# seconds. A timer whose service has not exited with Result=success within its
# grace raises ONE alert (notify.sh default; OnFailure= pages failures), repeated at most once per day, and a single
# "recovered" ping when it succeeds again. One run sends at most one message.
#
# Fail-closed: a missing, unreadable or malformed cadence file is itself an
# alert, and so is a timer on the box that is neither in the file nor in its
# `ignore` list. It does not duplicate the grace in hq-mail-drain and
# plan-usage (hq-je3fk.9): those alert on their own failures, this alerts on
# silence.
#
# Run one instance per scope (user timers from a user unit, system timers from
# a system unit); the argument selects which entries of the cadence file apply.
#
# HQ_ROOT            repo root (default ~/hq)
# DEADMAN_CONFIG     cadence file (default $HQ_ROOT/ops/config/timer-cadence.json)
# DEADMAN_STATE      state dir (default $HQ_ROOT/state/deadman/<scope>)
# DEADMAN_REALERT    seconds between repeat alerts (default 86400)
# DEADMAN_NOW        epoch override (test seam)
# DEADMAN_SYSTEMCTL  systemctl binary (test seam)
set -uo pipefail
SCOPE="${1:-user}"
HQ="${HQ_ROOT:-$HOME/hq}"
CONFIG="${DEADMAN_CONFIG:-$HQ/ops/config/timer-cadence.json}"
STATE="${DEADMAN_STATE:-$HQ/state/deadman/$SCOPE}"
REALERT="${DEADMAN_REALERT:-86400}"
NOW="${DEADMAN_NOW:-$(date +%s)}"
SC="${DEADMAN_SYSTEMCTL:-systemctl}"
[ "$SCOPE" = "user" ] && sc=("$SC" --user) || sc=("$SC")
# a timer of the other scope is queried through that scope's manager. The
# system run executes as the login user, so --user works once XDG_RUNTIME_DIR is set.
[ -n "${XDG_RUNTIME_DIR:-}" ] || export XDG_RUNTIME_DIR="/run/user/$(id -u)"
sc_user=("$SC" --user); sc_sys=("$SC")
mkdir -p "$STATE" 2>/dev/null || { echo "cannot create $STATE" >&2; exit 1; }

problems=()   # "<key>|<text>" for every key that is bad right now
checked=()    # every key evaluated this run, for recovery detection

read_num() { local v; v="$(cat "$1" 2>/dev/null)"; [[ "$v" =~ ^[0-9]+$ ]] && echo "$v" || echo 0; }

if ! jq -e '(.timers | type == "array" and length > 0)
            and all(.timers[]; (.timer | type == "string") and (.scope | IN("user","system"))
                    and ((.checked_by // .scope) | IN("user","system"))
                    and (.grace | type == "number" and . > 0))' "$CONFIG" >/dev/null 2>&1; then
  checked+=("_config")
  problems+=("_config|cadence file $CONFIG is missing, unreadable or malformed, so no timer is being watched")
else
  checked+=("_config")
  mapfile -t rows < <(jq -r --arg s "$SCOPE" '.timers[] | select((.checked_by // .scope) == $s) | "\(.timer) \(.scope) \(.grace)"' "$CONFIG")
  for row in "${rows[@]}"; do
    read -r timer uscope grace <<<"$row"
    if [ "$uscope" = "user" ]; then sc=("${sc_user[@]}"); else sc=("${sc_sys[@]}"); fi
    key="${timer//\//_}"; checked+=("$key")
    first="$STATE/$key.first"; lastok="$STATE/$key.lastok"
    [ -f "$first" ] || echo "$NOW" >"$first"
    svc="$("${sc[@]}" show -p Unit --value "$timer" 2>/dev/null)"
    [ -n "$svc" ] || svc="${timer%.timer}.service"
    out="$("${sc[@]}" show -p Result -p ExecMainExitTimestamp --timestamp=unix "$svc" 2>/dev/null)"
    result="$(sed -n 's/^Result=//p' <<<"$out")"
    ts="$(sed -n 's/^ExecMainExitTimestamp=@//p' <<<"$out")"
    # a timestamp in the future (clock skew) must not count as a recent success
    if [ "$result" = "success" ] && [[ "$ts" =~ ^[0-9]+$ ]] && [ "$ts" -le "$NOW" ] && [ "$ts" -gt "$(read_num "$lastok")" ]; then
      echo "$ts" >"$lastok"
    fi
    ref="$(read_num "$lastok")"; [ "$ref" -gt "$NOW" ] && ref=0
    f="$(read_num "$first")"; [ "$f" -gt "$ref" ] && ref="$f"
    age=$((NOW - ref))
    if [ "$age" -gt "$grace" ]; then
      problems+=("$key|$timer has not succeeded for $((age / 60)) min (grace $((grace / 60)) min)")
    fi
  done
  # a timer on the box that nobody gave a cadence is a hole in the net
  [ "$SCOPE" = "user" ] && sc=("${sc_user[@]}") || sc=("${sc_sys[@]}")
  if listing="$("${sc[@]}" list-timers --all --no-legend --no-pager 2>/dev/null)"; then
    known="$(jq -r '[.timers[].timer, (.ignore // [])[].timer] | .[]' "$CONFIG")"
    mapfile -t pats < <(jq -r '(.ignore_patterns // [])[] | strings' "$CONFIG")
    checked+=("_listing")
    while read -r t; do
      [ -n "$t" ] || continue
      grep -qxF "$t" <<<"$known" && continue
      skip=0; for g in "${pats[@]}"; do [ -n "$g" ] && [[ "$t" == $g ]] && skip=1; done
      [ "$skip" -eq 1 ] && continue
      k="_uncovered_${t//\//_}"; checked+=("$k")
      problems+=("$k|timer $t has no cadence in $CONFIG")
    done < <(grep -o '[^ ]*\.timer' <<<"$listing" | sort -u)
    # earlier uncovered alerts whose timer is gone or now covered get their recovery
    for f in "$STATE"/_uncovered_*.alert; do
      [ -e "$f" ] || continue; b="$(basename "$f" .alert)"
      printf '%s\n' "${checked[@]}" | grep -qxF "$b" || checked+=("$b")
    done
  else
    problems+=("_listing|systemctl list-timers failed ($SCOPE), so uncovered timers cannot be detected")
    checked+=("_listing")
  fi
fi

due=(); msgs=(); bad_keys=()
for p in "${problems[@]}"; do
  key="${p%%|*}"; bad_keys+=("$key")
  last="$(read_num "$STATE/$key.alert")"
  if [ "$last" -eq 0 ] || [ $((NOW - last)) -ge "$REALERT" ]; then
    due+=("$key"); msgs+=("${p#*|}")
  fi
done

rc=0
if [ "${#due[@]}" -gt 0 ]; then
  body="$(IFS=';'; echo "${msgs[*]}")"
  if "$HQ/ops/scripts/notify.sh" default "HQ timer silent on $(hostname -s) ($SCOPE)" "$body"; then
    for k in "${due[@]}"; do echo "$NOW" >"$STATE/$k.alert"; done
  else
    echo "could not deliver dead-man alert; will retry next run" >&2; rc=1
  fi
fi

# recovery: an armed alert whose key checked out clean this run
for k in "${checked[@]}"; do
  [ -f "$STATE/$k.alert" ] || continue
  printf '%s\n' "${bad_keys[@]:-}" | grep -qxF "$k" && continue
  "$HQ/ops/scripts/notify.sh" default "HQ timer recovered ($SCOPE)" "$k is healthy again" || true
  rm -f "$STATE/$k.alert"
done
exit "$rc"
