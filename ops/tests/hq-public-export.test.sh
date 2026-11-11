#!/usr/bin/env bash
# hq-public-export.sh (hq-an7jw.1): allowlist select, denylist scrub, leak gate.
# Hermetic: every case builds a small hq-like git tree under a temp dir with its
# own allow and deny files; nothing outside the temp dir is read or written.
# Planted leaks are assembled from pieces so this file itself passes the gate.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
X="$REPO/ops/scripts/hq-public-export.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "ok   $1"; }
bad() { fail=$((fail + 1)); echo "FAIL $1"; }
check() { # check <name> <got> <want>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi
}

AT="@"; SK="sk""-"; TN="tail""abc123"
# fixture <dir>: a fresh hq-like tree, committed, with allow and deny files
fixture() {
  local F="$1"; rm -rf "$F"; mkdir -p "$F/ops/scripts" "$F/ops/config" "$F/state" "$F/docs"
  cat >"$F/CLAUDE.md" <<'EOF'
# Constitution
Ask Quilla before you touch Zorbacorp money.

| Rig | Path | Branch | Notes |
|---|---|---|---|
| example-app | rigs/example-app | main | own ledger; finish.sh deploys by API |
| example-site | rigs/example-site | main | hq ledger; public-facing (redteam) |
| example-pos | rigs/example-pos | main | hq ledger; money surface (redteam); no deploy |
EOF
  printf '\nDashboard: https://box.%s.ts.net:8790\n' "$TN" >>"$F/CLAUDE.md"
  printf '#!/bin/sh\n# probes the Zorbacorp server for Quilla\nexec ops/scripts/zorbacorp-probe.sh\n' >"$F/ops/scripts/run.sh"
  printf '#!/bin/sh\necho probe\n' >"$F/ops/scripts/zorbacorp-probe.sh"
  chmod +x "$F/ops/scripts/run.sh" "$F/ops/scripts/zorbacorp-probe.sh"
  printf 'Zorbacorp pays Quilla; mail quilla%szorbacorp.mx\n' "$AT" >"$F/state/client-notes.md"
  printf 'design notes, nothing private\n' >"$F/docs/design.md"
  printf 'PNG\0\0binary' >"$F/ops/scripts/logo.bin"
  cat >"$F/ops/config/public-export.allow" <<'EOF'
CLAUDE.md
ops/
docs/
!docs/private/
ok [a-z]+@example\.com
EOF
  printf 'zorbacorp.mx\texample.com\nZorbacorp\tClientA\nQuilla\tPerson A\tw\ntailabc123\texample\n' \
    >"$F/ops/config/public-export.deny"
  git -C "$F" init -q && git -C "$F" add -A && git -C "$F" -c user.name=t -c user.email=t"$AT"example.com commit -qm fixture
  printf 'untracked Zorbacorp scratch\n' >"$F/ops/scripts/scratch.txt"
}
run() { # run <root> <args...>: sets rc, out, err
  local R="$1"; shift
  out=$("$X" --root "$R" --log "$T/run.log" "$@" 2>"$T/err"); rc=$?; err=$(cat "$T/err")
}
# prun <root> <allow> <deny> <args...>: commit the two lists into <root> (made a repository if it is a
# plain dir, everything in it committed) as .cfg/allow and .cfg/deny, then run with those repo-relative
# paths: the script reads its config from the root's HEAD only (hq-an7jw.16)
prun() {
  local R="$1" A="$2" D="$3"; shift 3
  mkdir -p "$R/.cfg"; cp "$A" "$R/.cfg/allow"; cp "$D" "$R/.cfg/deny"
  [ -e "$R/.git" ] || git -C "$R" init -q
  git -C "$R" add -A && git -C "$R" -c user.name=t -c user.email=t"$AT"example.com commit -q --allow-empty -m cfg
  run "$R" --allow .cfg/allow --deny .cfg/deny "$@"
}

# 1. clean tree: exit 0, allowed file scrubbed, excluded and untracked files absent
F="$T/hq1"; fixture "$F"
run "$F" --out "$T/o1"
check "clean export exits 0" "$rc" 0
grep -q 'Ask Person A before you touch ClientA money' "$T/o1/CLAUDE.md" \
  && ok "allowed file scrubbed to placeholders" || bad "allowed file scrubbed: $(head -3 "$T/o1/CLAUDE.md")"
grep -q 'box.example.ts.net' "$T/o1/CLAUDE.md" && ok "tailnet name scrubbed" || bad "tailnet name scrubbed"
grep -q '^| example-app |' "$T/o1/CLAUDE.md" && ! grep -qi 'client POS' "$T/o1/CLAUDE.md" \
  && ok "rig table replaced by the example table" || bad "rig table: $(grep '^|' "$T/o1/CLAUDE.md")"
[ ! -e "$T/o1/state/client-notes.md" ] && ok "excluded file skipped" || bad "excluded file skipped"
[ ! -e "$T/o1/ops/scripts/scratch.txt" ] && ok "untracked file skipped" || bad "untracked file skipped"
[ ! -e "$T/o1/ops/scripts/logo.bin" ] && grep -q 'skipped ops/scripts/logo.bin (binary)' "$T/run.log" \
  && ok "binary file skipped and logged" || bad "binary file skipped and logged"
[ ! -e "$T/o1/ops/config/public-export.deny" ] && ok "denylist never exported" || bad "denylist never exported"
[ -x "$T/o1/ops/scripts/ClientA-probe.sh" ] && [ ! -e "$T/o1/ops/scripts/zorbacorp-probe.sh" ] \
  && ok "file name scrubbed, mode kept" || bad "file name scrubbed: $(ls "$T/o1/ops/scripts")"
grep -q 'exec ops/scripts/ClientA-probe.sh' "$T/o1/ops/scripts/run.sh" \
  && ok "reference follows the renamed file" || bad "reference follows the renamed file"
check "no denylist term anywhere in the output" "$(grep -rilE 'zorbacorp|quilla|tailabc123' "$T/o1" | wc -l)" 0
grep -q "'Zorbacorp' -> 'ClientA'" "$T/run.log" && grep -q 'replacements total' "$T/run.log" \
  && ok "run log holds the replacement map and counts" || bad "run log map: $(cat "$T/run.log")"

# 2. --check: same verdict, writes nothing
run "$F" --check
check "--check on a clean tree exits 0" "$rc" 0

# 3. planted secret in an allowed file the denylist cannot scrub: exit 2, file and line named, nothing written
F="$T/hq3"; fixture "$F"
printf 'line one\nKEY=%sABCDEFGHIJKLMNOPQRSTUV12\n' "$SK" >"$F/docs/design.md"; git -C "$F" commit -qam leak
run "$F" --out "$T/o3"
check "unscrubbable secret exits 2" "$rc" 2
grep -q 'LEAK docs/design.md:2: api-key' <<<"$err" && ok "leak names file and line" || bad "leak names file and line: $err"
[ ! -e "$T/o3" ] && ok "refused run writes no output" || bad "refused run writes no output"

# 4. planted email in an allowed file, not on the denylist: exit 2
F="$T/hq4"; fixture "$F"
printf 'contact owner%srealmail.org\n' "$AT" >>"$F/docs/design.md"; git -C "$F" commit -qam leak
run "$F" --check
check "unlisted email exits 2" "$rc" 2
grep -q 'docs/design.md:2: email' <<<"$err" && ok "email leak named" || bad "email leak named: $err"

# 5. the same leak in an excluded file is ignored
F="$T/hq5"; fixture "$F"
mkdir -p "$F/docs/private"; printf 'KEY=%sABCDEFGHIJKLMNOPQRSTUV12\n' "$SK" >"$F/docs/private/keys.md"; git -C "$F" add -A; git -C "$F" commit -qm x
run "$F" --check
check "leak in an excluded file does not block" "$rc" 0

# 6. unscrubbable file name (an email shape): exit 2 naming it
F="$T/hq6"; fixture "$F"
touch "$F/docs/notes-owner${AT}realmail.org.md"; git -C "$F" add -A; git -C "$F" commit -qm x
run "$F" --out "$T/o6"
check "unscrubbable file name exits 2" "$rc" 2
grep -q 'REFUSED docs/notes-owner.*unscrubbable file name (email)' <<<"$err" && ok "file name refusal named" || bad "file name refusal: $err"

# 7. a case variant the scrub misses (case-sensitive entry) survives: gate exits 2
F="$T/hq7"; fixture "$F"
printf 'Quilla\tPerson A\tcw\n' >>"$F/ops/config/public-export.deny"
sed -i '/^Quilla\tPerson A\tw$/d' "$F/ops/config/public-export.deny"
printf 'QUILLA signs off\n' >>"$F/docs/design.md"; git -C "$F" commit -qam x
run "$F" --check
check "surviving denylist term exits 2" "$rc" 2
grep -q 'docs/design.md:2: denylist term survived scrub' <<<"$err" && ok "surviving term named" || bad "surviving term: $err"

# 8. symlink out of the root: exit 2; symlink inside the root is kept as a link
F="$T/hq8"; fixture "$F"
ln -s ../../../etc/hostname "$F/docs/escape"; git -C "$F" add -A; git -C "$F" commit -qm x
run "$F" --check
check "symlink outside the root exits 2" "$rc" 2
grep -q 'REFUSED docs/escape: symlink points outside the root' <<<"$err" && ok "symlink refusal named" || bad "symlink refusal: $err"
F="$T/hq8b"; fixture "$F"
ln -s design.md "$F/docs/alias.md"; git -C "$F" add -A; git -C "$F" commit -qm x
run "$F" --out "$T/o8"
check "symlink inside the root exits 0" "$rc" 0
[ -L "$T/o8/docs/alias.md" ] && check "inside symlink kept" "$(readlink "$T/o8/docs/alias.md")" design.md || bad "inside symlink kept"

# 9. env file selected by the allowlist: exit 2
F="$T/hq9"; fixture "$F"
printf 'A=1\n' >"$F/ops/.env"; git -C "$F" add -f ops/.env; git -C "$F" commit -qm x
run "$F" --check
check "allowlisted .env exits 2" "$rc" 2

# 10. fail-closed config: missing allowlist, missing denylist, empty selection, bad replacement
F="$T/hq10"; fixture "$F"
# crun <root> <file> <allow|deny> <args...>: commit <file> as .cfg/<name> and run with it
crun() {
  local R="$1" S="$2" K="$3"; shift 3
  mkdir -p "$R/.cfg"; cp "$S" "$R/.cfg/${S##*/}"
  git -C "$R" add -A && git -C "$R" -c user.name=t -c user.email=t"$AT"example.com commit -qm cfg
  run "$R" "--$K" ".cfg/${S##*/}" "$@"
}
run "$F" --check --allow .cfg/nope.allow
check "missing allowlist exits 1" "$rc" 1
run "$F" --check --deny .cfg/nope.deny
check "missing denylist exits 1" "$rc" 1
: >"$T/zero.allow"; crun "$F" "$T/zero.allow" allow --check
check "empty committed allowlist exits 1" "$rc" 1
printf 'nothing/here/\n' >"$T/empty.allow"
crun "$F" "$T/empty.allow" allow --check
check "allowlist selecting nothing exits 3" "$rc" 3
printf '!ops/\n' >"$T/neg.allow"
crun "$F" "$T/neg.allow" allow --check
check "allowlist with no include lines exits 1" "$rc" 1
printf 'Zorbacorp\tQuilla Inc\nQuilla\tPerson A\n' >"$T/loop.deny"
crun "$F" "$T/loop.deny" deny --check
check "replacement holding a denylist term exits 1" "$rc" 1
printf 'Zorbacorp\tClientA\tz\n' >"$T/flag.deny"
crun "$F" "$T/flag.deny" deny --check
check "unknown denylist flag exits 1" "$rc" 1

# 11. --out must be empty and outside the root; usage errors
F="$T/hq11"; fixture "$F"
mkdir -p "$T/o11"; touch "$T/o11/stale"
run "$F" --out "$T/o11"
check "non-empty --out exits 1" "$rc" 1
run "$F" --out "$F/export"
check "--out inside the root exits 1" "$rc" 1
run "$F"
check "no --out or --check exits 1" "$rc" 1

# 12. whole-word flag: the term inside a longer word is left alone
F="$T/hq12"; fixture "$F"
printf 'Quillacorp and Quilla\n' >"$F/docs/design.md"; git -C "$F" commit -qam x
run "$F" --out "$T/o12"
check "whole-word entry exits 0" "$rc" 0
check "whole-word entry scrubs only the word" "$(cat "$T/o12/docs/design.md")" "Quillacorp and Person A"

# 13. round 2 shapes (hq-an7jw.4): each planted line alone in an allowed file exits 2 naming the
# file, line and shape. Values are assembled from pieces so this file passes the gate itself.
plant() { # plant <name> <shape> <line>: fresh non-git root with ops/scripts/p.txt, allow ops/
  local R="$T/p-$1"; rm -rf "$R"; mkdir -p "$R/ops/scripts"
  printf 'ops/\n' >"$T/p.allow"; printf 'zorbacorp\tClientA\n' >"$T/p.deny"
  printf '%s\n' "$3" >"$R/ops/scripts/p.txt"
  prun "$R" "$T/p.allow" "$T/p.deny" --out "$T/po-$1"
  check "$1 exits 2" "$rc" 2
  grep -q "LEAK ops/scripts/p.txt:1: $2" <<<"$err" && ok "$1 named as $2" || bad "$1 named as $2: $err"
  [ ! -e "$T/po-$1" ] || bad "$1 wrote output"
}
G2="45 67"; TK="tsk""ey-auth-kAbCdEf1CNTRL-AbCdEfGhIjKlMnOpQrStUv"; PW="pass""word"
plant "MX phone 3-3-2-2 spaces" phone "call 555 123 $G2"
plant "MX phone 3-3-2-2 dashes" phone "call 555-123-${G2/ /-}"
plant "MX phone 3-3-2-2 dots" phone "call 555.123.${G2/ /.}"
plant "bare 10-digit phone" phone "cel 555""1234567"
plant "lowercase secret assignment" secret-assign "db_$PW=Sup3rS3cretValue"
plant "JSON secret key" secret-assign "{\"$PW\": \"hunter2hunter2X9\"}"
plant "YAML secret key" secret-assign "  $PW: Sup3rS3cretValue"
plant "CLI secret flag" secret-assign "tool --$PW Sup3rS3cretValue1"
plant "bare key with a generated value" secret-assign "\"k""ey\": \"AbCd1234EfGh5678\""
plant "tskey token" api-key "auth with $TK"
plant "Bearer token" api-key "Authorization: Bear""er Xk9aB2cD3eF4gH5iJ6kL7mN8"
plant "re_ token" api-key "r""e_AbCd1234_EfGhIjKlMnOpQrStUvWx"

