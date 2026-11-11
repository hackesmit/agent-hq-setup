#!/usr/bin/env bash
# Fixture tests for spawn.sh — isolated via HQ_ROOT (temp HQ + throwaway git rig).
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
SPAWN="$DIR/../scripts/spawn.sh"
REGSH="$DIR/../scripts/session-registry.sh"
fail=0
ok(){ printf 'PASS  %s\n' "$1"; }
no(){ printf 'FAIL  %s (%s)\n' "$1" "${2:-}"; fail=1; }
eq(){ [ "$2" = "$3" ] && ok "$1" || no "$1" "got=$2 want=$3"; }

# temp HQ with one throwaway git rig "foo" (needs a commit for worktree add)
export HQ_ROOT="$(mktemp -d)"
export HQ_STATE_DIR="$HQ_ROOT/state"
trap 'rm -rf "$HQ_ROOT"' EXIT
mkdir -p "$HQ_ROOT/rigs/foo"
git -C "$HQ_ROOT/rigs/foo" init -q
git -C "$HQ_ROOT/rigs/foo" -c user.email=t@t -c user.name=t commit --allow-empty -qm init

# spawn --dry-run creates worktree + branch + objectives + registry entry, prints id last
id="$("$SPAWN" foo "Add a Widget" --worker --dry-run | tail -1)"
case "$id" in s-*) ok "spawn prints s- id";; *) no "spawn prints s- id" "got=$id";; esac
suffix="${id#s-}"
[ -d "$HQ_ROOT/rigs/foo-$suffix" ] && ok "worktree created" || no "worktree created" "missing rigs/foo-$suffix"
br="$(git -C "$HQ_ROOT/rigs/foo" branch --list "foo-$suffix-*")"
[ -n "$br" ] && ok "branch created" || no "branch created" "no foo-$suffix-* branch"
[ -f "$HQ_STATE_DIR/objectives/$id.md" ] && ok "objectives file written" || no "objectives file written" "missing"
grep -q "Add a Widget" "$HQ_STATE_DIR/objectives/$id.md" && ok "objectives has task" || no "objectives has task"
st="$("$REGSH" get "$id" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')"
eq "registered active" "$st" "active"
kd="$("$REGSH" get "$id" | python3 -c 'import json,sys; print(json.load(sys.stdin)["kind"])')"
eq "kind is worker" "$kd" "worker"
of="$("$REGSH" get "$id" | python3 -c 'import json,sys; print(json.load(sys.stdin)["objectives_file"])')"
eq "objectives_file path registered" "$of" "state/objectives/$id.md"

# ---- worker isolation (HQ_WORKER_USER, bead hq-l7et) ----
# The property under test is fail-closed: naming a user we cannot become must ABORT
# the spawn, never quietly run the worker as the invoking account. A silent fallback
# would leave the fleet looking isolated while it was not, which is worse than no
# isolation at all.
plan_default="$("$SPAWN" foo "runas default" --worker --dry-run | grep '^spawn-plan:')"
case "$plan_default" in
  *"runas=$(id -un)"*) ok "plan names the invoking user when HQ_WORKER_USER is unset";;
  *) no "plan names the invoking user when HQ_WORKER_USER is unset" "got=$plan_default";;
esac

out="$(HQ_WORKER_USER=hq-no-such-user-$$ "$SPAWN" foo "runas missing user" --worker 2>&1)"; rc=$?
eq "unknown worker user aborts the spawn" "$rc" "3"
case "$out" in
  *"is not a user on this box"*) ok "unknown worker user says why";;
  *) no "unknown worker user says why" "got=$out";;
esac

# A real user we have no passwordless sudo rule for must also abort, not fall back.
# `nobody` exists everywhere, and on a correctly-privileged box nothing grants
# NOPASSWD for it. On a box where the invoking account holds blanket NOPASSWD (hqbox
# does today, which is the whole point of bead hq-l7et) the preflight legitimately
# succeeds and there is nothing to assert, so probe rather than assume: an
# environment-dependent assertion that fails on one box and passes on another is how
# a suite trains people to ignore it.
if ! id -u nobody >/dev/null 2>&1; then
  ok "un-sudoable worker user aborts the spawn (skipped: no nobody account)"
elif sudo -n -u nobody true 2>/dev/null; then
  ok "un-sudoable worker user aborts the spawn (skipped: this box grants $(id -un) passwordless sudo to any user, see hq-l7et)"
