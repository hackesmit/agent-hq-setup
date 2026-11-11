#!/usr/bin/env bash
# Fixture test for hq-deadman.sh: fake systemctl and notify.sh, controlled clock.
set -u
W="$(cd "$(dirname "$0")/../../../.." && pwd)"
T="$(mktemp -d)"; mkdir -p "$T/ops/scripts" "$T/bin"
cat >"$T/ops/scripts/notify.sh" <<EOF2
#!/bin/bash
[ -f "$T/down" ] && exit 1
echo "\$*" >> "$T/sent.log"
EOF2
chmod +x "$T/ops/scripts/notify.sh"
# fake systemctl: state in $T/svc/<timer>: "<Result> <exit-epoch>"; $T/timers lists the box's timers
cat >"$T/bin/systemctl" <<EOF2
#!/bin/bash
echo "\$*" >> "$T/calls.log"
args=("\$@"); a=(); for x in "\${args[@]}"; do case "\$x" in --user|--no-pager|--no-legend|--all|--timestamp=unix) ;; *) a+=("\$x");; esac; done
case "\${a[0]}" in
  list-timers) sed 's/\$/ n\/a n\/a n\/a n\/a/' "$T/timers" ;;
  show) last="\${a[\${#a[@]}-1]}"
    if [[ "\$last" == *.timer ]]; then echo "\${last%.timer}.service"; exit 0; fi
    f="$T/svc/\${last%.service}.timer"; [ -f "\$f" ] || exit 0
    read -r r ts <"\$f"; echo "Result=\$r"; echo "ExecMainExitTimestamp=@\$ts" ;;
esac
EOF2
chmod +x "$T/bin/systemctl"; mkdir -p "$T/svc"
cat >"$T/cad.json" <<'EOF2'
{"timers":[{"timer":"a.timer","scope":"user","grace":600},{"timer":"b.timer","scope":"user","grace":600}],
 "ignore":[{"timer":"x.timer","reason":"test"}]}
EOF2
printf 'a.timer\nb.timer\nx.timer\n' >"$T/timers"
export HQ_ROOT="$T" DEADMAN_CONFIG="$T/cad.json" DEADMAN_STATE="$T/state" DEADMAN_SYSTEMCTL="$T/bin/systemctl" DEADMAN_REALERT=86400
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 (got $2, want $3)"; fail=$((fail+1)); fi; }
run() { DEADMAN_NOW="$1" bash "$W/ops/services/deadman/hq-deadman.sh" user >/dev/null 2>&1; }
sent() { [ -f "$T/sent.log" ] && wc -l <"$T/sent.log" || echo 0; }

echo "success 1000" >"$T/svc/a.timer"; echo "success 1000" >"$T/svc/b.timer"
run 1100; check "healthy: no alert" "$(sent)" 0

# b stops running: inside grace quiet, past grace ONE alert
run 1500; check "inside grace: quiet" "$(sent)" 0
echo "success 1400" >"$T/svc/a.timer"
run 1800; check "stale: one alert" "$(sent)" 1
grep -q "b.timer" "$T/sent.log"; check "alert names the timer" "$?" 0
grep -q "a.timer has not" "$T/sent.log"; check "healthy timer not named" "$?" 1
run 1850; run 1900; check "repeat inside a day: still one" "$(sent)" 1
echo "success 88200" >"$T/svc/a.timer"; run 88300
check "after a day: re-alert" "$(sent)" 2

# restart: success clears, one recovered ping
echo "success 88350" >"$T/svc/b.timer"; echo "success 88350" >"$T/svc/a.timer"
run 88400; check "recovery: ping sent" "$(sent)" 3
grep -q "recovered" "$T/sent.log"; check "recovery text" "$?" 0
run 88500; check "recovery once" "$(sent)" 3

# repeatedly failing is silent time too (OnFailure pages the failure; this pages the silence)
echo "failed 88400" >"$T/svc/b.timer"; echo "success 88700" >"$T/svc/a.timer"
run 88800; check "failed-only within grace: quiet" "$(sent)" 3
echo "success 91000" >"$T/svc/a.timer"; run 91500
check "failed past grace: alert" "$(sent)" 4

# undeliverable alert: nonzero and re-sent next run
touch "$T/down"; echo "success 91600" >"$T/svc/a.timer"; rm -rf "$T/state"; mkdir -p "$T/state"; echo 100 >"$T/state/b.timer.first"; echo "success 100" >"$T/svc/b.timer"
DEADMAN_NOW=200000 bash "$W/ops/services/deadman/hq-deadman.sh" user >/dev/null 2>&1; check "down: exit nonzero" "$?" 1
rm "$T/down"; run 200100; check "back up: alert delivered" "$(sent)" 5

