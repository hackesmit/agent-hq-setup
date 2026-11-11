#!/usr/bin/env bash
# HQ Console v2: build one release from the credential-free local git mirror.
#
# Runs as hqbuild, from console-build.service (see units/console-build.service).
# Design: docs/superpowers/specs/2026-08-17-console-v2-design.md section 3.
#
#   build.sh [--mirror PATH] [--ref REF] [--out DIR] [--src DIR] [--keep N]
#
# Defaults: --mirror /var/lib/hqsync/mirrors/agent-hq.git --ref main
#           --out /var/lib/hqbuild/out --src /var/lib/hqbuild/src --keep 3
#
# What it does, in order:
#   1. resolve REF to a commit sha in the mirror (never from ~/hq: the working
#      tree is worker-writable, so only pushed, reviewed content is built)
#   2. exit 0 immediately if that sha is already built and complete
#   3. clone --no-checkout from the mirror, sparse-checkout ops/console/v2
#   4. full `npm ci --ignore-scripts` (vite and its plugins are devDeps)
#   5. `node_modules/.bin/vite build` invoked directly, never `npm run`, so
#      package.json cannot inject a command
#   6. prod-only `npm ci --ignore-scripts --omit=dev` for server and runner
#   7. `npm rebuild node-pty` (that one package only) and a PTY smoke test
#   8. assemble out/<sha>/{server,runner,shared,web,node_modules}, reject any
#      symlink in the tree, write RELEASE.json, then the .complete marker
#   9. keep the newest N outputs, drop the rest
#
# Exit 0 means "the newest commit is built and complete", whether or not this
# run did the work. console-build.service hands off to hq-console-activate on
# exit 0, and activate.sh no-ops when the sha is already current.
#
# TEST HOOKS (used by release/harness.sh on a machine with no compiler and no
# npm registry access; never set in production):
#   RELEASE_NPM     command used instead of `npm`
#   RELEASE_VITE    path used instead of <app>/node_modules/.bin/vite
#   SKIP_NATIVE=1   skip `npm rebuild node-pty` and the PTY smoke test
#   SMOKE_PTY=0     build node-pty but leave the smoke test to activate.sh
#   RELEASE_REGISTRY  npm registry URL (default https://registry.npmjs.org)
#   HUB_ORIGIN_WAIT / HUB_ORIGIN_POLL  seconds to wait for origin, poll step
set -uo pipefail
# Every git and npm invocation below is machine-parsed. A localized message
# would make a match silently fail.
export LC_ALL=C

MIRROR=/var/lib/hqsync/mirrors/agent-hq.git
REF=main
OUT=/var/lib/hqbuild/out
SRC=/var/lib/hqbuild/src
KEEP=3
NPM=${RELEASE_NPM:-npm}
REGISTRY=${RELEASE_REGISTRY:-https://registry.npmjs.org}
# Relative to the checked-out app root; overridable for the harness.
VITE=${RELEASE_VITE:-}
# Seconds to wait for a head commit to reach origin before deferring (hq-oq30g.3);
# well under the unit's TimeoutStartSec=1800.
HUB_ORIGIN_WAIT=${HUB_ORIGIN_WAIT:-120}
HUB_ORIGIN_POLL=${HUB_ORIGIN_POLL:-5}

log()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '    ok %s\n' "$*"; }
warn() { printf '    WARN %s\n' "$*"; }
die()  { printf '\nFAILED %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,40p' "$0"; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --mirror) MIRROR=${2:-}; shift 2 || die "--mirror needs a value";;
    --ref)    REF=${2:-};    shift 2 || die "--ref needs a value";;
    --out)    OUT=${2:-};    shift 2 || die "--out needs a value";;
    --src)    SRC=${2:-};    shift 2 || die "--src needs a value";;
    --keep)   KEEP=${2:-};   shift 2 || die "--keep needs a value";;
    -h|--help) usage 0;;
    *) die "unknown argument: $1 (try --help)";;
  esac
done

[ -n "$MIRROR" ] && [ -n "$REF" ] && [ -n "$OUT" ] && [ -n "$SRC" ] || die "empty argument value"
case "$KEEP" in ''|*[!0-9]*) die "--keep must be a number, got '$KEEP'";; esac
[ "$KEEP" -ge 1 ] || die "--keep must be at least 1"
case "$HUB_ORIGIN_WAIT$HUB_ORIGIN_POLL" in *[!0-9]*) die "HUB_ORIGIN_WAIT and HUB_ORIGIN_POLL must be numbers";; esac
[ "$HUB_ORIGIN_POLL" -ge 1 ] || die "HUB_ORIGIN_POLL must be at least 1"