else
  out2="$(HQ_WORKER_USER=nobody "$SPAWN" foo "runas unprivileged" --worker 2>&1)"; rc2=$?
  if [ "$rc2" = 0 ]; then
    no "un-sudoable worker user aborts the spawn" "spawn succeeded, so it fell back to $(id -un)"
  else
    ok "un-sudoable worker user aborts the spawn"
    case "$out2" in
      *"without a password"*|*"is not a user on this box"*) ok "un-sudoable worker user says why";;
      *) no "un-sudoable worker user says why" "got=$out2";;
    esac
  fi
fi

# bad rig exits non-zero
"$SPAWN" nope "x" --worker --dry-run >/dev/null 2>&1; [ "$?" != 0 ] && ok "bad rig fails" || no "bad rig fails"

# model routing + mode surface correctly in the dry-run plan line (no real launch)
plan_i="$("$SPAWN" foo "task one" --interactive --dry-run | grep '^spawn-plan:')"
echo "$plan_i" | grep -q "mode=interactive" && ok "interactive mode" || no "interactive mode" "$plan_i"
echo "$plan_i" | grep -q "model=claude-opus-5" && ok "interactive->opus default" || no "interactive->opus default" "$plan_i"
plan_w="$("$SPAWN" foo "task two" --worker --dry-run | grep '^spawn-plan:')"
echo "$plan_w" | grep -q "model=claude-sonnet-5" && ok "worker->sonnet default" || no "worker->sonnet default" "$plan_w"
plan_m="$("$SPAWN" foo "task three" --worker --model claude-opus-4-8 --dry-run | grep '^spawn-plan:')"
echo "$plan_m" | grep -q "model=claude-opus-4-8" && ok "--model override" || no "--model override" "$plan_m"
# dry-run launched nothing: no worker log dir populated
{ [ ! -d "$HQ_STATE_DIR/logs" ] || [ -z "$(ls -A "$HQ_STATE_DIR/logs" 2>/dev/null)" ]; } && ok "dry-run launched nothing" || no "dry-run launched nothing"

# ---- rig workers load hq's hooks (hq-je3fk.6) ----
# A real (non-dry) launch with no hq tmux session runs the worker headless, so a fake
# claude on PATH records the argv the launch script hands it, and a fake tmux keeps
# the spawn off every real tmux server.
fakebin="$HQ_ROOT/fakebin"; mkdir -p "$fakebin"
printf '#!/usr/bin/env bash\nexit 1\n' > "$fakebin/tmux"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "HQ_HOOK_DIR=${HQ_HOOK_DIR:-}" "OTEL_RESOURCE_ATTRIBUTES=${OTEL_RESOURCE_ATTRIBUTES:-}" "HQ_SESSION_ID=${HQ_SESSION_ID:-}" "HQ_BEAD=${HQ_BEAD:-}" "$@" > "$HQ_ROOT/claude-argv.$CDP_TERMINAL_ID"\n' > "$fakebin/claude"
chmod +x "$fakebin/tmux" "$fakebin/claude"
export HQ_HOOKS_ROOT="$(cd "$DIR/../.." && pwd)"
argv_of(){   # $1 = session id -> waits for and prints the fake claude's argv
  local f="$HQ_ROOT/claude-argv.$1" i
  for i in $(seq 50); do [ -s "$f" ] && break; sleep 0.1; done
  cat "$f" 2>/dev/null
}
wid="$(PATH="$fakebin:$PATH" HQ_TMUX_SERVERS=none "$SPAWN" foo "hooks on" --worker 2>/dev/null | tail -1)"
wargv="$(argv_of "$wid")"
echo "$wargv" | grep -qx -- "--settings" && ok "rig worker gets --settings" || no "rig worker gets --settings" "$wargv"
echo "$wargv" | grep -qx -- "$HQ_HOOKS_ROOT/ops/config/worker-hooks.json" \
  && ok "--settings names worker-hooks.json in the hq checkout" || no "--settings names worker-hooks.json in the hq checkout" "$wargv"
echo "$wargv" | grep -qx -- "HQ_HOOK_DIR=$HQ_HOOKS_ROOT/ops/scripts" \
  && ok "rig worker exports HQ_HOOK_DIR" || no "rig worker exports HQ_HOOK_DIR" "$wargv"