# 14. guards: long digit runs, timestamps, dates, dotted code references, code keys and short
# placeholders stay clean
R="$T/p-guard"; rm -rf "$R"; mkdir -p "$R/ops/scripts"
cat >"$R/ops/scripts/p.txt" <<EOF
id 55512345678901 and hash 5551234567890abc
ts 1730000000 on 2026-11-05 at 19:31:00
token: cfg.n8nToken, vercelToken: env.CONSOLE_VERCEL_TOKEN || ""
const KEY = "hq.console.settings"; "key":"cache_creation_5m_tokens"
$PW: changeme and hunter2 alone and token=<your-token>
EOF
prun "$R" "$T/p.allow" "$T/p.deny" --out "$T/po-guard"
check "guarded non-secrets exit 0" "$rc" 0

# 15. symlink targets: gated like file names, and a target outside the export is refused
F="$T/hq15"; fixture "$F"
ln -s "../../state/quilla${AT}realcorp.com" "$F/ops/scripts/eml"; git -C "$F" add -A; git -C "$F" commit -qm x
run "$F" --out "$T/o15"
check "symlink target with an email exits 2" "$rc" 2
grep -q 'REFUSED ops/scripts/eml: unscrubbable symlink target (email)' <<<"$err" \
  && ok "symlink target refusal named" || bad "symlink target refusal: $err"
[ ! -e "$T/o15" ] && ok "refused symlink run writes no output" || bad "refused symlink run writes no output"
F="$T/hq15b"; fixture "$F"
ln -s ../../state/client-notes.md "$F/ops/scripts/notes"; git -C "$F" add -A; git -C "$F" commit -qm x
run "$F" --check
check "symlink to a non-exported file exits 2" "$rc" 2
grep -q 'REFUSED ops/scripts/notes: symlink target is not exported' <<<"$err" \
  && ok "non-exported target named" || bad "non-exported target: $err"
F="$T/hq15c"; fixture "$F"
ln -s ../scripts "$F/ops/config/scripts"; git -C "$F" add -A; git -C "$F" commit -qm x
run "$F" --check
check "symlink to an exported dir exits 0" "$rc" 0

# 16. whole-word terms: a plural without an apostrophe is the word; the suffix is kept
F="$T/hq16"; fixture "$F"
printf 'Quillas and Quillaes, Quilla'"'"'s pen\n' >"$F/docs/design.md"; git -C "$F" commit -qam x
run "$F" --out "$T/o16"
check "plural whole-word export exits 0" "$rc" 0
check "plural and possessive scrubbed, suffix kept" "$(cat "$T/o16/docs/design.md")" "Person As and Person Aes, Person A's pen"

# 17. run log: mode 600, or the run fails
F="$T/hq17"; fixture "$F"
printf 'stale\n' >"$T/l17.log"; chmod 644 "$T/l17.log"
run "$F" --check --log "$T/l17.log"
check "run log rewritten with mode 600" "$rc:$(stat -c %a "$T/l17.log")" "0:600"
mkdir -p "$T/ro"; chmod 500 "$T/ro"
run "$F" --out "$T/o17" --log "$T/ro/run.log"
check "unwritable run log exits 1" "$rc" 1
[ ! -e "$T/o17" ] && ok "unwritable log writes no output" || bad "unwritable log writes no output"
ln -s "$T/l17.log" "$T/link.log"
run "$F" --check --log "$T/link.log"
check "symlinked run log exits 1" "$rc" 1

# 18. round 3 (hq-an7jw.5, lucy r2): a run log inside --out or the root is refused before any work
F="$T/hq18"; fixture "$F"
run "$F" --out "$T/o18" --log "$T/o18/run.log"
check "log inside --out exits 1" "$rc" 1
grep -q "log must be outside --out: .*o18/run.log" <<<"$err" && ok "log inside --out named" || bad "log inside --out named: $err"
[ ! -e "$T/o18/run.log" ] && [ -z "$(ls -A "$T/o18" 2>/dev/null)" ] && ok "log inside --out writes nothing" || bad "log inside --out writes nothing"
run "$F" --check --log "$F/ops/run.log"
check "log inside the root exits 1" "$rc" 1
grep -q "log must be outside the root: .*hq18/ops/run.log" <<<"$err" && ok "log inside the root named" || bad "log inside the root named: $err"
[ ! -e "$F/ops/run.log" ] && ok "log inside the root not written" || bad "log inside the root not written"

# 19. phones at a sentence end, after tel:, and in a file name; quoted dotted and two-line secrets
P1="555 123 $G2"; P10="555""1234567"
plant "MX phone at a sentence end" phone "Llama al $P1."
plant "bare phone at a sentence end" phone "$P10."
plant "tel: phone" phone "tel:$P10"
plant "quoted dotted password" secret-assign "{\"$PW\":\"Sup3r.S3cretValue\"}"
plant "two-line JSON password" secret-assign "{\"$PW\":
 \"Sup3rS3cretValue\"}"
plant "two-line YAML password" secret-assign "$PW:
  Sup3rS3cretValue"
R="$T/p-ml"; rm -rf "$R"; mkdir -p "$R/ops/scripts"
printf 'line one\n{"%s":\n "Sup3rS3cretValue"}\n' "$PW" >"$R/ops/scripts/p.txt"
prun "$R" "$T/p.allow" "$T/p.deny" --check
grep -q "LEAK ops/scripts/p.txt:2: secret-assign" <<<"$err" && ok "two-line secret names the key's line" || bad "two-line secret line: $err"
R="$T/p-name"; rm -rf "$R"; mkdir -p "$R/docs"; printf 'x\n' >"$R/docs/$P10.md"; printf 'docs/\n' >"$T/d.allow"
prun "$R" "$T/d.allow" "$T/p.deny" --out "$T/po-name"
check "phone in a file name exits 2" "$rc" 2
grep -q "REFUSED docs/$P10.md: unscrubbable file name (phone)" <<<"$err" && ok "phone file name named" || bad "phone file name: $err"
# guards still hold next to the new punctuation edges
R="$T/p-guard3"; rm -rf "$R"; mkdir -p "$R/ops/scripts"
cat >"$R/ops/scripts/p.txt" <<EOF
ratio 1.$P10 and $P10.5 and v$P10.md and 55512345678901.
ts 1730000000. id 2026-11-05. hash 5551234567890abc.
EOF
prun "$R" "$T/p.allow" "$T/p.deny" --check
check "decimals, long runs and hashes at punctuation stay clean" "$rc" 0

# 20. a symlink to a selected file that is skipped (binary) is refused against the staged tree
F="$T/hq20"; fixture "$F"
ln -s logo.bin "$F/ops/scripts/logo"; git -C "$F" add -A; git -C "$F" commit -qm x
run "$F" --out "$T/o20"
check "symlink to a skipped binary exits 2" "$rc" 2
grep -q 'REFUSED ops/scripts/logo: symlink target is not exported (logo.bin)' <<<"$err" \
  && ok "skipped-target symlink named" || bad "skipped-target symlink: $err"
[ ! -e "$T/o20" ] && ok "skipped-target symlink run writes no output" || bad "skipped-target symlink run writes no output"

# 21. round 4 (hq-an7jw.6): --out is canonical, last component included
F="$T/hq21"; fixture "$F"
mkdir -p "$T/pub21"; ln -s "$T/pub21" "$T/exp21"
run "$F" --out "$T/exp21" --log "$T/pub21/run.log"
check "symlinked --out with the log in its target exits 1" "$rc" 1
grep -q "log must be outside --out: .*pub21/run.log" <<<"$err" && ok "symlinked --out log named" || bad "symlinked --out log named: $err"
[ -z "$(ls -A "$T/pub21")" ] && ok "symlinked --out target stays empty" || bad "symlinked --out target: $(ls -A "$T/pub21")"
mkdir -p "$T/sub21"
run "$F" --out "$T/sub21/../dot21" --log "$T/dot21/run.log"
check ".. alias of --out with the log inside exits 1" "$rc" 1
[ ! -e "$T/dot21/run.log" ] && ok ".. alias writes no log" || bad ".. alias writes no log"
mkdir -p "$F/empty21"; ln -s "$F/empty21" "$T/in21"
run "$F" --out "$T/in21"
check "symlinked --out into the root exits 1" "$rc" 1
grep -q "out must be outside the root: .*hq21/empty21" <<<"$err" && ok "symlinked --out into the root named" || bad "symlinked --out into the root: $err"
[ -z "$(ls -A "$F/empty21")" ] && ok "root stays unwritten" || bad "root written: $(ls -A "$F/empty21")"
run "$F" --out "$T/missing21/parent/o"
check "--out with a missing parent exits 1" "$rc" 1
[ ! -e "$T/missing21" ] && ok "missing parent not created" || bad "missing parent created"
run "$F" --out "$T/exp21"
check "symlinked empty --out exports into its target" "$rc:$([ -f "$T/pub21/CLAUDE.md" ] && echo y)" "0:y"

# 22. round 4: complete Mexican numbers with a country prefix and a parenthesized area code
plant "MX phone +52 and parens" phone "Llama al +52 (555) 123 $G2."
plant "MX phone tel:+52 dashes" phone "tel:+52-555-123-${G2/ /-}"
plant "MX phone wa.me 12 digits" phone "https://wa.me/52$P10"
plant "MX phone tel:52 12 digits" phone "tel:52$P10"
plant "MX phone +52 1 mobile" phone "cel +52 1 555 123 $G2"
plant "MX phone 0052 prefix" phone "marca 0052 $P1"
plant "MX phone 3-7 grouping" phone "cel 555 ""1234567"
R="$T/p-name4"; rm -rf "$R"; mkdir -p "$R/docs"; printf 'x\n' >"$R/docs/+52-555-123-${G2/ /-}.md"
prun "$R" "$T/d.allow" "$T/p.deny" --out "$T/po-name4"
check "+52 phone in a file name exits 2" "$rc" 2
grep -q "REFUSED docs/+52-555-123-${G2/ /-}.md: unscrubbable file name (phone)" <<<"$err" && ok "+52 phone file name named" || bad "+52 phone file name: $err"

# 23. round 4: a secret value after a comment, a block indicator, a list dash, a backtick or a // comment
NL=$'\n'
plant "YAML secret after a comment" secret-assign "$PW: # production credential${NL}  Sup3rS3cretValue"
plant "YAML secret block |" secret-assign "$PW: |${NL}  Sup3rS3cretValue"
plant "YAML secret block >-" secret-assign "$PW: >-${NL}  Sup3rS3cretValue"
plant "YAML secret list item" secret-assign "api_tokens:${NL}  - Sup3rS3cretValue"
plant "YAML secret after a comment line" secret-assign "$PW:${NL}# prod${NL}  Sup3rS3cretValue"
plant "backtick secret value" secret-assign "$PW: \`Sup3rS3cretValue\`"
plant "JSON secret after a slash-slash comment" secret-assign "{\"$PW\": // prod${NL} \"Sup3rS3cretValue\"}"
plant "secret value with unsupported syntax" "secret key with unsupported value syntax" "$PW:${NL}  [Sup3rS3cretValue, x]"
# 24. round 4: a quoted value is gated whole, "/" included
plant "quoted base64 password" secret-assign "{\"$PW\":\"aB3dE5/gH7iJ9kL2\"}"
# guards: an empty value then another key, code that tests a token, unquoted references and paths
R="$T/p-guard4"; rm -rf "$R"; mkdir -p "$R/ops/scripts"
cat >"$R/ops/scripts/p.txt" <<EOF
$PW:
user: bob
token: cfg.n8nToken
api_token: \${API_TOKEN_2026_VALUE}
secret: ops/config/secret2026.txt
EOF
printf 'if token:\n    return run_it(token, 20261105)\n' >"$R/ops/scripts/q.py"
prun "$R" "$T/p.allow" "$T/p.deny" --check
check "empty value then a key, code and unquoted references stay clean" "$rc" 0

# 25. round 4: a term right after a source escape (\t, \n) is scrubbed and gated
R="$T/p-esc"; rm -rf "$R"; mkdir -p "$R/ops/scripts"
printf 'x = "abc\\t1755500000\\tQuilla\\tmsg\\n"\n' >"$R/ops/scripts/p.txt"
printf 'Quilla\tPerson A\tcw\n' >"$T/esc.deny"
prun "$R" "$T/p.allow" "$T/esc.deny" --out "$T/po-esc"
check "term after an escape exports" "$rc" 0
check "term after an escape scrubbed" "$(cat "$T/po-esc/ops/scripts/p.txt" 2>/dev/null)" 'x = "abc\t1755500000\tPerson A\tmsg\n"'
grep -q 'replacements total 1 over 1 terms' "$T/run.log" && ok "escape replacement counted" || bad "escape replacement: $(grep total "$T/run.log")"
printf 'x = "\\nQUILLA"\n' >"$R/ops/scripts/p.txt"
prun "$R" "$T/p.allow" "$T/esc.deny" --check
check "case variant after an escape gated" "$rc" 2

# 26. --gate: checks a tree as it is (no scrub), so a term a scrub would hide still fails
R="$T/g1"; rm -rf "$R"; mkdir -p "$R/docs"; printf 'clean text\n' >"$R/docs/a.md"
run "$T/hq1" --gate "$R"
check "--gate on a clean tree exits 0" "$rc" 0
printf 'mail Zorbacorp\n' >"$R/README.md"
run "$T/hq1" --gate "$R"
check "--gate refuses a term a scrub would have replaced" "$rc" 2
echo "$err" | grep -q 'README.md:1: denylist term' && ok "--gate names the file outside the allowlist" || bad "--gate names: $err"