# fail-closed config
rm -rf "$T/state"; : >"$T/sent.log"
for bad in missing empty badjson nograce; do
  case $bad in missing) rm -f "$T/cad.json";; empty) : >"$T/cad.json";; badjson) echo '{' >"$T/cad.json";;
    nograce) echo '{"timers":[{"timer":"a.timer","scope":"user"}]}' >"$T/cad.json";; esac
  rm -rf "$T/state"; : >"$T/sent.log"; run 1000
  grep -q "cadence file" "$T/sent.log"; check "config $bad: alert" "$?" 0
done
echo "success 1000" >"$T/svc/a.timer"
echo '{"timers":[{"timer":"a.timer","scope":"user","grace":600}]}' >"$T/cad.json"
rm -rf "$T/state"; : >"$T/sent.log"; run 1100
grep -q "timer b.timer has no cadence" "$T/sent.log"; check "uncovered timer: alert" "$?" 0

# ignore_patterns: snooze timers never alert
printf 'a.timer\nhq-wake-s-42.timer\n' >"$T/timers"
echo '{"timers":[{"timer":"a.timer","scope":"user","grace":600}],"ignore_patterns":["hq-wake-s-*.timer"]}' >"$T/cad.json"
rm -rf "$T/state"; : >"$T/sent.log"; run 1100; check "ignore_patterns: snooze timer quiet" "$(sent)" 0

# uncovered: key per timer, a second new timer is not masked; urgent never used
printf 'a.timer\nn1.timer\n' >"$T/timers"; rm -rf "$T/state"; : >"$T/sent.log"; run 1100
printf 'a.timer\nn1.timer\nn2.timer\n' >"$T/timers"; run 1200
check "second uncovered timer alerts at once" "$(sent)" 2
grep -q "^default " "$T/sent.log"; check "alerts use default priority" "$?" 0
grep -q "^urgent " "$T/sent.log"; check "no urgent" "$?" 1
printf 'a.timer\nn2.timer\n' >"$T/timers"; run 1300
grep -q "n1.timer is healthy again\|_uncovered_n1.timer is healthy" "$T/sent.log"; check "uncovered recovery" "$?" 0

# list-timers failing is a problem
cat >"$T/bin/lt-fail" <<EOF2
#!/bin/bash
[[ "\$*" == *list-timers* ]] && exit 1
exec "$T/bin/systemctl" "\$@"
EOF2
chmod +x "$T/bin/lt-fail"; rm -rf "$T/state"; : >"$T/sent.log"
DEADMAN_SYSTEMCTL="$T/bin/lt-fail" DEADMAN_NOW=1100 bash "$W/ops/services/deadman/hq-deadman.sh" user >/dev/null 2>&1
grep -q "list-timers failed" "$T/sent.log"; check "list-timers failure alerts" "$?" 0

# future last-exit timestamp (clock skew) does not suppress the alert
echo "success 9999999" >"$T/svc/a.timer"; echo '{"timers":[{"timer":"a.timer","scope":"user","grace":600}]}' >"$T/cad.json"
printf 'a.timer\n' >"$T/timers"; rm -rf "$T/state"; : >"$T/sent.log"; mkdir -p "$T/state"; echo 100 >"$T/state/a.timer.first"
run 5000; grep -q "a.timer has not" "$T/sent.log"; check "future timestamp ignored" "$?" 0

# cross-scope: system run watches a user timer with --user, user run watches a system timer plainly
cat >"$T/cad.json" <<'EOF2'
{"timers":[{"timer":"u.timer","scope":"user","checked_by":"system","grace":600},{"timer":"s.timer","scope":"system","checked_by":"user","grace":600}]}
EOF2
printf 'u.timer\ns.timer\n' >"$T/timers"; echo "success 1000" >"$T/svc/u.timer"; echo "success 1000" >"$T/svc/s.timer"
rm -rf "$T/state"; : >"$T/sent.log"; : >"$T/calls.log"
DEADMAN_NOW=1100 bash "$W/ops/services/deadman/hq-deadman.sh" system >/dev/null 2>&1
grep -q -- "--user.*u.service\|--user.*u.timer" "$T/calls.log"; check "system run queries user unit with --user" "$?" 0
grep -q "s.service\|s.timer" "$T/calls.log" && grep "s\.\(service\|timer\)" "$T/calls.log" | grep -q -- "--user"; check "system run does not query s with --user" "$?" 1
rm -rf "$T/state"; mkdir -p "$T/state"; : >"$T/calls.log"; : >"$T/sent.log"; echo 100 >"$T/state/s.timer.first"; echo "success 1000" >"$T/svc/s.timer"
DEADMAN_NOW=5000 bash "$W/ops/services/deadman/hq-deadman.sh" user >/dev/null 2>&1
grep "s\.\(service\|timer\)" "$T/calls.log" | grep -q -- "--user"; check "user run queries system unit without --user" "$?" 1
grep -q "s.timer has not" "$T/sent.log"; check "cross-scope stale alerts from other scope" "$?" 0
grep -q "u.timer has not" "$T/sent.log"; check "user run skips entry checked by system" "$?" 1

echo "$pass passed, $fail failed"; rm -rf "$T"; [ "$fail" -eq 0 ]