# every hook command the file names must exist where HQ_HOOK_DIR points
missing=""
for c in $(jq -r '.. | .command? // empty' "$HQ_HOOKS_ROOT/ops/config/worker-hooks.json" | sed 's/^"//; s/"$//'); do
  f="$(HQ_HOOK_DIR="$HQ_HOOKS_ROOT/ops/scripts" eval "printf %s \"$c\"")"
  [ -x "$f" ] || missing="$missing $f"
done
[ -z "$missing" ] && ok "every worker hook resolves to an executable" || no "every worker hook resolves to an executable" "$missing"

# an hq worker already loads the hooks from its worktree's .claude/settings.json, so it
# must not get them a second time
git -C "$HQ_ROOT" init -q
git -C "$HQ_ROOT" -c user.email=t@t -c user.name=t commit --allow-empty -qm init
hid="$(PATH="$fakebin:$PATH" HQ_TMUX_SERVERS=none "$SPAWN" hq "hq hooks once" --worker 2>/dev/null | tail -1)"
hargv="$(argv_of "$hid")"
[ -n "$hargv" ] && ok "hq worker launched" || no "hq worker launched" "no argv for $hid"
echo "$hargv" | grep -qx -- "--settings" && no "hq worker gets no --settings" "$hargv" || ok "hq worker gets no --settings"
echo "$hargv" | grep -qx -- "HQ_HOOK_DIR=" && ok "hq worker exports no HQ_HOOK_DIR" || no "hq worker exports no HQ_HOOK_DIR" "$hargv"
unset HQ_HOOKS_ROOT

# ---- usage rows carry the session, bead and rig (hq-pgbpq.6) ----
echo "$wargv" | grep -qx -- "OTEL_RESOURCE_ATTRIBUTES=hq.session=$wid,hq.bead=foo-${wid#s-},hq.rig=foo" \
  && ok "worker tags usage with session, default bead and rig" || no "worker tags usage with session, default bead and rig" "$wargv"
oid="$(PATH="$fakebin:$PATH" HQ_TMUX_SERVERS=none "$SPAWN" foo "tagged" --worker --bead 'hq-1,x=y z' 2>/dev/null | tail -1)"
oargv="$(argv_of "$oid")"
echo "$oargv" | grep -qx -- "OTEL_RESOURCE_ATTRIBUTES=hq.session=$oid,hq.bead=hq-1_x_y_z,hq.rig=foo" \
  && ok "a bead id cannot break the attribute list" || no "a bead id cannot break the attribute list" "$oargv"

# ---- workers carry HQ_SESSION_ID and HQ_BEAD for the orchestrator events (hq-4npjr.8) ----
echo "$oargv" | grep -qx -- "HQ_SESSION_ID=$oid" && ok "worker exports HQ_SESSION_ID" || no "worker exports HQ_SESSION_ID" "$oargv"
echo "$oargv" | grep -qx -- "HQ_BEAD=hq-1,x=y z" && ok "worker exports HQ_BEAD verbatim" || no "worker exports HQ_BEAD verbatim" "$oargv"

