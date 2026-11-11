#!/usr/bin/env bash
# HQ Console v2: publish a built release, health-gated, with automatic rollback.
#
# Runs as root, from hq-console-activate.service (started by
# console-build.service's OnSuccess=, or by hand).
# Design: docs/superpowers/specs/2026-08-17-console-v2-design.md section 3.
#
#   activate.sh --latest              activate the newest complete build
#   activate.sh <sha>                 activate one specific build
#   activate.sh --rollback            move `current` back one release
#
# Options: [--out DIR] [--releases DIR] [--service NAME] [--keep N]
# Defaults: --out /var/lib/hqbuild/out --releases /var/lib/hqconsole/releases
#           --service hq-console.service --keep 3
#
# The sequence, and why each step is where it is:
#   1. copy out/<sha> into releases/<sha>, links rejected again on arrival
#      (the build already rejected them; this is the boundary that matters,
#      because this is the tree the daemon executes and serves)
#   2. run the candidate `server.js --check` as hqconsole with the production
#      environment, 30 s cap, require {"ok":true} on stdout. --check binds no
#      port, writes nothing and runs no reconcile, so this is safe to do while
#      the old release is still serving
#   3. only then switch `current` (symlink write plus rename, so no reader ever
#      sees a missing link)
#   4. restart hq-console.service and wait for the health stamp the server
#      writes at successful listen. There is deliberately no HTTP health probe:
#      the server refuses self-peer connections (design section 3 auth), so a
#      curl from this box would be rejected by design and prove nothing
#   5. on any failure after the switch, move `current` back, restart, exit 1
#
# hq-runner.service is NEVER restarted here. It owns live PTYs and restarts
# itself after draining (see units/hq-runner.service). What activation does
# instead, after a healthy switch (and after a healthy --rollback): it asks the
# runner which release it runs, and when the runner code of that release
# differs from the new one (a hash over runner/ plus the node-pty version), it
# sends `restart` (hq-4npjr.20). With no blocking session alive (worker PTYs and
# the meta session block; persistent console terminals and adopted tmux panes do
# not) the runner drains and exits at once, and hq-runner.socket starts the new
# release on the next connect, re-attaching the persistent terminals under the
# same sid. Otherwise the runner logs "restart pending", keeps serving, and
# drains itself when the last blocking session ends; a meta session with no input
# for RUNNER_META_RESTART_IDLE_MS (default 1 h) is closed for it. An older runner
# without `restart` gets the old rule: `drain` only when no non-persistent
# session is alive, else "runner restart deferred" and the next run retries.
# Activation never waits and never kills a session. Any runner problem here is
# a warning, never an activation failure.
#
# TEST HOOKS (release/harness.sh; never set in production):
#   RELEASE_SYSTEMCTL   command used instead of `systemctl`
#   RELEASE_SERVER_CMD  command used instead of `/usr/bin/node`, given
#                       "<release>/server/src/server.js --check" as arguments
#   RELEASE_NODE        node binary (default /usr/bin/node)
#   RELEASE_RUN_AS      user to drop to (default hqconsole; empty = no sudo)
#   RELEASE_OWNER       chown target (default hqconsole:hqconsole; empty = skip)
#   RELEASE_STATE_DIR   health stamp directory
#   RELEASE_RUNNER_SOCKET runner socket (default /run/hqconsole/runner.sock)
#   RELEASE_RUNNER_DRAIN=0 never talk to the runner (no query, no drain)
#   RELEASE_SMOKE_PTY=1 run the node-pty smoke test here, for a builder that
#                       was configured with SMOKE_PTY=0
set -uo pipefail
export LC_ALL=C

OUT=/var/lib/hqbuild/out
REL=/var/lib/hqconsole/releases
SERVICE=hq-console.service
KEEP=3
MODE=""
SHA=""

SYSTEMCTL=${RELEASE_SYSTEMCTL:-systemctl}
NODE_BIN=${RELEASE_NODE:-/usr/bin/node}
RUN_AS=${RELEASE_RUN_AS-hqconsole}
OWNER=${RELEASE_OWNER-hqconsole:hqconsole}
STATE=${RELEASE_STATE_DIR:-/var/lib/hqconsole/state}
CHECK_TIMEOUT=${RELEASE_CHECK_TIMEOUT:-30}
HEALTH_TIMEOUT=${RELEASE_HEALTH_TIMEOUT:-30}
RUNNER_SOCK=${RELEASE_RUNNER_SOCKET:-/run/hqconsole/runner.sock}
RUNNER_DRAIN=${RELEASE_RUNNER_DRAIN:-1}

