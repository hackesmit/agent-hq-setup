#!/usr/bin/env bash
# Fixture test: pre-push refuses a planted fake secret and passes a clean push.
set -u
HOOK="$(cd "$(dirname "$0")/.." && pwd)/pre-push"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
ok(){ echo "ok   $1"; }; bad(){ echo "FAIL $1"; fail=1; }
git init -q --bare "$T/remote.git"
git init -q -b main "$T/w"; cd "$T/w" || exit 1
git config user.email t@t; git config user.name t
git remote add origin "$T/remote.git"
echo hi > a.txt; git add a.txt; git commit -qm clean
push(){ git -c core.hooksPath="$(dirname "$HOOK")" push -q origin "$BR" >"$T/out" 2>&1; }
BR=main; push && ok "clean push passes" || { bad "clean push passes"; cat "$T/out"; }
git checkout -qb feat
# fake keys assembled at runtime so this file itself holds no literal secret
printf 'aws_secret = "AKIA%s"\ntoken = "ghp_%s"\n' IOSFODNN7EXAMPLQ aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5 > cfg.env
git add cfg.env; git commit -qm secret
BR=feat; push && bad "planted secret refused" || ok "planted secret refused"
grep -q "BLOCKED: gitleaks" "$T/out" && ok "block message" || bad "block message"
HQ_SECRET_SCAN=0 push && ok "HQ_SECRET_SCAN=0 skips" || bad "HQ_SECRET_SCAN=0 skips"
git checkout -q main; git checkout -qb feat2; echo more > b.txt; git add b.txt; git commit -qm clean2
BR=feat2; push && ok "clean branch push passes" || { bad "clean branch push passes"; cat "$T/out"; }
# Force push over a remote sha this clone never fetched (review finding,
# hq-pgbpq.8): the base is unknown locally, so the hook must still scan.
git init -q -b main "$T/w2"; cd "$T/w2" || exit 1
git config user.email t@t; git config user.name t
git remote add origin "$T/remote.git"
echo a > a; git add a; git commit -qm c1
git -c core.hooksPath="$(dirname "$HOOK")" push -q origin main:fx >/dev/null 2>&1
git clone -q -b fx "$T/remote.git" "$T/w3"
( cd "$T/w3" && git config user.email t@t && git config user.name t && echo b >> a && git commit -qam c2 \
  && git -c core.hooksPath="$(dirname "$HOOK")" push -q origin fx >/dev/null 2>&1 )
printf 'token = "ghp_%s"\n' aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5 > s.env; git add s.env; git commit -qm secret
fpush(){ git -c core.hooksPath="$(dirname "$HOOK")" push -q --force origin HEAD:fx >"$T/out" 2>&1; }
fpush && bad "force push over unfetched sha refused" || ok "force push over unfetched sha refused"
git --git-dir="$T/remote.git" cat-file -e fx:s.env 2>/dev/null && bad "secret not on remote" || ok "secret not on remote"
grep -q "found a possible secret" "$T/out" && ok "force push blocked by the scan itself" || { bad "force push blocked by the scan itself"; cat "$T/out"; }

# A repo .gitleaks.toml in the pushed range cannot disable the scan.
git checkout -qb cfgbypass main~1
printf '[allowlist]\npaths = [".*"]\n' > .gitleaks.toml
printf 'token = "ghp_%s"\n' aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5 > t.env; git add .gitleaks.toml t.env; git commit -qm bypass
BR=cfgbypass; push && bad "repo .gitleaks.toml cannot bypass" || ok "repo .gitleaks.toml cannot bypass"
grep -q "WARNING: this push changes" "$T/out" && ok "allowlist change warned" || bad "allowlist change warned"

# A gitleaks that errors but exits 0 must block (fail-closed).
git checkout -qb clean3 main~1; echo c > c.txt; git add c.txt; git commit -qm clean3
mkdir -p "$T/fakebin"
printf '#!/bin/sh\necho "4:12AM ERR [git] fatal: something broke" >&2\nexit 0\n' > "$T/fakebin/gitleaks"; chmod +x "$T/fakebin/gitleaks"
BR=clean3; PATH="$T/fakebin:$PATH" push && bad "gitleaks ERR with exit 0 refused" || ok "gitleaks ERR with exit 0 refused"
grep -q "gitleaks errored" "$T/out" && ok "error message" || bad "error message"
printf '#!/bin/sh\nexit 2\n' > "$T/fakebin/gitleaks"
PATH="$T/fakebin:$PATH" push && bad "gitleaks unknown exit refused" || ok "gitleaks unknown exit refused"
BR=clean3; push && ok "clean push still passes with real gitleaks" || { bad "clean push still passes with real gitleaks"; cat "$T/out"; }
exit $fail