# ---- headless workers live in the detached hq-bg session (hq-4npjr.4) ----
pw="$("$SPAWN" foo "plan default" --worker --dry-run | grep '^spawn-plan:')"
echo "$pw" | grep -q "where=bg" && ok "worker plans hq-bg by default" || no "worker plans hq-bg by default" "$pw"
pp="$("$SPAWN" foo "plan pane" --worker --pane --dry-run | grep '^spawn-plan:')"
echo "$pp" | grep -q "where=pane" && ok "--pane plans a tiled pane" || no "--pane plans a tiled pane" "$pp"
pi="$("$SPAWN" foo "plan inter" --interactive --dry-run | grep '^spawn-plan:')"
echo "$pi" | grep -q "where=pane" && ok "interactive is always a pane" || no "interactive is always a pane" "$pi"
# real scratch tmux server holding a session named hq; fake claude exits at once
if command -v tmux >/dev/null 2>&1; then
  # Isolation: the suite may run inside the real hq tmux. A private TMUX_TMPDIR and no
  # $TMUX keep every tmux call (spawn's default-server probe included) off the real server.
  SOCK="spawnbg$$"; export HQ_TMUX_SERVERS="$SOCK"
  export TMUX_TMPDIR="$HQ_ROOT/tmx"; mkdir -p "$TMUX_TMPDIR"; unset TMUX
  tx(){ tmux -L "$SOCK" "$@"; }
  tx new-session -d -s hq -n main "sleep 600"
  trap 'tx kill-server 2>/dev/null; rm -rf "$HQ_ROOT"' EXIT
  sleepbin="$HQ_ROOT/sleepbin"; mkdir -p "$sleepbin"
  printf '#!/usr/bin/env bash\nsleep 600\n' > "$sleepbin/claude"; chmod +x "$sleepbin/claude"
  b1="$(PATH="$sleepbin:$PATH" "$SPAWN" foo "bg one" --worker 2>/dev/null | tail -1)"
  b2="$(PATH="$sleepbin:$PATH" "$SPAWN" foo "bg two" --worker 2>/dev/null | tail -1)"
  tx has-session -t '=hq-bg' 2>/dev/null && ok "hq-bg session created" || no "hq-bg session created"
  eq "each bg worker gets its own window" "$(tx list-windows -t '=hq-bg' -F '#W' | sort | tr '\n' ' ')" "$(printf '%s\n' "$b1" "$b2" | sort | tr '\n' ' ')"
  eq "bg workers are not tiled into hq" "$(tx list-windows -t '=hq' -F '#W' | tr '\n' ' ')" "main "
  reg="$("$REGSH" get "$b1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tmux_window"])')"
  case "$reg" in %*) ok "registry records the pane id";; *) no "registry records the pane id" "$reg";; esac
  # finish/kill helper reaches a pane in hq-bg
  ( . "$DIR/../scripts/lib/tmux-server.sh"; hq_kill_registry_window "$reg" )
  tx list-panes -s -t '=hq-bg' -F '#{pane_id}' | grep -qxF "$reg" && no "kill helper removes an hq-bg pane" || ok "kill helper removes an hq-bg pane"
  # --pane tiles into hq:work and leaves hq-bg alone
  b3="$(PATH="$sleepbin:$PATH" "$SPAWN" foo "pane one" --worker --pane 2>/dev/null | tail -1)"
  tx list-windows -t '=hq' -F '#W' | grep -qx work && ok "--pane worker lands in hq:work" || no "--pane worker lands in hq:work"
  tx list-windows -t '=hq-bg' -F '#W' | grep -qx "$b3" && no "--pane worker stayed out of hq-bg" || ok "--pane worker stayed out of hq-bg"
  tx kill-server 2>/dev/null; unset HQ_TMUX_SERVERS TMUX_TMPDIR
else
  ok "hq-bg tmux cases skipped: no tmux"
fi

# ---- one worker per bead (hq-4npjr.10) ----
# The 2026-11-04 double dispatch: nothing in spawn.sh refused a bead an active
# session already held. HQ_NO_TMUX makes the pane unknowable, which must hold.
CL="$HQ_STATE_DIR/console/dispatch"
"$REGSH" register --id s-hold --kind worker --rig foo --worktree "$HQ_ROOT/wt-hold" --branch b \
  --bead hq-held.1 --window %4242 --model m --objectives o >/dev/null