log()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '    ok %s\n' "$*"; }
warn() { printf '    WARN %s\n' "$*"; }
die()  { printf '\nFAILED %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,59p' "$0"; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --latest)   MODE=latest; shift;;
    --rollback) MODE=rollback; shift;;
    --out)      OUT=${2:-}; shift 2 || die "--out needs a value";;
    --releases) REL=${2:-}; shift 2 || die "--releases needs a value";;
    --service)  SERVICE=${2:-}; shift 2 || die "--service needs a value";;
    --keep)     KEEP=${2:-}; shift 2 || die "--keep needs a value";;
    -h|--help)  usage 0;;
    -*)         die "unknown option: $1 (try --help)";;
    *)          [ -z "$SHA" ] || die "more than one sha given"; MODE=sha; SHA=$1; shift;;
  esac
done
[ -n "$MODE" ] || die "nothing to do. Pass --latest, a sha, or --rollback."
case "$KEEP" in ''|*[!0-9]*) die "--keep must be a number";; esac
[ "$KEEP" -ge 2 ] || die "--keep must be at least 2, or a rollback has nowhere to go"

[ -d "$REL" ] || die "$REL does not exist. Run provision/hqbox-console-provision.sh first."
# state is written by the console user; a root-created dir would make health.json unwritable
if [ ! -d "$STATE" ]; then
  install -d -m 0750 ${OWNER:+-o "${OWNER%%:*}" -g "${OWNER##*:}"} "$STATE" || die "could not create $STATE"
fi
# one activation at a time: a concurrent run (manual, --rollback, the 5-minute timer)
# must never rm -rf the tree the live server runs from
LOCK_FILE="$REL/.activate.lock"
exec 8>"$LOCK_FILE" || die "cannot open $LOCK_FILE"
flock -n 8 || die "another activation is running (lock $LOCK_FILE); try again later"
FAILED_DIR="$REL/.failed"

HEALTH="$STATE/health.json"
CURRENT="$REL/current"
PREV_FILE="$REL/.previous"
PINNED="$REL/.pinned"

# --- helpers -----------------------------------------------------------------

current_sha() {  # prints the sha `current` points at, or nothing (no link, dangling link, or a self-loop)
  local t
  [ -L "$CURRENT" ] || return 0
  t=$(readlink -f "$CURRENT" 2>/dev/null) || return 0
  [ -n "$t" ] && [ -d "$t" ] || return 0
  t=$(basename "$t")
  [ "$t" != "current" ] || return 0
  printf '%s\n' "$t"
}

# Symlink hygiene, enforced on arrival and not merely on departure. This is the
# tree the daemon executes and serves; a link here is either dead weight or a
# way out of the served root.
reject_links() {  # reject_links <dir>
  local stray
  stray=$(find "$1" -type l 2>/dev/null)
  if [ -n "$stray" ]; then
    printf '%s\n' "$stray" | head -20
    die "release tree $1 contains symlinks (listed above); refusing to publish it"
  fi
}

prod_env() {  # prints the production environment as VAR=VALUE lines (names the server reads: server/src/config.js)
  local dir=$1
  printf '%s\n' \
    "NODE_ENV=production" \
    "CONSOLE_RELEASE_ROOT=$dir" \
    "CONSOLE_RELEASE_CANDIDATE=1" \
    "CONSOLE_STATE_DIR=$STATE" \
    "CONSOLE_TLS_DIR=/var/lib/hqconsole/tls" \
    "CONSOLE_HOST=hqbox.example.ts.net" \
    "CONSOLE_PORT=${CONSOLE_PORT:-8790}" \
    "CONSOLE_OWNER=owner@example.com" \
    "CONSOLE_WRAPPER=/usr/local/lib/hq-console/spawn-as-owner.sh" \
    "CONSOLE_WRAPPER_SUDO=1" \
    "CONSOLE_WRAPPER_USER=owner" \
    "CONSOLE_TAILSCALE_SOCK=/var/run/tailscale/tailscaled.sock" \
    "HQ_ROOT=/home/owner/hq" \
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
}

