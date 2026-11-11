#!/usr/bin/env bash
# ctl-whoami.test.sh: ctl whoami must never auto-bind a process that runs
# outside tmux to whatever pane is current on the default tmux server
# (hq-an7jw.19). mail-watch files cards with 'ctl ask' and no --session from a
# systemd unit; before the fix whoami fell back to 'tmux display-message', so
# when a registered worker's pane was current the card went to the
# orchestrator and a worker_ask event ran claude -p over sender-written mail.
# Hermetic: a private TMUX_TMPDIR makes the "default server" a temp one.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
CTL="$REPO/ops/console/ctl.sh"
REG="$REPO/ops/scripts/session-registry.sh"
pass=0; fail=0
ok(){ pass=$((pass+1)); echo "ok   $1"; }
bad(){ fail=$((fail+1)); echo "FAIL $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$3] got [$2])"; fi; }

command -v tmux >/dev/null || { echo "SKIP tmux not installed"; exit 0; }

unset HQ_CONSOLE_SID TMUX TMUX_PANE HQ_PANE HQ_NO_TMUX HQ_ORCH_EVENTS HQ_ORCH_FALLBACK_S
TMP="$(mktemp -d /tmp/ctlwho.XXXXXX)"
export TMUX_TMPDIR="$TMP"
trap 'tmux kill-server 2>/dev/null; rm -rf "$TMP"' EXIT
export HQ_STATE_DIR="$TMP/state" HQ_ROOT="$REPO" HQ_NO_SCHEDULE=1
export HQ_RIGS_DIR="$TMP/rigs"; mkdir -p "$HQ_RIGS_DIR/demo/.git" "$HQ_STATE_DIR"
export HQ_NOTIFY=/bin/true HQ_NO_BELL=1 HQ_ORCH=on
EVF="$HQ_STATE_DIR/orchestrator/events.jsonl"
WRD="$HQ_STATE_DIR/console"

# A detached server on the private default socket; its only pane is current.
tmux new-session -d -s w 'sleep 600' || { bad "start detached tmux server"; exit 1; }
pane="$(tmux display-message -p '#{pane_id}')"
sock="$(tmux display-message -p '#{socket_path}')"
[ -n "$pane" ] && ok "detached server has a current pane ($pane)" || bad "detached server has a current pane"
"$REG" register --id s-wk --kind worker --rig demo --worktree "$TMP/wt" \
  --branch b --bead bead-o --window "$pane" --model m --objectives "$TMP/obj.md" >/dev/null

olines(){ if [ -f "$1" ]; then grep -c worker_ask "$1"; else echo 0; fi; }
rfield(){ RID="$1" F="$2" WRD="$WRD" python3 -c 'import json,os
r=[x for x in json.load(open(os.environ["WRD"]+"/requests.json")) if x["id"]==os.environ["RID"]][0]
print(r.get(os.environ["F"],""))'; }

# ---- 1. the audit repro: no TMUX, no HQ_PANE, no HQ_CONSOLE_SID
out="$("$CTL" whoami 2>/dev/null)"; rc=$?
check "whoami outside tmux names no session even with a worker pane current" "$rc [$out]" "4 []"
rid="$("$CTL" ask "Mail to reply from x: y" --kind info --sev P1 2>/dev/null)"
check "out-of-tmux ask goes to the owner with no session and no worker_ask" \
  "$(rfield "$rid" to) [$(rfield "$rid" session)] $(olines "$EVF")" "owner [] 0"

# ---- 2. inside the worker's own pane it still binds (constraint)
out="$(TMUX="$sock,1,0" TMUX_PANE="$pane" "$CTL" whoami 2>/dev/null)"
check "whoami inside the worker pane binds to the worker" "$out" "s-wk"
out="$(TMUX="$sock,1,0" "$CTL" whoami 2>/dev/null)"
check "whoami with TMUX set and no TMUX_PANE asks tmux and binds" "$out" "s-wk"
rid="$(TMUX="$sock,1,0" TMUX_PANE="$pane" "$CTL" ask "which table?" --bead bead-o 2>/dev/null)"
check "ask inside the worker pane still goes to the orchestrator" \
  "$(rfield "$rid" to) [$(rfield "$rid" session)] $(olines "$EVF")" "orchestrator [s-wk] 1"

# ---- 3. fail-closed: TMUX set but tmux errors
mkdir -p "$TMP/bin"; printf '#!/bin/sh\nexit 1\n' > "$TMP/bin/tmux"; chmod +x "$TMP/bin/tmux"
out="$(PATH="$TMP/bin:$PATH" TMUX="$sock,1,0" "$CTL" whoami 2>/dev/null)"; rc=$?
check "whoami with TMUX set but tmux erroring names no session" "$rc [$out]" "4 []"

# ---- 4. the HQ_NO_TMUX opt-out still wins over TMUX
out="$(HQ_NO_TMUX=1 TMUX="$sock,1,0" "$CTL" whoami 2>/dev/null)"; rc=$?
check "HQ_NO_TMUX suppresses the tmux lookup" "$rc [$out]" "4 []"

# ---- 5. console PTY binding unchanged
out="$(HQ_CONSOLE_SID=s-con "$CTL" whoami 2>/dev/null)"
check "HQ_CONSOLE_SID still names the console session" "$out" "s-con"

echo "passed $pass, failed $fail"
[ "$fail" = 0 ]
