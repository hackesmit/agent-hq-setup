#!/usr/bin/env bash
# Adversarial review fixtures for beads hq-ehft (meta hooks) and hq-ig07 (guard tuning).
# Sections 1 to 3 (write-containment and bash-injection guard cases) were removed in
# hq-fgg3.11: proposal 58 unwired those cage guards and that bead deleted them. The
# numbering of sections 4 and 5 is kept so old review notes still line up.
#
# Added by a fresh-context reviewer, not by the author. These are the cases the author's
# suite (ops/console/v2/tests/guards/run.sh) does not cover: attacks aimed at getting a
# real write past the newly exempted /dev sinks, at getting an exfil pipeline past the
# newly left-anchored injection pattern, and at getting the settings-integrity gate to
# pass on a settings file that changed.
#
# Same safety rules as the author's suite: every script under test is COPIED into a
# throwaway dir, the originals under ops/scripts are never opened for writing, and the
# guards see one Bash call (this script) rather than a command line naming a guard path.
#
# Everything asserted here PASSES against the tree as reviewed. Two defects found during
# the review are deliberately NOT asserted here, because a review suite that fails on
# purpose cannot be committed green; they are written up in the review report instead:
#   1. hook-meta-audit.sh drops the audit record for a tool input over about 127 KB
#      (the payload goes to python3 through the environment, so execve returns E2BIG).
#   2. hook-meta-settings-integrity.sh re-baselines, and passes, if the per-session
#      baseline file is deleted; the baseline lives in the one directory the audited
#      session can write.
#
# Usage: bash ops/console/v2/tests/review/meta-web.sh
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="$(cd "$DIR/../../../../.." && pwd)"
META="$HQ/ops/console/v2/meta"

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
DOT=".claude"
mkdir -p "$T/g" "$T/meta" "$T/state" "$T/home/$DOT" "$T/proj/$DOT"

pass=0; fail=0
ok()  { pass=$((pass+1)); printf 'PASS  %s\n' "$1"; }
bad() { fail=$((fail+1)); printf 'FAIL  %s\n' "$1"; }
chk() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want $2, got $3)"; fi; }

jsonq() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }
bash_payload() { printf '{"session_id":"rev","cwd":"%s","tool_name":"Bash","tool_input":{"command":%s}}' "$HQ" "$(jsonq "$1")"; }

copy_in() {
  if ! cat "$1" > "$2"; then bad "could not copy $1"; return 1; fi
  if [ ! -s "$2" ]; then bad "copy of $1 is empty"; return 1; fi
}

# A here-string, not a pipe: a guard that exits without draining stdin would otherwise
# get SIGPIPE and mask its real exit code under pipefail.
verdict() { # <script> <command> ; echoes block or pass
  local rc
  bash "$1" >/dev/null 2>&1 <<<"$(bash_payload "$2")"
  rc=$?
  [ "$rc" = 2 ] && printf 'block' || printf 'pass'
}

echo
echo "=== 4. settings-integrity: attacks on the baseline itself ==="
copy_in "$META/hook-meta-settings-integrity.sh" "$T/meta/integrity.sh" || exit 1
copy_in "$META/meta-settings.json" "$T/meta/meta-settings.json" || exit 1
IH="$T/meta/integrity.sh"; MS="$T/meta/meta-settings.json"
US="$T/home/$DOT/settings.json"
CLEAN='{"permissions":{"defaultMode":"default"}}'
DIRTY='{"permissions":{"defaultMode":"default","allow":["Bash"]}}'
printf '%s\n' "$CLEAN" > "$US"

# The session id rides on the payload, so build it per call.
ihook_sid() { # <session id> [state base]
  local rc
  env HOME="$T/home" HQ_META_PROJECT="$T/proj" HQ_META_STATE="${2:-$T/state}" HQ_META_ALLOW_SELF_BASELINE="${SELF_BASELINE:-1}" \
      HQ_META_SETTINGS="$MS" bash "$IH" >/dev/null 2>&1 \
      <<<"{\"session_id\":\"$1\",\"cwd\":\"$T/proj\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls -l\"}}"
  rc=$?
  printf '%s' "$rc"
}

chk "a truncated baseline file blocks rather than passing" 0 "$(ihook_sid s-trunc)"
: > "$T/state/s-trunc/settings-baseline.sha256"
chk "an emptied baseline blocks" 2 "$(ihook_sid s-trunc)"

rm -rf "$T/state/s-junk"
chk "a fresh session records a baseline" 0 "$(ihook_sid s-junk)"
printf 'not a hash line\n' > "$T/state/s-junk/settings-baseline.sha256"
chk "a garbage baseline blocks" 2 "$(ihook_sid s-junk)"