# Builds the candidate command. sudo comes first (it drops the environment),
# then env sets the production variables, then the interpreter.
candidate_check() {  # candidate_check <release-dir>; prints stdout of the check
  local dir=$1
  local -a cmd=()
  local -a envs=()
  local line
  while IFS= read -r line; do envs+=("$line"); done < <(prod_env "$dir")
  [ -n "$RUN_AS" ] && cmd+=(sudo -n -u "$RUN_AS")
  cmd+=(env "${envs[@]}")
  if [ -n "${RELEASE_SERVER_CMD:-}" ]; then
    # Word-split on purpose: the hook is documented as a command line.
    # shellcheck disable=SC2206
    cmd+=(${RELEASE_SERVER_CMD})
  else
    cmd+=("$NODE_BIN")
  fi
  timeout "$CHECK_TIMEOUT" "${cmd[@]}" "$dir/server/src/server.js" --check
}

switch_to() {  # switch_to <sha>; atomic replacement of the `current` symlink
  local sha=$1
  ln -sfn "$REL/$sha" "$REL/.current.new" || die "could not create the staging symlink"
  mv -T "$REL/.current.new" "$CURRENT" || die "could not move the current symlink to $sha"
}

# The stamp is the only honest post-switch health signal available on this box.
# The server refuses connections from itself (design section 3), so nothing
# running on hqbox can reach the API to probe it; the contract instead is that
# the server writes {"sha":"...","at":"..."} to $HEALTH once it is listening.
wait_healthy() {  # wait_healthy <sha> <since-epoch>; 0 healthy, 1 not
  local sha=$1 since=$2 waited=0 st mtime body
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    st=$("$SYSTEMCTL" is-active "$SERVICE" 2>/dev/null)
    if [ "$st" = failed ]; then
      warn "$SERVICE entered the failed state after $waited s"
      return 1
    fi
    if [ -f "$HEALTH" ]; then
      mtime=$(stat -c %Y "$HEALTH" 2>/dev/null)
      body=$(cat "$HEALTH" 2>/dev/null)
      # Both conditions matter: a stale stamp from the previous release has the
      # wrong sha, and a stamp from an earlier run of the same sha has an mtime
      # from before the switch.
      if [ -n "$mtime" ] && [ "$mtime" -ge "$since" ] && grep -q "$sha" <<<"$body"; then
        [ "$st" = active ] && { ok "$SERVICE active, health stamp for $sha after ${waited}s"; return 0; }
      fi
    fi
    sleep 1
    waited=$((waited + 1))
  done
  warn "no health stamp for $sha within ${HEALTH_TIMEOUT}s (service state: ${st:-unknown})"
  return 1
}

restart_service() {
  "$SYSTEMCTL" restart "$SERVICE" || return 1
  return 0
}

prune_releases() {
  local keep_shas="" d n=0 pin
  keep_shas=$(current_sha)
  [ -f "$PREV_FILE" ] && keep_shas="$keep_shas $(cat "$PREV_FILE" 2>/dev/null)"
  # Releases a running runner still executes are pinned by the runner (phase 1
  # writes this file); until then it simply does not exist.
  if [ -f "$PINNED" ]; then
    while IFS= read -r pin; do
      [ -n "$pin" ] && keep_shas="$keep_shas $pin"
    done < "$PINNED"
  fi
  for d in $(find "$REL" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9a-f]{40}' -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk '{print $2}'); do
    n=$((n + 1))
    case " $keep_shas " in *" $(basename "$d") "*) continue;; esac
    [ "$n" -le "$KEEP" ] && continue
    rm -rf "$d" || warn "could not remove the aged-out release $d"
    ok "removed aged-out release $(basename "$d")"
  done
}

# --- runner drain ------------------------------------------------------------

