#!/usr/bin/env bash
# HQ Console v2: local test harness for build.sh and activate.sh.
#
# Runs on the laptop, as owner, with no root, no compiler and no npm registry.
# It exercises the real scripts end to end against stand-ins for the three
# things a laptop cannot provide:
#
#   npm          RELEASE_NPM points at a stub that lays down a fake
#                node_modules (including the workspace symlinks and .bin shims
#                npm really creates, so the assembler's symlink rejection is
#                actually tested)
#   vite         RELEASE_VITE points at a stub that writes a dist/
#   node-pty     SKIP_NATIVE=1, because this laptop has no make or g++. The
#                compile and the pty smoke test are therefore NOT covered here;
#                they are covered on hqbox by the first real build, and
#                SMOKE_PTY=0 plus RELEASE_SMOKE_PTY=1 moves the smoke test to
#                activate.sh if the build unit ever cannot allocate a pty.
#   systemctl    RELEASE_SYSTEMCTL points at a stub that runs the fake server
#                once and records active/failed
#   the server   RELEASE_SERVER_CMD is not needed: the harness commits a small
#                fake server.js into its throwaway mirror, so the real
#                copy/check/switch path runs against a real file. (The hook is
#                still supported by activate.sh for other test setups.)
#
# Cases:
#   1 build A                     builds and publishes out/<shaA>
#   2 build A again               skips, exits 0, does not rebuild
#   3 activate A                  candidate ok, switch, health stamp
#   4 activate A again            no-op, still current
#   5 activate B, candidate fails no switch, current stays A
#   6 activate B, post fails      switch, no stamp, rollback to A
#   7 activate B clean            switch to B
#   8 activate --rollback         back to A
#   9 activate C (runner/ changed) with a non-persistent session alive
#                                 no drain sent, "runner restart deferred"
#  10 activate C again (already current), only persistent terms alive
#                                 the deferred drain is retried and sent
#  11 --rollback C to A, runner on C, only persistent terms alive
#                                 drain sent (runner/ differs)
# 11b activate C, runner knows `restart`, a meta session alive
#                                 restart pending, no drain (hq-4npjr.20)
# 11c activate C again, only a persistent term and an adopted pane
#                                 restart drains at once (panes never block)
#  12 activate C, runner socket gone   activation still succeeds, warns
#   Cases 3, 4, 7 and 8 also assert that NO drain was sent (runner/ unchanged,
#   or the runner already runs the target).
#
# The runner is a fake Unix socket server under the temp tree, recording every
# op it receives. RELEASE_RUNNER_SOCKET always points at it, so the harness
# never touches the live /run/hqconsole/runner.sock.
#
#   harness.sh [--keep]     --keep leaves the temp tree for inspection
set -uo pipefail
export LC_ALL=C

KEEP_TREE=0
[ "${1:-}" = "--keep" ] && KEEP_TREE=1

HERE=$(cd "$(dirname "$0")" && pwd)
BUILD="$HERE/build.sh"
ACTIVATE="$HERE/activate.sh"
REPO=${HQ_ROOT:-/home/owner/hq}

[ -f "$BUILD" ]    || { echo "missing $BUILD" >&2; exit 1; }
[ -f "$ACTIVATE" ] || { echo "missing $ACTIVATE" >&2; exit 1; }
# -e, not -d: in a git worktree .git is a file
[ -e "$REPO/.git" ] || { echo "$REPO is not a git repository" >&2; exit 1; }

ROOT=$(mktemp -d /tmp/hq-console-release.XXXXXX) || { echo "mktemp failed" >&2; exit 1; }
# shellcheck disable=SC2329  # invoked by the EXIT trap below
cleanup() { [ -n "${RUNNER_PID:-}" ] && kill "$RUNNER_PID" 2>/dev/null; [ "$KEEP_TREE" = 1 ] && { echo "temp tree kept at $ROOT"; return; }; rm -rf "$ROOT"; }
trap cleanup EXIT