# 27. --push (hq-an7jw.11): a fresh temp repo from origin, commit naming the hq sha, push; idempotent.
# The checkout given is read for its origin url only: every case checks it byte for byte, .git
# included, and that no temp dir is left behind (every run's TMPDIR is $TMPDIR below).
GE=(-c user.name=t -c user.email=t"$AT"example.com)
REALGIT=$(command -v git)
export TMPDIR="$T/tmp"; mkdir -p "$TMPDIR"
# pushfix <name>: a fresh root with ops/public (README.md, LICENSE), a bare origin on main, a clone; sets F, O, C
pushfix() {
  F="$T/$1"; fixture "$F"; rm -f "$F/ops/scripts/scratch.txt"
  printf "!ops/public/\n" >>"$F/ops/config/public-export.allow"
  mkdir -p "$F/ops/public"; printf '# Public README\n' >"$F/ops/public/README.md"; printf 'MIT\n' >"$F/ops/public/LICENSE"
  git -C "$F" add -A && git -C "$F" "${GE[@]}" commit -qm public
  O="$T/$1.git"; C="$T/$1.co"; rm -rf "$O" "$C"
  git init -q --bare -b main "$O"; git clone -q "$O" "$C" 2>/dev/null
  git -C "$C" config user.name t; git -C "$C" config user.email t"$AT"example.com
}
snap() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16); }
untouched() { # untouched <label> <snap before>: the checkout is byte-identical and no temp dir is left
  check "$1: checkout byte-identical" "$(snap "$C")" "$2"
  check "$1: no temp dir left" "$(ls -A "$TMPDIR" | tr '\n' ' ')" ""
}
nothing_pushed() { # nothing_pushed <label> <snap before>: origin has no branch, the checkout is untouched
  [ -z "$(git -C "$O" for-each-ref)" ] && ok "$1: nothing pushed" || bad "$1: something pushed"
  untouched "$1" "$2"
}
more() { printf '%s\n' "${1:-more}" >>"$F/docs/design.md"; git -C "$F" "${GE[@]}" commit -qam more; }
pushfix pf0; s0=$(snap "$C")
run "$F" --push "$C"
check "--push exits 0" "$rc" 0
SHA=$(git -C "$F" rev-parse HEAD)
check "commit names the hq sha" "$(git -C "$O" log -1 --format=%s main)" "export from hq $SHA"
check "first export on an unborn origin has no parent" "$(git -C "$O" rev-list --count main)" 1
lst=$(git -C "$O" ls-tree --name-only main)
grep -qx README.md <<<"$lst" && grep -qx LICENSE <<<"$lst" && ! grep -qx ops/public <<<"$(git -C "$O" ls-tree -r --name-only main)" \
  && ok "public files land at the top, ops/public is not exported" || bad "public files: $lst"
grep -q 'Ask Person A before you touch ClientA money' <<<"$(git -C "$O" show main:CLAUDE.md)" && ok "pushed tree is scrubbed" || bad "pushed tree scrubbed"
untouched "successful push" "$s0"
grep -q "pull --ff-only" <<<"$out" && ok "success prints the pull hint" || bad "pull hint: $out"
# DoD 4: the pushed tree is the tree of the gated export, computed apart from the script
run "$F" --out "$T/pf0.exp"; cp "$F/ops/public/README.md" "$F/ops/public/LICENSE" "$T/pf0.exp/"
git init -q "$T/pf0.exp"; git -C "$T/pf0.exp" -c core.autocrlf=false add -A
check "pushed tree id equals the tree of the gated export" "$(git -C "$O" rev-parse 'main^{tree}')" "$(git -C "$T/pf0.exp" write-tree)"
n=$(git -C "$O" rev-list --count main)
run "$F" --push "$C"
check "second --push with no hq change exits 0" "$rc" 0
check "second --push makes no commit" "$(git -C "$O" rev-list --count main)" "$n"
grep -q 'no change' <<<"$out" && ok "no-change run says so" || bad "no-change: $out"
untouched "no-change run" "$s0"

# 28. --push fail-closed: a leak in the public files or the export means no push, nothing changed
printf 'ask Zorbacorp\n' >"$F/ops/public/CONTRIBUTING.md"
git -C "$F" add -A && git -C "$F" "${GE[@]}" commit -qm leak
o_head=$(git -C "$O" rev-parse main)
run "$F" --push "$C"
check "--push with a leaking public file exits 2" "$rc" 2
check "no push after a gate failure" "$(git -C "$O" rev-parse main)" "$o_head"
untouched "gate failure" "$s0"
git -C "$F" rm -q ops/public/CONTRIBUTING.md
printf 'mail z%sgmail.com\n' "$AT" >"$F/docs/design.md"
git -C "$F" add -A && git -C "$F" "${GE[@]}" commit -qm leak2
run "$F" --push "$C"
check "--push with an export leak exits 2" "$rc" 2
check "no push after an export leak" "$(git -C "$O" rev-parse main)" "$o_head"
untouched "export leak" "$s0"

# 28b. lucy r4 finding 1 (hq-an7jw.10): a clean filter in the checkout hides a local line from git;
# a refused run must leave that line and every other byte of the checkout as it was
pushfix pf1f; run "$F" --push "$C"; git -C "$C" pull -q 2>/dev/null
printf 'README.md filter=local\n' >"$C/.git/info/attributes"; git -C "$C" config filter.local.clean "sed '/^LOCAL:/d'"
printf 'LOCAL: only copy of my notes\n' >>"$C/README.md"; git -C "$C" add -A
check "clean filter: git status calls the checkout clean" "$(git -C "$C" status --porcelain | wc -l | tr -d ' ')" 0
s1=$(snap "$C"); o_head=$(git -C "$O" rev-parse main)
printf 'ask Zorbacorp\n' >"$F/ops/public/CONTRIBUTING.md"; git -C "$F" add -A && git -C "$F" "${GE[@]}" commit -qm leak
run "$F" --push "$C"
check "clean filter: the refused run exits 2" "$rc" 2
check "clean filter: the local line survives" "$(grep -c '^LOCAL: only copy of my notes' "$C/README.md")" 1
check "clean filter: origin not moved" "$(git -C "$O" rev-parse main)" "$o_head"
untouched "clean filter refusal" "$s1"

# 29. --push refusals: a dirty root, a dir that is not a checkout, a checkout with no origin
pushfix pf2r; run "$F" --push "$C"; s2=$(snap "$C"); o_head=$(git -C "$O" rev-parse main)
printf 'edit\n' >>"$F/docs/design.md"
run "$F" --push "$C"
check "--push refuses uncommitted tracked changes in the root" "$rc" 1
git -C "$F" "${GE[@]}" commit -qam fixed
mkdir -p "$T/notgit"; run "$F" --push "$T/notgit"
check "--push refuses a dir that is not a checkout" "$rc" 1
run "$F" --push "$T/no-such-dir"
check "--push refuses a missing dir" "$rc" 1
check "refusals: origin not moved" "$(git -C "$O" rev-parse main)" "$o_head"
untouched "refusals" "$s2"
run "$F" --push "$C"
check "--push after the fix exits 0" "$rc" 0
run "$F" --check --push "$C"
check "--push and --check are exclusive" "$rc" 1
pushfix pf23; git -C "$C" remote remove origin; s3=$(snap "$C")
run "$F" --push "$C"; check "--push refuses a checkout with no origin" "$rc" 1
nothing_pushed "no origin" "$s3"

# 30. --gate passes only what it read: binary, latin-1, unreadable and non-regular files are refusals
R="$T/g2"; rm -rf "$R"; mkdir -p "$R"; printf 'clean\n' >"$R/ok.md"; printf 'x\0y\nmail Zorbacorp\n' >"$R/blob.bin"
run "$T/hq1" --gate "$R"
check "--gate refuses a binary file (deny term inside)" "$rc" 2
echo "$err" | grep -q 'blob.bin: binary' && ok "--gate names the binary file" || bad "--gate binary: $err"
rm -f "$R/blob.bin"; printf 'cliente se\xf1or\n' >"$R/latin.txt"
run "$T/hq1" --gate "$R"
check "--gate refuses a latin-1 file" "$rc" 2
rm -f "$R/latin.txt"; printf 'clean\n' >"$R/locked.txt"; chmod 000 "$R/locked.txt"
if [ "$(id -u)" -eq 0 ]; then ok "--gate unreadable file (skipped: running as root reads mode 000)"
else run "$T/hq1" --gate "$R"; check "--gate refuses an unreadable file" "$rc" 2; fi
chmod 644 "$R/locked.txt"

# 31. path-scoped ok: the CUDA pins pass in the lockfile only, never as a URL host elsewhere
CU="12.9"".2.10"  # the CUDA wheel version, in pieces so this file passes the gate
R="$T/g3"; rm -rf "$R"; mkdir -p "$R/tools/v"; printf 'nvidia-cublas-cu12==%s\n' "$CU" >"$R/tools/v/requirements.lock"
cp "$T/hq1/ops/config/public-export.allow" "$T/cuda.allow"
printf 'ok@tools/v/requirements.lock (%s)\n' "${CU//./\\.}" >>"$T/cuda.allow"
G31="$T/hq31"; fixture "$G31"
crun "$G31" "$T/cuda.allow" allow --gate "$R"
check "ok@<path> passes the pin in its own file" "$rc" 0
printf 'curl https://%s/private\n' "$CU" >"$R/tools/v/fetch.sh"
run "$G31" --gate "$R" --allow .cfg/cuda.allow
check "the CUDA version as a URL host in another file fails the gate" "$rc" 2
rm -f "$R/tools/v/requirements.lock"
run "$REPO" --gate "$R"
check "the real allowlist does not pass the CUDA version as a URL host in another file" "$rc" 2

# 32. --push takes only the fixed public files, each checked, before anything is pushed
pushfix pf1; s=$(snap "$C"); printf 'PNG\0\0 Zorbacorp\n' >"$F/ops/public/logo.png"; git -C "$F" add -A && git -C "$F" "${GE[@]}" commit -qm bin
run "$F" --push "$C"
check "--push refuses a tracked binary in ops/public" "$rc" 2
nothing_pushed "tracked binary in ops/public" "$s"
pushfix pf2; s=$(snap "$C"); printf 'draft notes\n' >"$F/ops/public/draft.txt"
run "$F" --push "$C"
check "--push ignores an untracked file in ops/public (the committed dir decides)" "$rc" 0
grep -q 'draft' <<<"$(git -C "$O" ls-tree -r --name-only main 2>/dev/null)" && bad "untracked draft.txt reached origin" || ok "untracked draft.txt not on origin"
pushfix pf3; s=$(snap "$C"); run "$F" --push "$C" --public no-such-public
check "--push refuses a missing --public dir" "$rc" 1
nothing_pushed "missing --public dir" "$s"
pushfix pf4; s=$(snap "$C"); git -C "$F" rm -q ops/public/LICENSE && git -C "$F" "${GE[@]}" commit -qm nolicense
run "$F" --push "$C"
check "--push refuses a missing required public file" "$rc" 1
nothing_pushed "missing LICENSE" "$s"
pushfix pf5; s=$(snap "$C"); git -C "$F" mv ops/public/LICENSE docs/LICENSE; ln -s ../../docs/LICENSE "$F/ops/public/LICENSE"
git -C "$F" add -A && git -C "$F" "${GE[@]}" commit -qm linklicense
run "$F" --push "$C"
check "--push refuses a committed symlink as a public file" "$rc" 1
grep -q 'not a committed regular file' <<<"$err" && ok "public symlink names the cause" || bad "public symlink: $err"
nothing_pushed "committed public symlink" "$s"
# a --public dir whose name holds glob characters is read literally: p[ab] is not committed, pa is
pushfix pf19; s=$(snap "$C"); mkdir -p "$F/pa"; printf '# R\n' >"$F/pa/README.md"; printf 'MIT\n' >"$F/pa/LICENSE"
printf '!pa/\n!p[ab]/\n' >>"$F/ops/config/public-export.allow"; git -C "$F" add -A && git -C "$F" "${GE[@]}" commit -qm pa
mkdir -p "$F/p[ab]"; printf '# untracked\n' >"$F/p[ab]/README.md"; printf 'UNTRACKED\n' >"$F/p[ab]/LICENSE"
run "$F" --push "$C" --public "p[ab]"
check "--push refuses an uncommitted --public dir named with glob characters" "$rc" 1
nothing_pushed "glob-named --public dir" "$s"
# an untracked file with an allowed name next to tracked ones in a --public dir inside the root
pushfix pf20; s=$(snap "$C"); printf 'please\n' >"$F/ops/public/CONTRIBUTING.md"
run "$F" --push "$C"
check "--push ignores an untracked CONTRIBUTING.md in ops/public" "$rc" 0
check "untracked CONTRIBUTING.md not on origin" "$(git -C "$O" cat-file -t main:CONTRIBUTING.md 2>/dev/null)" ""

# 33. the checkout's own state never reaches origin and is never changed: commits ahead, untracked
# and ignored files, a pending merge, a tag, a broken index
pushfix pf6; run "$F" --push "$C"; git -C "$C" pull -q 2>/dev/null
printf 'TOKEN=%s\n' "abc123def456""ghi789" >"$C/cred"; git -C "$C" add cred; git -C "$C" "${GE[@]}" commit -qm add
git -C "$C" rm -q cred; git -C "$C" "${GE[@]}" commit -qm del
git -C "$C" -c user.name=Me -c user.email="me$AT""gmail.com" tag -a v1 -m "private note Zorbacorp" HEAD
printf 'keep\n' >"$C/.git/info/exclude"; printf 'mine\n' >"$C/keep"; printf 'loose\n' >"$C/untracked.md"
git -C "$C" rev-parse HEAD >"$C/.git/MERGE_HEAD"; printf 'broken\n' >"$C/.git/index"
s=$(snap "$C"); more
run "$F" --push "$C"
check "--push from a checkout in any local state exits 0" "$rc" 0
check "the credential commit never reached origin" "$(git -C "$O" log --all --format=%H -- cred | wc -l | tr -d ' ')" 0
check "no tag on origin" "$(git -C "$O" for-each-ref refs/tags | wc -l | tr -d ' ')" 0
check "origin holds one branch only" "$(git -C "$O" for-each-ref --format='%(refname)')" "refs/heads/main"
untouched "checkout in any local state" "$s"