# One request to the runner over its socket, as JSON lines. The hello may fail
# on a protocol mismatch (an old runner meeting a new release); the next op is
# sent anyway, because status, list and drain do not depend on it.
#   status   prints release, state, sessions
#   drain    sends `list` first and prints persistent (alive persistent console
#            terminals, which survive a restart). Then sends `restart`
#            (hq-4npjr.20): the runner drains at once when no session blocks it,
#            otherwise it keeps serving, prints pending=1, and drains itself when
#            the last blocking session (a worker PTY, the meta session after
#            RUNNER_META_RESTART_IDLE_MS of no input) ends. Adopted tmux panes
#            and persistent terms never block it.
#            An older runner answers `restart` with "unknown op": then the old
#            rule applies, counting every alive non-persistent session as
#            blocking; only at 0 does it send `drain`, else it prints deferred=1,
#            because a draining runner refuses new terminals until every
#            blocking session ends, which can be hours.
# Never waits for a drain to finish.
RUNNER_CLIENT='
const net = require("net");
const [sock, mode] = process.argv.slice(1);
const out = (k, v) => process.stdout.write(k + "=" + String(v).replace(/[^\w.:-]/g, "_") + "\n");
const timer = setTimeout(() => { out("error", "timeout"); process.exit(3); }, 10000);
const c = net.createConnection(sock);
const send = (id, op) => c.write(JSON.stringify({ id, op }) + "\n");
const done = (code) => { clearTimeout(timer); c.end(); process.exit(code); };
let buf = "";
let oldBlocking = 0;
c.on("error", (e) => { out("error", e.code || e.message); process.exit(2); });
c.on("connect", () => {
  c.write(JSON.stringify({ id: 1, op: "hello", protocol: 1, client: "activate.sh" }) + "\n");
});
c.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 1) {
      if (!m.ok) out("helloerr", m.error || "unknown");
      send(2, mode === "drain" ? "list" : "status");
      continue;
    }
    if (m.id < 2 || m.id > 4) continue;
    if (m.id === 3 && !m.ok && m.error === "unknown op") {
      // an older runner with no restart op: the pre-restart rule
      out("blocking", oldBlocking);
      if (oldBlocking > 0) { out("deferred", 1); done(0); }
      send(4, "drain");
      continue;
    }
    if (!m.ok) { out("error", m.error || "unknown"); done(4); }
    if (m.id === 2 && mode === "drain") {
      if (!Array.isArray(m.sessions)) { out("error", "list_without_sessions"); done(4); }
      const alive = m.sessions.filter((r) => r && r.alive === true);
      oldBlocking = alive.filter((r) => r.persistent !== true).length;
      out("persistent", alive.length - oldBlocking);
      send(3, "restart");
      continue;
    }
    if (m.id === 3) {
      out("blocking", m.blocking === undefined ? "?" : m.blocking);
      out("pending", m.pending ? 1 : 0);
    }
    if (m.release !== undefined) out("release", m.release);
    if (m.state !== undefined) out("state", m.state);
    if (m.sessions !== undefined) out("sessions", m.sessions);
    done(0);
  }
});
'

runner_rpc() {  # runner_rpc <status|drain>; prints key=value lines, non-zero on failure
  timeout 15 "$NODE_BIN" -e "$RUNNER_CLIENT" "$RUNNER_SOCK" "$1"
}

kv() { sed -n "s/^$1=//p" <<<"$2" | head -1; }  # kv <key> <rpc-output>

# What decides whether the runner must restart: its own files plus the node-pty
# it loads. Built files only, so a release that changes nothing but the server
# or the web bundle hashes the same and does not drain.
runner_tree_hash() {  # runner_tree_hash <release-dir>
  ( cd "$1" 2>/dev/null || exit 1
    { find runner -type f -print0 2>/dev/null | sort -z | xargs -0 -r sha256sum
      [ -f node_modules/node-pty/package.json ] && sha256sum node_modules/node-pty/package.json
    } | sha256sum | cut -c1-64 )
}

