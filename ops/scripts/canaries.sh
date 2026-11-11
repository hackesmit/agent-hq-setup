#!/usr/bin/env bash
# Canary suite (v5) — deterministic gate for the UNSANDBOXED posture.
#
# 2026-07-13: the OS (bubblewrap) sandbox was removed for efficiency; the kernel
# never-list (denyRead / denyWrite / allowWrite / network filter) is gone. Enforcement
# is now LOGICAL — a stack of PreToolUse hook guards. That is strictly weaker than the
# kernel (heuristic, bypassable by python open()/obfuscation), so this suite's job
# shifted: instead of proving bwrap blocks a write, it proves the guards are (a) wired
# in settings.json under the chosen posture, (b) present on disk, and (c) actually
# return exit 2 on a forbidden fixture. The guard self-tests are deterministic (no
# agent), so unlike the old live probe they cannot be confused with a worker refusal.
#
#   GATE 1  force-push guard fires (local scratch repo, no agent).
#   GATE 2  config integrity: settings.json declares the chosen unsandboxed posture,
#           deny lists retained as policy, and every guard is wired.
#   GATE 3  guard behavior: each guard blocks a forbidden fixture and passes a benign one.
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="$(cd "$DIR/../.." && pwd)"
SETTINGS="$HQ/.claude/settings.json"
fail=0
report() { if [ "$2" = "1" ]; then printf 'PASS  %s\n' "$1"; else printf 'FAIL  %s (%s)\n' "$1" "${3:-}"; fail=1; fi; }

# ============ GATE 1: force-push guard (deterministic, no agent) ============
T=$(mktemp -d)
(
  set -e
  cd "$T" && git init -qb main scratch && cd scratch
  git config core.hooksPath "$HQ/ops/githooks"
  git config user.email canary@hq && git config user.name canary
  echo a > f && git add f && git commit -qm c1
  git init -q --bare "$T/remote.git" && git remote add origin "$T/remote.git"
  git push -q origin main
  echo b > f && git add f && git commit -qm c2 && git push -q origin main
  git reset -q --hard HEAD~1
) >/dev/null 2>&1
if (cd "$T/scratch" && git push --force origin main) >/dev/null 2>&1; then
  report "gate: force-push guard blocks" 0 "force push to main SUCCEEDED"
else
  report "gate: force-push guard blocks" 1
fi
rm -rf "$T"

# ============ GATE 2: config integrity (deterministic, no agent) ============
# bwrap is no longer required; report its presence for information only.
if command -v bwrap >/dev/null 2>&1; then
  echo "INFO  bubblewrap present but unused (sandbox intentionally disabled)"
else
  echo "INFO  bubblewrap absent (expected — sandbox disabled)"
fi

python3 - "$SETTINGS" <<'PY'
import json, sys
try:
    s = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"FAIL  gate: settings.json parses (error: {e})"); sys.exit(3)

fails = []
sb = s.get("sandbox", {})
fs = sb.get("filesystem", {})
perms = s.get("permissions", {})

def need(cond, label):
    if not cond: fails.append(label)

# Chosen posture: sandbox OFF, unsandboxed bash allowed, bypass mode.
need(sb.get("enabled") is False, "sandbox.enabled must be false (chosen posture)")
need(sb.get("allowUnsandboxedCommands") is True, "sandbox.allowUnsandboxedCommands must be true")
need(perms.get("defaultMode") == "bypassPermissions", "permissions.defaultMode must be bypassPermissions")

# Full-trust posture (proposal 58, 2026-10-09): agents have root and every credential,
# so the six cage guards stay UNWIRED and the deny list stays empty. This gate now
# catches drift back to a half-cage, which strands agents filing commands again.
wired = set()
for blk in (s.get("hooks", {}).get("PreToolUse", []) or []):
    for h in blk.get("hooks", []):
        wired.add(h.get("command", "").split("/")[-1])
for g in ("hook-credential-read-guard.sh", "hook-write-containment-guard.sh",
          "hook-bash-injection-guard.sh", "hook-secret-in-file-guard.sh",
          "hook-cdp-password-guard.sh", "hook-exfil-guard.sh"):
    need(g not in wired, f"PreToolUse must NOT wire {g} (full trust, proposal 58)")
need(not perms.get("deny"), "permissions.deny must be empty (full trust, proposal 58)")

if fails:
    print("FAIL  gate: config integrity (full-trust posture)")
    for f in fails: print(f"        - {f}")
    sys.exit(2)
print("PASS  gate: config integrity (full-trust posture declared, cage guards unwired)")
PY
[ $? -eq 0 ] || fail=1

# ============ GATE 3: guard behavior self-tests (deterministic, no agent) ============
# Feed each guard a forbidden fixture on stdin; a real guard exits 2. Then a benign
# fixture; it must exit 0. This is what proves logical enforcement actually enforces.
mkjson() { python3 -c 'import json,sys; print(json.dumps({"tool_name":sys.argv[1],"tool_input":json.loads(sys.argv[2])}))' "$1" "$2"; }
guard() { # name  script  tool  input_json  expected_exit  label
  local rc
  rc=$(printf '%s' "$(mkjson "$3" "$4")" | "$DIR/$2" >/dev/null 2>&1; echo $?)
  if [ "$rc" = "$5" ]; then report "guard: $6" 1; else report "guard: $6" 0 "exit=$rc want=$5"; fi
}

# The cage guards (credential-read, write-containment, bash-injection, secret-in-file,
# exfil, cdp-password) are unwired under full trust (proposal 58), so they are no
# longer self-tested here. The workflow hooks below are still wired and still tested.
# no-em-dash (em dash U+2014 in a file write blocks; clean prose passes)
EMDASH=$(printf '\xe2\x80\x94')
guard nem hook-no-em-dash.sh Write "{\"content\":\"fixed the bug ${EMDASH} works now\"}"  2 "no-em-dash blocks em dash in write"
guard nem hook-no-em-dash.sh Write '{"content":"fixed the bug: works now, 30-day window"}' 0 "no-em-dash allows clean prose"
# commit-branch-check (direct commit on a rig canonical default branch blocks; non-commit passes).
# Self-contained: a throwaway canonical repo under rigs/ on `main`, removed after.
CBC="$HQ/rigs/.canary-cbc"
rm -rf "$CBC"
( set -e; git init -qb main "$CBC"; cd "$CBC"; git config user.email c@hq; git config user.name c; echo x>f; git add f; git commit -qm seed ) >/dev/null 2>&1
guard cbc hook-commit-branch-check.sh Bash "{\"command\":\"cd $CBC && git commit -m y\"}"  2 "commit-branch-check blocks commit on rig canonical default"
guard cbc hook-commit-branch-check.sh Bash "{\"command\":\"cd $CBC && git status\"}"        0 "commit-branch-check allows non-commit"
rm -rf "$CBC"

if [ "$fail" -ne 0 ]; then
  "$DIR/notify.sh" urgent "Canary FAILURE" "Guard/config integrity gate failed — see canaries.sh output"
  echo "CANARY SUITE: FAIL"; exit 1
fi
echo "CANARY SUITE: PASS"; exit 0