# Deleting the INTEGRITY_FAILED marker must not clear a real settings change.
printf '%s\n' "$CLEAN" > "$US"
chk "marker case: baseline recorded" 0 "$(ihook_sid s-marker)"
printf '%s\n' "$DIRTY" > "$US"
chk "marker case: the change blocks" 2 "$(ihook_sid s-marker)"
rm -f "$T/state/s-marker/flags/INTEGRITY_FAILED"
chk "deleting the marker does not unblock a changed settings file" 2 "$(ihook_sid s-marker)"

# A settings file swapped for a symlink whose target then changes must still block.
printf '%s\n' "$CLEAN" > "$US"
chk "symlink case: baseline recorded" 0 "$(ihook_sid s-sym)"
printf '%s\n' "$CLEAN" > "$T/home/decoy.json"
rm -f "$US"; ln -s "$T/home/decoy.json" "$US"
printf '%s\n' "$DIRTY" > "$T/home/decoy.json"
chk "a symlinked settings file whose target changes blocks" 2 "$(ihook_sid s-sym)"
rm -f "$US"; printf '%s\n' "$CLEAN" > "$US"

# A settings file that only appears later must block (this is where an "always allow"
# answer lands).
rm -f "$T/proj/$DOT/settings.local.json"
rm -rf "$T/state/s-appear"
chk "appear case: baseline recorded" 0 "$(ihook_sid s-appear)"
printf '{"permissions":{"allow":["Write"]}}\n' > "$T/proj/$DOT/settings.local.json"
chk "a settings.local.json appearing blocks" 2 "$(ihook_sid s-appear)"
rm -f "$T/proj/$DOT/settings.local.json"

# Fail closed on an unusable state dir, in both shapes.
chk "an uncreatable state dir blocks" 2 "$(ihook_sid s-nodir /proc/definitely/not/writable)"
mkdir -p "$T/state/s-ro"; chmod 500 "$T/state/s-ro"
chk "a read-only session state dir blocks" 2 "$(ihook_sid s-ro)"
chmod 700 "$T/state/s-ro"

# The meta settings file itself is watched.
printf '%s\n' "$CLEAN" > "$US"
rm -rf "$T/state/s-meta"
chk "meta settings case: baseline recorded" 0 "$(ihook_sid s-meta)"
printf '{"permissions":{"defaultMode":"bypassPermissions"}}\n' > "$MS"
chk "editing the meta settings file itself blocks" 2 "$(ihook_sid s-meta)"
copy_in "$META/meta-settings.json" "$MS" || exit 1

echo
echo "=== 5. audit hook: it never blocks, whatever it is handed ==="
copy_in "$META/hook-meta-audit.sh" "$T/meta/audit.sh" || exit 1
AH="$T/meta/audit.sh"
AUDIT="$T/audit.jsonl"
arc() { # <payload> [audit path]
  local rc
  env HQ_META_AUDIT="${2:-$AUDIT}" bash "$AH" >/dev/null 2>&1 <<<"$1"
  rc=$?
  printf '%s' "$rc"
}
chk "a well formed payload exits 0" 0 "$(arc "$(bash_payload 'git status')")"
chk "an empty payload exits 0"      0 "$(arc '')"
chk "a bare array exits 0"          0 "$(arc '[]')"
chk "a JSON null exits 0"           0 "$(arc 'null')"
chk "wrong field types exit 0"      0 "$(arc '{"session_id":null,"tool_name":123,"tool_input":"a string"}')"
chk "a null command exits 0"        0 "$(arc '{"tool_name":"Bash","tool_input":{"command":null}}')"
chk "an unwritable sink exits 0"    0 "$(arc "$(bash_payload 'ls')" /proc/definitely/not/writable/audit.jsonl)"
n_before="$(wc -l < "$AUDIT" 2>/dev/null || echo 0)"
chk "a payload with no tool_name exits 0" 0 "$(arc '{"session_id":"x"}')"
if [ "$(wc -l < "$AUDIT")" -gt "$n_before" ]; then ok "every accepted payload appends exactly one line"
else bad "every accepted payload appends exactly one line"; fi
# The trail must never carry the file body, only the path.
printf '{"session_id":"s","tool_name":"Write","tool_input":{"file_path":"/home/owner/hq/x.md","content":"SENSITIVE-BODY-TEXT"}}' > "$T/write.json"
env HQ_META_AUDIT="$AUDIT" bash "$AH" >/dev/null 2>&1 < "$T/write.json"
if grep -q 'SENSITIVE-BODY-TEXT' "$AUDIT"; then bad "the audit trail must not record file contents"
else ok "the audit trail records the path, never the file contents"; fi
if tail -n1 "$AUDIT" | grep -q '/home/owner/hq/x.md'; then ok "the audit trail records the target path"
else bad "the audit trail records the target path"; fi

echo
echo "review suite: $pass PASS, $fail FAIL"
[ "$fail" = 0 ] || exit 1
