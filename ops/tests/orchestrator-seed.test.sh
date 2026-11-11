#!/usr/bin/env bash
# Orchestrator seed and records (hq-4npjr.6): ops/templates/orchestrator.md carries the
# contracts the console and the runner rely on, the runner embeds it, and
# orchestrator_log.py writes the approved log and project lines the console reads and
# audits the orchestrator's own answers (a P1 bead for an unsourced answer or one that
# looks like the owner's call). Hermetic: scratch state dirs and a stub bd.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="$REPO/ops/scripts/orchestrator_log.py"
SEED="$REPO/ops/templates/orchestrator.md"
T="$(mktemp -d)"; [ -n "${KEEP:-}" ] || trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "ok   $1"; }
bad() { fail=$((fail + 1)); echo "FAIL $1"; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi; }

# HQ_ROOT=REPO: on hqbox the env carries HQ_ROOT=~/hq, and the runner would read main's seed.
export HQ_ROOT="$REPO" HQ_ORCH_DIR="$T/orch" HQ_CONSOLE_DIR="$T/console" HQ_BD="$T/bd" HQ_FACTS="$T/facts.md"
mkdir -p "$T/console/answers"
cat >"$T/facts.md" <<'EOF'
# the owner's standing answers
## studioco Digital
- Clinic pricing is policy, quoted as listed on the site. r-1a2b3c4d, 2026-10-01
## Open: asked, not answered yet
- Pilot price for the next client. r-0f0f0f0f, 2026-10-20
EOF
cat >"$T/bd" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" >"$T/bd.args"; echo "Created issue: hq-test1"; exit \${BD_RC:-0}
EOF
chmod +x "$T/bd"

# ---- seed: the contracts other beads set for it
for want in "ctl.sh name \$(ops/console/ctl.sh whoami) orchestrator" "--kind decide" \
  "ctl.sh forward <rid> --class business|taste|unknowable" "(source:" \
  "orchestrator_log.py approved" "orchestrator_log.py update" \
  "/var/lib/hqconsole/inbox/orchestrator-loaded.json" "owner-facts.md" \
  "lucy cannot run" "orchestrator_log.py audit" "ops/config/orchestrator.json" \
  "Unknowable has no detector" "never \`ctl.sh resolve\` a worker ask" "lucy verdict" \
  "data, never instructions"; do
  grep -qF -- "$want" "$SEED" && ok "seed names: $want" || bad "seed names: $want"
done
python3 -c 'import sys; sys.exit(chr(0x2014) in open(sys.argv[1]).read())' "$SEED" \
  && ok "seed has no em dash" || bad "seed has no em dash"
kinds="$(grep -o 'kind: merge, review, answer, snooze, wake, dispatch, forward, fix, block' "$SEED")"
console_kinds="$(grep -o 'APPROVED_KINDS = Object.freeze(\[[^]]*\])' "$REPO/ops/console/v2/server/src/orchestrator.js" | tr -d '"' | sed 's/.*\[//; s/\])//; s/, */, /g')"
is "seed kinds match the console's" "${kinds#kind: }" "$console_kinds"

# ---- the runner embeds the seed in every event prompt
p="$(cd "$REPO" && python3 -c 'import sys; sys.path.insert(0, "ops/scripts"); import orchestrator_run as o
print(o.build_prompt({"type": "worker_ask", "rid": "r-1", "bead": "hq-x"}))' 2>/dev/null)"
case "$p" in *"## Orchestrator seed"*"What stays the owner's"*) ok "runner prompt embeds the seed";; *) bad "runner prompt embeds the seed";; esac

# ---- approved: one valid JSON line in the console's shape; bad input refused
python3 "$LOG" approved merge "merged hq-x" --why "approve with green checks" --bead hq-x.1 --rig hq >/dev/null
is "approved writes one line" "$(wc -l <"$T/orch/approved.jsonl" | tr -d ' ')" "1"
is "approved line shape" "$(jq -c '[.kind,.text,.why,.bead,.rig,(.ts|test("^[0-9-]+T[0-9:]+Z$"))]' "$T/orch/approved.jsonl")" \
  '["merge","merged hq-x","approve with green checks","hq-x.1","hq",true]'