command -v git >/dev/null 2>&1 || die "git not found"
# the mirror is owned by hqsync; mark it safe for this process only (no global config writes)
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$MIRROR"
command -v "$NPM" >/dev/null 2>&1 || [ -x "$NPM" ] || die "npm not found (tried '$NPM')"

# 1. mirror and lock -----------------------------------------------------------
log "1/9 mirror $MIRROR ref $REF"
[ -d "$MIRROR" ] || die "mirror $MIRROR does not exist. hub-sync (ops/console/v2/sync, bead hq-4m5u) creates and maintains the per-repo mirrors under /var/lib/hqsync/mirrors; this script never creates one."
[ -r "$MIRROR" ] || die "mirror $MIRROR is not readable by $(id -un). The mirrors are group hqmirror; either the group bits or the world-read bits must let the build user in."
case "$MIRROR" in /var/lib/hqsync/mirrors/*.git|/tmp/*|/var/tmp/*) ;; *) die "--mirror must be a hub-sync mirror under /var/lib/hqsync/mirrors (got $MIRROR)";; esac
git --git-dir="$MIRROR" rev-parse --git-dir >/dev/null 2>&1 \
  || die "$MIRROR is not a git repository"

mkdir -p "$OUT" "$SRC" || die "could not create $OUT and $SRC"

# One build at a time. A second poll while a build runs is not an error: the
# lock holder is already building the same commit, so this run just leaves.
exec 9>"$OUT/.build.lock" || die "could not open the build lock at $OUT/.build.lock"
if ! flock -n 9; then
  ok "another build holds the lock, nothing to do"
  exit 0
fi

# refs/heads/<ref> first: in a mirror clone the branches live there, and asking
# for the bare name would also match a tag of the same name.
SHA=$(git --git-dir="$MIRROR" rev-parse --verify --quiet "refs/heads/$REF^{commit}")
[ -n "$SHA" ] || SHA=$(git --git-dir="$MIRROR" rev-parse --verify --quiet "$REF^{commit}")
# Only content GitHub already has gets built: hub-sync keeps refs/hub-origin/* as an
# exact (forced) shadow of origin's tips; a commit pushed straight into the mirror by a
# owner-context process is not built until hub-sync has forwarded it and fetched it back.
# A commit not yet forwarded is the normal race with git-sync and hub-sync, and it
# heals within minutes (hq-oq30g.3): wait up to HUB_ORIGIN_WAIT seconds for the
# shadow to catch up, then exit 0 with a deferred line so OnFailure stays quiet;
# the next timer poll retries. Nothing past this point runs until it is on origin.
if [ -n "$SHA" ] && git --git-dir="$MIRROR" rev-parse --verify --quiet "refs/hub-origin/$REF^{commit}" >/dev/null 2>&1; then
  waited=0
  until git --git-dir="$MIRROR" merge-base --is-ancestor "$SHA" "refs/hub-origin/$REF" 2>/dev/null; do
    if [ "$waited" -ge "$HUB_ORIGIN_WAIT" ]; then
      ok "deferred: $SHA on $REF is not yet on origin (refs/hub-origin/$REF) after ${waited}s; the next poll retries"
      exit 0
    fi
    [ "$waited" = 0 ] && ok "$SHA on $REF is not yet on origin; waiting up to ${HUB_ORIGIN_WAIT}s"
    sleep "$HUB_ORIGIN_POLL"; waited=$((waited + HUB_ORIGIN_POLL))
  done
elif [ -n "$SHA" ] && [ "${REQUIRE_HUB_ORIGIN:-1}" = 1 ] && [[ "$MIRROR" == /var/lib/hqsync/mirrors/* ]]; then
  die "mirror has no refs/hub-origin/$REF shadow yet (hub-sync has not fetched); refusing to build"
fi
[ -n "$SHA" ] || die "could not resolve '$REF' to a commit in $MIRROR. Has git-sync fetched yet?"
ok "resolved $REF to $SHA"

# 2. already built? ------------------------------------------------------------
# The common case: the timer polls every 5 minutes and main rarely moves. Bail
# out to the retention pass rather than re-cloning and re-installing. Retention
# still runs, because a previous run may have died before reaching it.
DEST="$OUT/$SHA"
if [ -f "$DEST/.complete" ]; then
  ok "$SHA already built at $DEST, nothing to do"
  printf '%s\n' "$SHA" > "$OUT/LATEST" || die "could not update $OUT/LATEST"
else

# 3. checkout ------------------------------------------------------------------
log "2/9 checkout"
WORK="$SRC/$SHA"
rm -rf "$WORK" || die "could not clear $WORK"
git clone --quiet --no-checkout "$MIRROR" "$WORK" \
  || die "clone from $MIRROR failed"
git -C "$WORK" sparse-checkout init --cone \
  || die "sparse-checkout init failed"
git -C "$WORK" sparse-checkout set ops/console/v2 \
  || die "sparse-checkout set failed"
git -C "$WORK" checkout --quiet --detach "$SHA" \
  || die "checkout of $SHA failed"

APP="$WORK/ops/console/v2"
[ -f "$APP/package.json" ]      || die "$APP/package.json missing at $SHA"
[ -f "$APP/package-lock.json" ] || die "$APP/package-lock.json missing at $SHA. The lockfile is what makes npm ci reproducible; refusing to build without it."
ok "checked out ops/console/v2 at $SHA"

STAGE="$OUT/.stage-$SHA"
rm -rf "$STAGE" || die "could not clear $STAGE"
mkdir -p "$STAGE" || die "could not create $STAGE"

# 4. full install (dev deps: vite, tailwind, typescript) ------------------------
# --ignore-scripts is the whole point: no package in the tree gets to run a
# lifecycle command on this box. --registry is explicit so a stray .npmrc
# cannot redirect the install.
log "3/9 npm ci (full, for the web build)"
( cd "$APP" && "$NPM" ci --ignore-scripts --no-audit --no-fund --registry "$REGISTRY" ) \
  || die "npm ci (full) failed. Check the journal for the registry error."
ok "dev+prod dependencies installed"

# 5. web build -----------------------------------------------------------------
log "4/9 vite build"
VITE_BIN=${VITE:-$APP/node_modules/.bin/vite}
[ -x "$VITE_BIN" ] || die "vite not executable at $VITE_BIN after npm ci"
( cd "$APP/web" && "$VITE_BIN" build ) \
  || die "vite build failed"
[ -f "$APP/web/dist/index.html" ] \
  || die "vite build produced no web/dist/index.html"
# The bundle itself, not just the entry page. An empty dist with a stray
# index.html would otherwise ship as a working release.
DIST_ASSETS=$(find "$APP/web/dist" -type f ! -name index.html | head -1)
[ -n "$DIST_ASSETS" ] || die "web/dist contains only index.html, no built assets"
mkdir -p "$STAGE/web" || die "could not create $STAGE/web"
cp -a "$APP/web/dist/." "$STAGE/web/" || die "could not stage web/dist"
ok "web assets staged"

# 6. prod-only install ---------------------------------------------------------
# npm ci wipes node_modules first, so this replaces the dev tree rather than
# layering on it. Only the two runtime workspaces are installed; the web
# workspace's runtime deps are already inside the bundle.
log "5/9 npm ci (prod only, server and runner)"
( cd "$APP" && "$NPM" ci --ignore-scripts --omit=dev --no-audit --no-fund \
    --registry "$REGISTRY" --include-workspace-root -w server -w runner ) \
  || die "npm ci (prod) failed"

find_pkg() {  # find_pkg <name> -> prints the package dir, or nothing
  local n=$1 p
  for p in "$APP/node_modules/$n" "$APP/server/node_modules/$n" "$APP/runner/node_modules/$n"; do
    [ -d "$p" ] && { printf '%s\n' "$p"; return 0; }
  done
  return 1
}
for dep in ws busboy node-pty; do
  find_pkg "$dep" >/dev/null || die "prod install is missing '$dep'. The -w filtered npm ci did not install the runtime workspaces; run npm ci --omit=dev without -w and re-check."
done
ok "runtime dependencies present"

# 7. node-pty ------------------------------------------------------------------
log "6/9 node-pty native build and smoke test"
if [ "${SKIP_NATIVE:-0}" = 1 ]; then
  warn "SKIP_NATIVE=1, not rebuilding node-pty (test hook, never set in production)"
else
  # Exactly one package is allowed to run its build. Everything else stayed
  # under --ignore-scripts.
  ( cd "$APP" && "$NPM" rebuild node-pty --foreground-scripts ) \
    || die "npm rebuild node-pty failed. build-essential and python3 must be installed (provision/hqbox-console-provision.sh does that)."
  PTY_NODE=$(find "$APP" -path '*/node-pty/build/Release/pty.node' -print -quit)
  [ -n "$PTY_NODE" ] || die "npm rebuild node-pty reported success but no pty.node exists. Refusing to ship a runner that cannot open a terminal."
  ok "compiled $PTY_NODE"

  if [ "${SMOKE_PTY:-1}" = 0 ]; then
    warn "SMOKE_PTY=0, deferring the PTY smoke test to activate.sh"
  else
    SMOKE="$APP/.pty-smoke.cjs"
    # .cjs so the require() form is valid regardless of the nearest
    # package.json "type". Written inside $APP so require resolves from the
    # tree we just installed.
    cat > "$SMOKE" <<'SMOKE_EOF'