# 34. origin refuses the push (a pre-receive hook): exit 4, origin at its start
pushfix pf7; run "$F" --push "$C"; s=$(snap "$C"); o_head=$(git -C "$O" rev-parse main)
more "design notes, round two"
printf '#!/bin/sh\nexit 1\n' >"$O/hooks/pre-receive"; chmod +x "$O/hooks/pre-receive"
run "$F" --push "$C"
check "--push with a refused push exits 4" "$rc" 4
check "refused push: origin at the start tip" "$(git -C "$O" rev-parse main)" "$o_head"
untouched "refused push" "$s"
rm -f "$O/hooks/pre-receive"
run "$F" --push "$C"; check "--push after the push is fixed exits 0" "$rc" 0

# 35. commit identity: the one public identity, never the ambient config or env; an override is gated
pushfix pf8; git -C "$C" config user.email "me$AT""gmail.com"
PUBE=$(sed -n 's/^PUBLIC_NAME="[^"]*" PUBLIC_EMAIL="\([^"]*\)"$/\1/p' "$X")
out=$(GIT_AUTHOR_EMAIL="me$AT""gmail.com" GIT_COMMITTER_EMAIL="me$AT""gmail.com" "$X" --root "$F" --log "$T/run.log" --push "$C" 2>"$T/err"); rc=$?
check "--push with an ambient gmail identity exits 0" "$rc" 0
check "author and committer are the public identity" "$(git -C "$O" log --format='%ae %ce' main | sort -u)" "$PUBE $PUBE"
check "commit dates are UTC" "$(git -C "$O" log -1 --format='%ad %cd' --date=format:%z main)" "+0000 +0000"
pushfix pf9; s=$(snap "$C")
out=$(HQ_PUBLIC_NAME="Zorbacorp bot" "$X" --root "$F" --log "$T/run.log" --push "$C" 2>"$T/err"); rc=$?
check "--push refuses a public identity on the denylist" "$rc" 2
nothing_pushed "denylisted identity" "$s"

# 36. git shims: race, rewind, accepted, unknown, a descendant tip
mkdir -p "$T/shim"
cat >"$T/shim/git" <<SHIM
#!/bin/bash
# MODE=race pushes another clone first; MODE=rewind resets origin main to an older commit;
# MODE=accepted fails after a real push; MODE=unknown fails every push and then every ls-remote;
# MODE=descend pushes, puts a child of it on origin and reports failure (lucy r4 finding 3: a third tip)
for a in "\$@"; do
  if [ "\$a" = push ]; then
    case "\$MODE" in
      race) "$REALGIT" -C "\$OTHER" push -q origin HEAD:main 2>/dev/null ;;
      rewind) "$REALGIT" -C "\$ORIGIN" update-ref refs/heads/main "\$REWIND" ;;
      accepted) "$REALGIT" "\$@"; exit 1 ;;
      unknown) : >"\$MARK"; exit 1 ;;
      descend) "$REALGIT" "\$@" || exit 9
        "$REALGIT" -C "\$OTHER" pull -q origin main 2>/dev/null; echo c >"\$OTHER/child"; "$REALGIT" -C "\$OTHER" add child
        "$REALGIT" -C "\$OTHER" -c user.name=x -c user.email=x@example.com commit -qm child
        "$REALGIT" -C "\$OTHER" push -q origin HEAD:main 2>/dev/null; exit 1 ;;
    esac
    break
  fi
  if [ "\$a" = ls-remote ] && [ "\$MODE" = unknown ] && [ -e "\$MARK" ]; then exit 128; fi
done
exec "$REALGIT" "\$@"
SHIM
chmod +x "$T/shim/git"
shimrun() { out=$(PATH="$T/shim:$PATH" "$X" --root "$F" --log "$T/run.log" --push "$C" 2>"$T/err"); rc=$?; err=$(cat "$T/err"); }
pushfix pf13; run "$F" --push "$C"; s=$(snap "$C")
git clone -q "$O" "$T/pf13.other" 2>/dev/null; printf 'x\n' >"$T/pf13.other/other"
git -C "$T/pf13.other" add other && git -C "$T/pf13.other" "${GE[@]}" commit -qm other
# origin at a third commit (neither the start nor ours) is an unknown outcome by design: exit 5, temp repo kept
keptrm() { kept=$(sed -n 's/.* is kept in \(.*\)$/\1/p' <<<"$err"); [ -n "$kept" ] && [ -d "$kept" ] && ok "$1: the temp repo is kept and named" || bad "$1: kept: $err"; rm -rf "$(dirname "$kept")"; }
more; MODE=race OTHER="$T/pf13.other" shimrun
check "--push when origin moved before the push exits 5" "$rc" 5
check "origin keeps the other commit, ours never lands" "$(git -C "$O" rev-parse main)" "$(git -C "$T/pf13.other" rev-parse HEAD)"
keptrm race; untouched "race" "$s"
pushfix pf13b; run "$F" --push "$C"; old=$(git -C "$O" rev-parse main); more; run "$F" --push "$C"; s=$(snap "$C")
more again; MODE=rewind ORIGIN="$O" REWIND="$old" shimrun
check "--push when origin rewound before the push exits 5" "$rc" 5
check "origin stays where it was rewound to" "$(git -C "$O" rev-parse main)" "$old"
keptrm rewind; untouched "rewind" "$s"
pushfix pf15; run "$F" --push "$C"; s=$(snap "$C"); more
MODE=accepted shimrun
check "--push whose push fails after origin accepted exits 0" "$rc" 0
check "the accepted commit is on origin" "$(git -C "$O" log -1 --format=%s main)" "export from hq $(git -C "$F" rev-parse HEAD)"
grep -q 'nothing pushed' <<<"$err" && bad "accepted push says nothing pushed: $err" || ok "accepted push never says nothing pushed"
untouched "accepted push" "$s"
pushfix pf16; run "$F" --push "$C"; o_head=$(git -C "$O" rev-parse main); more
MODE=unknown MARK="$T/pf16.mark" shimrun
check "--push with no answer after a failed push exits 5" "$rc" 5
kept=$(sed -n 's/.* is kept in \(.*\)$/\1/p' <<<"$err")
newc=$(sed -n 's/.*the export commit \([0-9a-f]*\) is kept.*/\1/p' <<<"$err")
check "unknown outcome keeps the temp repo holding the export commit" "$(git --git-dir="$kept" log -1 --format=%s "$newc" 2>/dev/null)" "export from hq $(git -C "$F" rev-parse HEAD)"
grep -q 'nothing pushed' <<<"$err" && bad "unknown outcome says nothing pushed: $err" || ok "unknown outcome never says nothing pushed"
check "unknown outcome: origin not moved" "$(git -C "$O" rev-parse main)" "$o_head"
rm -rf "$(dirname "$kept")"
pushfix pf16b; run "$F" --push "$C"; git clone -q "$O" "$T/pf16b.other" 2>/dev/null; s=$(snap "$C"); more
MODE=descend OTHER="$T/pf16b.other" shimrun
check "lucy r4 finding 3: origin past the export commit (a descendant tip) exits 5, not 4" "$rc" 5
check "finding 3: origin history holds the export commit" "$(git -C "$O" log --format=%s main | grep -c "export from hq $(git -C "$F" rev-parse HEAD)")" 1
keptrm "finding 3"; untouched "finding 3" "$s"

# 37. one push url, reachable: two urls or an unreachable one are refused before anything is built
pushfix pf14; run "$F" --push "$C"; o_head=$(git -C "$O" rev-parse main); more
git -C "$C" remote set-url --add --push origin "$O"; git -C "$C" remote set-url --add --push origin "$T/pf14.second.git"; s=$(snap "$C")
run "$F" --push "$C"
check "--push refuses an origin with two push urls" "$rc" 1
grep -q 'exactly one push url' <<<"$err" && ok "two-url refusal names the cause" || bad "two-url refusal: $err"
untouched "two push urls" "$s"
git -C "$C" config --unset-all remote.origin.pushurl; git -C "$C" remote set-url --push origin "$T/no-such-origin.git"; s=$(snap "$C")
run "$F" --push "$C"
check "--push refuses an unreachable push url" "$rc" 1
check "unreachable url: origin not moved" "$(git -C "$O" rev-parse main)" "$o_head"
untouched "unreachable push url" "$s"

# 38. DoD 2 and lucy r4 finding 2: TERM at any point before the push leaves origin and the checkout
# unchanged and no temp dir behind (a shim runs the real git, then sends TERM to the run)
cat >"$T/shim/gitterm" <<SHIM
#!/bin/bash
for a in "\$@"; do
  if [ "\$a" = "\$TERMON" ]; then "$REALGIT" "\$@"; r=\$?; pkill -TERM -f "hq-public-export[.]sh .*--push \$TERMCO\\\$"; exit \$r; fi
done
exec "$REALGIT" "\$@"
SHIM
mkdir -p "$T/shimterm"; mv "$T/shim/gitterm" "$T/shimterm/git"; chmod +x "$T/shimterm/git"
termrun() { out=$(TERMON="$1" TERMCO="$C" PATH="$T/shimterm:$PATH" "$X" --root "$F" --log "$T/run.log" --push "$C" 2>"$T/err"); rc=$?; err=$(cat "$T/err"); }
pushfix pf21; run "$F" --push "$C"; git -C "$C" pull -q 2>/dev/null; o_head=$(git -C "$O" rev-parse main); s=$(snap "$C")
for at in init fetch add write-tree commit-tree cat-file; do
  more "term $at"; termrun "$at"
  [ "$rc" -ne 0 ] && ok "TERM after $at: nonzero exit ($rc)" || bad "TERM after $at exited 0"
  check "TERM after $at: origin not moved" "$(git -C "$O" rev-parse main)" "$o_head"
  untouched "TERM after $at" "$s"
done
termrun cat-file; check "TERM in the main shell exits 143" "$rc" 143
pushfix pf21u; s=$(snap "$C")
termrun commit-tree
[ "$rc" -ne 0 ] && ok "unborn origin, TERM after commit-tree: nonzero exit" || bad "unborn TERM exited 0"
nothing_pushed "unborn origin, TERM after commit-tree" "$s"
run "$F" --push "$C"; check "the next run after a TERM exits 0" "$rc" 0

# 39. --gate fails on any listed path it did not read: a missing tracked file, a FIFO, a dir entry,
# and the denylist itself when the gated tree holds it
R="$T/g1"; rm -rf "$R"; mkdir -p "$R"; printf 'clean\n' >"$R/ok.md"; printf 'gone\n' >"$R/CLAUDE.md"
git -C "$R" init -q; git -C "$R" add -A; rm "$R/CLAUDE.md"
run "$T/hq1" --gate "$R"
check "--gate refuses a missing tracked file" "$rc" 2
grep -q 'CLAUDE.md: missing' <<<"$err" && ok "--gate names the missing file" || bad "--gate missing: $err"
R="$T/g4"; rm -rf "$R"; mkdir -p "$R"; printf 'clean\n' >"$R/ok.md"; mkfifo "$R/pipe"
run "$T/hq1" --gate "$R"
check "--gate refuses a FIFO" "$rc" 2
echo "$err" | grep -q 'pipe: not a regular file' && ok "--gate names the FIFO" || bad "--gate FIFO: $err"
R="$T/g5"; rm -rf "$R"; mkdir -p "$R/sub"; printf 'clean\n' >"$R/ok.md"; printf 'x\n' >"$R/sub/f"
git -C "$R" init -q; git -C "$R" add ok.md; git -C "$R" update-index --add --cacheinfo 160000,"$(git -C "$F" rev-parse HEAD)",sub
run "$T/hq1" --gate "$R"
check "--gate refuses a tracked path that is a dir (gitlink)" "$rc" 2
R="$T/g6"; rm -rf "$R"; mkdir -p "$R/ops/config"; printf 'clean\n' >"$R/ok.md"; cp "$T/hq1/ops/config/public-export.deny" "$R/ops/config/"
run "$T/hq1" --gate "$R"
check "--gate on a tree holding the denylist does not skip it" "$rc" 2
# a root whose .git git cannot read is refused, never exported as a plain dir (every file listed)
R="$T/g7"; rm -rf "$R"; mkdir -p "$R/docs"; printf 'clean\n' >"$R/docs/a.md"; printf 'gitdir: %s/nowhere\n' "$T" >"$R/.git"
run "$T/hq1" --gate "$R"
check "--gate refuses a root whose .git git cannot read" "$rc" 1

# 40. an exported .gitignore does not hide an exported file from the commit; the next run still works
pushfix pf25; printf 'notes.md\n' >"$F/docs/.gitignore"; printf 'n\n' >"$F/docs/notes.md"
git -C "$F" add -f -A && git -C "$F" "${GE[@]}" commit -qm gi
run "$F" --push "$C"; check "--push with an exported .gitignore exits 0" "$rc" 0
check "the ignored-name export file is committed" "$(git -C "$O" ls-tree --name-only main docs/notes.md)" "docs/notes.md"
run "$F" --push "$C"; check "the next --push after an exported .gitignore exits 0" "$rc" 0

# 41. a git that fails reading the root is a refusal; a commit-tree that adds a parent is refused
mkdir -p "$T/shim4"
cat >"$T/shim4/git" <<SHIM
#!/bin/bash
# FAILROOT=<dir> fails "git -C <dir> status"; EXTRAPARENT=<sha> adds a parent to commit-tree
if [ -n "\${FAILROOT:-}" ] && [ "\$1" = -C ] && [ "\$2" = "\$FAILROOT" ]; then
  for a in "\$@"; do [ "\$a" = status ] && exit 128; done
