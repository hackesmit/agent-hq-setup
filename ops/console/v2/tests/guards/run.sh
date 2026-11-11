#!/usr/bin/env bash
# Fixture suite for the console v2 meta-terminal hooks (bead hq-ehft).
# Its former sections 3 and 4 tested the proposal 21 tunings of the write-containment
# and bash-injection cage guards (bead hq-ig07). Proposal 58 unwired those guards and
# hq-fgg3.11 deleted them, so their cases and patch files were removed with them.
#
# How it works:
#   * Every script under test is COPIED into a throwaway dir first. The originals are
#     never touched or opened for writing.
#   * Each case feeds one synthetic PreToolUse/PostToolUse payload on stdin and
#     asserts the exit code (2 = block, 0 = pass) and, where it matters, the side
#     effects (audit line, baseline file, INTEGRITY_FAILED marker).
#
# Usage: bash ops/console/v2/tests/guards/run.sh
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="$(cd "$DIR/../../../../.." && pwd)"
META="$HQ/ops/console/v2/meta"

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/ops/scripts" "$T/home/.claude" "$T/proj/.claude" "$T/meta" "$T/state"

pass=0; fail=0
ok()   { pass=$((pass+1)); printf 'PASS  %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf 'FAIL  %s\n' "$1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want $2, got $3)"; fi; }

jsonq() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

# One synthetic payload. $1 tool, $2 the field value, $3 session id.
payload_bash()  { printf '{"session_id":"%s","cwd":"%s","tool_name":"Bash","tool_input":{"command":%s}}' "$3" "$T/proj" "$(jsonq "$2")"; }
payload_write() { printf '{"session_id":"%s","cwd":"%s","tool_name":"%s","tool_input":{"file_path":%s}}' "$3" "$T/proj" "$1" "$(jsonq "$2")"; }
payload_fetch() { printf '{"session_id":"%s","cwd":"%s","tool_name":"WebFetch","tool_input":{"url":%s}}' "$3" "$T/proj" "$(jsonq "$2")"; }
payload_read()  { printf '{"session_id":"%s","cwd":"%s","tool_name":"Read","tool_input":{"file_path":%s}}' "$3" "$T/proj" "$(jsonq "$2")"; }

copy_in() { # <src> <dst> ; copy a script under test, fail loudly if it is empty
  if ! cat "$1" > "$2"; then bad "could not copy $1"; return 1; fi
  if [ ! -s "$2" ]; then bad "copy of $1 is empty"; return 1; fi
}

# A here-string, not a pipe: a script that exits without reading stdin would give the
# writing end SIGPIPE and mask the real exit code under pipefail.
run_hook() { # <script> <payload> ; echoes the exit code
  local rc
  bash "$1" >/dev/null 2>&1 <<<"$2"
  rc=$?
  printf '%s' "$rc"
}

verdict() { [ "$1" = 2 ] && printf 'block' || printf 'pass'; }

echo "=== 0. syntax ==="
for s in "$META/hook-meta-audit.sh" "$META/hook-meta-settings-integrity.sh"; do
  if bash -n "$s"; then ok "bash -n $(basename "$s")"; else bad "bash -n $(basename "$s")"; fi
done
if python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$META/meta-settings.json"; then
  ok "meta-settings.json parses as JSON"
else
  bad "meta-settings.json parses as JSON"
fi
# The whole point of the meta settings file: no allow rule may pre-approve a mutating
# tool, and the permission mode must be the prompting one.
python3 - "$META/meta-settings.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
p = s.get("permissions", {})
bad = [r for r in (p.get("allow") or [])
       if r.split("(")[0] in ("Bash", "Write", "Edit", "MultiEdit", "NotebookEdit")]
pre = (s.get("hooks") or {}).get("PreToolUse")
sys.exit(0 if p.get("defaultMode") == "bypassPermissions" and not pre else 1)
PY
if [ $? = 0 ]; then ok "meta-settings: bypassPermissions, no blocking PreToolUse hook (full trust)"
else bad "meta-settings: bypassPermissions, no blocking PreToolUse hook (full trust)"; fi

echo
echo "=== 1. hook-meta-audit.sh (log only, never blocks) ==="
AUDIT="$T/audit.jsonl"
export HQ_META_AUDIT="$AUDIT"
AH="$T/meta/hook-meta-audit.sh"
copy_in "$META/hook-meta-audit.sh" "$AH"

rc="$(run_hook "$AH" "$(payload_write Write "$T/proj/notes.md" s-audit)")"
check "audit: Write payload exits 0" 0 "$rc"
got="$(tail -n1 "$AUDIT" | jq -r '.tool + " " + .target + " " + .session_id')"
check "audit: Write logs tool, file_path, session" "Write $T/proj/notes.md s-audit" "$got"
if tail -n1 "$AUDIT" | jq -e 'has("ts") and (.ts|test("^[0-9]{4}-"))' >/dev/null; then
  ok "audit: line carries a ts"
else bad "audit: line carries a ts"; fi

LONG="git log --oneline --decorate --graph $(python3 -c 'print("x"*400)')"
rc="$(run_hook "$AH" "$(payload_bash Bash "$LONG" s-audit)")"
check "audit: Bash payload exits 0" 0 "$rc"
len="$(tail -n1 "$AUDIT" | jq -r '.target' | awk '{print length($0)}')"
check "audit: Bash target truncated to 120 chars" 120 "$len"

rc="$(run_hook "$AH" "$(payload_fetch WebFetch "https://example.com/x" s-audit)")"
got="$(tail -n1 "$AUDIT" | jq -r '.target')"
check "audit: WebFetch logs the url" "https://example.com/x" "$got"
check "audit: WebFetch exits 0" 0 "$rc"

rc="$(run_hook "$AH" "$(payload_read Read "$T/proj/secret.txt" s-audit)")"
got="$(tail -n1 "$AUDIT" | jq -r '.target')"
check "audit: other tools log an empty target" "" "$got"
check "audit: other tools exit 0" 0 "$rc"

before="$(wc -l < "$AUDIT")"
rc="$(run_hook "$AH" 'not json at all')"
check "audit: malformed payload exits 0" 0 "$rc"
check "audit: malformed payload writes nothing" "$before" "$(wc -l < "$AUDIT")"

rc="$(HQ_META_AUDIT=/proc/definitely/not/writable/audit.jsonl run_hook "$AH" "$(payload_write Write /x s-audit)")"
check "audit: unwritable sink still exits 0 (fail open)" 0 "$rc"
export HQ_META_AUDIT="$AUDIT"

echo
echo "=== 2. hook-meta-settings-integrity.sh (synchronous, fails closed) ==="
IH="$T/meta/hook-meta-settings-integrity.sh"
copy_in "$META/hook-meta-settings-integrity.sh" "$IH"
MS="$T/meta/meta-settings.json"
copy_in "$META/meta-settings.json" "$MS"
USER_SETTINGS="$T/home/.claude/settings.json"
printf '{"permissions":{"defaultMode":"default"}}\n' > "$USER_SETTINGS"
ihook() { # <session id> [state base] ; run the integrity hook in a fake environment
  local rc
  env HOME="$T/home" HQ_META_PROJECT="$T/proj" HQ_META_STATE="${2:-$T/state}" HQ_META_ALLOW_SELF_BASELINE="${SELF_BASELINE:-1}" \
      HQ_META_SETTINGS="$MS" bash "$IH" >/dev/null 2>&1 <<<"$(payload_bash Bash 'ls -l' "$1")"
  rc=$?
  printf '%s' "$rc"
}

rc="$(ihook s1)"
check "integrity: first call records the baseline and passes" 0 "$rc"
# the runner writes the baseline before the session starts; a session that deletes it must be blocked
mkdir -p "$T/state/sdel"; rc="$(SELF_BASELINE=0 ihook sdel)"
check "integrity: missing baseline without the runner token blocks (fails closed)" 2 "$rc"
rc="$(ihook stok)"; rm -f "$T/state/stok/settings-baseline.sha256"; rc="$(SELF_BASELINE=0 ihook stok)"
check "integrity: baseline deleted after it was written blocks" 2 "$rc"
if [ -f "$T/state/s1/settings-baseline.sha256" ]; then ok "integrity: baseline file written under HQ_META_STATE"
else bad "integrity: baseline file written under HQ_META_STATE"; fi
n="$(wc -l < "$T/state/s1/settings-baseline.sha256")"
check "integrity: baseline covers all four watched files" 4 "$n"

rc="$(ihook s1)"
check "integrity: unchanged settings pass" 0 "$rc"
# the runner names the state dir: claude's own session id must not be where the hook looks
rc="$(HQ_META_SID=s1 SELF_BASELINE=0 ihook some-claude-uuid)"
check "integrity: HQ_META_SID picks the runner's session dir over the payload id" 0 "$rc"

printf '{"permissions":{"defaultMode":"default","allow":["Bash"]}}\n' > "$USER_SETTINGS"
rc="$(ihook s1)"
check "integrity: changed user settings block" 2 "$rc"
if [ -f "$T/state/s1/flags/INTEGRITY_FAILED" ] && grep -q "changed after session start" "$T/state/s1/flags/INTEGRITY_FAILED"; then
  ok "integrity: marker file written with the reason"
else bad "integrity: marker file written with the reason"; fi
rc="$(ihook s1)"
check "integrity: a failed session stays blocked" 2 "$rc"

printf '{"permissions":{"defaultMode":"default"}}\n' > "$USER_SETTINGS"
rc="$(ihook s2)"
check "integrity: a fresh session id starts clean" 0 "$rc"
printf '{"permissions":{"allow":["Write"]}}\n' > "$T/proj/.claude/settings.local.json"
rc="$(ihook s2)"
check "integrity: a settings.local.json appearing blocks" 2 "$rc"
if grep -q "appeared after session start" "$T/state/s2/flags/INTEGRITY_FAILED"; then
  ok "integrity: marker names the file that appeared"
else bad "integrity: marker names the file that appeared"; fi
rm -f "$T/proj/.claude/settings.local.json"

mv "$MS" "$MS.away"
rc="$(ihook s3)"
check "integrity: missing meta settings blocks" 2 "$rc"
mv "$MS.away" "$MS"

rc="$(ihook s4 /proc/definitely/not/writable)"
check "integrity: an unusable state dir blocks (fails closed)" 2 "$rc"

# Speed: this hook is on every mutating call, so it has to be cheap. Measured as the
# hook's own cost, i.e. best-of-7 minus the same harness running an empty script, so
# the number is not dominated by process startup on a slow box.
printf 'exit 0\n' > "$T/meta/noop.sh"
time_min() { # <script> ; fastest of 7 wall-clock runs, in ms
  local best=999999 s e ms _
  for _ in 1 2 3 4 5 6 7; do
    s=$(date +%s%N)
    env HOME="$T/home" HQ_META_PROJECT="$T/proj" HQ_META_STATE="$T/state" \
        HQ_META_SETTINGS="$MS" bash "$1" >/dev/null 2>&1 <<<"$(payload_bash Bash 'ls -l' s-speed)"
    e=$(date +%s%N)
    ms=$(( (e - s) / 1000000 ))
    [ "$ms" -lt "$best" ] && best=$ms
  done
  printf '%s' "$best"
}
overhead="$(time_min "$T/meta/noop.sh")"
total="$(time_min "$IH")"
own=$(( total - overhead ))
[ "$own" -lt 0 ] && own=0
if [ "$own" -lt 50 ]; then ok "integrity: hook cost ${own} ms (${total} ms total, ${overhead} ms harness), budget 50 ms"
else bad "integrity: hook cost ${own} ms (${total} ms total, ${overhead} ms harness), budget 50 ms"; fi

echo
echo "guards suite: $pass PASS, $fail FAIL"
[ "$fail" = 0 ] || exit 1