const pty = require('node-pty');
let out = '';
const timer = setTimeout(() => { console.error('pty smoke: timed out'); process.exit(1); }, 15000);
const p = pty.spawn('/bin/sh', ['-c', 'echo ok'], {
  name: 'xterm-color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
});
p.onData((d) => { out += d; });
p.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (out.indexOf('ok') === -1) {
    console.error('pty smoke: no output from the child, got ' + JSON.stringify(out));
    process.exit(1);
  }
  if (exitCode !== 0) { console.error('pty smoke: child exited ' + exitCode); process.exit(1); }
  console.log('pty smoke ok');
  process.exit(0);
});
SMOKE_EOF
    [ -f "$SMOKE" ] || die "could not write the smoke test"
    # If a hardened unit ever blocks pty allocation here, set SMOKE_PTY=0 on
    # the unit and let activate.sh run the same test outside the build sandbox.
    ( cd "$APP" && node "$SMOKE" ) \
      || die "node-pty smoke test failed. If the builder unit cannot allocate a pty, set SMOKE_PTY=0 in console-build.service and activate.sh will run it instead."
    rm -f "$SMOKE"
    ok "node-pty spawns a working pty"
  fi
fi

# 8. assemble ------------------------------------------------------------------
# Only what the runtime needs. No tests, no web sources, no .git, no lockfile.
log "7/9 assemble $STAGE"
[ -f "$APP/server/src/server.js" ] || die "server/src/server.js missing at $SHA. The server bead (P0.2) has not landed; there is nothing to release."
[ -f "$APP/runner/src/runner.js" ] || warn "runner/src/runner.js missing at $SHA, releasing without a runner (terminals will be unavailable)"