PASS=0
FAIL=0
CASE=""

say()  { printf '\n---- %s\n' "$*"; }
pass() { PASS=$((PASS + 1)); printf 'PASS %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL %s: %s\n' "$1" "$2"; [ -n "${3:-}" ] && tail -15 "$3"; }
fatal() { printf '\nHARNESS ERROR %s\n' "$*" >&2; exit 2; }

mkdir -p "$ROOT/bin" "$ROOT/logs" "$ROOT/out" "$ROOT/src" "$ROOT/releases" "$ROOT/state" \
  || fatal "could not create the temp layout"

# --- stubs -------------------------------------------------------------------

cat > "$ROOT/bin/npm" <<'NPM_EOF'
#!/bin/sh
# Harness stand-in for npm. Creates the shape of a real install, including the
# two kinds of symlink npm always leaves behind, so build.sh's symlink
# rejection is genuinely exercised rather than trivially satisfied.
sub=$1
[ $# -gt 0 ] && shift
case "$sub" in
  ci)
    rm -rf node_modules server/node_modules runner/node_modules
    mkdir -p node_modules/ws node_modules/busboy node_modules/node-pty \
             node_modules/.bin node_modules/@hq node_modules/vite/bin || exit 1
    for p in ws busboy node-pty vite; do
      printf '{"name":"%s","version":"0.0.0-harness"}\n' "$p" > "node_modules/$p/package.json" || exit 1
    done
    printf '#!/bin/sh\nexit 0\n' > node_modules/vite/bin/vite.js || exit 1
    chmod +x node_modules/vite/bin/vite.js || exit 1
    ln -sfn ../vite/bin/vite.js node_modules/.bin/vite || exit 1
    ln -sfn ../../server node_modules/@hq/console-server || exit 1
    ln -sfn ../../shared node_modules/@hq/console-shared || exit 1
    echo "harness npm: ci $*"
    ;;
  rebuild)
    mkdir -p node_modules/node-pty/build/Release || exit 1
    : > node_modules/node-pty/build/Release/pty.node || exit 1
    echo "harness npm: rebuild $*"
    ;;
  *)
    echo "harness npm: unexpected subcommand '$sub'" >&2
    exit 1
    ;;
esac
exit 0
NPM_EOF

cat > "$ROOT/bin/vite" <<'VITE_EOF'
#!/bin/sh
# Harness stand-in for the vite binary. cwd is the web workspace.
[ "$1" = build ] || { echo "harness vite: expected 'build', got '${1:-}'" >&2; exit 1; }
rm -rf dist
mkdir -p dist/assets || exit 1
printf '<!doctype html><title>hq console harness</title>\n' > dist/index.html || exit 1
printf 'export const harness = true;\n' > dist/assets/app.js || exit 1
echo "harness vite: wrote dist/index.html and dist/assets/app.js"
exit 0
VITE_EOF

cat > "$ROOT/bin/systemctl" <<'SYSTEMCTL_EOF'
#!/bin/sh
# Harness stand-in for systemctl. `restart` runs the fake server once, in the
# foreground: a clean exit means the release came up and wrote its health
# stamp, a non-zero exit stands in for a unit that failed to start.
STATEF="$HARNESS_ROOT/systemctl.state"
[ -f "$STATEF" ] || echo inactive > "$STATEF"
case "$1" in
  restart)
    if CONSOLE_STATE_DIR="$HARNESS_STATE" \
       node "$HARNESS_REL/current/server/src/server.js" >> "$HARNESS_ROOT/logs/service.log" 2>&1
    then
      echo active > "$STATEF"
    else
      echo failed > "$STATEF"
    fi
    exit 0
    ;;
  is-active)
    cat "$STATEF"
    [ "$(cat "$STATEF")" = active ] && exit 0
    exit 3
    ;;
  stop)
    echo inactive > "$STATEF"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
SYSTEMCTL_EOF