out="$(HQ_NO_TMUX=1 "$SPAWN" foo "dup" --worker --dry-run --bead hq-held.1 2>&1)"; rc=$?
eq "spawn refuses a bead an active session holds (exit 3)" "$rc" "3"
case "$out" in *"s-hold"*) ok "refusal names the holder";; *) no "refusal names the holder" "$out";; esac
n="$(git -C "$HQ_ROOT/rigs/foo" worktree list | wc -l | tr -d ' ')"
HQ_NO_TMUX=1 "$SPAWN" foo "dup" --worker --dry-run --bead hq-held.1 >/dev/null 2>&1
eq "a refused spawn makes no worktree" "$(git -C "$HQ_ROOT/rigs/foo" worktree list | wc -l | tr -d ' ')" "$n"
id="$(HQ_NO_TMUX=1 "$SPAWN" foo "forced" --worker --dry-run --bead hq-held.1 --force 2>/dev/null | tail -1)"
case "$id" in s-*) ok "--force starts a second worker anyway";; *) no "--force starts a second worker anyway" "$id";; esac
# review round 1 note 1: a forced second worker leaves a record (registry, event, stderr)
EVF="$HQ_ROOT/forced-events.jsonl"
out="$(HQ_NO_TMUX=1 HQ_NO_NOTIFY=1 HQ_EVENTS_FILE="$EVF" HQ_SESSION_ID=s-coord "$SPAWN" foo "forced" --worker --dry-run --bead hq-held.1 --force 2>&1)"
fid="$(printf '%s\n' "$out" | tail -1)"
fb="$("$REGSH" get "$fid" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("forced_by",""))')"
case "$fb" in "s-coord: hq-held.1 is held by s-"*) ok "--force records forced_by with the holder";; *) no "--force records forced_by with the holder" "$fb";; esac
eq "--force writes a forced event" "$(jq -r 'select(.type=="forced")|.bead' "$EVF" 2>/dev/null)" "hq-held.1"
case "$out" in *"--force: $fid starts on hq-held.1 over"*) ok "--force says what it overrode";; *) no "--force says what it overrode" "$out";; esac
fid="$(HQ_NO_TMUX=1 HQ_NO_NOTIFY=1 HQ_EVENTS_FILE="$EVF" "$SPAWN" foo "free" --worker --dry-run --bead hq-free.1 --force 2>/dev/null | tail -1)"
eq "--force on a free bead records nothing" "$("$REGSH" get "$fid" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("forced_by","none"))')" "none"
eq "--force on a free bead writes no event" "$(jq -r 'select(.type=="forced")|.bead' "$EVF" | wc -l | tr -d ' ')" "1"
# a dead pane counts as free: the fixture pane is s-dead's (its launch script) and dead
"$REGSH" register --id s-dead --kind worker --rig foo --worktree "$HQ_ROOT/wt-dead" --branch b \
  --bead hq-dead.1 --window %77 --model m --objectives o >/dev/null
printf '{"%%77":{"dead":true,"pid":"1","path":"/x","cmd":"bash /s/launch-s-dead.sh"}}' >"$HQ_ROOT/panes.json"
id="$(HQ_PANES_FIXTURE="$HQ_ROOT/panes.json" "$SPAWN" foo "takeover" --worker --dry-run --bead hq-dead.1 2>/dev/null | tail -1)"
case "$id" in s-*) ok "a dead pane frees its bead for a new worker";; *) no "a dead pane frees its bead" "$id";; esac
# ...and the new worker now holds it: a third spawn is refused
HQ_NO_TMUX=1 "$SPAWN" foo "third" --worker --dry-run --bead hq-dead.1 >/dev/null 2>&1; rc=$?
eq "the takeover worker holds the bead" "$rc" "3"
[ -e "$CL/hq-dead.1.json" ] && no "spawn releases its own claim once registered" || ok "spawn releases its own claim once registered"
# hq-4npjr.19 (2026-11-04 20:52 to 20:54): s-1fee took hq-63nvj.2, its claude
# exited at 20:54:14 with commits unmerged, and s-340d took the same bead 19 s
# later because a dead pane counted as free. A dead pane over unmerged work holds.
git -C "$HQ_ROOT/rigs/foo" worktree add -q -b ex-b "$HQ_ROOT/wt-ex" 2>/dev/null
git -C "$HQ_ROOT/wt-ex" -c user.email=t@t -c user.name=t commit --allow-empty -qm "finished work"
"$REGSH" register --id s-ex --kind worker --rig foo --worktree "$HQ_ROOT/wt-ex" --branch ex-b \
  --bead hq-ex.1 --window %88 --model m --objectives o >/dev/null
printf '{"%%88":{"dead":true,"pid":"1","path":"/x","cmd":"bash /s/launch-s-ex.sh"}}' >"$HQ_ROOT/panes-ex.json"
out="$(HQ_PANES_FIXTURE="$HQ_ROOT/panes-ex.json" "$SPAWN" foo "second" --worker --dry-run --bead hq-ex.1 2>&1)"; rc=$?
eq "a dead pane over unmerged commits still holds: spawn exits 3" "$rc" "3"
case "$out" in *"held by s-ex"*"1 ahead"*) ok "the spawn refusal names the first session and its unmerged work";; *) no "the spawn refusal names the first session" "$out";; esac
out="$(HQ_PANES_FIXTURE="$HQ_ROOT/panes-ex.json" HQ_SPAWN=/bin/false "$DIR/../console/ctl.sh" dispatch hq-ex.1 --rig foo 2>&1)"; rc=$?
eq "ctl dispatch on the same bead exits 3" "$rc" "3"
case "$out" in *"held by s-ex"*) ok "the dispatch refusal names the first session";; *) no "the dispatch refusal names the first session" "$out";; esac
# uncommitted edits hold too
git -C "$HQ_ROOT/rigs/foo" worktree add -q -b ex2-b "$HQ_ROOT/wt-ex2" 2>/dev/null
echo wip >"$HQ_ROOT/wt-ex2/wip.txt"
"$REGSH" register --id s-ex2 --kind worker --rig foo --worktree "$HQ_ROOT/wt-ex2" --branch ex2-b \
  --bead hq-ex.2 --window %89 --model m --objectives o >/dev/null