mkdir -p "$STAGE/server" "$STAGE/runner" || die "could not create the stage layout"
cp -a "$APP/package.json" "$STAGE/package.json" || die "could not stage the root package.json"
cp -a "$APP/server/src" "$STAGE/server/src" || die "could not stage server/src"
cp -a "$APP/server/package.json" "$STAGE/server/package.json" || die "could not stage server/package.json"
if [ -d "$APP/runner/src" ]; then
  cp -a "$APP/runner/src" "$STAGE/runner/src" || die "could not stage runner/src"
fi
cp -a "$APP/runner/package.json" "$STAGE/runner/package.json" || die "could not stage runner/package.json"
# The sudo wrapper the runner execs. Its path is what the sudoers drop-in
# allows, so it has to ship inside the release.
for sh in "$APP"/runner/*.sh "$APP"/runner/*.py; do
  [ -f "$sh" ] || continue
  cp -a "$sh" "$STAGE/runner/" || die "could not stage $sh"
  chmod 0755 "$STAGE/runner/$(basename "$sh")" || die "could not chmod $sh"
done
cp -a "$APP/shared" "$STAGE/shared" || die "could not stage shared/"
# Capri, the meta terminal (proposal 19): the settings file and the two hooks, which
# activate.sh installs root-owned into /var/lib/hqconsole/meta after the health gate.
if [ -d "$APP/meta" ]; then
  install -d "$STAGE/meta" || die "could not stage meta/"
  for f in meta-settings.json hook-meta-audit.sh hook-meta-settings-integrity.sh; do
    [ -f "$APP/meta/$f" ] && { cp -a "$APP/meta/$f" "$STAGE/meta/$f" || die "could not stage meta/$f"; }
  done
fi
rm -rf "$STAGE/shared/node_modules"
cp -a "$APP/node_modules" "$STAGE/node_modules" || die "could not stage node_modules"
for w in server runner; do
  if [ -d "$APP/$w/node_modules" ]; then
    cp -a "$APP/$w/node_modules" "$STAGE/$w/node_modules" || die "could not stage $w/node_modules"
  fi
done

# Symlink hygiene. The release tree is served and executed by a daemon that
# resolves realpaths and refuses anything outside its root, so a link is either
# useless or an escape. npm creates two kinds every time and both are removed
# here rather than tolerated:
#   node_modules/.bin/*   CLI shims, never used at runtime
#   node_modules/@hq/*    workspace links back into the source tree
# @hq/console-shared is re-materialised as a real directory because the server
# may legitimately import it by package name.
find "$STAGE" -type d -name .bin -prune -exec rm -rf {} + \
  || die "could not remove node_modules/.bin"
rm -rf "$STAGE/node_modules/@hq" || die "could not remove the workspace links"
mkdir -p "$STAGE/node_modules/@hq" || die "could not create node_modules/@hq"
cp -a "$STAGE/shared" "$STAGE/node_modules/@hq/console-shared" \
  || die "could not materialise @hq/console-shared"

STRAY_LINKS=$(find "$STAGE" -type l)
if [ -n "$STRAY_LINKS" ]; then
  printf '%s\n' "$STRAY_LINKS" | head -20
  die "the assembled release contains symlinks (listed above). A dependency shipped one, or the workspace links came back. Resolve them to real files before shipping."
fi
ok "no symlinks in the output tree"

# 9. metadata and publish ------------------------------------------------------
log "8/9 metadata"
NODE_V=$(node -v 2>/dev/null)
[ -n "$NODE_V" ] || die "node not on PATH in the builder"
# The console-runner wire protocol version. shared/index.js declares it once
# the runner bead lands; 0 means "not declared yet", which --check treats as
# first boot.
PROTOCOL=$(sed -n 's/.*RUNNER_PROTOCOL[^0-9]*\([0-9]\{1,\}\).*/\1/p' "$APP/shared/index.js" 2>/dev/null | head -1)
[ -n "$PROTOCOL" ] || PROTOCOL=0
BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{\n  "sha": "%s",\n  "builtAt": "%s",\n  "node": "%s",\n  "protocol": %s\n}\n' \
  "$SHA" "$BUILT_AT" "$NODE_V" "$PROTOCOL" > "$STAGE/RELEASE.json" \
  || die "could not write RELEASE.json"
