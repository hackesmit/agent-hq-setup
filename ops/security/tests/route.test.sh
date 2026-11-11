#!/usr/bin/env bash
# route.sh + route.py (hq-8cry.5): real bd ledgers in a temp HQ (hq plus one
# own-ledger rig), fake notify and spawn that log their calls, fixture publish
# dates (offline). Covers each tier, the cooldown hold, the KEV bypass, kev
# null as unknown, grouping, a duplicate run, a lost state file, a new advisory
# and a tier escalation on a later day.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "ok   $1"; }
bad() { fail=$((fail + 1)); echo "FAIL $1"; }
eq()  { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (want '$1', got '$2')"; fi; }

command -v bd >/dev/null || { echo "FAIL bd not on PATH"; exit 1; }
H="$T/hq"; mkdir -p "$H/rigs/shop" "$H/state/security"
for d in "$H:hq" "$H/rigs/shop:sh"; do
  (cd "${d%%:*}" && git init -q && bd init --prefix "${d##*:}" -q >/dev/null 2>&1) || { echo "FAIL bd init ${d##*:}"; exit 1; }
done
cat >"$T/notify" <<EOF
#!/usr/bin/env bash
printf '%s|%s|%s\n' "\$1" "\$2" "\$3" >>"$T/notify.log"
EOF
cat >"$T/spawn" <<EOF
#!/usr/bin/env bash
printf '%s|%s\n' "\$1" "\$*" >>"$T/spawn.log"
# Register the session the way spawn.sh does, so the router's registry check sees it.
b=""; while [ \$# -gt 0 ]; do [ "\$1" = --bead ] && b="\$2"; shift; done
f="\$HQ/state/sessions.json"; [ -f "\$f" ] || echo '{}' >"\$f"
n="s-\$(date +%s%N | tail -c 7)"; jq --arg n "\$n" --arg b "\$b" '.[\$n] = {bead:\$b, status:"active"}' "\$f" >"\$f.tmp" && mv "\$f.tmp" "\$f"
echo "\$n"
EOF
chmod +x "$T/notify" "$T/spawn"; : >"$T/notify.log"; : >"$T/spawn.log"

cat >"$T/tiers.json" <<'EOF'
{"cooldown_days": 7, "sensitive_classes": ["money","auth","data","public","unknown"],
 "unknown_rig": {"ledger":"hq","classes":["unknown"],"live":true},
 "rigs": {"safe": {"ledger":"hq","classes":[]},
          "shop": {"ledger":"rig","classes":["money"]},
          "dead": {"ledger":"hq","classes":[],"live":false}}}
EOF
cat >"$T/published.json" <<'EOF'
{"npm/lodash@4.17.23":"2026-10-01","npm/young@1.0.1":"2026-10-25","npm/kevpkg@2.0.1":"2026-10-27",
 "npm/kevdead@1.0.1":"2026-01-01","npm/unknownkev@3.0.1":"2026-01-01"}
EOF
# f <id> <rig> <pkg> <installed> <fixed|null> <sev> <kev true|false|null> [malicious] [own_code]
f() { jq -nc --arg i "$1" --arg r "$2" --arg p "$3" --arg v "$4" --argjson x "$5" --arg s "$6" --argjson k "$7" \
  --argjson m "${8:-false}" --argjson o "${9:-false}" \
  '{id:$i, rig:$r, package:$p, ecosystem:"npm", installed:$v, fixed:$x, severity:$s, kev:$k, malicious:$m, own_code:$o, sources:["package-lock.json"]}'; }
findings() {  # findings <out> <kev_available> <finding json lines...>
  local out="$1" kev="$2"; shift 2
  printf '%s\n' "$@" | jq -s --argjson k "$kev" '{date:"t", summary:{scan_errors:0, kev_available:$k}, findings:.}' >"$out"
}
DAY1=(
  "$(f GHSA-lo-1 safe lodash 4.17.20 '"4.17.21"' HIGH false)"
  "$(f GHSA-lo-2 safe lodash 4.17.20 '"4.17.23"' MEDIUM false)"
  "$(f GHSA-lo-2 safe lodash 4.17.20 '"4.17.23"' MEDIUM false)"
  "$(f GHSA-yo-1 safe young 1.0.0 '"1.0.1"' LOW false)"
  "$(f GHSA-mi-1 safe minor 1.0.0 '"1.1.0"' HIGH false)"
  "$(f GHSA-nx-1 shop next 14.2.5 '"14.2.10"' CRITICAL false)"
  "$(f MAL-2099-1 shop evil 1.0.0 null UNKNOWN false true)"
  "$(f GHSA-kv-1 safe kevpkg 2.0.0 '"2.0.1"' HIGH true)"
  "$(f GHSA-kd-1 dead kevdead 1.0.0 '"1.0.1"' HIGH true)"
  "$(f GHSA-uk-1 safe unknownkev 3.0.0 '"3.0.1"' MEDIUM null)"
  "$(f GHSA-nd-1 safe nodate 1.0.0 '"1.0.1"' LOW false)"
  "$(f HQ-OWN-1 safe ops-script 0 null HIGH false false true)"
)
findings "$T/day1.json" true "${DAY1[@]}"

run() { HQ="$H" BD=bd NOTIFY="$T/notify" SPAWN="$T/spawn" HQ_SEC_PUBLISHED="$T/published.json" \
  bash "$REPO/ops/security/route.sh" --config "$T/tiers.json" --offline "$@"; }
beads() { (cd "$1" && bd list --all -n 0 --json 2>/dev/null) | jq -c '[.[] | select((.external_ref // "") | startswith("secwatch:"))]'; }
bead() {  # bead <dir> <key> <jq field expr>
  beads "$1" | jq -r --arg k "secwatch:$2" ".[] | select(.external_ref==\$k) | $3"; }

# --- dry run touches nothing ---
out="$(run --findings "$T/day1.json" --date 2026-10-28 --dry-run)"; rc=$?
eq 0 "$rc" "dry run exits 0"
grep -q '^route: dry run: 10 new (2 A, 5 B, 3 C)' <<<"$out" && ok "dry run plans 10 beads (2 A, 5 B, 3 C)" || bad "dry run summary: $(head -1 <<<"$out")"
eq 0 "$(beads "$H" | jq length)" "dry run files nothing"
[ -e "$H/state/security/routed.json" ] && bad "dry run wrote state" || ok "dry run writes no state"

# --- day 1 ---
out="$(run --findings "$T/day1.json" --date 2026-10-28 2>&1)"; rc=$?
eq 0 "$rc" "day 1 exits 0"
eq 8 "$(beads "$H" | jq length)" "eight beads in the hq ledger"
eq 2 "$(beads "$H/rigs/shop" | jq length)" "the money rig's two beads are in its own ledger"
eq 0 "$(beads "$H" | jq '[.[]|select(.external_ref|test("^secwatch:shop/"))]|length')" "no shop bead leaked into hq"

# tier A: grouped, highest fix, dispatched once with a Sonnet worker
eq 1 "$(beads "$H" | jq '[.[]|select(.title|test(" lodash "))]|length')" "two lodash advisories and a repeated one make one bead"
eq "Security: safe lodash 4.17.20 to 4.17.23 (HIGH, tier A)" "$(bead "$H" safe/npm/lodash@4.17.20 .title)" "tier A targets the highest fixed version"
eq "P1,dispatched,safe,security,secwatch,tier-a" "$(bead "$H" safe/npm/lodash@4.17.20 '.labels|sort|join(",")')" "tier A labels, no redteam, dispatched marked in the ledger"
lo="$(bead "$H" safe/npm/lodash@4.17.20 .id)"
eq 1 "$(grep -c "^safe|.*--bead $lo" "$T/spawn.log")" "tier A dispatched to a worker on its rig"
grep -q -- "--model claude-sonnet-5-5" "$T/spawn.log" && grep -q "finish.sh" "$T/spawn.log" && grep -q "Opus 5.5 reviewer" "$T/spawn.log" \
  && ok "dispatch task carries the Opus review and finish.sh" || bad "dispatch task: $(cat "$T/spawn.log")"
bead "$H" safe/npm/lodash@4.17.20 .description | grep -q "GHSA-lo-1, GHSA-lo-2" && ok "bead lists every advisory" || bad "advisories missing"
bead "$H" safe/npm/lodash@4.17.20 .description | grep -q "^Definition of Done:" && ok "bead carries a DoD" || bad "no DoD"

# tier A held by the cooldown
eq tier-a "$(bead "$H" safe/npm/young@1.0.0 '.labels[]|select(startswith("tier"))')" "young fix is still tier A"
grep -q "young" "$T/spawn.log" && bad "young fix dispatched inside the cooldown" || ok "a fix published 3 days ago is held"
bead "$H" safe/npm/young@1.0.0 .description | grep -q "clears the cooldown on 2026-11-01" && ok "held bead names the date" || bad "hold date missing"

# tier B
for k in safe/npm/minor@1.0.0 safe/npm/unknownkev@3.0.0 safe/npm/nodate@1.0.0 dead/npm/kevdead@1.0.0; do
  eq tier-b "$(bead "$H" "$k" '.labels[]|select(startswith("tier"))')" "tier B: $k"
done
eq tier-b "$(bead "$H/rigs/shop" shop/npm/next@14.2.5 '.labels[]|select(startswith("tier"))')" "tier B: a patch bump on a money rig"
bead "$H/rigs/shop" shop/npm/next@14.2.5 .labels | grep -q redteam && ok "tier B is redteam" || bad "tier B without redteam"
bead "$H/rigs/shop" shop/npm/next@14.2.5 .description | grep -q "lucy" && ok "tier B DoD names lucy" || bad "tier B without lucy"
bead "$H" safe/npm/unknownkev@3.0.0 .description | grep -q "KEV unknown" && ok "kev null is reported as unknown" || bad "kev null wording"
eq "dead" "$(bead "$H" dead/npm/kevdead@1.0.0 '.labels[]|select(.=="dead")')" "hq ledger beads carry the rig label"

# tier C: P0, urgent, KEV bypass only for KEV
for k in safe/npm/kevpkg@2.0.0 safe/npm/ops-script@0; do
  eq 0 "$(bead "$H" "$k" .priority)" "tier C is P0: $k"
done
eq 0 "$(bead "$H/rigs/shop" shop/npm/evil@1.0.0 .priority)" "tier C: malicious on a live rig"
eq 3 "$(grep -c '^urgent|Security P0' "$T/notify.log")" "three urgent pages, one per tier C"
eq 0 "$(grep -vc '^urgent|' "$T/notify.log")" "no other notifications"
bead "$H" safe/npm/kevpkg@2.0.0 .description | grep -q "min-release-age=0" && ok "KEV fix may bypass the cooldown" || bad "KEV bypass missing"
bead "$H/rigs/shop" shop/npm/evil@1.0.0 .description | grep -q "min-release-age=0" && bad "malicious fix bypasses the cooldown" || ok "only KEV bypasses the cooldown"

# --- duplicate run: same findings, nothing new ---
: >"$T/spawn.log"; : >"$T/notify.log"
out="$(run --findings "$T/day1.json" --date 2026-10-28 2>&1)"; rc=$?
eq 0 "$rc" "duplicate run exits 0"
eq 10 "$(( $(beads "$H" | jq length) + $(beads "$H/rigs/shop" | jq length) ))" "duplicate run files nothing"
eq 0 "$(wc -l <"$T/spawn.log")" "duplicate run dispatches nothing"
eq 0 "$(wc -l <"$T/notify.log")" "duplicate run pages nobody"
grep -q "10 already routed" <<<"$out" && ok "duplicates counted" || bad "duplicate summary: $out"

# --- lost state: the ledgers' secwatch refs stop a refile ---
mv "$H/state/security/routed.json" "$T/routed.bak"
out="$(run --findings "$T/day1.json" --date 2026-10-28 2>&1)"
eq 10 "$(( $(beads "$H" | jq length) + $(beads "$H/rigs/shop" | jq length) ))" "lost state files nothing again"
eq 0 "$(wc -l <"$T/spawn.log")" "lost state dispatches nothing again"
eq "$lo" "$(jq -r '.routed["safe/npm/lodash@4.17.20"].bead' "$H/state/security/routed.json")" "state rebuilt from the ledger"
mv "$T/routed.bak" "$H/state/security/routed.json"

# --- day 6: a new advisory, a KEV hit on the unknown, the cooldown ends ---
jq --argjson n "$(f GHSA-nx-2 shop next 14.2.5 '"14.2.11"' HIGH false)" \
  '.summary.kev_available = true | .findings |= (map(.kev = (if .package=="unknownkev" then true else (.kev // false) end)) + [$n])' \
  "$T/day1.json" >"$T/day6.json"
out="$(run --findings "$T/day6.json" --date 2026-11-02 2>&1)"; rc=$?
eq 0 "$rc" "day 6 exits 0"
eq 10 "$(( $(beads "$H" | jq length) + $(beads "$H/rigs/shop" | jq length) ))" "a new advisory on a known package files no bead"
nx="$(bead "$H/rigs/shop" shop/npm/next@14.2.5 .id)"
(cd "$H/rigs/shop" && bd comments "$nx" 2>/dev/null) | grep -q "new advisories GHSA-nx-2" && ok "new advisory commented on the bead" || bad "no comment for GHSA-nx-2"
eq 0 "$(bead "$H" safe/npm/unknownkev@3.0.0 .priority)" "kev unknown then true escalates to P0"
eq tier-c "$(bead "$H" safe/npm/unknownkev@3.0.0 '.labels[]|select(startswith("tier"))')" "escalation relabels tier-c"
eq 1 "$(grep -c '^urgent|Security P0: safe unknownkev' "$T/notify.log")" "escalation pages the owner once"
yo="$(bead "$H" safe/npm/young@1.0.0 .id)"
eq 1 "$(grep -c -- "--bead $yo" "$T/spawn.log")" "held tier A dispatched after the cooldown"
eq 1 "$(wc -l <"$T/spawn.log")" "nothing else dispatched"
out="$(run --findings "$T/day6.json" --date 2026-11-02 2>&1)"
eq 1 "$(wc -l <"$T/spawn.log")" "a dispatched bead is never dispatched twice"
eq 1 "$(grep -c '^urgent|' "$T/notify.log")" "an escalation pages only once"

# --- dispatch cap ---
H2="$T/hq2"; mkdir -p "$H2/state/security"; (cd "$H2" && git init -q && bd init --prefix hq -q >/dev/null 2>&1)
findings "$T/many.json" true "$(f A-1 safe lodash 4.17.20 '"4.17.23"' HIGH false)" "$(f A-2 safe kevdead 1.0.0 '"1.0.1"' HIGH false)" "$(f A-3 safe unknownkev 3.0.0 '"3.0.1"' HIGH false)"
: >"$T/spawn.log"
HQ="$H2" BD=bd NOTIFY="$T/notify" SPAWN="$T/spawn" HQ_SEC_PUBLISHED="$T/published.json" \
  bash "$REPO/ops/security/route.sh" --config "$T/tiers.json" --offline --findings "$T/many.json" --date 2026-10-28 --max-dispatch 2 >/dev/null 2>&1
eq 2 "$(wc -l <"$T/spawn.log")" "the dispatch cap holds the third tier A"
HQ="$H2" BD=bd NOTIFY="$T/notify" SPAWN="$T/spawn" HQ_SEC_PUBLISHED="$T/published.json" \
  bash "$REPO/ops/security/route.sh" --config "$T/tiers.json" --offline --findings "$T/many.json" --date 2026-10-29 --max-dispatch 2 >/dev/null 2>&1
eq 3 "$(wc -l <"$T/spawn.log")" "the capped bead goes out on the next run"

# --- fail closed on malformed or unknown KEV / malicious fields (review round 2) ---
P1="$T/pub1.json"; echo '{"npm/lodash@4.17.21":"2026-01-01"}' >"$P1"
FB='"id":"GHSA-x","rig":"peel","ecosystem":"npm","package":"lodash","installed":"4.17.20","fixed":"4.17.21","severity":"HIGH"'
tier(){ echo "{\"summary\":$1,\"findings\":[{$FB$2}]}" >"$T/fc.json"
  python3 "$REPO/ops/security/route.py" --findings "$T/fc.json" --config "$REPO/ops/config/security-tiers.json" \
    --state "$T/fc-none" --date 2026-10-28 --published "$P1" --offline | jq -r '.file[0].tier'; }
K='{"scan_errors":0,"kev_available":true}'
C0="$REPO/ops/config/security-tiers.json"
eq A "$(tier "$K" ',"kev":false,"malicious":false')" "control: clean patch on peel is tier A"
eq B "$(tier "$K" ',"kev":"true","malicious":false')" "kev as a string is unknown, tier B"
eq B "$(tier "$K" ',"kev":1,"malicious":false')" "kev as a number is unknown, tier B"
eq B "$(tier '{"scan_errors":0,"kev_available":false}' ',"kev":false,"malicious":false')" "kev_available false forces unknown, tier B"
eq B "$(tier '{"scan_errors":0}' ',"kev":false,"malicious":false')" "missing kev_available forces unknown, tier B"
eq B "$(tier "$K" ',"kev":false')" "missing malicious is unknown, tier B"
eq B "$(tier "$K" ',"kev":false,"malicious":"no"')" "non-boolean malicious is unknown, tier B"
eq true "$(python3 "$REPO/ops/security/route.py" --findings <(jq '.summary.kev_available=false' "$T/fc.json") --config "$REPO/ops/config/security-tiers.json" \
  --state "$T/fc-none" --date 2026-10-28 --published "$P1" --offline | jq -r .incomplete)" "a file without the KEV catalog is reported incomplete"

# --- hq-8cry.9: durable side effects, rewrites, lost-state recovery, run lock ---
H3="$T/hq3"; mkdir -p "$H3/state/security"; (cd "$H3" && git init -q && bd init --prefix h3 -q >/dev/null 2>&1)
S3="$H3/state/security/routed.json"
cat >"$T/bdw" <<EOF
#!/usr/bin/env bash
# bd, except the subcommands listed in $T/bdfail fail
if [ -f "$T/bdfail" ] && grep -qx "\$1" "$T/bdfail"; then echo "injected \$1 failure" >&2; exit 1; fi
exec bd "\$@"
EOF
cat >"$T/notify3" <<EOF
#!/usr/bin/env bash
[ -f "$T/notifyfail" ] && exit 1
printf '%s|%s|%s\n' "\$1" "\$2" "\$3" >>"$T/notify3.log"
EOF
cat >"$T/spawn3" <<EOF
#!/usr/bin/env bash
# like a real spawn, leave a long-lived process behind with every inherited fd
printf '%s|%s\n' "\$1" "\$*" >>"$T/spawn.log"; sleep 30 >/dev/null 2>&1 &
b=""; while [ \$# -gt 0 ]; do [ "\$1" = --bead ] && b="\$2"; shift; done
f="\$HQ/state/sessions.json"; [ -f "\$f" ] || echo '{}' >"\$f"
jq --arg b "\$b" '.["s-" + \$b] = {bead:\$b, status:"active"}' "\$f" >"\$f.tmp" && mv "\$f.tmp" "\$f"; echo s-test
EOF
chmod +x "$T/bdw" "$T/notify3" "$T/spawn3"; : >"$T/notify3.log"; : >"$T/spawn.log"
run3() { HQ="$H3" BD="$T/bdw" NOTIFY="$T/notify3" SPAWN="$T/spawn3" HQ_SEC_PUBLISHED="$T/published.json" \
  bash "$REPO/ops/security/route.sh" --config "$T/tiers.json" --offline "$@"; }
pend() { jq -c --arg k "$1" '.routed[$k].pending // []' "$S3"; }
D1=(
  "$(f GHSA-kv-1 safe kevpkg 2.0.0 '"2.0.1"' HIGH true)"
  "$(f GHSA-mi-1 safe minor 1.0.0 '"1.1.0"' HIGH false)"
  "$(f GHSA-lo-1 safe lodash 4.17.20 '"4.17.23"' HIGH false)"
  "$(f GHSA-yo-1 safe young 1.0.0 '"1.0.1"' LOW false)"
  "$(f GHSA-uk-1 safe unknownkev 3.0.0 '"3.0.1"' MEDIUM null)"
  "$(f GHSA-mb-1 safe maybe 1.0.0 '"1.0.1"' LOW false null)"
)
findings "$T/d1.json" true "${D1[@]}"

# 1. a failed page stays pending and is sent on the next run, once
touch "$T/notifyfail"
run3 --findings "$T/d1.json" --date 2026-10-28 >/dev/null 2>&1; rc=$?
eq 1 "$rc" "a failed page exits 1"
eq '[{"op":"page"}]' "$(pend safe/npm/kevpkg@2.0.0)" "a failed page stays pending in the state"
rm -f "$T/notifyfail"
run3 --findings "$T/d1.json" --date 2026-10-28 >/dev/null 2>&1; rc=$?
eq 0 "$rc" "the retry run exits 0"
eq 1 "$(grep -c '^urgent|Security P0: safe kevpkg' "$T/notify3.log")" "the failed page is sent on the next run"
eq '[]' "$(pend safe/npm/kevpkg@2.0.0)" "a sent page leaves the pending list"
run3 --findings "$T/d1.json" --date 2026-10-28 >/dev/null 2>&1
eq 1 "$(grep -c '^urgent|' "$T/notify3.log")" "a sent page is never sent again"
lo3="$(bead "$H3" safe/npm/lodash@4.17.20 .id)"
eq 1 "$(grep -c -- "--bead $lo3" "$T/spawn.log")" "tier A dispatched on day 1"

# 9. malicious null reads unknown, and the DoD asks for a clean bill
bead "$H3" safe/npm/maybe@1.0.0 .description | grep -q "malicious unknown" && ok "body prints malicious unknown for null" || bad "malicious null wording"
bead "$H3" safe/npm/maybe@1.0.0 .description | grep -q "confirmed not malicious" && ok "DoD does not treat null as clean" || bad "DoD malicious null"

# 3 (worker side). the tier A task re-checks the tier with a command that works
grep -q "re-check the tier right before finishing" "$T/spawn.log" && ok "tier A task re-checks the tier before finish.sh" || bad "no tier re-check in the task"
chk="$(grep -- "--bead $lo3" "$T/spawn.log" | sed -n 's/.*re-check the tier right before finishing: \[\(.*\)\] must exit 0.*/\1/p')"
(eval "$chk") >/dev/null 2>&1 && ok "the tier re-check passes while the bead is tier A" || bad "tier re-check fails on a tier A bead: $chk"

# 1 + 2. failed rewrite and comment are retried; a higher fix rewrites title, target and proof
D2=("${D1[@]}"
  "$(f GHSA-mi-2 safe minor 1.0.0 '"1.2.0"' HIGH false)"
  "$(f GHSA-lo-3 safe lodash 4.17.20 '"4.18.0"' HIGH false)")
findings "$T/d2.json" true "${D2[@]}"
printf 'comment\nupdate\n' >"$T/bdfail"
run3 --findings "$T/d2.json" --date 2026-10-29 >/dev/null 2>&1; rc=$?
rm -f "$T/bdfail"
eq 1 "$rc" "a failed rewrite or comment exits 1"
eq "Security: safe minor 1.0.0 to 1.1.0 (HIGH, tier B)" "$(bead "$H3" safe/npm/minor@1.0.0 .title)" "title unchanged while the rewrite fails"
eq '["comment","rewrite"]' "$(jq -c --arg k safe/npm/minor@1.0.0 '[.routed[$k].pending[].op]|sort' "$S3")" "the failed rewrite and comment stay pending"
run3 --findings "$T/d2.json" --date 2026-10-29 >/dev/null 2>&1; rc=$?
eq 0 "$rc" "the retry run exits 0"
eq "Security: safe minor 1.0.0 to 1.2.0 (HIGH, tier B)" "$(bead "$H3" safe/npm/minor@1.0.0 .title)" "a higher fixed version rewrites the title"
bead "$H3" safe/npm/minor@1.0.0 .description | grep -q "resolves to 1.2.0 or later" && ok "a higher fixed version rewrites the target" || bad "target not rewritten"
bead "$H3" safe/npm/minor@1.0.0 .description | grep -q "lists none of GHSA-mi-1, GHSA-mi-2" && ok "a new advisory rewrites the verification command" || bad "proof not rewritten"
mi3="$(bead "$H3" safe/npm/minor@1.0.0 .id)"
eq 1 "$( (cd "$H3" && bd comments "$mi3" 2>/dev/null) | grep -c 'target rose 1.1.0 to')" "the failed comment is posted once on retry"
eq '[]' "$(pend safe/npm/minor@1.0.0)" "nothing left pending"

# 3. escalation A to B rewrites the bead: no autonomous flow, redteam plus lucy
eq "tier-b" "$(bead "$H3" safe/npm/lodash@4.17.20 '[.labels[]|select(startswith("tier"))]|join(",")')" "escalated tier A bead relabelled tier-b only"
bead "$H3" safe/npm/lodash@4.17.20 .labels | grep -q redteam && ok "escalated bead gains redteam" || bad "escalated bead lacks redteam"
d="$(bead "$H3" safe/npm/lodash@4.17.20 .description)"
grep -q "Tier A (autonomous)" <<<"$d" && bad "escalated bead keeps the tier A flow" || ok "escalation drops the tier A flow"
grep -q "lucy" <<<"$d" && grep -q "redteam" <<<"$d" && ok "escalation adds the redteam and lucy steps" || bad "escalated DoD lacks redteam or lucy"
grep -q "^Model: claude-opus-5-5" <<<"$d" && ok "escalation moves the model to Opus" || bad "escalated model"
(eval "$chk") >/dev/null 2>&1 && bad "tier re-check still passes after the escalation" || ok "the worker's tier re-check fails after the escalation"

# 4. lost state, no backup, past the cooldown: dispatch state comes from the ledger
rm -f "$S3"; : >"$T/spawn.log"
findings "$T/d3.json" true "${D2[@]/'"kev":null'/'"kev":true'}"
jq -e '[.findings[]|select(.package=="unknownkev")][0].kev==true' "$T/d3.json" >/dev/null || bad "fixture: unknownkev not KEV in d3"
out="$(run3 --findings "$T/d3.json" --date 2026-11-02 2>&1)"; rc=$?
eq 0 "$rc" "lost-state run exits 0"
yo3="$(bead "$H3" safe/npm/young@1.0.0 .id)"
eq 1 "$(grep -c -- "--bead $yo3" "$T/spawn.log")" "lost state: the held tier A goes out after the cooldown"
eq 1 "$(wc -l <"$T/spawn.log")" "lost state: the dispatched tier A is not sent again"
eq true "$(jq -r '.routed["safe/npm/young@1.0.0"].dispatched' "$S3")" "lost state: dispatch recorded"
eq B "$(jq -r '.routed["safe/npm/lodash@4.17.20"].tier' "$S3")" "lost state: tier read back from the ledger"
eq 1 "$(grep -c '^urgent|Security P0: safe unknownkev' "$T/notify3.log")" "adoption pages an escalation to C"
eq 0 "$(bead "$H3" safe/npm/unknownkev@3.0.0 .priority)" "adoption reconciles the priority"
eq "tier-c" "$(bead "$H3" safe/npm/unknownkev@3.0.0 '[.labels[]|select(startswith("tier"))]|join(",")')" "adoption reconciles the tier label"
eq 1 "$( (cd "$H3" && bd comments "$mi3" 2>/dev/null) | grep -c 'Security watch')" "adoption reads advisories and target back, no spurious comment"
(cd "$H3" && bd update "$mi3" -p 4 >/dev/null 2>&1); rm -f "$S3"
run3 --findings "$T/d3.json" --date 2026-11-02 >/dev/null 2>&1; rc=$?
eq 0 "$rc" "a worker left running by spawn does not hold the run lock"
eq 1 "$(bead "$H3" safe/npm/minor@1.0.0 .priority)" "adoption reconciles a hand-changed priority"
eq 1 "$(wc -l <"$T/spawn.log")" "a second lost-state run dispatches nothing"
eq 1 "$(grep -c '^urgent|Security P0: safe unknownkev' "$T/notify3.log")" "a second lost-state run pages nobody"

# 5. one run at a time; a stale temp name; a failed state write stops before bd create
findings "$T/d4.json" true "$(f GHSA-n4-1 safe newpkg 1.0.0 '"2.0.0"' LOW false)"
( flock -n 9 && run3 --findings "$T/d4.json" --date 2026-11-03 >/dev/null 2>&1; echo $? >"$T/lockrc" ) 9>>"$S3.lock"
eq 4 "$(cat "$T/lockrc")" "a second run exits 4 while the lock is held"
eq "" "$(bead "$H3" safe/npm/newpkg@1.0.0 .id)" "the locked-out run files nothing"
run3 --findings "$T/d4.json" --date 2026-11-03 >/dev/null 2>&1
[ -n "$(bead "$H3" safe/npm/newpkg@1.0.0 .id)" ] && ok "the run after the lock is released files" || bad "newpkg not filed after the lock"
mkdir -p "$S3.tmp"
findings "$T/d4b.json" true "$(f GHSA-tp-1 safe tmppkg 1.0.0 '"2.0.0"' LOW false)"
run3 --findings "$T/d4b.json" --date 2026-11-03 >/dev/null 2>&1
n4="$(bead "$H3" safe/npm/tmppkg@1.0.0 .id)"
[ -n "$n4" ] && eq "$n4" "$(jq -r '.routed["safe/npm/tmppkg@1.0.0"].bead' "$S3")" "a stale routed.json.tmp does not block state writes" || bad "tmppkg not filed"
rmdir "$S3.tmp"
findings "$T/d5.json" true "$(f GHSA-n5-1 safe other 1.0.0 '"2.0.0"' LOW false)"
chmod 555 "$H3/state/security"
run3 --findings "$T/d5.json" --date 2026-11-03 >/dev/null 2>&1; rc=$?
chmod 755 "$H3/state/security"
eq 1 "$rc" "a failed state write exits 1"
eq "" "$(bead "$H3" safe/npm/other@1.0.0 .id)" "a failed state write stops before bd create"

# 4 (review). an unreadable ledger stops the run; it never reads as empty
rm -f "$S3"; : >"$T/spawn.log"; echo list >"$T/bdfail"
run3 --findings "$T/d3.json" --date 2026-11-04 >/dev/null 2>&1; rc=$?
rm -f "$T/bdfail"
eq 1 "$rc" "a failed bd list exits 1"
eq 1 "$(beads "$H3" | jq '[.[]|select(.external_ref=="secwatch:safe/npm/young@1.0.0")]|length')" "a failed bd list files no duplicate"
eq 0 "$(wc -l <"$T/spawn.log")" "a failed bd list dispatches nothing"
run3 --findings "$T/d3.json" --date 2026-11-04 >/dev/null 2>&1

# 3 (review). a worker's own relabel to tier-b survives a later rewrite
(cd "$H3" && bd update "$yo3" --remove-label tier-a --add-label tier-b >/dev/null 2>&1)
findings "$T/d6.json" true "${D2[@]/'"kev":null'/'"kev":true'}" "$(f GHSA-yo-2 safe young 1.0.0 '"1.0.1"' LOW false)"
run3 --findings "$T/d6.json" --date 2026-11-05 >/dev/null 2>&1
eq "tier-b" "$(bead "$H3" safe/npm/young@1.0.0 '[.labels[]|select(startswith("tier"))]|join(",")')" "a later rewrite keeps the worker's tier-b"
bead "$H3" safe/npm/young@1.0.0 .description | grep -q "Tier A (autonomous)" && bad "the rewrite restored the tier A flow" || ok "the rewrite does not restore the tier A flow"
eq 0 "$(wc -l <"$T/spawn.log")" "a demoted bead is not dispatched again"

# 6 to 10 in route.py
plan() {  # plan <config> <findings json array>
  echo "{\"summary\":$K,\"findings\":$2}" >"$T/pc.json"
  python3 "$REPO/ops/security/route.py" --findings "$T/pc.json" --config "$1" --state "$T/fc-none" --date 2026-10-28 --published "$P1" --offline; }
jq '.rigs.peel.classes = "money"' "$REPO/ops/config/security-tiers.json" >"$T/cs.json"
eq B "$(plan "$T/cs.json" "[{$FB,\"kev\":false,\"malicious\":false}]" | jq -r '.file[0].tier')" "classes as a string is unknown, tier B"
jq '.rigs.peel.classes = null' "$REPO/ops/config/security-tiers.json" >"$T/cn.json"
eq B "$(plan "$T/cn.json" "[{$FB,\"kev\":false,\"malicious\":false}]" | jq -r '.file[0].tier')" "classes null is unknown, tier B"
eq C "$(plan "$C0" "[{$FB,\"kev\":false,\"malicious\":false,\"aliases\":[\"MAL-2026-9\"]}]" | jq -r '.file[0].tier')" "a MAL- alias forces malicious"
eq C "$(plan "$C0" "[{${FB/GHSA-x/MAL-2026-8},\"kev\":false,\"malicious\":false}]" | jq -r '.file[0].tier')" "a MAL- id forces malicious"
r="$(plan "$C0" "[{$FB,\"kev\":false,\"malicious\":false},{${FB/GHSA-x/GHSA-y},\"fixed\":\"see advisory\",\"kev\":false,\"malicious\":false}]" | jq -r '.file[0] | "\(.tier) \(.bump)"')"
eq "B unknown" "$r" "an unparsable fixed version makes the bump unknown, tier B"
eq 2026-10-27 "$(cd "$REPO/ops/security" && python3 -c 'import route; print((route.pypi_published([{"upload_time_iso_8601":"2020-01-01T00:00:00Z"},{"upload_time_iso_8601":"2026-10-27T09:00:00Z"}]) or "")[:10])' 2>/dev/null)" \
  "PyPI publish date is the latest upload"

# --- review round two of hq-8cry.9: one fresh ledger per scenario ---
P5="$T/pub5.json"; echo '{"npm/pa@1.0.1":"2026-01-01","npm/pb@1.0.5":"2026-01-01","npm/pb@1.0.2":"2026-01-01","npm/pe@1.0.1":"2026-01-01","npm/pd@1.0.1":"2026-10-25","npm/pq@1.0.1":"2026-01-01","npm/pc@1.0.1":"2026-01-01","npm/pm@1.0.1":"2026-01-01","npm/pw@1.0.1":"2026-01-01"}' >"$P5"
cat >"$T/notify5" <<EOF
#!/usr/bin/env bash
[ -f "$T/n5fail" ] && exit 1
printf '%s|%s|%s\n' "\$1" "\$2" "\$3" >>"$T/n5.log"
EOF
cat >"$T/spawn5" <<EOF
#!/usr/bin/env bash
# s5crash: the router dies after labelling, before any worker exists
[ -f "$T/s5crash" ] && { kill -KILL \$PPID; exit 1; }
printf '%s\n' "\$*" >>"$T/s5.log"
b=""; while [ \$# -gt 0 ]; do [ "\$1" = --bead ] && b="\$2"; shift; done
f="\$HQ/state/sessions.json"; [ -f "\$f" ] || echo '{}' >"\$f"
jq --arg b "\$b" '.["s-" + \$b] = {bead:\$b}' "\$f" >"\$f.tmp" && mv "\$f.tmp" "\$f"; echo s-5
EOF
chmod +x "$T/notify5" "$T/spawn5"
fresh5() { H5="$T/hq5-$1"; S5="$H5/state/security/routed.json"; mkdir -p "$H5/state/security"
  (cd "$H5" && git init -q && bd init --prefix "h5$1" -q >/dev/null 2>&1); echo '{}' >"$H5/state/sessions.json"; : >"$T/n5.log"; : >"$T/s5.log"; rm -f "$T/n5fail" "$T/s5crash"; }
run5() { HQ="$H5" BD=bd NOTIFY="$T/notify5" SPAWN="$T/spawn5" HQ_SEC_PUBLISHED="$P5" \
  bash "$REPO/ops/security/route.sh" --config "$T/tiers.json" --offline "$@" >/dev/null 2>&1; }

# Opus: a page that failed, then a lost state file, still pages exactly once.
fresh5 page
findings "$T/f5c.json" true "$(f GHSA-pc-1 safe pc 1.0.0 '"1.0.1"' HIGH true)"
touch "$T/n5fail"; run5 --findings "$T/f5c.json" --date 2026-10-28; rm -f "$T/n5fail" "$S5"
run5 --findings "$T/f5c.json" --date 2026-10-29
eq 1 "$(grep -c '^urgent|' "$T/n5.log")" "a failed page survives a lost state file"
rm -f "$S5"; run5 --findings "$T/f5c.json" --date 2026-10-30
eq 1 "$(grep -c '^urgent|' "$T/n5.log")" "the paged label stops a second page after another state loss"

# lucy 1: a ledger relabel is an escalation even with unchanged findings.
fresh5 relabel
findings "$T/f5a.json" true "$(f GHSA-pa-1 safe pa 1.0.0 '"1.0.1"' HIGH false)"
run5 --findings "$T/f5a.json" --date 2026-10-28
pa="$(bead "$H5" safe/npm/pa@1.0.0 .id)"
bead "$H5" safe/npm/pa@1.0.0 .description | grep -q "Tier A (autonomous)" && ok "control: pa starts tier A" || bad "control: pa starts tier A"
(cd "$H5" && bd update "$pa" --remove-label tier-a --add-label tier-b >/dev/null 2>&1)
run5 --findings "$T/f5a.json" --date 2026-10-29
bead "$H5" safe/npm/pa@1.0.0 .description | grep -q "Tier A (autonomous)" && bad "a worker relabel to tier-b drops the tier A flow" || ok "a worker relabel to tier-b drops the tier A flow"
(cd "$H5" && bd update "$pa" --remove-label tier-b --add-label tier-c >/dev/null 2>&1)
run5 --findings "$T/f5a.json" --date 2026-10-30
eq 1 "$(grep -c '^urgent|Security P0: safe pa' "$T/n5.log")" "a hand relabel to tier-c pages"
eq 0 "$(bead "$H5" safe/npm/pa@1.0.0 .priority)" "a hand relabel to tier-c sets P0"

# lucy 2: a crash after labelling and before the spawn is dispatched on the next run.
fresh5 crash
findings "$T/f5e.json" true "$(f GHSA-pe-1 safe pe 1.0.0 '"1.0.1"' HIGH false)"
touch "$T/s5crash"; run5 --findings "$T/f5e.json" --date 2026-10-28; rm -f "$T/s5crash"
run5 --findings "$T/f5e.json" --date 2026-10-29
pe="$(bead "$H5" safe/npm/pe@1.0.0 .id)"
eq 1 "$(grep -c -- "--bead $pe" "$T/s5.log")" "a crash before the spawn is dispatched on the next run"
run5 --findings "$T/f5e.json" --date 2026-10-30
eq 1 "$(grep -c -- "--bead $pe" "$T/s5.log")" "and only once"

# lucy 3: a blocked, never dispatched tier A bead is dispatched after a lost state.
fresh5 blocked
findings "$T/f5d.json" true "$(f GHSA-pd-1 safe pd 1.0.0 '"1.0.1"' HIGH false)"
run5 --findings "$T/f5d.json" --date 2026-10-28
pd="$(bead "$H5" safe/npm/pd@1.0.0 .id)"
eq 0 "$(wc -l <"$T/s5.log")" "control: pd is held by the cooldown"
(cd "$H5" && bd update "$pd" --status blocked >/dev/null 2>&1); rm -f "$S5"
run5 --findings "$T/f5d.json" --date 2026-11-02
eq 1 "$(grep -c -- "--bead $pd" "$T/s5.log")" "a blocked never-dispatched bead goes out after a lost state"

# lucy 4: a later partial findings file never lowers the target.
fresh5 target
findings "$T/f5b1.json" true "$(f GHSA-pb-x safe pb 1.0.0 '"1.0.5"' HIGH false)"
findings "$T/f5b2.json" true "$(f GHSA-pb-y safe pb 1.0.0 '"1.0.2"' HIGH false)"
run5 --findings "$T/f5b1.json" --date 2026-10-28; run5 --findings "$T/f5b2.json" --date 2026-10-29
bead "$H5" safe/npm/pb@1.0.0 .title | grep -q " to 1.0.5 (" && ok "a partial file keeps the higher target" || bad "a partial file keeps the higher target: $(bead "$H5" safe/npm/pb@1.0.0 .title)"
rm -f "$S5"; run5 --findings "$T/f5b2.json" --date 2026-10-30
bead "$H5" safe/npm/pb@1.0.0 .title | grep -q " to 1.0.5 (" && ok "and after a lost state" || bad "and after a lost state: $(bead "$H5" safe/npm/pb@1.0.0 .title)"

# round three: the registry check fails closed
for mode in corrupt missing; do
  fresh5 "reg$mode"
  findings "$T/f5q.json" true "$(f GHSA-pq-1 safe pq 1.0.0 '"1.0.1"' HIGH false)"
  run5 --findings "$T/f5q.json" --date 2026-10-28
  pq="$(bead "$H5" safe/npm/pq@1.0.0 .id)"
  if [ "$mode" = corrupt ]; then echo '{not json' >"$H5/state/sessions.json"; else rm -f "$H5/state/sessions.json"; fi
  rm -f "$S5"; run5 --findings "$T/f5q.json" --date 2026-10-29
  eq 1 "$(grep -c -- "--bead $pq" "$T/s5.log")" "a $mode registry never respawns a dispatched bead"
done

# round four (lucy round two): one fresh ledger per scenario, bd wrapped to fail on demand
cat >"$T/bd6" <<EOF
#!/usr/bin/env bash
if [ "\$1" = update ]; then
  for a in "\$@"; do
    [ "\$a" = --title ] && [ -f "$T/b6title" ] && exit 1
    [ "\$a" = paged ] && [ -f "$T/b6paged" ] && exit 1
  done
fi
exec bd "\$@"
EOF
chmod +x "$T/bd6"
run6() { HQ="$H5" BD="$T/bd6" NOTIFY="$T/notify5" SPAWN="$T/spawn5" HQ_SEC_PUBLISHED="$P5" \
  bash "$REPO/ops/security/route.sh" --config "$T/tiers.json" --offline "$@" >/dev/null 2>&1; }
recheck() { local c; c="$(grep -o -- '\[cd .*\] must exit 0' "$T/s5.log" | tail -1 | sed 's/^\[//; s/\] must exit 0$//')"
  [ -n "$c" ] || return 9; bash -c "$c" >/dev/null 2>&1; }

# lucy 1: a failed escalation rewrite leaves tier-a on the bead; the worker re-check still fails.
fresh5 rew; rm -f "$T/b6title" "$T/b6paged"
findings "$T/f6a.json" true "$(f GHSA-pa-1 safe pa 1.0.0 '"1.0.1"' HIGH false)"
run6 --findings "$T/f6a.json" --date 2026-10-28
recheck && ok "control: the re-check passes on an untouched tier A bead" || bad "control: the re-check passes on an untouched tier A bead"
findings "$T/f6a2.json" true "$(f GHSA-pa-1 safe pa 1.0.0 '"1.0.1"' HIGH true)"
touch "$T/b6title"; run6 --findings "$T/f6a2.json" --date 2026-10-29; r=$?
bead "$H5" safe/npm/pa@1.0.0 .labels | grep -q tier-a && ok "control: the failed rewrite left tier-a on the bead" || bad "control: the failed rewrite left tier-a on the bead"
recheck && bad "a failed escalation rewrite fails the worker re-check" || ok "a failed escalation rewrite fails the worker re-check"
rm -f "$T/b6title"; mv "$S5" "$S5.bak"
recheck && bad "a missing routing state fails the re-check (fail closed)" || ok "a missing routing state fails the re-check (fail closed)"
mv "$S5.bak" "$S5"

# lucy 2: with the state intact, a claimed or closed bead is never spawned.
for st6 in in_progress closed; do
  fresh5 "disp$st6"
  findings "$T/f6d.json" true "$(f GHSA-pd-1 safe pd 1.0.0 '"1.0.1"' HIGH false)"
  run6 --findings "$T/f6d.json" --date 2026-10-28
  pd="$(bead "$H5" safe/npm/pd@1.0.0 .id)"
  eq 0 "$(wc -l <"$T/s5.log")" "control: pd is held by the cooldown ($st6)"
  (cd "$H5" && bd update "$pd" --status "$st6" >/dev/null 2>&1)
  run6 --findings "$T/f6d.json" --date 2026-11-02
  eq 0 "$(grep -c -- "--bead $pd" "$T/s5.log")" "an $st6 bead with an intact state is not spawned"
  eq true "$(jq -r --arg k safe/npm/pd@1.0.0 '.routed[$k].dispatched' "$S5")" "and the state records it dispatched ($st6)"
done

# lucy 3: a page that went out but whose paged label failed retries the label, never the page.
fresh5 mark
findings "$T/f6c.json" true "$(f GHSA-pc-1 safe pc 1.0.0 '"1.0.1"' HIGH true)"
touch "$T/b6paged"; run6 --findings "$T/f6c.json" --date 2026-10-28; r=$?
eq 1 "$r" "a failed paged label exits 1"
eq '[{"op":"mark-paged"}]' "$(jq -c --arg k safe/npm/pc@1.0.0 '.routed[$k].pending' "$S5")" "the paged label stays pending"
rm -f "$T/b6paged"; run6 --findings "$T/f6c.json" --date 2026-10-29
bead "$H5" safe/npm/pc@1.0.0 .labels | grep -q '"paged"' && ok "the paged label is added on retry" || bad "the paged label is added on retry"
eq '[]' "$(jq -c --arg k safe/npm/pc@1.0.0 '.routed[$k].pending' "$S5")" "nothing pending after the retry"
rm -f "$S5"; run6 --findings "$T/f6c.json" --date 2026-10-30
eq 1 "$(grep -c '^urgent|' "$T/n5.log")" "one page in all, also after a lost state"

# lucy 4: a later partial file never drops the malicious remediation.
fresh5 mal
findings "$T/f6m1.json" true "$(f MAL-2026-1 safe pm 1.0.0 '"1.0.1"' CRITICAL false true)"
findings "$T/f6m2.json" true "$(f GHSA-pm-2 safe pm 1.0.0 '"1.0.1"' HIGH false false)"
findings "$T/f6m3.json" true "$(f GHSA-pm-3 safe pm 1.0.0 '"1.0.1"' HIGH false false)"
run6 --findings "$T/f6m1.json" --date 2026-10-28
bead "$H5" safe/npm/pm@1.0.0 .description | grep -q "removed or replaced" && ok "control: a malicious bead asks for removal" || bad "control: a malicious bead asks for removal"
run6 --findings "$T/f6m2.json" --date 2026-10-29
d="$(bead "$H5" safe/npm/pm@1.0.0 .description)"
grep -q "GHSA-pm-2" <<<"$d" && ok "control: the partial file rewrote the bead" || bad "control: the partial file rewrote the bead"
grep -q "removed or replaced" <<<"$d" && grep -q "malicious yes" <<<"$d" && ok "a partial file keeps the malicious remediation" || bad "a partial file keeps the malicious remediation"
rm -f "$S5"; run6 --findings "$T/f6m3.json" --date 2026-10-30
d="$(bead "$H5" safe/npm/pm@1.0.0 .description)"
grep -q "GHSA-pm-3" <<<"$d" && grep -q "removed or replaced" <<<"$d" && ok "and after a lost state" || bad "and after a lost state"

# review round three: carried KEV evidence never waives the cooldown for a malicious package.
fresh5 waive
findings "$T/f6w1.json" true "$(f GHSA-pw-1 safe pw 1.0.0 '"1.0.1"' HIGH true)"
findings "$T/f6w2.json" true "$(f MAL-2026-9 safe pw 1.0.0 '"1.0.1"' CRITICAL false true)"
run6 --findings "$T/f6w1.json" --date 2026-10-28
bead "$H5" safe/npm/pw@1.0.0 .description | grep -q "waived: KEV fix" && ok "control: a KEV fix is waived" || bad "control: a KEV fix is waived"
run6 --findings "$T/f6w2.json" --date 2026-10-29
d="$(bead "$H5" safe/npm/pw@1.0.0 .description)"
grep -q "malicious yes" <<<"$d" && ! grep -q "waived" <<<"$d" && ok "a malicious package never gets the cooldown waiver" || bad "a malicious package never gets the cooldown waiver"

# --- hq-8cry.12: open findings of the hq-8cry.9 round three reviews ---
cat >"$T/bd7" <<EOF
#!/usr/bin/env bash
[ "\$1" = create ] && [ -f "$T/b7create" ] && { echo "injected create failure" >&2; exit 1; }
exec bd "\$@"
EOF
chmod +x "$T/bd7"
run7() { HQ="$H5" BD="$T/bd7" NOTIFY="$T/notify5" SPAWN="$T/spawn5" HQ_SEC_PUBLISHED="$P5" \
  bash "$REPO/ops/security/route.sh" --config "$T/tiers.json" --offline "$@" >/dev/null 2>&1; }

# 1. the worker re-check wants exactly tier-a on the bead and tier A in its title.
fresh5 exact; rm -f "$T/b7create"
findings "$T/f7a.json" true "$(f GHSA-pa-1 safe pa 1.0.0 '"1.0.1"' HIGH false)"
run7 --findings "$T/f7a.json" --date 2026-10-28
pa="$(bead "$H5" safe/npm/pa@1.0.0 .id)"
recheck && ok "control: the re-check passes on a clean tier A bead" || bad "control: the re-check passes on a clean tier A bead"
(cd "$H5" && bd update "$pa" --add-label tier-b >/dev/null 2>&1)
recheck && bad "tier-b next to tier-a fails the re-check" || ok "tier-b next to tier-a fails the re-check"
(cd "$H5" && bd update "$pa" --remove-label tier-b --add-label tier-c >/dev/null 2>&1)
recheck && bad "tier-c next to tier-a fails the re-check" || ok "tier-c next to tier-a fails the re-check"
(cd "$H5" && bd update "$pa" --remove-label tier-c --title "Security: safe pa 1.0.0 to 1.0.1 (HIGH, tier B)" >/dev/null 2>&1)
recheck && bad "a title tier other than A fails the re-check" || ok "a title tier other than A fails the re-check"

# 2a. a change in KEV or malicious evidence alone is stored and rewrites the bead.
fresh5 evid
findings "$T/f7e1.json" true "$(f GHSA-pv-1 safe pv 1.0.0 '"1.1.0"' HIGH false false)" "$(f GHSA-pk-1 dead pk 1.0.0 '"1.1.0"' HIGH false)"
findings "$T/f7e2.json" true "$(f GHSA-pv-1 safe pv 1.0.0 '"1.1.0"' HIGH false null)" "$(f GHSA-pk-1 dead pk 1.0.0 '"1.1.0"' HIGH true)"
run7 --findings "$T/f7e1.json" --date 2026-10-28
bead "$H5" safe/npm/pv@1.0.0 .description | grep -q "malicious no" && ok "control: pv starts malicious no" || bad "control: pv starts malicious no"
run7 --findings "$T/f7e2.json" --date 2026-10-29
eq null "$(jq -c --arg k safe/npm/pv@1.0.0 '.routed[$k].item.malicious' "$S5")" "malicious turning unknown alone is stored in the state"
bead "$H5" safe/npm/pv@1.0.0 .description | grep -q "malicious unknown" && ok "malicious turning unknown alone rewrites the bead" || bad "malicious turning unknown alone rewrites the bead"
eq true "$(jq -c --arg k dead/npm/pk@1.0.0 '.routed[$k].item.kev' "$S5")" "KEV turning true alone is stored in the state"
bead "$H5" dead/npm/pk@1.0.0 .description | grep -q "KEV yes" && ok "KEV turning true alone rewrites the bead" || bad "KEV turning true alone rewrites the bead"

# 2b. evidence merges before the tier: earlier KEV on a rig that has become live is tier C.
fresh5 evtier
jq '.rigs.dead.live = true' "$T/tiers.json" >"$T/tiers-live.json"
findings "$T/f7l1.json" true "$(f GHSA-pl-1 dead pl 1.0.0 '"1.0.1"' HIGH true)"
findings "$T/f7l2.json" true "$(f GHSA-pl-2 dead pl 1.0.0 '"1.0.1"' HIGH false)"
run7 --findings "$T/f7l1.json" --date 2026-10-28
eq tier-b "$(bead "$H5" dead/npm/pl@1.0.0 '[.labels[]|select(startswith("tier"))]|join(",")')" "control: KEV on a rig that is not live is tier B"
run7 --findings "$T/f7l2.json" --date 2026-10-29 --config "$T/tiers-live.json"
eq tier-c "$(bead "$H5" dead/npm/pl@1.0.0 '[.labels[]|select(startswith("tier"))]|join(",")')" "earlier KEV evidence sets the tier once the rig is live"
eq 1 "$(grep -c '^urgent|Security P0: dead pl' "$T/n5.log")" "and pages"

# 3. a failed bd create keeps its tier, ids and evidence as the floor on retry.
fresh5 fcreate
findings "$T/f7c1.json" true "$(f GHSA-pf-1 safe pf 1.0.0 '"1.0.1"' HIGH true)"
findings "$T/f7c2.json" true "$(f GHSA-pf-2 safe pf 1.0.0 '"1.0.1"' MEDIUM false)"
touch "$T/b7create"; run7 --findings "$T/f7c1.json" --date 2026-10-28; r=$?; rm -f "$T/b7create"
eq 1 "$r" "control: a failed bd create exits 1"
eq "" "$(bead "$H5" safe/npm/pf@1.0.0 .id)" "control: nothing filed"
run7 --findings "$T/f7c2.json" --date 2026-10-29
eq "Security: safe pf 1.0.0 to 1.0.1 (HIGH, tier C)" "$(bead "$H5" safe/npm/pf@1.0.0 .title)" "a refiled entry keeps its tier and severity"
eq 0 "$(bead "$H5" safe/npm/pf@1.0.0 .priority)" "a refiled entry keeps P0"
d="$(bead "$H5" safe/npm/pf@1.0.0 .description)"
grep -q "Advisories: GHSA-pf-1, GHSA-pf-2" <<<"$d" && grep -q "KEV yes" <<<"$d" && ok "a refiled entry keeps its ids and KEV evidence" || bad "a refiled entry keeps its ids and KEV evidence"
eq 1 "$(grep -c '^urgent|Security P0: safe pf' "$T/n5.log")" "a refiled tier C pages once"

# 4. severity and priority never drop when a later partial file adds only a lower advisory.
fresh5 sev
findings "$T/f7s1.json" true "$(f GHSA-ps-1 safe ps 1.0.0 '"1.1.0"' HIGH false)"
findings "$T/f7s2.json" true "$(f GHSA-ps-2 safe ps 1.0.0 '"1.1.0"' LOW false)"
findings "$T/f7s3.json" true "$(f GHSA-ps-3 safe ps 1.0.0 '"1.1.0"' LOW false)"
run7 --findings "$T/f7s1.json" --date 2026-10-28
run7 --findings "$T/f7s2.json" --date 2026-10-29
bead "$H5" safe/npm/ps@1.0.0 .description | grep -q "GHSA-ps-2" && ok "control: the lower advisory rewrote the bead" || bad "control: the lower advisory rewrote the bead"
eq "Security: safe ps 1.0.0 to 1.1.0 (HIGH, tier B)" "$(bead "$H5" safe/npm/ps@1.0.0 .title)" "a lower advisory keeps the severity"
eq 1 "$(bead "$H5" safe/npm/ps@1.0.0 .priority)" "a lower advisory keeps the priority"
rm -f "$S5"; run7 --findings "$T/f7s3.json" --date 2026-10-30
eq "Security: safe ps 1.0.0 to 1.1.0 (HIGH, tier B)" "$(bead "$H5" safe/npm/ps@1.0.0 .title)" "and after a lost state"
eq 1 "$(bead "$H5" safe/npm/ps@1.0.0 .priority)" "and the priority after a lost state"

# 5. KEV or malicious evidence on a closed bead reopens it, never only a comment.
fresh5 closed
findings "$T/f7z1.json" true "$(f GHSA-pz-1 safe pz 1.0.0 '"1.1.0"' HIGH false)" "$(f GHSA-py-1 safe py 1.0.0 '"1.1.0"' HIGH false)"
findings "$T/f7z2.json" true "$(f GHSA-pz-1 safe pz 1.0.0 '"1.1.0"' HIGH false)" "$(f GHSA-pz-2 safe pz 1.0.0 '"1.1.0"' HIGH true)" \
  "$(f GHSA-py-1 safe py 1.0.0 '"1.1.0"' HIGH false)" "$(f MAL-2026-7 safe py 1.0.0 '"1.1.0"' CRITICAL false true)"
run7 --findings "$T/f7z1.json" --date 2026-10-28
for k in safe/npm/pz@1.0.0 safe/npm/py@1.0.0; do (cd "$H5" && bd close "$(bead "$H5" "$k" .id)" -r "fixture" >/dev/null 2>&1); done
eq closed "$(bead "$H5" safe/npm/pz@1.0.0 .status)" "control: pz is closed"
run7 --findings "$T/f7z2.json" --date 2026-10-29
eq open "$(bead "$H5" safe/npm/pz@1.0.0 .status)" "a KEV finding reopens a closed bead"
eq open "$(bead "$H5" safe/npm/py@1.0.0 .status)" "a malicious finding reopens a closed bead"
run7 --findings "$T/f7z2.json" --date 2026-10-30
eq '[]' "$(jq -c --arg k safe/npm/pz@1.0.0 '.routed[$k].pending' "$S5")" "the reopen leaves nothing pending"

# --- hq-8cry.17: non-blocking findings of the hq-8cry.12 reviews ---
# 1. a KEV or malicious change made only in the ledger (a hand edit) is compared
# against the stored item: it rewrites, is stored, and reopens a closed bead.
fresh5 hand
findings "$T/f8h.json" true "$(f GHSA-ph-1 dead ph 1.0.0 '"1.1.0"' HIGH false)" "$(f GHSA-pg-1 dead pg 1.0.0 '"1.1.0"' HIGH false)"
run7 --findings "$T/f8h.json" --date 2026-10-28
for k in dead/npm/ph@1.0.0 dead/npm/pg@1.0.0; do
  b="$(bead "$H5" "$k" .id)"; d="$(bead "$H5" "$k" .description)"
  if [ "$k" = dead/npm/ph@1.0.0 ]; then d="${d/KEV no/KEV yes}"; else d="${d/malicious no/malicious yes}"; fi
  (cd "$H5" && bd update "$b" -d "$d" >/dev/null 2>&1 && bd close "$b" -r fixture >/dev/null 2>&1)
done
eq closed "$(bead "$H5" dead/npm/ph@1.0.0 .status)" "control: ph is closed with KEV yes written by hand"
run7 --findings "$T/f8h.json" --date 2026-10-29
eq true "$(jq -c --arg k dead/npm/ph@1.0.0 '.routed[$k].item.kev' "$S5")" "a ledger-only KEV yes is stored in the state"
eq true "$(jq -c --arg k dead/npm/pg@1.0.0 '.routed[$k].item.malicious' "$S5")" "a ledger-only malicious yes is stored in the state"
eq open "$(bead "$H5" dead/npm/ph@1.0.0 .status)" "a ledger-only KEV yes reopens the closed bead"
eq open "$(bead "$H5" dead/npm/pg@1.0.0 .status)" "a ledger-only malicious yes reopens the closed bead"
(cd "$H5" && bd comments "$(bead "$H5" dead/npm/ph@1.0.0 .id)" 2>/dev/null) | grep -q "evidence KEV no to yes" \
  && ok "the comment names the ledger-only evidence" || bad "the comment names the ledger-only evidence"
bead "$H5" dead/npm/pg@1.0.0 .description | grep -q "removed or replaced with a clean version" \
  && ok "the rewrite carries the malicious remediation" || bad "the rewrite carries the malicious remediation"
run7 --findings "$T/f8h.json" --date 2026-10-30
eq '[]' "$(jq -c --arg k dead/npm/ph@1.0.0 '.routed[$k].pending' "$S5")" "a third run leaves nothing pending"
(cd "$H5" && bd comments "$(bead "$H5" dead/npm/ph@1.0.0 .id)" 2>/dev/null) | grep -q "Security watch 2026-10-30" \
  && bad "a third run finds no new evidence" || ok "a third run finds no new evidence"
eq 0 "$(grep -c . "$T/n5.log")" "a tier B on a rig that is not live never pages"

# 2. a filing that reached the ledger but never confirmed (bd create succeeded and
# reported failure) is adopted with the ledger tier, severity, target, evidence
# and advisory ids as floors before planning.
cat >"$T/bd8" <<BD8
#!/usr/bin/env bash
[ "\$1" = create ] && [ -f "$T/b8lie" ] && { bd "\$@" >/dev/null 2>&1; echo "injected: created, reported failure" >&2; exit 1; }
exec bd "\$@"
BD8
chmod +x "$T/bd8"
run8() { HQ="$H5" BD="$T/bd8" NOTIFY="$T/notify5" SPAWN="$T/spawn5" HQ_SEC_PUBLISHED="$P5" \
  bash "$REPO/ops/security/route.sh" --config "$T/tiers.json" --offline "$@" >/dev/null 2>&1; }
fresh5 unconf
findings "$T/f8u.json" true "$(f GHSA-pw-1 safe pw 1.0.0 '"1.0.1"' HIGH false)" "$(f GHSA-pj-1 dead pj 1.0.0 '"1.1.0"' MEDIUM false)"
touch "$T/b8lie"; run8 --findings "$T/f8u.json" --date 2026-10-28; r=$?; rm -f "$T/b8lie"
eq 1 "$r" "control: a create that reports failure exits 1"
eq '' "$(jq -r --arg k safe/npm/pw@1.0.0 '.routed[$k].bead' "$S5")" "control: the state has no bead id for pw"
pw="$(bead "$H5" safe/npm/pw@1.0.0 .id)"; pj="$(bead "$H5" dead/npm/pj@1.0.0 .id)"
[ -n "$pw" ] && [ -n "$pj" ] && ok "control: both beads reached the ledger" || bad "control: both beads reached the ledger"
d="$(bead "$H5" safe/npm/pw@1.0.0 .description)"; d="${d/Advisories: GHSA-pw-1./Advisories: GHSA-pw-1, GHSA-pw-9.}"
(cd "$H5" && bd update "$pw" --title "Security: safe pw 1.0.0 to 1.0.2 (CRITICAL, tier B)" -d "$d" \
  --remove-label tier-a --add-label tier-b >/dev/null 2>&1)
d="$(bead "$H5" dead/npm/pj@1.0.0 .description)"
(cd "$H5" && bd update "$pj" -d "${d/KEV no/KEV yes}" >/dev/null 2>&1)
run8 --findings "$T/f8u.json" --date 2026-10-29
eq "Security: safe pw 1.0.0 to 1.0.2 (CRITICAL, tier B)" "$(bead "$H5" safe/npm/pw@1.0.0 .title)" "an adopted unconfirmed filing keeps the ledger tier, severity and target"
eq "$pw" "$(jq -r --arg k safe/npm/pw@1.0.0 '.routed[$k].bead' "$S5")" "the state adopts the ledger bead id"
bead "$H5" safe/npm/pw@1.0.0 .labels | grep -q redteam && ok "the adopted bead is rewritten as tier B (redteam)" || bad "the adopted bead is rewritten as tier B (redteam)"
eq B "$(jq -r --arg k safe/npm/pw@1.0.0 '.routed[$k].tier' "$S5")" "the state stores the ledger tier"
eq "GHSA-pw-1,GHSA-pw-9" "$(jq -r --arg k safe/npm/pw@1.0.0 '.routed[$k].ids|join(",")' "$S5")" "the state keeps the ledger advisory ids"
eq 0 "$(grep -c -- "--bead $pw" "$T/s5.log")" "a ledger tier B is never dispatched as tier A"
eq true "$(jq -c --arg k dead/npm/pj@1.0.0 '.routed[$k].item.kev' "$S5")" "an adopted unconfirmed filing keeps the ledger KEV evidence"
bead "$H5" dead/npm/pj@1.0.0 .description | grep -q "KEV yes" && ok "and its rewrite says KEV yes" || bad "and its rewrite says KEV yes"
eq 1 "$(beads "$H5" | jq '[.[]|select(.external_ref=="secwatch:safe/npm/pw@1.0.0")]|length')" "no second pw bead"

# 2b. lucy round one: a ledger target survives a state that never knew one, and
# a target no finding vouches for is never dispatched as tier A.
fresh5 nullfix
findings "$T/f8n.json" true "$(f GHSA-pn-1 dead pn 1.0.0 null HIGH false)" "$(f GHSA-pq-1 safe pq 1.0.0 null HIGH false)"
touch "$T/b8lie"; run8 --findings "$T/f8n.json" --date 2026-10-28; rm -f "$T/b8lie"
pn="$(bead "$H5" dead/npm/pn@1.0.0 .id)"; pq="$(bead "$H5" safe/npm/pq@1.0.0 .id)"
eq null "$(jq -c --arg k dead/npm/pn@1.0.0 '.routed[$k].fixed' "$S5")" "control: the state has no target for pn"
d="$(bead "$H5" dead/npm/pn@1.0.0 .description)"
(cd "$H5" && bd update "$pn" --title "Security: dead pn 1.0.0 to 1.2.0 (HIGH, tier B)" -d "${d/KEV no/KEV yes}" >/dev/null 2>&1)
(cd "$H5" && bd update "$pq" --title "Security: safe pq 1.0.0 to 1.0.2 (HIGH, tier B)" >/dev/null 2>&1)
run8 --findings "$T/f8n.json" --date 2026-11-20
eq '"1.2.0"' "$(jq -c --arg k dead/npm/pn@1.0.0 '.routed[$k].fixed' "$S5")" "a ledger target is adopted over a null state target"
bead "$H5" dead/npm/pn@1.0.0 .title | grep -q " to 1.2.0 (" && ok "and the KEV rewrite keeps it" || bad "and the KEV rewrite keeps it: $(bead "$H5" dead/npm/pn@1.0.0 .title)"
bead "$H5" dead/npm/pn@1.0.0 .description | grep -q "KEV yes" && ok "and says KEV yes" || bad "and says KEV yes"
[ "$(jq -r --arg k safe/npm/pq@1.0.0 '.routed[$k].tier' "$S5")" != A ] && ok "a held target with no finding behind it is not tier A" || bad "a held target with no finding behind it is not tier A"
eq 0 "$(grep -c -- "--bead $pq" "$T/s5.log")" "and is never dispatched"

# 3. KEV or malicious news reopens a bead in any inactive status, not only closed.
fresh5 defer
findings "$T/f8d1.json" true "$(f GHSA-pd-1 safe pdx 1.0.0 '"1.1.0"' HIGH false)" "$(f GHSA-pp-1 safe ppx 1.0.0 '"1.1.0"' HIGH false)"
findings "$T/f8d2.json" true "$(f GHSA-pd-1 safe pdx 1.0.0 '"1.1.0"' HIGH true)" "$(f MAL-2026-8 safe ppx 1.0.0 '"1.1.0"' HIGH false true)"
run7 --findings "$T/f8d1.json" --date 2026-10-28
(cd "$H5" && bd update "$(bead "$H5" safe/npm/pdx@1.0.0 .id)" --status deferred --defer 2027-01-01 >/dev/null 2>&1)
(cd "$H5" && bd update "$(bead "$H5" safe/npm/ppx@1.0.0 .id)" --status deferred >/dev/null 2>&1)
eq deferred "$(bead "$H5" safe/npm/pdx@1.0.0 .status)" "control: pdx is deferred"
run7 --findings "$T/f8d2.json" --date 2026-10-29
eq open "$(bead "$H5" safe/npm/pdx@1.0.0 .status)" "a KEV finding reopens a deferred bead"
eq open "$(bead "$H5" safe/npm/ppx@1.0.0 .status)" "a malicious finding reopens a deferred bead"
eq null "$(bead "$H5" safe/npm/pdx@1.0.0 '.defer_until // null')" "the reopen clears the defer date"
eq 2 "$(grep -c '^urgent|Security P0: safe p[dp]x' "$T/n5.log")" "each escalation pages once"
d="$(bead "$H5" safe/npm/ppx@1.0.0 .description)"
grep -q "malicious package" <<<"$d" && ! grep -q "waived" <<<"$d" \
  && ok "a malicious fix never gets the cooldown waiver" || bad "a malicious fix never gets the cooldown waiver"

# --- the shipped policy ---
C="$REPO/ops/config/security-tiers.json"
jq empty "$C" && ok "security-tiers.json parses" || bad "security-tiers.json"
eq "peel" "$(jq -r --argjson s "$(jq .sensitive_classes "$C")" '[.rigs|to_entries[]|select((.value.classes - ($s - (.value.classes))) == [] and ((.value.classes|length)==0))|.key]|join(",")' "$C")" \
  "only peel is eligible for tier A in the shipped policy"
eq "" "$(jq -r '[.rigs|to_entries[]|select(.value.live==false)|.key]|join(",")' "$C")" "every shipped rig counts as live"
LC_ALL=C grep -nP '\x{2014}|\x{2013}' "$REPO/ops/security/route.sh" "$REPO/ops/security/route.py" "$C" >/dev/null 2>&1 \
  && bad "em or en dash in route files" || ok "no em dashes"

echo "route.test: $pass passed, $fail failed"
[ "$fail" = 0 ]
