#!/usr/bin/env bash
# Adversarial review regression tests for the console v2 release/sync/wrapper work
# (beads hq-dgnf, hq-qwj2, hq-4m5u). These pin properties the design states but the
# existing harness/test scripts do not cover:
#
#   1 build.sh rejects a symlink that the BUNDLER planted in web/dist
#     (release/harness.sh only exercises the symlinks npm creates)
#   2 build.sh never reaches package.json scripts: an npm that fails on `run`
#     and `exec` still produces a complete build, and the source contains no
#     `npm run` / `npx` call
#   3 spawn-as-owner.sh refuses verb injection, non-allowlisted verbs and
#     out-of-tree / traversal paths
#   4 hub-sync forwards only the default branch, autofix/* and refs/dolt/*:
#     a feature branch pushed to the mirror never reaches origin, and a
#     divergence is reported as "diverged" in status.json (not just in the log)
#
# Usage: bash ops/console/v2/tests/review/run.sh
set -uo pipefail
export LC_ALL=C
HERE=$(cd "$(dirname "$0")" && pwd)
V2=$(cd "$HERE/../.." && pwd)
REPO=${HQ_ROOT:-/home/owner/hq}
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf 'PASS %s\n' "$1"; }
ko(){ FAIL=$((FAIL+1)); printf 'FAIL %s: %s\n' "$1" "${2:-}"; }
ROOT=$(mktemp -d /tmp/hq-console-review.XXXXXX) || exit 2
trap 'rm -rf "$ROOT"' EXIT

# ---------------------------------------------------------------- fixtures --
mkdir -p "$ROOT/bin" "$ROOT/out" "$ROOT/src" "$ROOT/logs"

cat > "$ROOT/bin/npm" <<'NPM'
#!/bin/sh
# npm stand-in. `run` and `exec` are hard failures on purpose: build.sh must
# never invoke a package.json script.
sub=$1; [ $# -gt 0 ] && shift
case "$sub" in
  ci)
    rm -rf node_modules server/node_modules runner/node_modules
    mkdir -p node_modules/ws node_modules/busboy node_modules/node-pty node_modules/.bin node_modules/@hq || exit 1
    for p in ws busboy node-pty; do printf '{"name":"%s","version":"0"}\n' "$p" > "node_modules/$p/package.json"; done
    ln -sfn ../../shared node_modules/@hq/console-shared || exit 1
    ;;
  rebuild) mkdir -p node_modules/node-pty/build/Release && : > node_modules/node-pty/build/Release/pty.node ;;
  run|exec|start|test) echo "npm $sub must never be called by build.sh" >&2; exit 97 ;;
  *) echo "unexpected npm subcommand '$sub'" >&2; exit 1 ;;
esac
exit 0
NPM

cat > "$ROOT/bin/vite-clean" <<'VC'
#!/bin/sh
[ "$1" = build ] || exit 1
rm -rf dist; mkdir -p dist/assets || exit 1
printf '<!doctype html>\n' > dist/index.html
printf 'export const x=1;\n' > dist/assets/app.js
exit 0
VC

cat > "$ROOT/bin/vite-evil" <<'VE'
#!/bin/sh
# A bundler (or a plugin) that emits a symlink out of the served tree.
[ "$1" = build ] || exit 1
rm -rf dist; mkdir -p dist/assets || exit 1
printf '<!doctype html>\n' > dist/index.html
printf 'export const x=1;\n' > dist/assets/app.js
ln -sfn /etc/passwd dist/assets/leak.txt
exit 0
VE
chmod +x "$ROOT/bin/npm" "$ROOT/bin/vite-clean" "$ROOT/bin/vite-evil"

[ -d "$REPO/.git" ] || { echo "no git repo at $REPO" >&2; exit 2; }
git clone --quiet --bare "$REPO" "$ROOT/mirror.git" || { echo "bare clone failed" >&2; exit 2; }
git clone --quiet "$ROOT/mirror.git" "$ROOT/work" || { echo "work clone failed" >&2; exit 2; }
git -C "$ROOT/work" config user.email review@localhost
git -C "$ROOT/work" config user.name "review tests"
APP="$ROOT/work/ops/console/v2"
mkdir -p "$APP/server/src"
printf 'process.stdout.write(JSON.stringify({ok:true})+"\\n");\n' > "$APP/server/src/server.js"
git -C "$ROOT/work" add ops/console/v2/server/src/server.js >/dev/null
git -C "$ROOT/work" commit -q -m "review fixture: stand-in server"
git -C "$ROOT/work" push -q origin HEAD:main
SHA=$(git -C "$ROOT/work" rev-parse HEAD)

build(){ # build <vite-stub> <logname>
  RELEASE_NPM="$ROOT/bin/npm" RELEASE_VITE="$ROOT/bin/$1" SKIP_NATIVE=1 \
    bash "$V2/release/build.sh" --mirror "$ROOT/mirror.git" --ref main \
      --out "$ROOT/out" --src "$ROOT/src" --keep 3 > "$ROOT/logs/$2.log" 2>&1
}

# -- 1 symlink planted by the bundler ----------------------------------------
build vite-evil evil; RC=$?
if [ "$RC" -ne 0 ] && grep -q 'contains symlinks' "$ROOT/logs/evil.log" \
   && [ ! -f "$ROOT/out/$SHA/.complete" ]; then
  ok "1 build.sh rejects a symlink emitted into web/dist"
else
  ko "1 build.sh rejects a symlink emitted into web/dist" "rc=$RC $(tail -2 "$ROOT/logs/evil.log")"
fi