fi
if [ -n "\${EXTRAPARENT:-}" ]; then
  for a in "\$@"; do [ "\$a" = commit-tree ] && exec "$REALGIT" "\$@" -p "\$EXTRAPARENT"; done
fi
exec "$REALGIT" "\$@"
SHIM
chmod +x "$T/shim4/git"
pushfix pf27; run "$F" --push "$C"; o_head=$(git -C "$O" rev-parse main); s=$(snap "$C"); more
out=$(FAILROOT="$F" PATH="$T/shim4:$PATH" "$X" --root "$F" --log "$T/run.log" --push "$C" 2>"$T/err"); rc=$?
check "--push refuses when git status fails in the root" "$rc" 1
check "failing root status: origin not moved" "$(git -C "$O" rev-parse main)" "$o_head"
untouched "failing root status" "$s"
# the extra parent is origin's first commit, an object the temp repo holds after its fetch
pushfix pf30; run "$F" --push "$C"; priv=$(git -C "$O" rev-parse main); more; run "$F" --push "$C"
o_head=$(git -C "$O" rev-parse main); s=$(snap "$C"); more
out=$(EXTRAPARENT="$priv" PATH="$T/shim4:$PATH" "$X" --root "$F" --log "$T/run.log" --push "$C" 2>"$T/err"); rc=$?; err=$(cat "$T/err")
check "--push refuses a commit with a parent other than the start" "$rc" 2; grep -q "not the one built" <<<"$err" || bad "extra parent err: $err"
check "extra parent: origin not moved" "$(git -C "$O" rev-parse main)" "$o_head"
untouched "extra parent" "$s"

# 42. the pushed bytes are the gated bytes, whatever filter or line-ending config is set
# the checkout's own filter config plays no part: it is never used
pushfix pf31; run "$F" --push "$C"; more
git -C "$C" config filter.inj.clean "sed 's/^more\$/Zorbacorp pays Quilla/'"
printf 'docs/design.md filter=inj\n' >"$C/.git/info/attributes"
run "$F" --push "$C"
check "--push ignores a clean filter in the checkout config" "$rc" 0
olog=$(git -C "$O" log --all -p); grep -qi zorbacorp <<<"$olog" && bad "checkout clean filter: a denylist term reached origin" || ok "checkout clean filter: no denylist term on origin"
# a clean filter from the global config with an exported .gitattributes line: refused, not pushed
pushfix pf32; run "$F" --push "$C"; o_head=$(git -C "$O" rev-parse main); s=$(snap "$C")
printf 'design.md filter=inj\n' >"$F/docs/.gitattributes"; printf 'more\n' >>"$F/docs/design.md"
git -C "$F" add -A && git -C "$F" "${GE[@]}" commit -qm attrs
printf '[filter "inj"]\n\tclean = sed s/^more$/Zorbacorp/\n' >"$T/pf32.gitconfig"
git -C "$F" config filter.inj.clean cat  # the root's own config wins there; the temp repo sees the global filter
out=$(GIT_CONFIG_GLOBAL="$T/pf32.gitconfig" "$X" --root "$F" --log "$T/run.log" --push "$C" 2>"$T/err"); rc=$?; err=$(cat "$T/err")
check "--push refuses a clean filter from the global config" "$rc" 2
grep -q 'not the gated tree' <<<"$err" && ok "global clean filter: the refusal names the tree mismatch" || bad "global filter err: $err"
check "global clean filter: origin not moved" "$(git -C "$O" rev-parse main)" "$o_head"
untouched "global clean filter" "$s"
# core.autocrlf=true in the global config is overridden: the CRLF bytes reach origin as they are
pushfix pf33; run "$F" --push "$C"
printf 'line one\r\nline two\r\n' >"$F/docs/crlf.md"; git -C "$F" add docs/crlf.md && git -C "$F" "${GE[@]}" commit -qm crlf
printf '[core]\n\tautocrlf = true\n' >"$T/pf33.gitconfig"
out=$(GIT_CONFIG_GLOBAL="$T/pf33.gitconfig" "$X" --root "$F" --log "$T/run.log" --push "$C" 2>"$T/err"); rc=$?
check "--push of a CRLF file under a global autocrlf exits 0" "$rc" 0
check "the CRLF bytes reach origin unchanged" "$(git -C "$O" cat-file blob main:docs/crlf.md | od -An -c | tr -d ' \n')" 'lineone\r\nlinetwo\r\n'

# 43. DoD 6: no rollback machinery is left in the script
grep -nE 'restore\(|reset (-q )?--hard|clean -f|rm -rf "?\$P|SWAPPED|COMMITTED|update-ref' "$X" >"$T/rb.txt" \
  && bad "rollback machinery left: $(cat "$T/rb.txt")" || ok "no restore, reset --hard, clean or rm in a checkout"

# 44. s-1107 B1 (hq-an7jw.12): a root holding .git lists from git only; every git read fault refuses
mkdir -p "$T/shim5"
cat >"$T/shim5/git" <<SHIM
#!/bin/bash
# for "git -C \$FROOT ...": FAILTOP=N fails rev-parse --show-toplevel from its Nth call (exit 128);
# TOPIS=<dir> answers rev-parse --show-toplevel with <dir>; FAILLS=1 fails ls-files (exit 128);
# FAILLT=1 fails ls-tree (exit 128), LTEMPTY=1 answers it with nothing (exit 0); FAILCF=1 fails
# cat-file (exit 128), CFSHORT=1 drops the last 10 bytes of its answer (exit 0)
if [ "\$1" = -C ] && [ "\$2" = "\${FROOT:-}" ]; then
  if [ "\$3" = rev-parse ] && [ "\$4" = --show-toplevel ]; then
    n=\$(( \$(cat "\$CNT" 2>/dev/null || echo 0) + 1 )); echo \$n >"\$CNT"
    [ -n "\${FAILTOP:-}" ] && [ \$n -ge "\$FAILTOP" ] && exit 128
    [ -n "\${TOPIS:-}" ] && { echo "\$TOPIS"; exit 0; }
  fi
  [ "\$3" = ls-files ] && [ -n "\${FAILLS:-}" ] && exit 128
  [ "\$3" = ls-tree ] && [ -n "\${FAILLT:-}" ] && exit 128
  [ "\$3" = ls-tree ] && [ -n "\${LTEMPTY:-}" ] && exit 0
  [ "\$3" = cat-file ] && [ -n "\${FAILCF:-}" ] && exit 128
  if [ "\$3" = cat-file ] && [ -n "\${CFSHORT:-}" ]; then "$REALGIT" "\$@" | head -c -10; exit 0; fi
fi
exec "$REALGIT" "\$@"
SHIM
chmod +x "$T/shim5/git"
s5run() { rm -f "$T/cnt5"; out=$(FROOT="$F" CNT="$T/cnt5" PATH="$T/shim5:$PATH" "$X" --root "$F" --log "$T/run.log" "$@" 2>"$T/err"); rc=$?; err=$(cat "$T/err"); }
# leftovers <label>: neither the untracked nor the excluded file is on origin
leftovers() {
  local t; t=$(git -C "$O" ls-tree -r --name-only main 2>/dev/null)
  grep -qE 'untracked-plan|ignored\.md' <<<"$t" && bad "$1: an untracked or ignored file reached origin" || ok "$1: no untracked or ignored file on origin"
}
pushfix pf44; run "$F" --push "$C"; o_head=$(git -C "$O" rev-parse main); more
printf 'my untracked private plan\n' >"$F/docs/untracked-plan.md"
printf 'docs/ignored.md\n' >"$F/.git/info/exclude"; printf 'ignored private notes\n' >"$F/docs/ignored.md"
s=$(snap "$C")
# the reviewer's lsfail.sh: rev-parse fails from its 2nd call; --push reads the toplevel once (the
# listing is the committed tree, hq-an7jw.13), so it never fails here
FAILTOP=2 s5run --push "$C"
leftovers "rev-parse fails from call 2 (lsfail.sh)"
check "lsfail.sh: --push reads the toplevel once (push check)" "$(cat "$T/cnt5")" 1
untouched "lsfail.sh" "$s"
o_head=$(git -C "$O" rev-parse main); more
FAILTOP=1 s5run --push "$C"
check "--push refuses when rev-parse --show-toplevel fails from call 1" "$rc" 1
check "rev-parse fails from call 1: origin not moved" "$(git -C "$O" rev-parse main)" "$o_head"
leftovers "rev-parse fails from call 1"
grep -q 'git cannot read the repository' <<<"$err" && ok "a failed rev-parse names the cause" || bad "rev-parse refusal: $err"
# hq-an7jw.13: --push lists and reads the committed tree; a failed, empty or short read refuses
for v in FAILLT LTEMPTY FAILCF CFSHORT; do
  out=$(env "$v=1" FROOT="$F" CNT="$T/cnt5" PATH="$T/shim5:$PATH" "$X" --root "$F" --log "$T/run.log" --push "$C" 2>"$T/err"); rc=$?; err=$(cat "$T/err")
  check "--push refuses when $v" "$rc" 1
  check "$v: origin not moved" "$(git -C "$O" rev-parse main)" "$o_head"
  check "$v: no temp dir left" "$(ls -A "$TMPDIR" | tr '\n' ' ')" ""
done
FAILLS=1 s5run --push "$C"
check "--push never calls ls-files: a failing ls-files changes nothing" "$rc" 0
leftovers "ls-files fails on --push"
o_head=$(git -C "$O" rev-parse main); more
# --out exports the committed snapshot too (hq-an7jw.17): it never calls ls-files; --gate on a
# checkout still lists with ls-files, and a failing one refuses
FAILLS=1 s5run --out "$T/o44a"
check "--out never calls ls-files: a failing ls-files changes nothing" "$rc" 0
[ -s "$T/o44a/CLAUDE.md" ] && ok "--out written from the snapshot" || bad "--out from the snapshot: $err"
FAILLS=1 s5run --gate "$F"
check "--gate on a checkout refuses when ls-files fails" "$rc" 1
grep -q 'git ls-files failed' <<<"$err" && ok "a failed ls-files names the cause" || bad "ls-files refusal: $err"
FAILTOP=1 s5run --check
check "--check refuses when rev-parse fails" "$rc" 1
# rev-parse answers another directory, or a symlink to one: refused, never a find listing
mkdir -p "$T/elsewhere"; ln -sfn "$T/elsewhere" "$T/elselink"
TOPIS="$T/elsewhere" s5run --push "$C"
check "--push refuses a toplevel that is another directory" "$rc" 1
grep -q 'not its repository' <<<"$err" && ok "another toplevel names the cause" || bad "other toplevel: $err"
TOPIS="$T/elselink" s5run --out "$T/o44b"
check "--out refuses a toplevel that is a symlink to another directory" "$rc" 1
TOPIS="$T/no-such-top" s5run --out "$T/o44c"
check "--out refuses a toplevel that does not exist" "$rc" 1
check "rev-parse faults: origin not moved" "$(git -C "$O" rev-parse main)" "$o_head"
untouched "rev-parse and ls-files faults" "$s"
# a trailing slash or a symlink to the root resolves (pwd -P) to the root itself: git listing, no leftovers
run "$F/" --out "$T/o44d"
check "--root with a trailing slash exports" "$rc" 0
[ -e "$T/o44d/docs/design.md" ] && [ ! -e "$T/o44d/docs/untracked-plan.md" ] && [ ! -e "$T/o44d/docs/ignored.md" ] \
  && ok "trailing slash root: git-tracked files only" || bad "trailing slash root: $(ls "$T/o44d/docs")"
ln -sfn "$F" "$T/pf44.link"
run "$T/pf44.link" --push "$C"
check "--push through a symlink to the root exits 0" "$rc" 0
leftovers "symlinked root"
# a subdirectory of a repository: --push refuses it; nothing lists the parent repository's untracked files
o_head=$(git -C "$O" rev-parse main); more; s=$(snap "$C")
run "$F/ops" --push "$C" --allow config/public-export.allow --deny config/public-export.deny --public public
check "--push refuses a root that is a subdirectory of a repository" "$rc" 1
grep -q 'repository toplevel' <<<"$err" && ok "subdirectory root names the cause" || bad "subdir root: $err"
check "subdirectory root: origin not moved" "$(git -C "$O" rev-parse main)" "$o_head"
untouched "subdirectory root" "$s"
# a plain dir (no .git): --out and --push refuse it (no HEAD to read the config from); --gate lists every file
R="$T/plain44"; rm -rf "$R"; mkdir -p "$R/docs"; printf 'plain notes\n' >"$R/docs/a.md"
run "$R" --out "$T/o44e"
check "--out refuses a plain dir root" "$rc" 1
[ ! -e "$T/o44e" ] && ok "plain dir --out: nothing written" || bad "plain dir --out wrote $T/o44e"
run "$T/hq1" --gate "$R"
check "--gate on a plain dir lists its files with find" "$rc" 0
run "$R" --push "$C"
check "--push refuses a plain dir root" "$rc" 1
grep -q 'no .git in' <<<"$err" && ok "plain dir push names the cause" || bad "plain dir push: $err"
# a repository that tracks no files is not an export, whatever sits untracked in it
R="$T/empty44"; rm -rf "$R"; mkdir -p "$R/docs"; git -C "$R" init -q; printf 'untracked\n' >"$R/docs/a.md"
run "$R" --out "$T/o44f"
check "--out refuses a repository with no commit" "$rc" 1
grep -q 'needs a commit' <<<"$err" && ok "no commit names the cause" || bad "no commit: $err"
run "$T/hq1" --gate "$R"
check "--gate refuses a repository with zero tracked files" "$rc" 1
grep -q 'tracks no files' <<<"$err" && ok "zero tracked files names the cause" || bad "zero tracked: $err"
# GIT_INDEX_FILE / GIT_DIR in the environment do not redirect the listing: an index that adds the untracked file
GIT_INDEX_FILE="$T/idx44" git -C "$F" read-tree HEAD && GIT_INDEX_FILE="$T/idx44" git -C "$F" add docs/untracked-plan.md
out=$(GIT_INDEX_FILE="$T/idx44" "$X" --root "$F" --log "$T/run.log" --out "$T/o44g" 2>"$T/err"); rc=$?
check "--out with a foreign GIT_INDEX_FILE exports" "$rc" 0
[ -e "$T/o44g/docs/design.md" ] && [ ! -e "$T/o44g/docs/untracked-plan.md" ] \
  && ok "foreign GIT_INDEX_FILE: the root's own index lists" || bad "foreign GIT_INDEX_FILE: $(ls "$T/o44g/docs" 2>&1)"