printf '{"%%89":{"dead":true,"pid":"1","path":"/x","cmd":"bash /s/launch-s-ex2.sh"}}' >"$HQ_ROOT/panes-ex2.json"
HQ_PANES_FIXTURE="$HQ_ROOT/panes-ex2.json" "$SPAWN" foo "second" --worker --dry-run --bead hq-ex.2 >/dev/null 2>&1; rc=$?
eq "a dead pane over uncommitted edits holds" "$rc" "3"
# a worker that exited with nothing unmerged frees its bead
git -C "$HQ_ROOT/rigs/foo" worktree add -q -b ex3-b "$HQ_ROOT/wt-ex3" 2>/dev/null
"$REGSH" register --id s-ex3 --kind worker --rig foo --worktree "$HQ_ROOT/wt-ex3" --branch ex3-b \
  --bead hq-ex.3 --window %90 --model m --objectives o >/dev/null
printf '{"%%90":{"dead":true,"pid":"1","path":"/x","cmd":"bash /s/launch-s-ex3.sh"}}' >"$HQ_ROOT/panes-ex3.json"
id="$(HQ_PANES_FIXTURE="$HQ_ROOT/panes-ex3.json" "$SPAWN" foo "takeover" --worker --dry-run --bead hq-ex.3 2>/dev/null | tail -1)"
case "$id" in s-*) ok "a dead pane over a clean worktree frees its bead";; *) no "a dead pane over a clean worktree frees its bead" "$id";; esac

# another dispatch's fresh claim holds the bead; the claimant's own nonce passes
mkdir -p "$CL"
printf '{"bead":"hq-cl.1","epoch":%s,"nonce":"n-1","ts":"t"}' "$(date +%s)" >"$CL/hq-cl.1.json"
"$SPAWN" foo "claimed" --worker --dry-run --bead hq-cl.1 >/dev/null 2>&1; rc=$?
eq "a live dispatch claim refuses a direct spawn" "$rc" "3"
id="$(HQ_CLAIM_NONCE=n-1 "$SPAWN" foo "claimant" --worker --dry-run --bead hq-cl.1 2>/dev/null | tail -1)"
case "$id" in s-*) ok "the claimant's own nonce passes";; *) no "the claimant's own nonce passes" "$id";; esac
# hq-oq30g.2 (hq-4npjr.20): a reviewer takes --bead past a hold with --review, the
# row records role=reviewer, and a reviewer row never holds the bead itself
rid="$(HQ_NO_TMUX=1 "$SPAWN" foo "review" --worker --dry-run --bead hq-held.1 --review 2>/dev/null | tail -1)"
case "$rid" in s-*) ok "--review spawns past an active worker's hold";; *) no "--review spawns past an active worker's hold" "$rid";; esac
eq "--review records role=reviewer on the row" "$("$REGSH" get "$rid" | jq -r '.role // "none"')" "reviewer"
eq "--review records no forced_by" "$("$REGSH" get "$rid" | jq -r '.forced_by // "none"')" "none"
# a batch: sibling hq-bt.2's claim points at primary hq-bt.1, held by an active worker
"$REGSH" register --id s-bt --kind worker --rig foo --worktree "$HQ_ROOT/wt-bt" --branch b \
  --bead hq-bt.1 --window %4343 --model m --objectives o >/dev/null