chmod +x "$ROOT/bin/npm" "$ROOT/bin/vite" "$ROOT/bin/systemctl" || fatal "could not chmod the stubs"

# --- throwaway mirror --------------------------------------------------------

say "setting up a throwaway bare mirror from $REPO"
git clone --quiet --bare "$REPO" "$ROOT/mirror.git" || fatal "bare clone failed"
git clone --quiet "$ROOT/mirror.git" "$ROOT/work" || fatal "work clone failed"
git -C "$ROOT/work" config user.email harness@localhost || fatal "git config failed"
git -C "$ROOT/work" config user.name "release harness" || fatal "git config failed"

APPDIR="$ROOT/work/ops/console/v2"
[ -f "$APPDIR/package-lock.json" ] || fatal "ops/console/v2/package-lock.json is not committed in $REPO; the harness needs it in the mirror"
mkdir -p "$APPDIR/server/src" || fatal "mkdir server/src failed"

# The fake server. ESM, because server/package.json declares type=module and
# this file is copied into the release next to it.
cat > "$APPDIR/server/src/server.js" <<'SERVER_EOF'
// Harness stand-in for the console server. Two modes:
//   --check   candidate mode: print {"ok":true} and exit 0
//   (none)    serve mode: write the health stamp and exit 0
// Failures are forced per release sha so a rollback target stays healthy while
// the release being activated fails.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const releaseDir = process.env.CONSOLE_RELEASE_DIR || join(here, '..', '..');
let sha = 'unknown';
try {
  sha = JSON.parse(readFileSync(join(releaseDir, 'RELEASE.json'), 'utf8')).sha;
} catch (err) {
  process.stderr.write('harness server: no RELEASE.json at ' + releaseDir + '\n');
}

if (process.argv.includes('--check')) {
  if (process.env.FAKE_FAIL_CHECK_SHA === sha) {
    process.stdout.write(JSON.stringify({ ok: false, sha, error: 'forced candidate failure' }) + '\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ ok: true, sha, protocol: 0 }) + '\n');
  process.exit(0);
}

if (process.env.FAKE_FAIL_POST_SHA === sha) {
  process.stderr.write('harness server: forced post-switch failure for ' + sha + '\n');
  process.exit(1);
}

const stateDir = process.env.CONSOLE_STATE_DIR;
if (!stateDir) {
  process.stderr.write('harness server: CONSOLE_STATE_DIR is unset\n');
  process.exit(1);
}
mkdirSync(stateDir, { recursive: true });
writeFileSync(join(stateDir, 'health.json'),
  JSON.stringify({ sha, at: new Date().toISOString() }) + '\n');
process.stdout.write('harness server: healthy ' + sha + '\n');
process.exit(0);
SERVER_EOF

git -C "$ROOT/work" add ops/console/v2/server/src/server.js || fatal "git add failed"
git -C "$ROOT/work" commit -q -m "harness: fake console server (commit A)" || fatal "commit A failed"
# --force: cloned from a worktree, HEAD is that worktree's branch, which need
# not descend from main; the mirror is throwaway, so main simply becomes it
git -C "$ROOT/work" push -q --force origin HEAD:main || fatal "push A failed"
SHA_A=$(git -C "$ROOT/work" rev-parse HEAD) || fatal "rev-parse A failed"

# --- fake runner -------------------------------------------------------------

# Answers hello, status, list and drain like runner/src/server.js. The release
# it claims to run is read from $ROOT/runner-release and the session records
# `list` returns from $ROOT/runner-sessions.json, on every request, so a case
# can say "the runner now runs X with these sessions". Every op lands in
# $ROOT/runner-ops.log.
cat > "$ROOT/bin/fake-runner.cjs" <<'RUNNER_EOF'
const net = require('net');
const fs = require('fs');
const [sock, relFile, opsLog, sessFile] = process.argv.slice(2);
// present: this fake knows `restart`; absent: an older runner ("unknown op")
const restartFlag = relFile + '.restart-op';
try { fs.unlinkSync(sock); } catch {}
let state = 'running';
net.createServer((c) => {
  let buf = '';
  c.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      let release = 'dev';
      try { release = fs.readFileSync(relFile, 'utf8').trim() || 'dev'; } catch {}
      fs.appendFileSync(opsLog, m.op + ' ' + release + '\n');
      let r;
      let sessions = [];
      try { sessions = JSON.parse(fs.readFileSync(sessFile, 'utf8')); } catch {}
      const alive = sessions.filter((x) => x.alive).length;
      if (m.op === 'hello') r = { ok: true, protocol: 1, release, state, sessions };
      else if (m.op === 'status') r = { ok: true, state, sessions: alive, release, protocol: 1 };
      else if (m.op === 'list') r = { ok: true, sessions };
      else if (m.op === 'drain') { state = 'draining'; r = { ok: true, state, sessions: alive }; }
      else if (m.op === 'restart' && fs.existsSync(restartFlag)) {
        // a runner with the restart op (hq-4npjr.20): persistent terms and
        // adopted panes never block; anything else makes the restart pending
        const blocking = sessions.filter((x) => x.alive && x.persistent !== true && x.kind !== 'tmux').length;
        if (blocking === 0) { state = 'draining'; r = { ok: true, state, sessions: alive, pending: false, blocking: 0 }; }
        else r = { ok: true, state, pending: true, blocking };
      }
      else r = { ok: false, error: 'unknown op' };
      c.write(JSON.stringify({ id: m.id, ...r }) + '\n');
    }
  });
}).listen(sock);
// a new runner process after a drain starts out running
process.on('SIGUSR1', () => { state = 'running'; });
RUNNER_EOF