# -- 2 no package.json script is ever run ------------------------------------
rm -rf "$ROOT/out" "$ROOT/src"; mkdir -p "$ROOT/out" "$ROOT/src"
build vite-clean clean; RC=$?
if [ "$RC" -eq 0 ] && [ -f "$ROOT/out/$SHA/.complete" ] && ! grep -q 'must never be called' "$ROOT/logs/clean.log"; then
  ok "2a build.sh completes with an npm whose 'run'/'exec' fail"
else
  ko "2a build.sh completes with an npm whose 'run'/'exec' fail" "rc=$RC $(tail -3 "$ROOT/logs/clean.log")"
fi
if ! grep -nE '(^|[^-])\$?(NPM|npm)"?[[:space:]]+(run|exec)|npx' "$V2/release/build.sh" | grep -qv '^[0-9]*:#'; then
  ok "2b build.sh source contains no 'npm run' / 'npx' invocation"
else
  ko "2b build.sh source contains no 'npm run' / 'npx' invocation" "$(grep -nE 'npm[[:space:]]+run|npx' "$V2/release/build.sh" | grep -v '^[0-9]*:#' | head -3)"
fi

# -- 3 wrapper allowlist ------------------------------------------------------
FAKEHQ="$ROOT/fakehq"; mkdir -p "$FAKEHQ/rigs/demo"
git init -q "$FAKEHQ"; git init -q "$FAKEHQ/rigs/demo"
W="$V2/runner/spawn-as-owner.sh"
refuse(){ # refuse <label> <args...>
  local label=$1; shift
  local out rc
  out=$(HQ_ROOT="$FAKEHQ" bash "$W" "$@" 2>&1); rc=$?
  if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -q '^spawn-as-owner:'; then
    ok "3 refused: $label"
  else
    ko "3 refused: $label" "rc=$rc out=$(printf '%s' "$out" | head -1)"
  fi
}
refuse "ctl verb injection"        ctl 'state; id'
refuse "ctl verb not in the list"  ctl exec
refuse "bd verb not in the list"   bd remember foo
refuse "unknown top-level verb"    definitely-not-a-verb x
refuse "commit-only ../ traversal" git-commit-only "$FAKEHQ" '../../../etc/passwd' m
refuse "commit-only absolute path" git-commit-only "$FAKEHQ" '/etc/passwd' m
refuse "commit-only path outside the projects allowlist" git-commit-only "$FAKEHQ" 'ops/scripts/x.sh' m
refuse "git-log outside HQ_ROOT"   git-log /etc 5
refuse "empty verb"

# -- 4 hub-sync forwards only the allowed refs --------------------------------
H="$ROOT/hub"; mkdir -p "$H"
export HUB_MIRRORS="$H/mirrors" HUB_REPOS_CONF="$H/repos.conf" HUB_CRED_FILE="$H/cred" \
       HUB_LOCK="$H/lock" HUB_HEARTBEAT="$H/hb" HUB_STATUS="$H/status.json"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q --bare -b main "$H/origin.git"
git clone -q "$H/origin.git" "$H/seed" 2>/dev/null
git -C "$H/seed" commit -q --allow-empty -m init; git -C "$H/seed" push -q origin main
: >"$HUB_CRED_FILE"; : >"$HUB_LOCK"
bash "$V2/sync/hub-sync.sh" --init demo "$H/origin.git" main >"$H/init.log" 2>&1
git clone -q "$HUB_MIRRORS/demo.git" "$H/owner" 2>/dev/null
# a feature branch and an autofix branch, both pushed to the mirror
git -C "$H/owner" checkout -q -b feature/secret
git -C "$H/owner" commit -q --allow-empty -m "worker branch, must not reach origin"
git -C "$H/owner" push -q origin feature/secret
git -C "$H/owner" checkout -q -b autofix/mail main
git -C "$H/owner" commit -q --allow-empty -m "autofix branch, must reach origin"
git -C "$H/owner" push -q origin autofix/mail
bash "$V2/sync/hub-sync.sh" >"$H/c1.log" 2>&1
if ! git -C "$H/origin.git" rev-parse -q --verify refs/heads/feature/secret >/dev/null 2>&1; then
  ok "4a a feature branch on the mirror is NOT forwarded to origin"
else
  ko "4a a feature branch on the mirror is NOT forwarded to origin" "origin has refs/heads/feature/secret"
fi
if git -C "$H/origin.git" rev-parse -q --verify refs/heads/autofix/mail >/dev/null 2>&1; then
  ok "4b autofix/* IS forwarded to origin"
else
  ko "4b autofix/* IS forwarded to origin" "origin lacks refs/heads/autofix/mail"
fi
# divergence must be visible in status.json, which is what the console reads
git -C "$H/owner" checkout -q main
git -C "$H/owner" commit -q --allow-empty -m "mirror side"; git -C "$H/owner" push -q origin main
git -C "$H/seed" commit -q --allow-empty -m "origin side"; git -C "$H/seed" push -q origin main
MIRROR_TIP_BEFORE=$(git -C "$HUB_MIRRORS/demo.git" rev-parse main)
bash "$V2/sync/hub-sync.sh" >"$H/c2.log" 2>&1
MIRROR_TIP_AFTER=$(git -C "$HUB_MIRRORS/demo.git" rev-parse main)
if [ "$MIRROR_TIP_BEFORE" = "$MIRROR_TIP_AFTER" ]; then
  ok "4c a diverged ref does not clobber the mirror tip"
else
  ko "4c a diverged ref does not clobber the mirror tip" "$MIRROR_TIP_BEFORE -> $MIRROR_TIP_AFTER"
fi
if grep -q '"demo":"diverged"' "$HUB_STATUS"; then
  ok "4d status.json reports demo as diverged"
else
  ko "4d status.json reports demo as diverged" "$(cat "$HUB_STATUS")"
fi

printf '\nreview tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