# After a healthy switch to <sha> (or a run that finds <sha> already current):
# drain the runner when its code changed and no non-persistent session is
# alive; otherwise defer, and the next run checks again.
# <fallback> is the release we switched away from, used only when the runner
# cannot say which release it runs. Always returns 0: the console release is
# already live and healthy, so a runner problem is reported, not fatal.
runner_drain_if_changed() {  # runner_drain_if_changed <sha> <fallback>
  local sha=$1 fallback=$2 out rel st base n
  if [ "$RUNNER_DRAIN" = 0 ]; then
    ok "runner: RELEASE_RUNNER_DRAIN=0, not contacted"
    return 0
  fi
  if [ ! -f "$REL/$sha/runner/src/runner.js" ]; then
    warn "runner: $sha ships no runner/src/runner.js; not draining the running runner"
    return 0
  fi
  if [ ! -S "$RUNNER_SOCK" ]; then
    warn "runner: no socket at $RUNNER_SOCK; the runner starts from current on its next connect"
    return 0
  fi
  # A connect to the socket-activated socket starts a stopped runner, which then
  # runs current (the new release) and reports it, so the check below skips.
  if ! out=$(runner_rpc status); then
    warn "runner: status query failed ($(kv error "$out")); not draining. Send drain by hand if runner/ changed."
    return 0
  fi
  rel=$(kv release "$out"); st=$(kv state "$out")
  if [ "$st" = draining ]; then
    ok "runner: already draining (runs ${rel:-unknown}); not sending drain again"
    return 0
  fi
  base=$rel
  case "$base" in ''|dev|unknown) base=$fallback;; esac
  if [ -z "$base" ]; then
    ok "runner: runs '${rel:-unknown}' and there is no previous release to compare with; not draining"
    return 0
  fi
  if [ "$base" = "$sha" ]; then
    ok "runner: already runs $sha"
    return 0
  fi
  if [ -d "$REL/$base" ]; then
    if [ "$(runner_tree_hash "$REL/$base")" = "$(runner_tree_hash "$REL/$sha")" ]; then
      ok "runner: code unchanged between $base and $sha; not draining"
      return 0
    fi
    log "runner code changed ($base to $sha): sending restart"
  else
    log "runner runs $base, which is no longer on disk: sending restart"
  fi
  if ! out=$(runner_rpc drain); then
    warn "runner: drain request failed ($(kv error "$out")); the runner keeps running $base"
    return 0
  fi
  n=$(kv blocking "$out")
  if [ "$(kv deferred "$out")" = 1 ]; then
    warn "runner restart deferred: ${n:-?} session(s) would block it (alive and not persistent: workers, adopted panes, meta). No drain sent; the runner keeps running $base and the next activation retries."
    return 0
  fi
  if [ "$(kv pending "$out")" = 1 ]; then
    ok "runner restart pending: ${n:-?} blocking session(s) (worker PTYs, the meta session). The runner keeps running $base and serving, and restarts itself into $sha when they end; a meta session idle past RUNNER_META_RESTART_IDLE_MS is closed for it."
    return 0
  fi
  ok "runner: drain sent, state $(kv state "$out"), 0 blocking session(s), $(kv persistent "$out") persistent terminal(s) to re-attach under the same sid. The runner exits now and hq-runner.socket starts $sha on the next connect."
  return 0
}

# --- rollback ----------------------------------------------------------------

if [ "$MODE" = rollback ]; then
  log "rollback"
  CUR=$(current_sha)
  [ -f "$PREV_FILE" ] || die "no $PREV_FILE, so there is no recorded previous release to roll back to"
  PREV=$(cat "$PREV_FILE")
  [ -n "$PREV" ] || die "$PREV_FILE is empty"
  [ -d "$REL/$PREV" ] || die "the recorded previous release $PREV is no longer on disk (retention removed it). Rebuild that commit instead."
  [ "$PREV" != "$CUR" ] || die "the previous release is the current one ($CUR); nothing to roll back to"
  # Record the direction back, so a rollback is itself reversible.
  printf '%s\n' "$CUR" > "$PREV_FILE" || die "could not update $PREV_FILE"
  SINCE=$(date +%s)
  switch_to "$PREV"
  ok "current -> $PREV (was $CUR)"
  restart_service || die "could not restart $SERVICE after the rollback. current is $PREV; fix the unit by hand."
  if wait_healthy "$PREV" "$SINCE"; then
    runner_drain_if_changed "$PREV" "$CUR"
    printf '\nROLLBACK OK %s (was %s)\n' "$PREV" "$CUR"
    exit 0
  fi
  # No automatic ping-pong back to a release that was just rolled away from.
  die "rolled back to $PREV but it did not report healthy. current stays at $PREV; check: journalctl -u $SERVICE -n 50"
fi

# --- resolve the target ------------------------------------------------------

log "1/6 target"
if [ "$MODE" = latest ]; then
  [ -f "$OUT/LATEST" ] || die "$OUT/LATEST does not exist. Has console-build.service ever produced a build?"
  SHA=$(cat "$OUT/LATEST")
  [ -n "$SHA" ] || die "$OUT/LATEST is empty"
fi
case "$SHA" in *[!0-9a-f]*|"") die "'$SHA' is not a commit sha";; esac
# the automatic path (--latest, the 5-minute timer) never re-tries a sha that already
# failed post-switch, or a bad build would restart the live console every cycle;
# an explicit `activate.sh <sha>` (a human retrying on purpose) is allowed
if [ "$MODE" = latest ] && [ -e "$FAILED_DIR/$SHA" ] && [ "${RELEASE_FORCE:-0}" != 1 ]; then
  die "release $SHA already failed activation once ($(cat "$FAILED_DIR/$SHA" 2>/dev/null | head -1)); not retrying it automatically. Fix forward with a new commit, activate it by sha on purpose, or RELEASE_FORCE=1."