out=$(GIT_DIR="$T/hq1/.git" "$X" --root "$F" --log "$T/run.log" --out "$T/o44h" 2>"$T/err"); rc=$?
check "--out with a foreign GIT_DIR exports" "$rc" 0
check "foreign GIT_DIR: the root's own tracked files" "$(cd "$T/o44h" && find . -type f | sort | tr '\n' ' ')" "$(cd "$T/o44d" && find . -type f | sort | tr '\n' ' ')"

# 45. hq-an7jw.13 (lucy on hq-an7jw.12): --push exports the committed blobs of HEAD, never working-tree
# bytes; a relative origin url resolves from the checkout; a failed start-tree read refuses
PRIV="PRIVATE-WT-""BYTES"
committed_is() { # committed_is <label> <path> [needle]: origin's blob equals the committed blob, no working-tree bytes
  check "$1: origin holds the committed bytes" "$(git -C "$O" cat-file blob "main:$2" | sha256sum)" "$(git -C "$F" cat-file blob "HEAD:$2" | sha256sum)"
  grep -q "${3:-$PRIV}" <<<"$(git -C "$O" cat-file blob "main:$2")" && bad "$1: working-tree bytes on origin" || ok "$1: no working-tree bytes on origin"
}
# (1) lucy's repro: assume-unchanged hides a working-tree edit from status
pushfix pf45a; git -C "$F" update-index --assume-unchanged docs/design.md; printf '%s\n' "$PRIV" >>"$F/docs/design.md"
run "$F" --push "$C"
check "--push with an assume-unchanged edited file exits 0" "$rc" 0
committed_is "assume-unchanged" docs/design.md
# (2) the same with skip-worktree
pushfix pf45b; git -C "$F" update-index --skip-worktree docs/design.md; printf '%s\n' "$PRIV" >>"$F/docs/design.md"
run "$F" --push "$C"
check "--push with a skip-worktree edited file exits 0" "$rc" 0
committed_is "skip-worktree" docs/design.md
# (3) a clean filter that maps working-tree bytes to the committed ones (same size, so status trusts
# it), plus export-ignore and export-subst in the tree
pushfix pf45c; git -C "$F" config filter.priv.clean "tr A-Z a-z"
printf 'design.md filter=priv\na.md export-ignore\nb.md export-subst\n' >"$F/docs/.gitattributes"
printf 'kept a\n' >"$F/docs/a.md"; printf 'sub $Format:%%H$\n' >"$F/docs/b.md"
git -C "$F" add -A && git -C "$F" "${GE[@]}" commit -qm attrs
tr a-z A-Z <"$F/docs/design.md" >"$T/up45"; cat "$T/up45" >"$F/docs/design.md"
check "clean filter: the root status is clean" "$(git -C "$F" status --porcelain --untracked-files=no)" ""
run "$F" --push "$C"
check "--push under a clean filter and export attributes exits 0" "$rc" 0
committed_is "clean filter" docs/design.md "NOTHING PRIVATE"
check "export-ignore: the file is on origin" "$(git -C "$O" cat-file blob main:docs/a.md)" "kept a"
check "export-subst: no substitution" "$(git -C "$O" cat-file blob main:docs/b.md)" 'sub $Format:%H$'
# committed symlink and executable bit come from the tree entries
pushfix pf45s; ln -s design.md "$F/docs/link.md"; git -C "$F" add -A && git -C "$F" "${GE[@]}" commit -qm link
run "$F" --push "$C"
check "--push with a committed symlink exits 0" "$rc" 0
check "symlink entry on origin" "$(git -C "$O" ls-tree main docs/link.md | cut -c1-6)" "120000"
check "executable bit on origin" "$(git -C "$O" ls-tree main ops/scripts/run.sh | cut -c1-6)" "100755"
# (4) an edit staged in the index is dirty: still refused
pushfix pf45d; s=$(snap "$C"); printf 'staged edit\n' >>"$F/docs/design.md"; git -C "$F" add docs/design.md
run "$F" --push "$C"
check "--push with a staged edit is refused" "$rc" 1
nothing_pushed "staged edit" "$s"
# (5) a relative origin url, run from a cwd where that path is a decoy repository, or nothing
pushfix pf45e; git -C "$C" remote set-url origin ../pf45e.git
mkdir -p "$T/decoy/cwd"; rm -rf "$T/decoy/pf45e.git"; git init -q --bare -b main "$T/decoy/pf45e.git"
out=$(cd "$T/decoy/cwd" && "$X" --root "$F" --log "$T/run.log" --push "$C" 2>"$T/err"); rc=$?; err=$(cat "$T/err")
check "--push with a relative origin url from a decoy cwd exits 0" "$rc" 0
check "relative url: the push landed in the checkout's origin" "$(git -C "$O" rev-parse -q --verify main >/dev/null && echo yes)" yes
check "relative url: the decoy is untouched" "$(git -C "$T/decoy/pf45e.git" for-each-ref | wc -l | tr -d ' ')" 0
more; o_head=$(git -C "$O" rev-parse main)
out=$(cd / && "$X" --root "$F" --log "$T/run.log" --push "$C" 2>"$T/err"); rc=$?
check "--push with a relative origin url from / exits 0" "$rc" 0
check "relative url from /: origin moved" "$([ "$(git -C "$O" rev-parse main)" != "$o_head" ] && echo yes)" yes
git -C "$C" remote set-url origin ../no-such-origin.git; s=$(snap "$C"); o_head=$(git -C "$O" rev-parse main); more
run "$F" --push "$C"
check "--push with a relative origin url that does not resolve exits 1" "$rc" 1
check "unresolved relative url: origin not moved" "$(git -C "$O" rev-parse main)" "$o_head"
untouched "unresolved relative url" "$s"
# (6, 7) the start-tree read fails, or answers nothing: refused, origin unchanged
mkdir -p "$T/shim45"
cat >"$T/shim45/git" <<SHIM
#!/bin/bash
# RPT=fail fails rev-parse of a ^{tree} (exit 128); RPT=empty answers it with nothing (exit 0)
case " \$* " in *" rev-parse "*"^{tree}"*) [ "\$RPT" = fail ] && exit 128; [ "\$RPT" = empty ] && exit 0 ;; esac
exec "$REALGIT" "\$@"
SHIM
chmod +x "$T/shim45/git"
pushfix pf45f; run "$F" --push "$C"; s=$(snap "$C")
for m in fail empty; do
  more "change $m"; o_head=$(git -C "$O" rev-parse main)
  out=$(RPT=$m PATH="$T/shim45:$PATH" "$X" --root "$F" --log "$T/run.log" --push "$C" 2>"$T/err"); rc=$?; err=$(cat "$T/err")
  check "--push when the start-tree read is $m exits 1" "$rc" 1
  check "start-tree $m: origin not moved" "$(git -C "$O" rev-parse main)" "$o_head"
  grep -q 'cannot read the tree of the start' <<<"$err" && ok "start-tree $m names the cause" || bad "start-tree $m: $err"
  untouched "start-tree $m" "$s"
done
# fail-closed: a gitlink in the committed tree; an allowlist that is not committed
pushfix pf45g; s=$(snap "$C")
mkdir -p "$F/docs/sub"; git -C "$F" update-index --add --cacheinfo 160000,"$(git -C "$F" rev-parse HEAD)",docs/sub && git -C "$F" "${GE[@]}" commit -qm gitlink
run "$F" --push "$C"
check "--push refuses a gitlink in the committed tree" "$rc" 2
grep -q 'not a file or symlink' <<<"$err" && ok "gitlink names the cause" || bad "gitlink: $err"
nothing_pushed "gitlink" "$s"
pushfix pf45h; s=$(snap "$C"); cp "$F/ops/config/public-export.allow" "$F/ops/config/local.allow"
run "$F" --push "$C" --allow ops/config/local.allow
check "--push refuses an allowlist that is not committed" "$rc" 1
nothing_pushed "uncommitted allowlist" "$s"

# 46. hq-an7jw.14 (Opus round-3 B1 on hq-an7jw.13): --allow, --deny and --public map into the committed
# snapshot lexically; no working-tree symlink picks which committed bytes are read
otree() { git -C "$O" ls-tree -r --name-only main 2>/dev/null | tr '\n' ' '; }
# (1) the a6 repro: a skip-worktree working-tree symlink at the allowlist path to a wider committed allowlist
pushfix pf46a; printf "plain notes\n" >"$F/state/notes.md"; git -C "$F" rm -q state/client-notes.md
printf 'ops/\ndocs/\nstate/\n!ops/public/\n' >"$F/docs/wide.allow"
git -C "$F" add -A && git -C "$F" "${GE[@]}" commit -qm wide
git -C "$F" update-index --skip-worktree ops/config/public-export.allow
rm "$F/ops/config/public-export.allow"; ln -s ../../docs/wide.allow "$F/ops/config/public-export.allow"
check "allowlist symlink: the root status is clean" "$(git -C "$F" status --porcelain --untracked-files=no)" ""
run "$F" --push "$C"
check "--push with a working-tree symlink at the allowlist path exits 0" "$rc" 0
grep -q 'state/' <<<"$(otree)" && bad "allowlist symlink: state/ reached origin: $(otree)" || ok "allowlist symlink: nothing outside the committed allowlist on origin"
check "allowlist symlink: origin holds the committed allowlist's paths" "$(otree)" "CLAUDE.md LICENSE README.md docs/design.md docs/wide.allow ops/config/public-export.allow ops/scripts/ClientA-probe.sh ops/scripts/run.sh "
# (2) the same for the denylist: a symlink to a committed empty file; the committed term is still scrubbed
pushfix pf46b; : >"$F/docs/none.deny"; git -C "$F" add -A && git -C "$F" "${GE[@]}" commit -qm none
git -C "$F" update-index --skip-worktree ops/config/public-export.deny
rm "$F/ops/config/public-export.deny"; ln -s ../../docs/none.deny "$F/ops/config/public-export.deny"
run "$F" --push "$C"
check "--push with a working-tree symlink at the denylist path exits 0" "$rc" 0
c46=$(git -C "$O" cat-file blob main:CLAUDE.md 2>/dev/null)
grep -q ClientA <<<"$c46" && ! grep -q Zorbacorp <<<"$c46" && ok "denylist symlink: the committed term is scrubbed" || bad "denylist symlink: $c46"
# a denylist missing from the working tree (skip-worktree) still reads the committed one
pushfix pf46c; git -C "$F" update-index --skip-worktree ops/config/public-export.deny; rm "$F/ops/config/public-export.deny"
run "$F" --push "$C"
check "--push with the denylist missing from the working tree exits 0" "$rc" 0
grep -q ClientA <<<"$(git -C "$O" cat-file blob main:CLAUDE.md 2>/dev/null)" && ok "missing working-tree denylist: committed term scrubbed" || bad "missing working-tree denylist"
# (3) --public: the working-tree ops/public is a symlink to a committed dir with another README
pushfix pf46d; mkdir -p "$F/docs/pub2"; printf '# Other README\n' >"$F/docs/pub2/README.md"; printf 'GPL\n' >"$F/docs/pub2/LICENSE"
git -C "$F" add -A && git -C "$F" "${GE[@]}" commit -qm pub2
git -C "$F" update-index --skip-worktree ops/public/README.md ops/public/LICENSE
rm -r "$F/ops/public"; ln -s ../docs/pub2 "$F/ops/public"
check "public symlink: the root status is clean" "$(git -C "$F" status --porcelain --untracked-files=no)" ""
run "$F" --push "$C"
check "--push with a working-tree symlink at the public dir exits 0" "$rc" 0
check "public symlink: the committed README ships" "$(git -C "$O" cat-file blob main:README.md 2>/dev/null)" "# Public README"
check "public symlink: the committed LICENSE ships" "$(git -C "$O" cat-file blob main:LICENSE 2>/dev/null)" "MIT"
# an uncommitted working-tree dir symlink given as --public: refused, nothing pushed
pushfix pf46e; s=$(snap "$C"); ln -s public "$F/ops/pubx"
run "$F" --push "$C" --public ops/pubx
check "--push refuses an uncommitted symlinked --public dir" "$rc" 1
nothing_pushed "uncommitted symlinked --public" "$s"
# (4) --allow through symlinked directories: a working-tree link is not in HEAD (exit 1); an absolute
# path is a usage refusal; the cwd plays no part (paths are relative to the root)
pushfix pf46f; s=$(snap "$C"); ln -s ops/config "$F/wcfg"
run "$F" --push "$C" --allow wcfg/public-export.allow
check "--push refuses --allow through an uncommitted working-tree dir symlink" "$rc" 1
nothing_pushed "--allow via working-tree dir symlink" "$s"
ln -s "$F" "$T/pf46f.link"
run "$F" --push "$C" --allow "$T/pf46f.link/ops/config/public-export.allow"
check "--push refuses --allow reaching into the root through an outside symlink" "$rc" 1
grep -q 'wants a path relative to the root' <<<"$err" && ok "outside symlink names the cause" || bad "outside symlink: $err"
nothing_pushed "--allow via outside symlink" "$s"
out=$(cd "$T/pf46f.link/ops" && "$X" --root "$F" --log "$T/run.log" --push "$C" --allow config/public-export.allow 2>"$T/err"); rc=$?; err=$(cat "$T/err")
check "--push --allow is relative to the root, not the cwd" "$rc" 1
nothing_pushed "--allow relative to the cwd" "$s"
out=$(cd "$T/pf46f.link/ops" && "$X" --root "$F" --log "$T/run.log" --push "$C" --allow ops/config/public-export.allow 2>"$T/err"); rc=$?; err=$(cat "$T/err")
check "--push with root-relative config paths from a symlinked cwd exits 0" "$rc" 0
# a committed dir symlink in the path: exit 1
pushfix pf46g; s=$(snap "$C"); ln -s ops/config "$F/ccfg"; git -C "$F" add -A && git -C "$F" "${GE[@]}" commit -qm ccfg
run "$F" --push "$C" --allow ccfg/public-export.allow
check "--push refuses --allow through a committed dir symlink" "$rc" 1
grep -q 'not a committed non-empty file' <<<"$err" && ok "committed dir symlink names the cause" || bad "committed dir symlink: $err"
nothing_pushed "--allow via committed dir symlink" "$s"
# (5) a committed symlink at the allowlist path: exit 1, nothing pushed
pushfix pf46h; s=$(snap "$C"); git -C "$F" mv ops/config/public-export.allow docs/real.allow
ln -s ../../docs/real.allow "$F/ops/config/public-export.allow"; git -C "$F" add -A && git -C "$F" "${GE[@]}" commit -qm linkallow
run "$F" --push "$C"
check "--push refuses a committed symlink at the allowlist path" "$rc" 1
nothing_pushed "committed allowlist symlink" "$s"
# the public dir itself a committed symlink: exit 1
pushfix pf46i; s=$(snap "$C"); git -C "$F" mv ops/public docs/pubreal; ln -s ../docs/pubreal "$F/ops/public"
git -C "$F" add -A && git -C "$F" "${GE[@]}" commit -qm linkpub
run "$F" --push "$C"
check "--push refuses a committed symlink at the public dir" "$rc" 1
nothing_pushed "committed public dir symlink" "$s"