printf '{"bead":"hq-bt.2","primary":"hq-bt.1","epoch":%s,"nonce":"n-bt","ts":"t"}' "$(date +%s)" >"$CL/hq-bt.2.json"
HQ_NO_TMUX=1 "$SPAWN" foo "sib" --worker --dry-run --bead hq-bt.2 >/dev/null 2>&1; rc=$?
eq "a batch-held sibling refuses a plain worker (exit 3)" "$rc" "3"
rid="$(HQ_NO_TMUX=1 "$SPAWN" foo "review sib" --worker --dry-run --bead hq-bt.2 --review 2>/dev/null | tail -1)"
case "$rid" in s-*) ok "--review spawns past a batch hold";; *) no "--review spawns past a batch hold" "$rid";; esac
eq "--review leaves the batch claim alone" "$(jq -r .nonce "$CL/hq-bt.2.json")" "n-bt"
# the reviewer row alone does not hold: with the worker gone, a worker spawn passes
"$REGSH" register --id s-rv --kind worker --rig foo --worktree "$HQ_ROOT/wt-rv" --branch b \
  --bead hq-rv.1 --window %4444 --model m --objectives o --role reviewer >/dev/null
id="$(HQ_NO_TMUX=1 "$SPAWN" foo "after review" --worker --dry-run --bead hq-rv.1 2>/dev/null | tail -1)"
case "$id" in s-*) ok "a reviewer row never holds its bead";; *) no "a reviewer row never holds its bead" "$id";; esac
# a spawn that fails after claiming (a worker user it cannot become) leaves no claim
HQ_WORKER_USER=hq-no-such-user-$$ "$SPAWN" foo "x" --worker --bead hq-fail.1 >/dev/null 2>&1; rc=$?
eq "the late-failing spawn fails" "$rc" "3"
[ -e "$CL/hq-fail.1.json" ] && no "a failed spawn leaves no claim" || ok "a failed spawn leaves no claim"

# hq-4npjr.22: a registry that exists but does not parse fails closed. bead_hold
# raises, so spawn and ctl dispatch refuse (non-zero, no worktree); a missing
# registry is a fresh box and still spawns.
REG="$HQ_STATE_DIR/sessions.json"; cp "$REG" "$HQ_ROOT/reg.bak"
for kind in empty truncated array unreadable; do
  case "$kind" in
    empty) : >"$REG";;
    truncated) head -c 40 "$HQ_ROOT/reg.bak" >"$REG";;
    array) printf '[]' >"$REG";;
    unreadable) cp "$HQ_ROOT/reg.bak" "$REG"; chmod 000 "$REG";;
  esac
  if [ "$kind" = unreadable ] && [ -r "$REG" ]; then ok "registry $kind: skipped (running as root)"; chmod 644 "$REG"; continue; fi
  n="$(git -C "$HQ_ROOT/rigs/foo" worktree list | wc -l | tr -d ' ')"
  HQ_NO_TMUX=1 "$SPAWN" foo "corrupt" --worker --dry-run --bead hq-corrupt.1 >/dev/null 2>&1; rc=$?
  eq "registry $kind: spawn refuses as a hold-check fault (exit 5, hq-oq30g.2)" "$rc" "5"
  out="$(HQ_NO_TMUX=1 "$SPAWN" foo "corrupt" --worker --dry-run --bead hq-corrupt.1 2>&1)"
  case "$out" in *"hold check failed"*) ok "registry $kind: says hold check failed";; *) no "registry $kind: says hold check failed" "$out";; esac
  eq "registry $kind: no worktree" "$(git -C "$HQ_ROOT/rigs/foo" worktree list | wc -l | tr -d ' ')" "$n"
  HQ_NO_TMUX=1 HQ_SPAWN=/bin/true "$DIR/../console/ctl.sh" dispatch hq-corrupt.1 --rig foo >/dev/null 2>&1; rc=$?
  [ "$rc" != 0 ] && ok "registry $kind: ctl dispatch refuses (exit $rc)" || no "registry $kind: ctl dispatch refuses" "rc=0"
  [ -e "$CL/hq-corrupt.1.json" ] && no "registry $kind: a refused dispatch leaves no claim" || ok "registry $kind: a refused dispatch leaves no claim"
  chmod 644 "$REG" 2>/dev/null
done
rm -f "$REG"
id="$(HQ_NO_TMUX=1 "$SPAWN" foo "fresh box" --worker --dry-run --bead hq-corrupt.1 2>/dev/null | tail -1)"
case "$id" in s-*) ok "a missing registry still spawns";; *) no "a missing registry still spawns" "$id";; esac

[ "$fail" = 0 ] && echo "SPAWN TESTS: PASS" || { echo "SPAWN TESTS: FAIL"; exit 1; }