fi
[ -d "$OUT/$SHA" ] || die "no build at $OUT/$SHA"
[ -f "$OUT/$SHA/.complete" ] || die "the build at $OUT/$SHA has no completeness marker; it is half-written or failed"
ok "target $SHA"

CUR=$(current_sha)
if [ "$CUR" = "$SHA" ]; then
  ST=$("$SYSTEMCTL" is-active "$SERVICE" 2>/dev/null)
  if [ "$ST" = active ]; then
    ok "$SHA is already current and $SERVICE is active, nothing to do"
    # A runner restart deferred by an earlier activation is retried here, so the
    # 5-minute timer picks it up once the blocking sessions have ended.
    runner_drain_if_changed "$SHA" "$(cat "$PREV_FILE" 2>/dev/null)"
    prune_releases
    exit 0
  fi
  warn "$SHA is already current but $SERVICE is '$ST'; re-activating"
fi

# --- copy into the console tree ----------------------------------------------

log "2/6 copy into $REL/$SHA"
command -v rsync >/dev/null 2>&1 || die "rsync not installed. provision/hqbox-console-provision.sh installs it."
INCOMING="$REL/.incoming-$SHA"
rm -rf "$INCOMING" || die "could not clear $INCOMING"
# check the SOURCE tree: rsync --no-links would silently drop a link and ship a
# release with a hole, so the boundary is enforced before the copy, not after
reject_links "$OUT/$SHA"
rsync -a --no-links --delete "$OUT/$SHA/" "$INCOMING/" \
  || die "rsync of $OUT/$SHA into $INCOMING failed"
reject_links "$INCOMING"
[ -f "$INCOMING/.complete" ] || die "the copy lost the completeness marker"
[ -f "$INCOMING/server/src/server.js" ] || die "the copy has no server/src/server.js"
[ -f "$INCOMING/web/index.html" ] || die "the copy has no web/index.html"
if [ -n "$OWNER" ]; then
  chown -R "$OWNER" "$INCOMING" || die "could not chown $INCOMING to $OWNER"
fi
# Dirs traversable, files readable, anything already executable stays so
# (spawn-as-owner.sh). owner gets read, never write: the whole point of
# serving from /var/lib rather than ~/hq.
chmod -R u=rwX,go=rX "$INCOMING" || die "could not set modes on $INCOMING"
rm -rf "${REL:?}/${SHA:?}" || die "could not clear a previous $REL/$SHA"
mv -T "$INCOMING" "$REL/$SHA" || die "could not move $INCOMING into place"
ok "release tree at $REL/$SHA"

# Optional: the PTY smoke test, when the builder was configured to defer it
# (SMOKE_PTY=0). Runs as the console user against the copied release, which is
# also a check that hqconsole can actually load the compiled binding.
if [ "${RELEASE_SMOKE_PTY:-0}" = 1 ]; then
  log "2b/6 deferred node-pty smoke test"
  SMOKE="$REL/$SHA/.pty-smoke.cjs"
  cat > "$SMOKE" <<'SMOKE_EOF'
const pty = require('node-pty');
let out = '';
const timer = setTimeout(() => { console.error('pty smoke: timed out'); process.exit(1); }, 15000);
const p = pty.spawn('/bin/sh', ['-c', 'echo ok'], {
  name: 'xterm-color', cols: 80, rows: 24, cwd: '/', env: process.env,
});
p.onData((d) => { out += d; });
p.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (out.indexOf('ok') === -1) { console.error('pty smoke: no output'); process.exit(1); }
  if (exitCode !== 0) { console.error('pty smoke: child exited ' + exitCode); process.exit(1); }
  console.log('pty smoke ok');
  process.exit(0);
});
SMOKE_EOF
  SMOKE_CMD=()
  [ -n "$RUN_AS" ] && SMOKE_CMD+=(sudo -n -u "$RUN_AS")
  SMOKE_CMD+=("$NODE_BIN" "$SMOKE")
  if ! ( cd "$REL/$SHA" && "${SMOKE_CMD[@]}" ); then
    rm -f "$SMOKE"
    rm -rf "${REL:?}/${SHA:?}"
    die "node-pty smoke test failed for $SHA; the release was removed and current was not touched"
  fi
  rm -f "$SMOKE"
  ok "node-pty works in the published release"
fi

# --- candidate check ---------------------------------------------------------