# 47. hq-an7jw.16 (lucy round 4 on hq-an7jw.14): --allow, --deny and --public are repo-relative paths
# read from HEAD only; nothing maps a filesystem path into the root, and no working-tree byte decides
# (lucy finding 1: an alias of the root, here a symlink, a case variant on a case-insensitive disk,
# reads a wider working-tree allowlist; it is refused as a usage error before any read)
pushfix pf47a; s=$(snap "$C"); printf "plain notes\n" >"$F/state/notes.md"; git -C "$F" rm -q state/client-notes.md
git -C "$F" add -A && git -C "$F" "${GE[@]}" commit -qm notes
git -C "$F" update-index --skip-worktree ops/config/public-export.allow
printf 'docs/\nstate/\n' >"$F/ops/config/public-export.allow"; ln -s "$F" "$T/pf47a.alias"
run "$F" --push "$C" --allow "$T/pf47a.alias/ops/config/public-export.allow"
check "lucy r4 f1: --allow by an alias path of the root exits 1" "$rc" 1
grep -q -- '--allow wants a path relative to the root' <<<"$err" && ok "lucy r4 f1: a usage refusal" || bad "lucy r4 f1: $err"
nothing_pushed "lucy r4 f1 alias" "$s"
for a in "$F/ops/config/public-export.allow" "ops/../ops/config/public-export.allow" "./ops/config/public-export.allow" \
         "ops//config/public-export.allow" "ops/config/" ""; do
  run "$F" --check --allow "$a"
  check "--allow '$a' is a usage refusal (exit 1)" "$rc" 1
done
run "$F" --check --deny "/etc/hostname"; check "--deny absolute is exit 1" "$rc" 1
run "$F" --check --public "../x"; check "--public with a .. component is exit 1" "$rc" 1
run "$F" --check --allow ops/config/none.allow; check "--allow not in HEAD is exit 1" "$rc" 1
grep -q 'not a committed non-empty file' <<<"$err" && ok "--allow not in HEAD names the cause" || bad "--allow not in HEAD: $err"
# an uncommitted working-tree edit to the allowlist (skip-worktree, so status is clean) changes nothing
run "$F" --push "$C"
check "--push with an uncommitted wider allowlist exits 0" "$rc" 0
grep -q 'state/' <<<"$(otree)" && bad "uncommitted allowlist: state/ reached origin: $(otree)" || ok "uncommitted allowlist: no state/ on origin"
grep -q 'CLAUDE.md' <<<"$(otree)" && ok "uncommitted allowlist: the committed allowlist decided" || bad "uncommitted allowlist: $(otree)"
F="$T/hq47o"; fixture "$F"; printf 'state/\n' >>"$F/ops/config/public-export.allow"
run "$F" --out "$T/o47o"
check "--out with an uncommitted wider allowlist exits 0" "$rc" 0
[ ! -e "$T/o47o/state" ] && ok "--out: the uncommitted allowlist line has no effect" || bad "--out: state/ exported"
# (lucy finding 2: a symlinked working-tree ancestor of the public dir no longer changes the outcome)
pushfix pf47b; s=$(snap "$C")
git -C "$F" ls-files -z ops | xargs -0 git -C "$F" update-index --skip-worktree
mv "$F/ops" "$T/pf47b.ops-aside"; mkdir -p "$T/pf47b.ext/public"; printf 'draft\n' >"$T/pf47b.ext/public/draft.txt"
ln -s "$T/pf47b.ext" "$F/ops"
check "lucy r4 f2: the root status is clean" "$(git -C "$F" status --porcelain --untracked-files=no)" ""
run "$F" --push "$C"
check "lucy r4 f2: a symlinked ancestor of the public dir does not refuse a valid export" "$rc" 0
check "lucy r4 f2: the committed README ships" "$(git -C "$O" cat-file blob main:README.md 2>/dev/null)" "# Public README"
grep -q 'draft' <<<"$(otree)" && bad "lucy r4 f2: draft.txt reached origin" || ok "lucy r4 f2: no working-tree public file on origin"

# hq-an7jw.17, lucy finding 1 on hq-an7jw.16: --out and --check export the HEAD snapshot, never the
# working tree. On 927f011 --out listed with ls-files and read working-tree bytes, so B held the marker.
F="$T/hq17a"; fixture "$F"
run "$F" --out "$T/o17a"; check "f1: export A exits 0" "$rc" 0
printf '# marker-uncommitted-17\n' >>"$F/ops/config/public-export.allow"
printf 'uncommitted design line\n' >>"$F/docs/design.md"
run "$F" --out "$T/o17b"; check "f1: export B after an uncommitted allowlist edit exits 0" "$rc" 0
diff -r "$T/o17a" "$T/o17b" >/dev/null && ok "f1: exports A and B are byte-identical" || bad "f1: A and B differ: $(diff -r "$T/o17a" "$T/o17b" | head -3)"
check "f1: no export holds the uncommitted marker" "$(grep -rl 'marker-uncommitted-17\|uncommitted design line' "$T/o17a" "$T/o17b" | wc -l)" 0
# an uncommitted leak in a tracked, allowed file: --check reads HEAD, so it passes; --gate on the
# checkout reads the working tree, so it refuses (its behavior is unchanged)
printf 'KEY=%sABCDEFGHIJKLMNOPQRSTUV12\n' "$SK" >>"$F/docs/design.md"
run "$F" --check; check "f1: --check ignores an uncommitted leak (HEAD snapshot)" "$rc" 0
run "$F" --gate "$F"; check "f1: --gate still scans the working tree" "$rc" 2
F="$T/hq17p"; fixture "$F"; mkdir -p "$F/ops/public"; printf 'draft\n' >"$F/ops/public/draft.md"
run "$F" --out "$T/o17p"
[ ! -e "$T/o17p/ops/public/draft.md" ] && ok "f1: --out ignores an untracked file under ops/public" || bad "f1: untracked ops/public file exported"

# hq-an7jw.17, lucy finding 2: core runs in "( core ) || exit" under --push, where bash ignores errexit,
# so a failed find, mkdir or cp inside it must refuse by explicit status. On 927f011 the find shim's
# partial list (CLAUDE.md alone) passed the gate and --push exited 0 publishing it.
mkdir -p "$T/shim17"
REALFIND=$(command -v find) REALMKDIR=$(command -v mkdir) REALCP=$(command -v cp)
cat >"$T/shim17/find" <<SHIM
#!/bin/bash
# FINDFAIL=1: in a dir named snap, print one NUL-terminated entry and fail (a read error mid-walk)
if [ -n "\${FINDFAIL:-}" ] && [ "\${PWD##*/}" = snap ]; then printf './CLAUDE.md\0'; exit 1; fi
exec "$REALFIND" "\$@"
SHIM
cat >"$T/shim17/mkdir" <<SHIM
#!/bin/bash
# MKFAIL=<suffix>: fail when the last argument ends in <suffix>
if [ -n "\${MKFAIL:-}" ]; then case "\${!#}" in *"\$MKFAIL") exit 1 ;; esac; fi
exec "$REALMKDIR" "\$@"
SHIM
cat >"$T/shim17/cp" <<SHIM
#!/bin/bash
# CPFAIL=1: copy, then report failure (a write error after part of the copy)
if [ -n "\${CPFAIL:-}" ]; then "$REALCP" "\$@"; exit 1; fi
exec "$REALCP" "\$@"
SHIM
chmod +x "$T/shim17/find" "$T/shim17/mkdir" "$T/shim17/cp"
s17run() { # s17run <VAR=value> <args...>
  local v="$1"; shift
  out=$(env "$v" PATH="$T/shim17:$PATH" "$X" --root "$F" --log "$T/run.log" "$@" 2>"$T/err"); rc=$?; err=$(cat "$T/err")
}
pushfix pf17; s=$(snap "$C")
for c in "FINDFAIL=1|failed (find)" "MKFAIL=/tree|cannot make the output dir" "CPFAIL=1|failed (cp)"; do
  v="${c%%|*}" msg="${c#*|}"
  s17run "$v" --push "$C"
  [ "$rc" -ne 0 ] && ok "f2: --push with $v exits non-zero ($rc)" || bad "f2: --push with $v exited 0: $out"
  nothing_pushed "f2: $v" "$s"
  grep -qF "$msg" <<<"$err" && ok "f2: $v names the failed step" || bad "f2: $v message: $err"
done
F="$T/hq17f"; fixture "$F"
s17run FINDFAIL=1 --check; check "f2: --check refuses a failed find" "$rc" 1
s17run FINDFAIL=1 --out "$T/o17f"; check "f2: --out refuses a failed find" "$rc" 1
[ ! -e "$T/o17f" ] && ok "f2: failed find: --out not written" || bad "f2: failed find: --out written"
s17run MKFAIL=o17m --out "$T/o17m"; check "f2: --out refuses a failed mkdir" "$rc" 1
[ ! -e "$T/o17m" ] && ok "f2: failed mkdir: --out not written" || bad "f2: failed mkdir: --out written"
s17run CPFAIL=1 --out "$T/o17c"; check "f2: --out refuses a failed cp" "$rc" 1
[ ! -e "$T/o17c" ] && ok "f2: failed cp: the partial --out is removed" || bad "f2: failed cp: --out left: $(ls -A "$T/o17c")"
mkdir "$T/o17e"; s17run CPFAIL=1 --out "$T/o17e"; check "f2: --out into an empty dir refuses a failed cp" "$rc" 1
check "f2: failed cp: the empty --out dir is left empty" "$(ls -A "$T/o17e" | wc -l)" 0

# 21. root .gitignore (hq-an7jw.21): the committed ops/share/public.gitignore of THIS repo ships as
# the export's .gitignore and ignores every private path on the list; --gate maps nothing
F="$T/hq21"; fixture "$F"; mkdir -p "$F/ops/share"
cp "$REPO/ops/share/public.gitignore" "$F/ops/share/public.gitignore"
git -C "$F" add -A && git -C "$F" -c user.name=t -c user.email=t"$AT"example.com commit -qm gitignore
run "$F" --out "$T/o21"
check "g1: export with the public .gitignore exits 0" "$rc" 0
[ -f "$T/o21/.gitignore" ] && cmp -s "$T/o21/.gitignore" "$REPO/ops/share/public.gitignore" \
  && ok "g1: the export ships the public .gitignore at its root" || bad "g1: root .gitignore missing or changed"
[ ! -e "$T/o21/ops/share/public.gitignore" ] && ok "g1: the source name is not shipped too" || bad "g1: source name shipped"
git -C "$T/o21" init -q
for p in ops/.env ops/config/site.env ops/config/visibility.env .git-credentials .beads-credential-key \
  state/x rigs/x/y ops/git-sync.log ops/metrics/x.json; do
  mkdir -p "$T/o21/$(dirname "$p")"; : >"$T/o21/$p"
  git -C "$T/o21" check-ignore -q "$p" && ok "g1: clone ignores $p" || bad "g1: clone does not ignore $p"
done
git -C "$T/o21" check-ignore -q ops/scripts/run.sh && bad "g1: clone ignores shipped code" || ok "g1: shipped code is not ignored"
mkdir -p "$T/g21/ops/share"; cp "$REPO/ops/share/public.gitignore" "$T/g21/ops/share/"
run "$F" --gate "$T/g21"
[ "$rc" -eq 0 ] && ! grep -q 'renamed ops/share/public.gitignore' "$T/run.log" \
  && ok "g1: --gate maps nothing" || bad "g1: --gate rc $rc: $(grep renamed "$T/run.log")"
F="$T/hq21b"; fixture "$F"; mkdir -p "$F/ops/share"; printf 'x\n' >"$F/ops/share/public.gitignore"
printf 'y\n' >"$F/.gitignore"; printf '.gitignore\n' >>"$F/ops/config/public-export.allow"
git -C "$F" add -A && git -C "$F" -c user.name=t -c user.email=t"$AT"example.com commit -qm both
run "$F" --out "$T/o21b"
[ "$rc" -ne 0 ] && [ ! -e "$T/o21b" ] && grep -q 'collides' <<<"$out$err" \
  && ok "g1: an allowed hq .gitignore collides and is refused" || bad "g1: collision rc $rc: $err"