ok "RELEASE.json sha=$SHA node=$NODE_V protocol=$PROTOCOL"

# The completeness marker is the last thing written inside the stage, and the
# stage is then moved into place with a single rename. A reader therefore never
# sees a half-assembled out/<sha> that claims to be complete.
printf '%s\n' "$SHA" > "$STAGE/.complete" || die "could not write the completeness marker"
rm -rf "$DEST" || die "could not clear a previous partial $DEST"
mv -T "$STAGE" "$DEST" || die "could not publish $STAGE to $DEST"
printf '%s\n' "$SHA" > "$OUT/LATEST" || die "could not update $OUT/LATEST"
ok "published $DEST"

# The checkout is scratch; the release is the artifact.
rm -rf "$WORK"

fi  # end of the "not already built" branch

log "9/9 retention"

# Keep the newest $KEEP complete outputs. Ordered by the marker's mtime, which
# is written once at publish and never touched again, so this is publish order
# and not "whatever last read the directory".
COMPLETE=$(find "$OUT" -mindepth 2 -maxdepth 2 -name .complete -printf '%T@ %h\n' 2>/dev/null | sort -rn | awk '{print $2}')
KEPT=0
while IFS= read -r d; do
  [ -n "$d" ] || continue
  KEPT=$((KEPT + 1))
  if [ "$KEPT" -le "$KEEP" ]; then
    continue
  fi
  rm -rf "$d" || die "could not remove the aged-out build $d"
  ok "removed aged-out build $(basename "$d")"
done <<< "$COMPLETE"
# Stale stage dirs from a run that died mid-build.
find "$OUT" -mindepth 1 -maxdepth 1 -name '.stage-*' -mmin +120 -exec rm -rf {} + 2>/dev/null
# Scratch checkouts of builds that no longer exist.
find "$SRC" -mindepth 1 -maxdepth 1 -type d -mmin +1440 -exec rm -rf {} + 2>/dev/null
ok "keeping the newest $KEEP builds"

printf '\nBUILD OK %s\n' "$SHA"
exit 0