log "3/6 candidate check (server.js --check, ${CHECK_TIMEOUT}s cap)"
CAND=$(candidate_check "$REL/$SHA")
CAND_RC=$?
if [ "$CAND_RC" -ne 0 ]; then
  # The bad tree stays on disk for inspection but never becomes current.
  die "candidate check for $SHA exited $CAND_RC (124 means it exceeded ${CHECK_TIMEOUT}s). current is still ${CUR:-unset}. Output: $(printf '%s' "$CAND" | tail -c 400)"
fi
if ! grep -q '"ok"[[:space:]]*:[[:space:]]*true' <<<"$CAND"; then
  die "candidate check for $SHA did not report {\"ok\":true}. current is still ${CUR:-unset}. Output: $(printf '%s' "$CAND" | tail -c 400)"
fi
ok "candidate reports healthy"

# --- switch ------------------------------------------------------------------

log "4/6 switch current"
# Kept so a failed activation can put the pointer back exactly as it was. If it
# were left saying "previous is $CUR" after rolling back TO $CUR, a later
# `--rollback` would find previous == current and refuse.
PREV_BEFORE=""
[ -f "$PREV_FILE" ] && PREV_BEFORE=$(cat "$PREV_FILE" 2>/dev/null)
# only when we are actually moving away from CUR: re-activating the same sha (unit
# down, timer tick) must not overwrite the real rollback target with itself
if [ -n "$CUR" ] && [ "$CUR" != "$SHA" ]; then
  printf '%s\n' "$CUR" > "$PREV_FILE" || die "could not record the previous release in $PREV_FILE"
fi
SINCE=$(date +%s)
switch_to "$SHA"
ok "current -> $SHA (was ${CUR:-none})"

# --- restart and verify ------------------------------------------------------

log "5/6 restart $SERVICE and wait ${HEALTH_TIMEOUT}s for the health stamp"
ROLLBACK_REASON=""
if ! restart_service; then
  ROLLBACK_REASON="systemctl restart $SERVICE failed"
elif ! wait_healthy "$SHA" "$SINCE"; then
  ROLLBACK_REASON="$SERVICE did not write a health stamp for $SHA within ${HEALTH_TIMEOUT}s"
fi

if [ -n "$ROLLBACK_REASON" ]; then
  warn "$ROLLBACK_REASON"
  mkdir -p "$FAILED_DIR" && printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ROLLBACK_REASON" > "$FAILED_DIR/$SHA"
  if [ -z "$CUR" ]; then
    # First activation on a fresh box: there is nothing to fall back to. Do not
    # leave `current` pointing at a release that never came up (it would become
    # the rollback target of the next activation); unlink it and stop the unit.
    rm -f "$CURRENT"
    "$SYSTEMCTL" stop "$SERVICE"
    die "the first release $SHA failed to come up and there is no previous release to restore. $SERVICE is stopped. Check: journalctl -u $SERVICE -n 50"
  fi
  log "rolling back to $CUR"
  SINCE=$(date +%s)
  switch_to "$CUR"
  if [ -n "$PREV_BEFORE" ]; then
    printf '%s\n' "$PREV_BEFORE" > "$PREV_FILE" || warn "could not restore $PREV_FILE"
  else
    rm -f "$PREV_FILE"
  fi
  if restart_service && wait_healthy "$CUR" "$SINCE"; then
    die "$SHA failed to come up ($ROLLBACK_REASON); rolled back to $CUR, which is healthy. Check: journalctl -u $SERVICE -n 50"
  fi
  die "$SHA failed to come up ($ROLLBACK_REASON) AND the rollback to $CUR did not report healthy either. This needs hands: journalctl -u $SERVICE -n 100"
fi

# --- runner ------------------------------------------------------------------

# Before retention, so the release the runner runs is still on disk to compare.
log "5b/6 runner"
runner_drain_if_changed "$SHA" "$CUR"

# --- retention ---------------------------------------------------------------

log "6/6 retention (keep $KEEP)"
prune_releases