start_fake_runner() {
  [ -n "${RUNNER_PID:-}" ] && kill "$RUNNER_PID" 2>/dev/null
  node "$ROOT/bin/fake-runner.cjs" "$ROOT/runner.sock" "$ROOT/runner-release" "$ROOT/runner-ops.log" "$ROOT/runner-sessions.json" \
    >> "$ROOT/logs/fake-runner.log" 2>&1 &
  RUNNER_PID=$!
  local i=0
  while [ ! -S "$ROOT/runner.sock" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  [ -S "$ROOT/runner.sock" ] || fatal "fake runner did not bind $ROOT/runner.sock"
}
stop_fake_runner() {
  [ -n "${RUNNER_PID:-}" ] && kill "$RUNNER_PID" 2>/dev/null
  wait "$RUNNER_PID" 2>/dev/null
  RUNNER_PID=""
  rm -f "$ROOT/runner.sock"
}
runner_runs() { printf '%s\n' "$1" > "$ROOT/runner-release"; }
runner_sessions() { printf '%s\n' "$1" > "$ROOT/runner-sessions.json"; }
# record shapes as runner/src/sessions.js and tmux.js write them: a persistent
# console term carries persistent:true, an adopted hq:work pane (kind tmux) has
# no persistent field, a snoozed term is listed with alive:false
S_TERM='{"sid":"t1","kind":"interactive","alive":true,"persistent":true}'
S_PANE='{"sid":"%7","kind":"tmux","alive":true}'
S_DEAD='{"sid":"w1","kind":"worker","alive":false,"persistent":false}'
S_SNOOZED='{"sid":"t2","kind":"interactive","alive":false,"snoozedUntil":"2026-10-21T08:00:00Z"}'
drains() { grep -c '^drain ' "$ROOT/runner-ops.log" 2>/dev/null || true; }
restarts() { grep -c '^restart ' "$ROOT/runner-ops.log" 2>/dev/null || true; }
S_WORKER='{"sid":"w2","kind":"worker","alive":true,"persistent":false}'
S_META='{"sid":"m1","kind":"meta","alive":true,"persistent":false}'

: > "$ROOT/runner-ops.log"
runner_runs dev
runner_sessions '[]'
start_fake_runner

# --- shared environment ------------------------------------------------------

export HARNESS_ROOT="$ROOT"
export HARNESS_REL="$ROOT/releases"
export HARNESS_STATE="$ROOT/state"
export RELEASE_NPM="$ROOT/bin/npm"
export RELEASE_VITE="$ROOT/bin/vite"
export RELEASE_SYSTEMCTL="$ROOT/bin/systemctl"
export SKIP_NATIVE=1
# Empty on purpose (activate.sh reads these with ${VAR-default}, so an exported
# empty value means "no sudo" and "no chown", which is what a rootless run
# needs).
export RELEASE_RUN_AS=""
export RELEASE_OWNER=""
export RELEASE_WRAPPER_DIR="$ROOT/wrapper-lib"
RELEASE_NODE=$(command -v node)
export RELEASE_NODE
export RELEASE_STATE_DIR="$ROOT/state"
export RELEASE_HEALTH_TIMEOUT=10
export RELEASE_CHECK_TIMEOUT=15
# never the live socket
export RELEASE_RUNNER_SOCKET="$ROOT/runner.sock"

do_build() {  # do_build <logname>
  bash "$BUILD" --mirror "$ROOT/mirror.git" --ref main \
    --out "$ROOT/out" --src "$ROOT/src" --keep 3 > "$ROOT/logs/$1.log" 2>&1
}

do_activate() {  # do_activate <logname> <args...>
  local name=$1; shift
  bash "$ACTIVATE" --out "$ROOT/out" --releases "$ROOT/releases" \
    --service hq-console.service --keep 3 "$@" > "$ROOT/logs/$name.log" 2>&1
}

cur_sha() { basename "$(readlink -f "$ROOT/releases/current" 2>/dev/null)"; }

# --- case 1: build A ---------------------------------------------------------

CASE="1 build A"
say "$CASE"
if do_build build-a; then
  if [ -f "$ROOT/out/$SHA_A/.complete" ] \
     && [ -f "$ROOT/out/$SHA_A/web/index.html" ] \
     && [ -f "$ROOT/out/$SHA_A/RELEASE.json" ] \
     && [ -f "$ROOT/out/$SHA_A/server/src/server.js" ] \
     && [ -d "$ROOT/out/$SHA_A/node_modules/ws" ] \
     && [ -d "$ROOT/out/$SHA_A/node_modules/@hq/console-shared" ] \
     && [ -x "$ROOT/out/$SHA_A/runner/spawn-as-owner.sh" ]; then
    STRAY=$(find "$ROOT/out/$SHA_A" -type l)
    if [ -z "$STRAY" ]; then
      pass "$CASE"
    else
      fail "$CASE" "symlinks survived into the output: $(printf '%s' "$STRAY" | head -3)"
    fi
  else
    fail "$CASE" "output tree incomplete" "$ROOT/logs/build-a.log"
  fi
else
  fail "$CASE" "build.sh exited non-zero" "$ROOT/logs/build-a.log"
fi

# --- case 2: build A again is a no-op ----------------------------------------

CASE="2 build A again skips"
say "$CASE"
STAMP_BEFORE=$(stat -c %Y "$ROOT/out/$SHA_A/.complete" 2>/dev/null)
if do_build build-a2; then
  STAMP_AFTER=$(stat -c %Y "$ROOT/out/$SHA_A/.complete" 2>/dev/null)
  MSG=$(grep -c 'already built' "$ROOT/logs/build-a2.log")
  if [ "$STAMP_BEFORE" = "$STAMP_AFTER" ] && [ "${MSG:-0}" -ge 1 ]; then
    pass "$CASE"
  else
    fail "$CASE" "it rebuilt instead of skipping" "$ROOT/logs/build-a2.log"
  fi
else
  fail "$CASE" "build.sh exited non-zero" "$ROOT/logs/build-a2.log"
fi

# --- case 3: activate A ------------------------------------------------------

CASE="3 activate A succeeds"
say "$CASE"
if do_activate activate-a "$SHA_A"; then
  if [ "$(cur_sha)" = "$SHA_A" ] && grep -q "$SHA_A" "$ROOT/state/health.json" 2>/dev/null \
     && [ "$(drains)" = 0 ] && grep -q 'no previous release to compare' "$ROOT/logs/activate-a.log"; then
    pass "$CASE"
  else
    fail "$CASE" "drains=$(drains) current is $(cur_sha), health stamp $(cat "$ROOT/state/health.json" 2>/dev/null)" "$ROOT/logs/activate-a.log"
  fi
else
  fail "$CASE" "activate.sh exited non-zero" "$ROOT/logs/activate-a.log"
fi

# from here on the runner runs A, as socket activation would have started it
runner_runs "$SHA_A"

# --- case 4: activating the current release again is a no-op -----------------

CASE="4 activate A again is a no-op"
say "$CASE"
if do_activate activate-a2 "$SHA_A"; then
  if grep -q 'already current' "$ROOT/logs/activate-a2.log" && [ "$(cur_sha)" = "$SHA_A" ] && [ "$(drains)" = 0 ]; then
    pass "$CASE"
  else
    fail "$CASE" "expected an early no-op" "$ROOT/logs/activate-a2.log"
  fi
else
  fail "$CASE" "activate.sh exited non-zero" "$ROOT/logs/activate-a2.log"
fi

# --- commit B and build it ---------------------------------------------------

say "commit B"
printf '// harness commit B\n' >> "$APPDIR/server/src/server.js" || fatal "could not amend the fake server"
git -C "$ROOT/work" add ops/console/v2/server/src/server.js || fatal "git add B failed"
git -C "$ROOT/work" commit -q -m "harness: fake console server (commit B)" || fatal "commit B failed"
git -C "$ROOT/work" push -q origin HEAD:main || fatal "push B failed"
SHA_B=$(git -C "$ROOT/work" rev-parse HEAD) || fatal "rev-parse B failed"
do_build build-b || fatal "build of commit B failed, see $ROOT/logs/build-b.log"
[ -f "$ROOT/out/$SHA_B/.complete" ] || fatal "commit B did not produce a complete build"

# --- case 5: candidate failure must not switch -------------------------------

CASE="5 candidate failure leaves current alone"
say "$CASE"
FAKE_FAIL_CHECK_SHA="$SHA_B" do_activate activate-b-badcheck "$SHA_B"
RC=$?
if [ "$RC" -ne 0 ] && [ "$(cur_sha)" = "$SHA_A" ]; then
  pass "$CASE"
else
  fail "$CASE" "rc=$RC current=$(cur_sha), expected non-zero and $SHA_A" "$ROOT/logs/activate-b-badcheck.log"
fi

# --- case 6: post-switch failure must roll back ------------------------------

CASE="6 post-switch failure rolls back to A"
say "$CASE"
FAKE_FAIL_POST_SHA="$SHA_B" do_activate activate-b-badpost "$SHA_B"
RC=$?
HEALTH_SHA=$(sed -n 's/.*"sha"[^"]*"\([0-9a-f]*\)".*/\1/p' "$ROOT/state/health.json" 2>/dev/null)
if [ "$RC" -ne 0 ] && [ "$(cur_sha)" = "$SHA_A" ] && [ "$HEALTH_SHA" = "$SHA_A" ]; then
  pass "$CASE"
else
  fail "$CASE" "rc=$RC current=$(cur_sha) health=$HEALTH_SHA, expected non-zero, current and health both $SHA_A" "$ROOT/logs/activate-b-badpost.log"
fi

# --- case 7: clean activation of B -------------------------------------------

CASE="7 activate B succeeds"
say "$CASE"
if do_activate activate-b "$SHA_B"; then
  if [ "$(cur_sha)" = "$SHA_B" ] && grep -q "$SHA_B" "$ROOT/state/health.json" 2>/dev/null \
     && [ "$(drains)" = 0 ] && grep -q 'runner: code unchanged' "$ROOT/logs/activate-b.log"; then
    pass "$CASE"
  else
    fail "$CASE" "current is $(cur_sha), drains=$(drains) (runner/ did not change, expected 0)" "$ROOT/logs/activate-b.log"
  fi
else
  fail "$CASE" "activate.sh exited non-zero" "$ROOT/logs/activate-b.log"
fi

# --- case 8: manual rollback -------------------------------------------------

CASE="8 manual rollback returns to A"
say "$CASE"
if do_activate rollback --rollback; then
  if [ "$(cur_sha)" = "$SHA_A" ] && grep -q "$SHA_A" "$ROOT/state/health.json" 2>/dev/null \
     && [ "$(drains)" = 0 ] && grep -q "runner: already runs $SHA_A" "$ROOT/logs/rollback.log"; then
    pass "$CASE"
  else
    fail "$CASE" "current is $(cur_sha), drains=$(drains)" "$ROOT/logs/rollback.log"
  fi
else
  fail "$CASE" "activate.sh --rollback exited non-zero" "$ROOT/logs/rollback.log"
fi

# --- commit C changes runner/ and build it ------------------------------------

say "commit C (runner/ changes)"
[ -f "$APPDIR/runner/src/runner.js" ] || fatal "the mirror has no runner/src/runner.js"
printf '// harness commit C\n' >> "$APPDIR/runner/src/runner.js" || fatal "could not amend runner.js"
git -C "$ROOT/work" add ops/console/v2/runner/src/runner.js || fatal "git add C failed"
git -C "$ROOT/work" commit -q -m "harness: runner change (commit C)" || fatal "commit C failed"
git -C "$ROOT/work" push -q origin HEAD:main || fatal "push C failed"
SHA_C=$(git -C "$ROOT/work" rev-parse HEAD) || fatal "rev-parse C failed"
do_build build-c || fatal "build of commit C failed, see $ROOT/logs/build-c.log"
[ -f "$ROOT/out/$SHA_C/.complete" ] || fatal "commit C did not produce a complete build"

# --- case 9: runner/ changed, but a non-persistent session would block -----

CASE="9 activate C defers the runner restart while an adopted pane is alive"
say "$CASE"
runner_sessions "[$S_TERM,$S_PANE,$S_DEAD]"
T0=$(date +%s)
if do_activate activate-c "$SHA_C"; then
  T1=$(date +%s)
  if [ "$(cur_sha)" = "$SHA_C" ] && [ "$(drains)" = 0 ] \
     && grep -q "^list $SHA_A\$" "$ROOT/runner-ops.log" \
     && grep -q 'runner restart deferred: 1 session(s) would block it' "$ROOT/logs/activate-c.log" \
     && [ $((T1 - T0)) -lt 30 ]; then
    pass "$CASE"
  else
    fail "$CASE" "current=$(cur_sha) drains=$(drains) took $((T1 - T0))s" "$ROOT/logs/activate-c.log"
  fi
else
  fail "$CASE" "activate.sh exited non-zero" "$ROOT/logs/activate-c.log"
fi

# --- case 10: the next run retries and drains once only persistent terms live

CASE="10 activate C again retries the deferred drain (only persistent terms)"
say "$CASE"
runner_sessions "[$S_TERM,$S_DEAD,$S_SNOOZED]"
if do_activate activate-c-retry "$SHA_C"; then
  if [ "$(cur_sha)" = "$SHA_C" ] && [ "$(drains)" = 1 ] \
     && grep -q "^drain $SHA_A\$" "$ROOT/runner-ops.log" \
     && grep -q 'already current' "$ROOT/logs/activate-c-retry.log" \
     && grep -q 'drain sent, state draining, 0 blocking session(s), 1 persistent terminal(s)' "$ROOT/logs/activate-c-retry.log"; then
    pass "$CASE"
  else
    fail "$CASE" "current=$(cur_sha) drains=$(drains)" "$ROOT/logs/activate-c-retry.log"
  fi
else
  fail "$CASE" "activate.sh exited non-zero" "$ROOT/logs/activate-c-retry.log"
fi

# --- case 11: rollback across a runner change drains too ---------------------

CASE="11 rollback C to A sends drain (runner on C, only persistent terms)"
say "$CASE"
# the drained runner exited and socket activation started C
runner_runs "$SHA_C"
kill -USR1 "$RUNNER_PID" 2>/dev/null
runner_sessions "[$S_TERM]"
if do_activate rollback-c --rollback; then
  if [ "$(cur_sha)" = "$SHA_A" ] && [ "$(drains)" = 2 ] && grep -q "^drain $SHA_C\$" "$ROOT/runner-ops.log"; then
    pass "$CASE"
  else
    fail "$CASE" "current=$(cur_sha) drains=$(drains)" "$ROOT/logs/rollback-c.log"
  fi
else
  fail "$CASE" "activate.sh --rollback exited non-zero" "$ROOT/logs/rollback-c.log"
fi

# --- cases 11b, 11c: a runner with the restart op (hq-4npjr.20) ------------------

CASE="11b activate C, restart-aware runner with a live meta session: restart pending, no drain"
say "$CASE"
: > "$ROOT/runner-release.restart-op"
runner_runs "$SHA_A"
kill -USR1 "$RUNNER_PID" 2>/dev/null
runner_sessions "[$S_TERM,$S_META]"
if do_activate activate-c-pending "$SHA_C"; then
  if [ "$(cur_sha)" = "$SHA_C" ] && [ "$(drains)" = 2 ] && [ "$(restarts)" -ge 1 ] \
     && grep -q 'runner restart pending: 1 blocking session(s)' "$ROOT/logs/activate-c-pending.log"; then
    pass "$CASE"
  else
    fail "$CASE" "current=$(cur_sha) drains=$(drains) restarts=$(restarts)" "$ROOT/logs/activate-c-pending.log"
  fi
else
  fail "$CASE" "activate.sh exited non-zero" "$ROOT/logs/activate-c-pending.log"
fi

CASE="11c activate C again, restart-aware runner, only a term and an adopted pane: restart drains"
say "$CASE"
runner_sessions "[$S_TERM,$S_PANE]"
if do_activate activate-c-restart "$SHA_C"; then
  if [ "$(drains)" = 2 ] \
     && grep -q 'drain sent, state draining, 0 blocking session(s), 1 persistent terminal(s)' "$ROOT/logs/activate-c-restart.log"; then
    pass "$CASE"
  else
    fail "$CASE" "drains=$(drains) restarts=$(restarts)" "$ROOT/logs/activate-c-restart.log"
  fi
else
  fail "$CASE" "activate.sh exited non-zero" "$ROOT/logs/activate-c-restart.log"
fi
rm -f "$ROOT/runner-release.restart-op"

# --- case 12: no runner socket is a warning, not a failure -------------------

CASE="12 activate C with the runner socket gone still succeeds"
say "$CASE"
stop_fake_runner
if do_activate activate-c-nosock "$SHA_C"; then
  if [ "$(cur_sha)" = "$SHA_C" ] && grep -q 'runner: no socket at' "$ROOT/logs/activate-c-nosock.log"; then
    pass "$CASE"
  else
    fail "$CASE" "current=$(cur_sha)" "$ROOT/logs/activate-c-nosock.log"
  fi
else
  fail "$CASE" "activate.sh exited non-zero" "$ROOT/logs/activate-c-nosock.log"
fi

# --- summary -----------------------------------------------------------------

printf '\n========================================\n'
printf 'harness: %d passed, %d failed\n' "$PASS" "$FAIL"
printf 'temp tree: %s\n' "$ROOT"
printf '========================================\n'
[ "$FAIL" -eq 0 ] || exit 1
exit 0