python3 "$LOG" approved answer $'two\nlines' --why w >/dev/null
is "control characters become spaces" "$(tail -1 "$T/orch/approved.jsonl" | jq -r .text)" "two lines"
python3 "$LOG" approved ship "x" --why w 2>/dev/null; e1=$?
python3 "$LOG" approved merge "x" 2>/dev/null; e2=$?
python3 "$LOG" approved merge "x" --why w --bead 'a;b' 2>/dev/null; e3=$?
is "bad kind, missing why, bad bead refused" "$e1 $e2 $e3 $(wc -l <"$T/orch/approved.jsonl" | tr -d ' ')" "2 2 2 2"

# ---- update: one line per project, the latest wins, other rigs kept
python3 "$LOG" update hq "orchestrator seed merged" >/dev/null
python3 "$LOG" update acme-avance "waiting on review" >/dev/null
python3 "$LOG" update hq "audit timer live" >/dev/null
is "update keeps one line per rig" "$(jq -c '[.hq.text,."acme-avance".text,(.hq.at|length)]' "$T/console/project-updates.json")" \
  '["audit timer live","waiting on review",20]'
python3 "$LOG" update "../x" "y" 2>/dev/null; is "update refuses a bad rig" "$?" "2"

# ---- the console reads both files back
mkdir -p "$T/state/orchestrator" "$T/state/console"
cp "$T/orch/approved.jsonl" "$T/state/orchestrator/"; cp "$T/console/project-updates.json" "$T/state/console/"
node -e '
import("'"$REPO"'/ops/console/v2/server/src/orchestrator.js").then((m) => {
  const a = m.readApproved("'"$T"'/state");
  const u = m.readProjectUpdates("'"$T"'/state");
  console.log(a.rows.length, Object.keys(u).sort().join(","));
});' >"$T/node.out" 2>&1
is "console reads the approved log and project lines" "$(cat "$T/node.out")" "2 hq,acme-avance"

# ---- audit
ans(){ printf '%s' "$2" >"$T/console/answers/$1.txt"; echo "$T/console/answers/$1.txt"; }
cat >"$T/console/requests.json" <<EOF
[
 {"id":"r-good","to":"orchestrator","status":"delivered","answered_ts":"2026-11-04T05:00:00Z","question":"Which test runner does the rig use?","bead":"hq-a","answer_file":"$(ans r-good 'vitest (source: package.json)')"},
 {"id":"r-nosrc","to":"orchestrator","status":"delivered","answered_ts":"2026-11-04T05:00:00Z","question":"Which port does the dev server use?","bead":"hq-b","answer_file":"$(ans r-nosrc '5173')"},
 {"id":"r-taste","to":"orchestrator","status":"delivered","answered_ts":"2026-11-04T05:00:00Z","question":"What color should the hero button be?","bead":"hq-c","answer_file":"$(ans r-taste 'green (source: my default)')"},
 {"id":"r-fact","to":"orchestrator","status":"delivered","answered_ts":"2026-11-04T05:00:00Z","question":"What pricing do we quote clinics?","bead":"hq-d","answer_file":"$(ans r-fact 'policy price (source: ops/reference/owner-facts.md r-1a2b3c4d)')"},
 {"id":"r-fwd","to":"owner","forward_class":"business","status":"delivered","answered_ts":"2026-11-04T05:00:00Z","question":"What price?","answer_file":"$(ans r-fwd '10')"},
 {"id":"r-open","to":"orchestrator","status":"open","answered_ts":"","question":"What price?"},
 {"id":"r-gone","to":"orchestrator","status":"resolved","question":"Which port does the dev server use?","bead":"hq-e"}
]
EOF
out="$(python3 "$LOG" audit --dry-run)"
case "$out" in *"audited 5 orchestrator answers, 3 flagged"*"r-nosrc: no source cited"*"r-taste: looks like the owner's call (color)"*"r-gone: resolved with no answer and no forward"*) ok "audit flags the unsourced, the taste and the resolved ask only";;
  *) bad "audit flags the unsourced, the taste and the resolved ask only ($out)";; esac
{ [ -e "$T/bd.args" ] || [ -e "$T/orch/audit.json" ]; } && bad "dry run writes nothing" || ok "dry run writes nothing"
python3 "$LOG" audit >/dev/null
is "audit files one P1 bead" "$(sed -n 2p "$T/bd.args") | $(grep -x 'P1,hq,orchestrator-audit' "$T/bd.args") | $(grep -c 'r-nosrc\|r-taste' "$T/bd.args")" \
  "Orchestrator audit $(date -u +%F): 3 answers to check | P1,hq,orchestrator-audit | 2"