# the release is healthy: only now does its wrapper become the root-owned sudoers
# target (installing it before the candidate check would hand a rejected release's
# wrapper to the live console)
# the sudoers target is a root-owned copy, never a path under the hqconsole-writable tree
WRAPPER_DIR="${RELEASE_WRAPPER_DIR:-/usr/local/lib/hq-console}"
if [ -f "$REL/$SHA/runner/spawn-as-owner.sh" ]; then
  if [ "$(id -u)" = 0 ] || [ -w "$WRAPPER_DIR" ] || [ -w "$(dirname "$WRAPPER_DIR")" ]; then
    install -d -m 0755 "$WRAPPER_DIR" || die "could not create $WRAPPER_DIR"
    if [ "$(id -u)" = 0 ]; then
      install -o root -g root -m 0755 "$REL/$SHA/runner/spawn-as-owner.sh" "$WRAPPER_DIR/spawn-as-owner.sh" || die "could not install the wrapper"
    else
      install -m 0755 "$REL/$SHA/runner/spawn-as-owner.sh" "$WRAPPER_DIR/spawn-as-owner.sh" || die "could not install the wrapper"
    fi
    ok "wrapper installed at $WRAPPER_DIR/spawn-as-owner.sh"
    # The wrapper's owner-side helpers (write-truths.py, truths-audit.py,
    # meta-verbs.py) are resolved next to the wrapper's REAL path, so they must
    # live in the same root-owned dir: a helper left in the hqconsole-writable
    # release tree would be hqconsole code running as owner.
    for helper in "$REL/$SHA"/runner/*.py; do
      [ -f "$helper" ] || continue
      if [ "$(id -u)" = 0 ]; then
        install -o root -g root -m 0755 "$helper" "$WRAPPER_DIR/$(basename "$helper")" || die "could not install $(basename "$helper")"
      else
        install -m 0755 "$helper" "$WRAPPER_DIR/$(basename "$helper")" || die "could not install $(basename "$helper")"
      fi
    done
    ok "wrapper helpers installed: $(ls "$REL/$SHA"/runner/*.py 2>/dev/null | xargs -n1 basename 2>/dev/null | tr '\n' ' ')"
  else
    warn "not root and $WRAPPER_DIR not writable: wrapper not installed (harness mode)"
  fi
fi
# Capri, the meta terminal (proposal 19): install the settings file and the two hooks
# ROOT-owned into /var/lib/hqconsole/meta, exactly like the wrapper, and only after the
# release is healthy. meta-verbs.py refuses to start a meta session unless these are
# root-owned with no group/other write, so an hqconsole-owned copy would be inert. The
# whole feature stays behind RUNNER_META_ENABLED / CONSOLE_META_ENABLED (default off).
META_DIR_INSTALL="${RELEASE_META_DIR:-/var/lib/hqconsole/meta}"
if [ -d "$REL/$SHA/meta" ] && { [ "$(id -u)" = 0 ] || [ -w "$META_DIR_INSTALL" ]; }; then
  install -d -m 0755 "$META_DIR_INSTALL" 2>/dev/null || true
  for f in meta-settings.json hook-meta-audit.sh hook-meta-settings-integrity.sh; do
    [ -f "$REL/$SHA/meta/$f" ] || continue
    case "$f" in *.sh) m=0755;; *) m=0644;; esac
    if [ "$(id -u)" = 0 ]; then
      install -o root -g root -m "$m" "$REL/$SHA/meta/$f" "$META_DIR_INSTALL/$f" || die "could not install meta/$f"
    else
      install -m "$m" "$REL/$SHA/meta/$f" "$META_DIR_INSTALL/$f" || die "could not install meta/$f"
    fi
  done
  # The audit trail is written by the audited identity (owner appends from the
  # PostToolUse hook), so ownership alone lets the session truncate or rewrite its own
  # record. The append-only attribute is root-set and survives the owner: appends
  # still work, truncate/unlink/rewrite do not. Best effort: a filesystem without
  # chattr support warns and the file stays as provisioned.
  if [ "$(id -u)" = 0 ] && [ -f "$META_DIR_INSTALL/audit.jsonl" ] && command -v chattr >/dev/null 2>&1; then
    chattr +a "$META_DIR_INSTALL/audit.jsonl" 2>/dev/null && ok "Capri audit trail is append-only (chattr +a)" || warn "could not set append-only on $META_DIR_INSTALL/audit.jsonl"
  fi
  ok "Capri meta files installed root-owned at $META_DIR_INSTALL (feature flag still off unless the unit sets it)"
fi
# a release came up: from now on the service belongs in the boot set
"$SYSTEMCTL" is-enabled "$SERVICE" >/dev/null 2>&1 || "$SYSTEMCTL" enable "$SERVICE" >/dev/null 2>&1 || warn "could not enable $SERVICE"
printf '\nACTIVATE OK %s (previous %s)\n' "$SHA" "${CUR:-none}"
exit 0
