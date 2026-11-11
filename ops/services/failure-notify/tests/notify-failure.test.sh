#!/usr/bin/env bash
# Fixture test for notify-failure.sh: failed delivery must not arm dedupe.
set -u
W="$(cd "$(dirname "$0")/../../../.." && pwd)"
T="$(mktemp -d)"; mkdir -p "$T/ops/scripts" "$T/state"
cat >"$T/ops/scripts/notify.sh" <<EOF
#!/bin/bash
# fails while $T/fail exists, logs every call
echo "\$(date +%s) \$*" >> "$T/calls.log"
[ -f "$T/fail" ] && exit 1
echo "\$*" >> "$T/delivered.log"
exit 0
EOF
chmod +x "$T/ops/scripts/notify.sh"
export HQ_ROOT="$T" HQ_FAILURE_NOTIFY_STATE="$T/state" HQ_FAILURE_NOTIFY_RETRY_SLEEP=0
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 (got $2, want $3)"; fail=$((fail+1)); fi; }

# 1: endpoint down: 3 attempts, exit 1, no stamp
touch "$T/fail"
bash "$W/ops/services/failure-notify/notify-failure.sh" zz-unit.service user >/dev/null 2>&1; rc=$?
check "down: exit nonzero" "$rc" 1
check "down: 3 attempts" "$(wc -l <"$T/calls.log")" 3
check "down: no stamp" "$([ -f "$T/state/zz-unit.service.stamp" ] && echo yes || echo no)" no

# 2: endpoint back, second failure inside 6 h still alerts
rm "$T/fail"
bash "$W/ops/services/failure-notify/notify-failure.sh" zz-unit.service user >/dev/null 2>&1; rc=$?
check "back: exit 0" "$rc" 0
check "back: delivered once" "$(wc -l <"$T/delivered.log")" 1
check "back: stamp armed" "$([ -f "$T/state/zz-unit.service.stamp" ] && echo yes || echo no)" yes

# 3: third failure inside the window is suppressed and counted
bash "$W/ops/services/failure-notify/notify-failure.sh" zz-unit.service user >/dev/null 2>&1; rc=$?
check "repeat: exit 0" "$rc" 0
check "repeat: still one delivery" "$(wc -l <"$T/delivered.log")" 1
check "repeat: suppressed count" "$(cut -d' ' -f2 "$T/state/zz-unit.service.stamp")" 1

# 4: fails once then succeeds within one run (retry path)
rm -f "$T/state/"*; : >"$T/calls.log"; : >"$T/delivered.log"
cat >"$T/ops/scripts/notify.sh" <<EOF
#!/bin/bash
n=\$(( \$(cat "$T/n" 2>/dev/null || echo 0) + 1 )); echo \$n > "$T/n"
[ "\$n" -lt 2 ] && exit 1
echo "\$*" >> "$T/delivered.log"
EOF
bash "$W/ops/services/failure-notify/notify-failure.sh" zz-unit.service user >/dev/null 2>&1; rc=$?
check "retry: exit 0" "$rc" 0
check "retry: delivered on attempt 2" "$(cat "$T/n")" 2
# 5: default window is 24 h; 3 failures in a row give 1 alert
rm -f "$T/state/"*; : >"$T/delivered.log"
printf '#!/bin/bash\necho "$*" >> "%s/delivered.log"\n' "$T" >"$T/ops/scripts/notify.sh"
for i in 1 2 3; do bash "$W/ops/services/failure-notify/notify-failure.sh" zz-unit.service user >/dev/null 2>&1; done
check "3 failures in a row: 1 alert" "$(wc -l <"$T/delivered.log")" 1
echo "$(( $(date +%s) - 20 * 3600 )) 0" >"$T/state/zz-unit.service.stamp"
bash "$W/ops/services/failure-notify/notify-failure.sh" zz-unit.service user >/dev/null 2>&1
check "20 h later: still quiet (24 h window)" "$(wc -l <"$T/delivered.log")" 1
rm -rf "$T"
echo "pass=$pass fail=$fail"
[ "$fail" = 0 ]