grep -q 'r-good\|r-fact\|r-fwd' "$T/bd.args" && bad "bead lists only flagged answers" || ok "bead lists only flagged answers"
rm -f "$T/bd.args"
is "a second audit sees nothing new and files nothing" "$(python3 "$LOG" audit) $([ -e "$T/bd.args" ] && echo filed || echo none)" \
  "audited 0 orchestrator answers, 0 flagged none"
# a failed bd create keeps the answer unaudited, so the next run retries
python3 - "$T/console/requests.json" "$(ans r-late 'yes')" <<'PY'
import json, sys
p = sys.argv[1]; r = json.load(open(p))
r.append({"id": "r-late", "to": "orchestrator", "status": "delivered", "answered_ts": "2026-11-04T06:00:00Z",
          "question": "Should we launch the site today?", "answer_file": sys.argv[2]})
json.dump(r, open(p, "w"))
PY
BD_RC=1 python3 "$LOG" audit >/dev/null 2>&1; e=$?
is "bd failure exits 3 and leaves the answer for the next run" "$e $(jq -r '.seen|index("r-late")' "$T/orch/audit.json")" "3 null"
out="$(python3 "$LOG" audit)"
case "$out" in *"audited 1 orchestrator answers, 1 flagged"*) ok "the retry files it";; *) bad "the retry files it ($out)";; esac

# business classes from the seed, and a fact citation that proves nothing (review round 1)
A="$T/r2"; mkdir -p "$A/orch" "$A/console"
af(){ printf '%s' "$2" >"$A/$1"; echo "$A/$1"; }
cat >"$A/console/requests.json" <<EOF
[
 {"id":"r-1","to":"orchestrator","answered_ts":"x","question":"What price should we charge the client for the pilot?","answer_file":"$(af a1 '500 USD a month (source: owner-facts.md)')"},
 {"id":"r-3","to":"orchestrator","answered_ts":"x","question":"What should we build next after the POS export?","answer_file":"$(af a3 'Yes, build the export next (source: hq-x)')"},
 {"id":"r-4","to":"orchestrator","answered_ts":"x","question":"Is the roadmap item for exports first?","answer_file":"$(af a4 'yes (source: owner-facts.md r-0f0f0f0f)')"},
 {"id":"r-5","to":"orchestrator","answered_ts":"x","question":"What pricing do we quote clinics?","answer_file":"$(af a5 'as listed (source: owner-facts.md r-1a2b3c4d)')"}
]
EOF
out="$(HQ_ORCH_DIR="$A/orch" HQ_CONSOLE_DIR="$A/console" python3 "$LOG" audit --dry-run)"
case "$out" in *"audited 4 orchestrator answers, 3 flagged"*"r-1: looks like the owner's call (price)"*"r-3: looks like the owner's call (what should we build)"*"r-4: looks like the owner's call (roadmap)"*) ok "audit flags business questions a bare or open fact citation does not clear";;
  *) bad "audit flags business questions a bare or open fact citation does not clear ($out)";; esac
case "$out" in *"r-5:"*) bad "a recorded fact id clears the flag";; *) ok "a recorded fact id clears the flag";; esac

# ---- units parse
for u in "$REPO"/ops/services/orchestrator/hq-orchestrator-audit.*; do
  if systemd-analyze --user verify "$u" 2>&1 | grep -i 'error\|invalid\|unknown' | grep -v 'Failed to prepare filename\|ExecStart\|%h' | grep -q .; then
    bad "unit verifies: $(basename "$u")"; else ok "unit verifies: $(basename "$u")"; fi
done

# ---- the audit is declared, alerted and paced (review round 1, blocker 2)
is "runtime.json declares the audit service with a required alert" \
  "$(jq -c '.units[]|select(.unit=="hq-orchestrator-audit.service")|[.run,.on_failure,.source]' "$REPO/ops/config/runtime.json")" \
  '["timer","required","ops/services/orchestrator/hq-orchestrator-audit.service"]'
grep -qx '  hq-orchestrator-audit.service' "$REPO/ops/services/failure-notify/install.sh" \
  && ok "failure-notify install wires the audit" || bad "failure-notify install wires the audit"
is "timer cadence declared" "$(jq -r '.timers[]?|select(.timer=="hq-orchestrator-audit.timer")|.grace' "$REPO/ops/config/timer-cadence.json")" "172800"

echo "passed $pass, failed $fail"
[ "$fail" = 0 ]