# 48. Windows identity shapes (hq-an7jw.22): a machine or user SID and a default device name are
# personal machine identity. Dummy values, assembled from pieces so this file passes the gate.
SID="S-1-5-""21-1234567890-987654321-1122334455"; DT="desk""top"; LT="lap""top"
plant "SID with RID" windows-sid "<UserId>$SID-1001</UserId>"
plant "SID without RID" windows-sid "machine $SID"
plant "lowercase SID" windows-sid "sid ${SID,,}-500"
plant "upper device name" device-name "TSNAME=\"${DT^^}-AB12CDE\""
plant "mixed-case device name" device-name "host ${DT^}-aB3xYz9.example.ts.net"
plant "laptop device name" device-name "taildrop to $LT-q7w8e9r:"
R="$T/p-guard-win"; rm -rf "$R"; mkdir -p "$R/ops/scripts"
cat >"$R/ops/scripts/p.txt" <<EOF
CONF=ops/.$DT-share; see $DT-share.sh and $LT-mode, $DT-pc, ${DT^^}-SHARE
builtin S-1-5-32-544 and S-1-5-18, prefix S-1-5-""21 alone, short S-1-5-""21-12345-1-2
EOF
prun "$R" "$T/p.allow" "$T/p.deny" --out "$T/po-guard-win"
check "Windows guards (no digit, builtin SIDs, short subauthorities) exit 0" "$rc" 0
# a real value listed in the denylist is scrubbed before the gate, so the export passes
R="$T/p-win-deny"; rm -rf "$R"; mkdir -p "$R/ops/scripts"
printf 'TSNAME="%s-AB12CDE"\n<UserId>%s-1001</UserId>\n' "$DT" "$SID" >"$R/ops/scripts/p.txt"
printf '%s-AB12CDE\tyour-pc\n%s-1001\tCOMPUTER\\user\n' "$DT" "$SID" >"$T/w.deny"
prun "$R" "$T/p.allow" "$T/w.deny" --out "$T/po-win-deny"
check "denylisted SID and device name export exits 0" "$rc" 0
grep -qx 'TSNAME="your-pc"' "$T/po-win-deny/ops/scripts/p.txt" \
  && ok "device name scrubbed to its placeholder" || bad "device name scrub: $(cat "$T/po-win-deny/ops/scripts/p.txt")"

# 49. round 2 (hq-an7jw.26, lucy BLOCK): a SID before _Classes or any non-digit delimiter, short and
# hyphenated device names, and numeric character references (decoded copy scanned next to the raw)
plant "SID before _Classes" windows-sid "HKEY_USERS\\${SID}_Classes"
plant "SID with RID before _Classes" windows-sid "HKEY_USERS\\${SID}-1001_Classes"
plant "SID before a letter" windows-sid "key ${SID}x"
plant "short device name" device-name "host ${DT^^}-A1"
plant "hyphenated device name" device-name "host ${LT^^}-DEV-A1"
plant "lowercase hyphenated device name" device-name "host $DT-a-1:"
plant "device name before _" device-name "${DT^^}-A1_backup"
plant "decimal-encoded SID" windows-sid "<UserId>$(sed 's/-/\&#45;/g' <<<"$SID")</UserId>"
plant "hex-encoded SID" windows-sid "<UserId>$(sed 's/-/\&#x2D;/g' <<<"$SID")-1001</UserId>"
plant "encoded digit in SID" windows-sid "<UserId>S-1-5-&#50;1-${SID#S-1-5-21-}</UserId>"
plant "hex-encoded device name" device-name "<Host>${DT^^}&#x2d;A1</Host>"
# the deny list matches the decoded copy: an encoded term survives the raw scrub and is refused
R="$T/p-enc-deny"; rm -rf "$R"; mkdir -p "$R/ops/scripts"
printf '<Author>zorb&#97;corp</Author>\n' >"$R/ops/scripts/task.xml"
prun "$R" "$T/p.allow" "$T/p.deny" --out "$T/po-enc-deny"
check "encoded denylist term exits 2" "$rc" 2
grep -q 'LEAK ops/scripts/task.xml:1: denylist term' <<<"$err" && ok "encoded denylist term named" || bad "encoded denylist term named: $err"
R="$T/p-enc-sid-deny"; rm -rf "$R"; mkdir -p "$R/ops/scripts"
printf '<UserId>%s</UserId>\n' "$(sed 's/-/\&#45;/g' <<<"$SID")" >"$R/ops/scripts/task.xml"
printf '%s\tCOMPUTER\\user\n' "$SID" >"$T/w2.deny"
prun "$R" "$T/p.allow" "$T/w2.deny" --out "$T/po-enc-sid-deny"
check "encoded SID with its decoded spelling denylisted exits 2" "$rc" 2
grep -q 'LEAK ops/scripts/task.xml:1: denylist term' <<<"$err" && ok "encoded denylisted SID named as denylist term" \
  || bad "encoded denylisted SID named: $err"
G="$T/g-enc"; rm -rf "$G"; mkdir -p "$G"; cp "$R/ops/scripts/task.xml" "$G/"
run "$R" --allow .cfg/allow --deny .cfg/deny --gate "$G"
[ "$rc" -ne 0 ] && ok "--gate refuses the encoded denylisted SID ($rc)" || bad "--gate passed the encoded SID: $err"
# a file name is gated on its decoded spelling too
R="$T/p-enc-name"; rm -rf "$R"; mkdir -p "$R/ops/scripts"; printf 'x\n' >"$R/ops/scripts/${DT^^}&#45;A1.txt"
prun "$R" "$T/p.allow" "$T/p.deny" --out "$T/po-enc-name"
check "encoded device name in a file name exits 2" "$rc" 2
grep -q 'unscrubbable file name (device-name)' <<<"$err" && ok "encoded file name named" || bad "encoded file name named: $err"
# a reference the decoder cannot read is refused, never passed
R="$T/p-enc-bad"; rm -rf "$R"; mkdir -p "$R/ops/scripts"
printf '<A>&#x11%s;</A>\n<B>&#xD%s;</B>\n' 0000 800 >"$R/ops/scripts/task.xml"
prun "$R" "$T/p.allow" "$T/p.deny" --out "$T/po-enc-bad"
check "undecodable character reference exits 2" "$rc" 2
grep -q 'task.xml:2: character reference' <<<"$err" && ok "undecodable surrogate named" || bad "undecodable surrogate named: $err"
grep -q 'REFUSED ops/scripts/task.xml:1: character reference' <<<"$err" && ok "undecodable reference named" || bad "undecodable reference named: $err"
[ ! -e "$T/po-enc-bad" ] && ok "undecodable reference wrote nothing" || bad "undecodable reference wrote output"
# guards: placeholders, plain references and wordy desktop- names with no digit still pass
R="$T/p-guard-win2"; rm -rf "$R"; mkdir -p "$R/ops/scripts"
cat >"$R/ops/scripts/p.txt" <<EOF
host your-pc, account GEORGE\\owner, COMPUTER\\user; $DT-share-mode and ${LT^^}-DEV-BOX
<a>&#65;&#x42;&amp;&lt;</a> and S-1-5-""21-1234567890-987654321 (two subauthorities)
perl: s/&#0?39;|&apos;/x/g and a valid bare &#x11 with no semicolon
EOF
prun "$R" "$T/p.allow" "$T/p.deny" --out "$T/po-guard-win2"
check "round 2 guards (placeholders, plain references, no digit) exit 0" "$rc" 0
grep -qF '&#65;&#x42;' "$T/po-guard-win2/ops/scripts/p.txt" && ok "export keeps references as written" || bad "export rewrote references"

# 50. round 3 (hq-an7jw.29, lucy BLOCK): the whole-file secret detectors also run on the decoded
# copy, and a reference to no character is refused with or without the ";"
EP="&#112;${PW#p}"  # the key name with its first letter spelled as a decimal reference
plant "encoded key, value on the line" secret-assign "$EP=R7vQ2mNp9zTa4hKx"
plant "hex-encoded key, value on the line" secret-assign "db_&#x70;${PW#p}: R7vQ2mNp9zTa4hKx"
plant "encoded key, YAML value on the next line" secret-assign "$EP:${NL}  R7vQ2mNp9zTa4hKx"
plant "encoded key, JSON value on the next line" secret-assign "{\"$EP\":${NL} \"R7vQ2mNp9zTa4hKx\"}"
plant "encoded key, YAML block value" secret-assign "$EP: |${NL}  R7vQ2mNp9zTa4hKx"
plant "encoded letter in the value" secret-assign "$PW=R7vQ2mNp&#57;zTa4hKx"
plant "encoded quote around the value" secret-assign "$PW=&#34;R7vQ2mNp9zTa4hKx&#34;"
# a decoded line feed splits the decoded copy; the hit still names the source line
R="$T/p-enc-lf"; rm -rf "$R"; mkdir -p "$R/ops/scripts"
printf 'a&#10;b&#10;c\n%s=R7vQ2mNp9zTa4hKx\n' "$EP" >"$R/ops/scripts/p.txt"
prun "$R" "$T/p.allow" "$T/p.deny" --out "$T/po-enc-lf"
check "encoded key after a decoded line feed exits 2" "$rc" 2
grep -q 'LEAK ops/scripts/p.txt:2: secret-assign' <<<"$err" && ok "decoded hit names its source line" || bad "decoded source line: $err"
# --gate runs the same decoded scan on a tree as it is
G="$T/g-enc-key"; rm -rf "$G"; mkdir -p "$G"; printf '%s=R7vQ2mNp9zTa4hKx\n' "$EP" >"$G/p.txt"
run "$R" --allow .cfg/allow --deny .cfg/deny --gate "$G"
check "--gate refuses an encoded key" "$rc" 2
# refuse <name> <line>: a reference to no character, refused with its line named
refuse() {
  local R="$T/p-$1"; rm -rf "$R"; mkdir -p "$R/ops/scripts"
  printf '%s\n' "$2" >"$R/ops/scripts/p.txt"
  prun "$R" "$T/p.allow" "$T/p.deny" --out "$T/po-$1"
  check "$1 exits 2" "$rc" 2
  grep -q 'REFUSED ops/scripts/p.txt:1: character reference' <<<"$err" && ok "$1 named" || bad "$1 named: $err"
  [ ! -e "$T/po-$1" ] || bad "$1 wrote output"
}
refuse "unterminated hex past U+10FFFF" "<A>&#x11""0000</A>"
refuse "unterminated decimal past U+10FFFF" "<A>&#""1114112 </A>"
refuse "unterminated surrogate" "x &#xD8""00 y"
refuse "unterminated NUL" "x &#""0 y"
refuse "terminated decimal past U+10FFFF" "<A>&#""1114112;</A>"
refuse "near miss of the perl literal" 'perl: s/&#''0?40;/x/g'
R="$T/p-enc-badname"; rm -rf "$R"; mkdir -p "$R/ops/scripts"; printf 'x\n' >"$R/ops/scripts/a&#x11""0000.txt"
prun "$R" "$T/p.allow" "$T/p.deny" --out "$T/po-enc-badname"
check "unterminated invalid reference in a file name exits 2" "$rc" 2
grep -q 'unscrubbable file name (undecodable character reference)' <<<"$err" && ok "bad file name named" || bad "bad file name named: $err"
# the one named exception: the news.sh perl regex, as written in the tree, passes
R="$T/p-perl-lit"; rm -rf "$R"; mkdir -p "$R/ops/security"
printf '%s\n' "      \$s =~ s/&quot;/\"/g; \$s =~ s/&#0?39;|&apos;/\\x27/g;" >"$R/ops/security/news.sh"
prun "$R" "$T/p.allow" "$T/p.deny" --out "$T/po-perl-lit"
check "news.sh perl apostrophe regex exits 0" "$rc" 0

# hq's own client terms (hq-an7jw.36, .38): each term of a "# red team hq-an7jw.N" section of the
# real denylist, with the whole real denylist, is scrubbed to its placeholder by --out and refused
# in any case by --gate. This file is exported, so the terms are read from the private denylist
# (read only), never written here, and cases are named by placeholder; a copy without it skips.
RD="$REPO/ops/config/public-export.deny"
client_terms() { # $1 section id (an7jw.36), $2 expected term count
  local sec=$1 want=$2 CT i=0 term repl R G
  CT=$(awk -v h="# red team hq-$sec:" 'index($0, h) == 1 { on = 1; next } /^#/ { on = 0 } on && NF' "$RD")
  check "hq-$sec section lists $want client terms" "$(grep -c . <<<"$CT")" "$want"
  while IFS=$'\t' read -r term repl _; do
    i=$((i + 1)); R="$T/p-ct$sec-$i"; G="$T/g-ct$sec-$i"; rm -rf "$R" "$G"; mkdir -p "$R/ops/scripts" "$G"
    printf 'see %s here\n' "$term" >"$R/ops/scripts/p.txt"
    prun "$R" "$T/ct.allow" "$T/ct.deny" --out "$T/po-ct$sec-$i"
    check "$sec term $i ($repl): --out exits 0" "$rc" 0
    check "$sec term $i ($repl): scrubbed to its placeholder" "$(cat "$T/po-ct$sec-$i/ops/scripts/p.txt" 2>/dev/null)" "see $repl here"
    printf 'see %s here\n' "${term^^}" >"$G/p.txt"
    prun "$T/r-ct$sec-$i" "$T/ct.allow" "$T/ct.deny" --gate "$G"
    check "$sec term $i ($repl): --gate refuses it in upper case" "$rc" 2
    grep -q 'p.txt:1: denylist term' <<<"$err" && ok "$sec term $i ($repl): --gate names the line" \
      || bad "$sec term $i ($repl): --gate names the line"
  done <<<"$CT"
}
if [ -r "$RD" ]; then
  cp "$RD" "$T/ct.deny"; printf 'ops/\n' >"$T/ct.allow"
  client_terms an7jw.36 5
  client_terms an7jw.38 4
  client_terms an7jw.50 1
  client_terms an7jw.49 9
else
  echo "skip hq-an7jw.36/.38 client terms: no private denylist in this copy"
fi

bash -n "$X" && ok "bash -n" || bad "bash -n"

echo "pass $pass fail $fail"
[ "$fail" -eq 0 ]
