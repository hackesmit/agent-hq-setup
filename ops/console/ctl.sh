#!/usr/bin/env bash
# ctl.sh: the console control-center CLI. Owns the request/answer state machine,
# per-rig tasks, dispatch claims, and the aggregated dashboard state. Lives in
# ops/console/ (agent-evolvable) while ops/scripts/console.sh stays the frozen
# legacy entrypoint; both share state/console/ and the statelib.py lock, so old
# workers keep working. The node server shells ONLY to this CLI.
# Spec: docs/superpowers/specs/2026-08-11-console-control-center-design.md
#
# Subcommands (beyond the legacy set):
#   ask "<q>" [--bead B] [--session S] [--urgent] [--wait [--chunk N]]   file request;
#       prints the question in the asking terminal (stderr) and marks that session's
#       console card as waiting; rings the owner's terminal (bell.sh); --urgent ALSO pushes ntfy;
#       --wait polls, prints ANSWERED <rid> + text (exit 0) or WAITING <rid> (exit 10);
#       --notify-ping (console.sh) also sends a default notify, only when it goes to the owner
#   await <rid> [--chunk N]      keep waiting on a filed request (same outputs)
#   answer <rid> [--here] (--file F | "<text>")   record the answer; live delivery or revival;
#       --here: the asker got it in its own terminal, so settle it delivered, no injection
#       A worker's ask goes to the orchestrator first ("to": "orchestrator", no
#       bell, a worker_ask event) when its event runner's path unit is up and the
#       runner script exists (HQ_ORCH_RUNNER); else the owner.
#   forward <rid> --class business|taste|unknowable [--note N]   orchestrator
#       hands a worker's ask to the owner (rings him); refuses with no class
#   orch-sweep                   forward orchestrator asks untouched for 10 minutes
#   cancel <rid>                 cancel an undelivered request
#   park-mark <rid> --session S  bind a parked session to its pending request
#   resolve <rid> | requests     dismiss without text | list undelivered
#   clear <rid>                  take a request off the board (stuck "delivering" too)
#   req-snooze <rid> "<when>"    defer a question off its session card until a date
#   req-unsnooze <rid>           bring a deferred question back now (resets its SLA clock)
#   meta-inject "<text>"         queue a transcript for the open Capri (proposal 25);
#       the server delivers it only when a passkey-attached tab is present
#   ear-wake [--check]           stamp a wake request for a sleeping ear (the
#       console button); --check prints the last stamp for the ear's poll
#   ear-state <phase> [text] [--progress 0..1]
#       the Capri voice ear's live phase for the console indicator
#       (idle|wake|listening|thinking|speaking|muted|offline). Latest wins. --progress
#       fills the crystal on a long task; omit it for work of unknown length.
#   req-sla-sweep                escalate open questions past their severity's SLA
#       (P0 30m, P1 4h, P2 24h; +1 severity, re-ring, max 2; run by state)
#   sink <rid> [--top]           send a question to the bottom of the waiting list (or back up)
#   name <session> "<label>" | --clear   what a terminal calls itself on its card
#   whoami                       session id owning the current tmux pane
#   focus <session>              bring that session's tmux pane to the front
#   phase set|check|uncheck|list ...     (same as legacy, now under the lock)
#   log-change "<desc>" [--session S]
#   tasks [--refresh]            per-rig open/in_progress beads (30s cache)
#   dispatch <bead> --rig R [--model M] [--op ID] [--force]   claim + spawn a worker
#     (exit 3 naming the holder when a live session or claim holds the bead;
#     --force takes it over anyway. dispatch-batch takes --force too.)
#   finish-check <bead>          report approval marker vs branch head
#   kill <session>               end its own pane and mark it done; succeeds when already gone
#   reconcile [--dry-run]        settle worker rows whose pane is gone: done, or finishable if unmerged
#   cmd (RETIRED by proposal 58; prints one line and exits 3)
#   state                        aggregated dashboard JSON
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="${HQ_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
STATE_DIR="${HQ_STATE_DIR:-$HQ/state}"
WR="$STATE_DIR/console"; PH="$WR/phases"; ANS="$WR/answers"; OPS="$WR/ops"
TC="$WR/tasks-cache"; DC="$WR/dispatch"
REGSH="$HQ/ops/scripts/session-registry.sh"
RIGS="${HQ_RIGS_DIR:-$HQ/rigs}"
mkdir -p "$PH" "$ANS" "$OPS" "$TC" "$DC"
[ -f "$WR/requests.json" ] || printf '[]\n' > "$WR/requests.json"
export HQ STATE_DIR WR PH ANS OPS TC DC REGSH RIGS
export CTL_DIR="$SCRIPT_DIR"
PYLIB="import sys, os; sys.path.insert(0, os.environ['CTL_DIR']); import statelib as sl"
die(){ echo "ctl: $1" >&2; exit "${2:-1}"; }

valid_id(){ printf '%s' "$1" | grep -qE '^[A-Za-z0-9._-]{1,64}$'; }

# poll_once <rid>: exit 0 answered (marker + text printed, CAS to delivered done),
# 7 keep waiting, 11 cancelled/resolved, 4 missing.
poll_once(){
  RID="$1" python3 - <<PY
$PYLIB
import os
rid = os.environ["RID"]
r = sl.get_request(rid)
if r is None:
    print("MISSING " + rid); raise SystemExit(4)
st = r.get("status", "open")
if st in ("cancelled", "resolved"):
    print("CANCELLED " + rid); raise SystemExit(11)
if st in ("answered", "delivered"):
    # read the answer BEFORE the terminal transition; an unreadable file must
    # leave the request answered (retryable), never delivered-and-lost
    try:
        text = open(r.get("answer_file", "")).read().rstrip("\n")
    except Exception:
        text = None
    if text is None:
        raise SystemExit(7)
    ok = st == "delivered"
    if not ok:
        ok, _ = sl.cas(rid, {"answered"}, "delivered", {"delivery": "polled"})
    if ok:
        print("ANSWERED " + rid)
        print(text)
        raise SystemExit(0)
raise SystemExit(7)
PY
}

# inject <session> <rid>: type the answer straight into that session's tmux pane
# so a live terminal gets it WITHOUT polling. Exit 0 only if it landed; every
# caller falls back to poll delivery.
#
# The safety question is "is Claude still alive in that pane". If it exited, the
# pane is a bare shell and typed text would EXECUTE as a command. Checking the
# foreground process is not enough: a busy Claude shows bash/python while it
# runs a tool, and a worker blocked on 'ask --wait' shows python. So we walk the
# pane's process TREE for a live claude/node. Typing into a busy Claude is safe
# and is exactly what happens when the owner types while it works: the tty buffers
# it and Claude reads it when it next accepts input.
# live_pane <sid>: print the tmux pane a session still owns, or return 1.
#
# Two ways this goes wrong if you only look up the registry row. A pane that has
# dropped back to its shell would RUN whatever we type instead of reading it, so the
# pane must still carry a claude/node process. And tmux reuses pane ids while the
# registry keeps finished sessions pointed at the pane they used to hold, so a stale
# row would deliver one terminal's answer into whoever holds that pane now. So the
# pane is bound by the session identity in its claude process's environment.
#
# Output is "<socket> <pane>". hqbox runs two tmux servers: "default" (Alt-key
# panes, spawn.sh workers started from the overseer) and "hqterm" (hq-runner's
# server: console terminals, as the tmux session hqt-<sid>, and anything
# spawn.sh starts from inside one). Pane ids are per server, so a registry pane
# id like %5 can name a pane on either, or a different pane on each. The pane is
# therefore looked up on BOTH servers and bound to the session by the identity
# its claude process carries (CDP_TERMINAL_ID from spawn.sh/term.sh, else
# HQ_CONSOLE_SID from the console runner), never by the registry status, which
# can be wrong. Exactly one bound, live pane, or nothing is typed (hq-zqqu.1
# round 3).
live_pane(){
  local sid="$1" entry
  [ -n "$sid" ] || return 1
  [ -z "${HQ_NO_TMUX:-}" ] || return 1
  command -v tmux >/dev/null || return 1
  entry="$("$REGSH" get "$sid" 2>/dev/null)" || return 1
  ENTRY="$entry" SID="$sid" python3 - <<'LPY' || return 1
import json, os, subprocess
sid = os.environ["SID"]
try:
    d = json.loads(os.environ["ENTRY"])
except Exception:
    raise SystemExit(1)
win = d.get("tmux_window") or ""

def tmux(sock, *args):
    # -L default explicitly: a bare tmux run inside an hqterm pane ($TMUX set)
    # would address hqterm and see the same pane twice
    cmd = ["tmux", "-L", sock]
    try:
        return subprocess.run(cmd + list(args), capture_output=True, text=True,
                              timeout=10).stdout.split("\n")
    except Exception:
        return []

FMT = "#{pane_id} #{pane_pid} #{pane_dead}"
# candidate (socket, pane id, pane pid) on both servers
cands = []
for sock in ("default", "hqterm"):
    rows = []
    if win.startswith("%") and win[1:].isdigit():
        rows += [l for l in tmux(sock, "list-panes", "-a", "-F", FMT) if l.split(" ")[0] == win]
    if sock == "hqterm" and (d.get("kind") or "") == "console-term":
        rows += tmux(sock, "list-panes", "-t", "=hqt-" + sid, "-F", FMT)
    for l in rows:
        bits = l.split()
        if len(bits) == 3 and bits[1].isdigit() and bits[2] == "0" \
                and (sock, bits[0]) not in [c[:2] for c in cands]:
            cands.append((sock, bits[0], bits[1]))

kids = {}
for e in os.listdir("/proc"):
    if not e.isdigit():
        continue
    try:
        with open("/proc/%s/stat" % e) as fh:
            ppid = fh.read().rsplit(")", 1)[1].split()[1]
        kids.setdefault(ppid, []).append(e)
    except Exception:
        pass

def tree(root):
    seen, stack = {root}, [root]
    while stack:
        for c in kids.get(stack.pop(), []):
            if c not in seen:
                seen.add(c); stack.append(c)
    return seen

def identity(pid):
    """The session a process belongs to. CDP_TERMINAL_ID wins: a pane spawned
    from inside a console terminal inherits that terminal's HQ_CONSOLE_SID as
    well as carrying its own CDP_TERMINAL_ID."""
    try:
        with open("/proc/%s/environ" % pid, "rb") as fh:
            raw = fh.read().decode("utf-8", "replace").split("\0")
    except Exception:
        return ""
    env = dict(kv.split("=", 1) for kv in raw if "=" in kv)
    return env.get("CDP_TERMINAL_ID") or env.get("HQ_CONSOLE_SID") or ""

bound = []
for sock, pane, ppid in cands:
    for p in tree(ppid):
        try:
            with open("/proc/%s/cmdline" % p, "rb") as fh:
                cl = fh.read().decode("utf-8", "replace")
        except Exception:
            continue
        # a live claude (node) that belongs to this very session: a bare shell
        # would RUN typed text, and someone else's claude must never get it
        if ("claude" in cl or cl.split("\0")[0].endswith("node")) and identity(p) == sid:
            bound.append((sock, pane))
            break
if len(bound) != 1:
    raise SystemExit(1)   # gone, or not resolvable to exactly one pane: type nothing
print("%s %s" % bound[0], end="")
LPY
}

# deliver_text <sid> <text>: type one line into a session's terminal.
# HQ_INJECT is the test seam (like HQ_WAKE / HQ_NOTIFY): the suites point it at a
# recorder so delivery can be asserted without a tmux pane to type into.
deliver_text(){
  local sid="$1" msg="$2" pane
  [ -n "$sid" ] || return 1
  if [ -n "${HQ_INJECT:-}" ]; then "$HQ_INJECT" "$sid" "$msg"; return $?; fi
  local where sock
  where="$(live_pane "$sid")" || return 1
  sock="${where%% *}"; pane="${where#* }"
  local -a tm=(tmux -L "$sock")
  # one line: a newline inside send-keys -l would submit early
  msg="$(printf '%s' "$msg" | tr '\n\r\t' '   ' | tr -s ' ')"
  "${tm[@]}" send-keys -t "$pane" -l "$msg" >/dev/null 2>&1 || return 1
  "${tm[@]}" send-keys -t "$pane" Enter >/dev/null 2>&1 || return 1
  return 0
}

inject(){
  local sid="$1" rid="$2" msg
  msg="$(RID="$rid" python3 - <<PY
$PYLIB
import os
rid = os.environ["RID"]
r = sl.get_request(rid) or {}
try:
    ans = open(r.get("answer_file", "")).read().strip()
except Exception:
    raise SystemExit(1)
q = (r.get("question", "") or "").strip()
print("[HQ console] the owner answered your question %r: %s "
      "(request %s is delivered; continue with this answer.)" % (q[:160], ans, rid))
PY
)" || return 1
  deliver_text "$sid" "$msg"
}

# ---- ask routing (docs/designs/2026-11-04-orchestrator.md section 1) --------
# A worker's ask goes to the orchestrator first. Every failure routes it to
# the owner as before: no orchestrator unit running, the event not written, or 10
# minutes with nobody touching it (orch-sweep). A cap hit or a crash in the
# runner forwards the ask itself (ops/scripts/orchestrator_run.py, hq-4npjr.2),
# and the 10-minute sweep backs that up.
ORCH_DIR="$STATE_DIR/orchestrator"
ORCH_EVENTS="${HQ_ORCH_EVENTS:-$ORCH_DIR/events.jsonl}"

# The script hq-orchestrator.service executes (ExecStart=/bin/bash
# %h/hq/ops/scripts/orchestrator-run.sh run): the main checkout, not this one.
ORCH_RUNNER="${HQ_ORCH_RUNNER:-$HOME/hq/ops/scripts/orchestrator-run.sh}"

# orch_available: 0 when the event runner's path unit is up (user manager,
# ops/config/runtime.json) AND the runner script it fires exists, so a unit
# with nothing to run never holds asks for 10 minutes. HQ_ORCH=on|off is the
# seam (tests, a kill switch).
orch_available(){
  case "${HQ_ORCH:-auto}" in
    off) return 1 ;;
    on) return 0 ;;
    *) [ -f "$ORCH_RUNNER" ] && systemctl --user is-active --quiet hq-orchestrator.path 2>/dev/null ;;
  esac
}

# orch_event_ask <rid> <bead> <session>: append one worker_ask event in the
# runner's schema (orchestrator_run.py: id, ts, type, rid, bead) with a single
# fsynced O_APPEND write, then touch the pending flag the path unit also
# watches. Nonzero only when the event line did not land.
orch_event_ask(){
  RID="$1" BEAD="$2" SESS="$3" EVF="$ORCH_EVENTS" python3 - <<'PY' 2>/dev/null
import json, os, secrets, time
evf = os.environ["EVF"]
os.makedirs(os.path.dirname(evf), exist_ok=True)
line = (json.dumps({"id": "e-%d-%s" % (time.time_ns(), secrets.token_hex(3)),
                    "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "type": "worker_ask", "rid": os.environ["RID"],
                    "bead": os.environ["BEAD"], "session": os.environ["SESS"]}) + "\n").encode()
fd = os.open(evf, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
try:
    if os.write(fd, line) != len(line):
        raise SystemExit(1)
    os.fsync(fd)
finally:
    os.close(fd)
try:
    open(os.path.join(os.path.dirname(evf), "pending"), "a").close()
except OSError:
    pass   # PathChanged on the events file still wakes the runner
PY
}

# ring_owner "<bead>" "<question>" <urgent 0|1>: the bell for a question that
# needs the owner, plus the urgent ntfy push when asked (same policy as ask).
ring_owner(){
  local bead="$1" q="$2" urgent="$3" nopush=""
  BELL="${HQ_BELL:-$SCRIPT_DIR/bell.sh}"
  [ "$urgent" = 1 ] && nopush=1
  [ -x "$BELL" ] && HQ_BELL_NO_PUSH="$nopush" "$BELL" "needs you: ${bead:+[$bead] }$q" >/dev/null 2>&1 || true
  if [ "$urgent" = 1 ]; then
    NOTIFY="${HQ_NOTIFY:-$HQ/ops/scripts/notify.sh}"
    [ -x "$NOTIFY" ] && HQ_NO_BELL=1 "$NOTIFY" urgent "Console: URGENT" "${bead:+[$bead] }$q" >/dev/null 2>&1 || true
  fi
}

wait_loop(){ # <rid> <chunk-seconds>
  local rid="$1" chunk="$2" deadline rc n=0
  deadline=$(( $(date +%s) + chunk ))
  while :; do
    # a waiting worker keeps the 10-minute fallback ticking even with no
    # console open (every 30 s; the sweep is a no-op when nothing is due)
    [ $((n % 15)) = 0 ] && "$SCRIPT_DIR/ctl.sh" orch-sweep >/dev/null 2>&1
    n=$((n+1))
    poll_once "$rid"; rc=$?
    case "$rc" in
      0) return 0 ;;
      11) return 11 ;;
      4) die "no such request: $rid" 4 ;;
      *) : ;;
    esac
    [ "$(date +%s)" -lt "$deadline" ] || { echo "WAITING $rid"; return 10; }
    sleep 2
  done
}

cmd="${1:-}"; shift 2>/dev/null || true

case "$cmd" in
ask)
  q="${1:-}"; shift 2>/dev/null || true; bead=""; session=""; wait=0; chunk=480; urgent=0; ping=0
  kind=""; cmd=""; link=""; why=""; sev=""; meta=""
  while [ $# -gt 0 ]; do case "$1" in
    --bead) bead="${2:-}"; shift;; --session) session="${2:-}"; shift;;
    --wait) wait=1;; --chunk) chunk="${2:-480}"; shift;;
    --urgent) urgent=1;;
    # console.sh's legacy notify ping, sent here because only ask knows the
    # route: a request that went to the owner pings, an orchestrator one does not
    --notify-ping) ping=1;;
    # structured handoff fields (console v2 design, section 5): what kind of ask, a
    # copyable command, a link, the reason, and the severity lane (P0 also pushes ntfy)
    --kind) kind="${2:-}"; shift;; --cmd) cmd="${2:-}"; shift;; --link) link="${2:-}"; shift;;
    --why) why="${2:-}"; shift;; --sev) sev="${2:-}"; shift;; --meta) meta="${2:-}"; shift;;
    esac; shift; done
  [ -n "$q" ] || die "usage: ctl ask \"<question>\" [--bead B] [--session S] [--kind run|decide|login|info] [--cmd C] [--link URL] [--why W] [--sev P0|P1|P2] [--urgent] [--wait [--chunk N]]" 2
  case "$kind" in ""|run|decide|login|info|autofix|keep-or-revert) ;; *) die "bad --kind $kind" 2;; esac
  case "$sev" in ""|P0|P1|P2) ;; *) die "bad --sev $sev" 2;; esac
  [ "$sev" = P0 ] && urgent=1
  [ -z "$bead" ] || valid_id "$bead" || die "bad bead id" 2
  [ -z "$session" ] || valid_id "$session" || die "bad session id" 2
  # A request with no session has no return address: the answer cannot be
  # injected and nothing knows who to wake, which is why questions sat idle.
  # Bind to the asking pane's session automatically when the caller did not.
  if [ -z "$session" ]; then
    session="$("$SCRIPT_DIR/ctl.sh" whoami 2>/dev/null || true)"
    valid_id "$session" 2>/dev/null || session=""
  fi
  rid="r-$(printf '%04x%04x' $((RANDOM%65536)) $((RANDOM%65536)))"
  skind=""
  [ -n "$session" ] && skind="$("$REGSH" get "$session" 2>/dev/null | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("kind",""))
except Exception: print("")' 2>/dev/null)"
  # A headless worker's ask goes to the orchestrator first (design section 1).
  # An urgent or P0 ask, any non-worker, or no available orchestrator: the owner.
  to=owner
  [ "$skind" = worker ] && [ "$urgent" != 1 ] && orch_available && to=orchestrator
  Q="$q" BEAD="$bead" SESSION="$session" RID="$rid" KIND="$kind" CMD="$cmd" LINK="$link" WHY="$why" SEV="$sev" META="$meta" TO="$to" python3 - <<PY
$PYLIB
import os, json
meta = {}
try:
    meta = json.loads(os.environ.get("META") or "{}")
except Exception:
    meta = {}
sl.add_request(os.environ["RID"], os.environ["Q"], os.environ.get("BEAD",""), os.environ.get("SESSION",""),
               kind=os.environ.get("KIND",""), cmd=os.environ.get("CMD",""), link=os.environ.get("LINK",""),
               why=os.environ.get("WHY",""), sev=os.environ.get("SEV",""), meta=meta,
               to=os.environ.get("TO","owner"))
PY
  [ $? = 0 ] || die "could not file the request" 3
  if [ "$to" = orchestrator ] && ! orch_event_ask "$rid" "$bead" "$session"; then
    # the runner never hears of it, so it goes to the owner now (fail closed)
    RID="$rid" python3 -c "$PYLIB
import os; sl.reroute_to_owner(os.environ['RID'], 'unrouted')" 2>/dev/null
    to=owner
  fi
  # A terminal that needs the owner rings his terminal. With nobody attached,
  # bell.sh pushes a quiet ntfy instead (away); a loud push is reserved for
  # --urgent, which pushes as well, so it tells the bell not to (notify.sh
  # gets HQ_NO_BELL so an urgent ask does not ring twice).
  # Seams (like HQ_WAKE / HQ_SPAWN / HQ_BD) so the suites can stub both.
  # An orchestrator ask rings nobody: the owner hears of it only when forwarded.
  [ "$to" = owner ] && ring_owner "$bead" "$q" "$urgent"
  if [ "$to" = owner ] && [ "$ping" = 1 ]; then
    NOTIFY="${HQ_NOTIFY:-$HQ/ops/scripts/notify.sh}"
    [ -x "$NOTIFY" ] && HQ_NO_BELL=1 "$NOTIFY" default "Console: question waiting" "${bead:+[$bead] }$q" >/dev/null 2>&1 || true
  fi
  # The question is shown in the asking terminal itself (the owner, 2026-10-20: no
  # Needs-you panel; the agent asks in its own terminal and waits there, and the
  # terminal's console card carries the waiting mark and the question). stderr,
  # because stdout is the contract callers parse (the rid, or ANSWERED/WAITING).
  {
    if [ "$to" = orchestrator ]; then
      echo "QUESTION FOR THE ORCHESTRATOR ($rid)${bead:+ [$bead]}:"
    else
      echo "QUESTION FOR OWNER ($rid)${bead:+ [$bead]}:"
    fi
    printf '%s\n' "$q" | sed 's/^/  /'
    if [ "$to" = orchestrator ]; then
      echo "The orchestrator answers it or forwards it to the owner; untouched for 10 minutes, it goes to the owner by itself."
      [ "$wait" = 1 ] || echo "Collect the answer with: $SCRIPT_DIR/ctl.sh await $rid"
    elif [ -z "$session" ]; then
      echo "No terminal is bound to this question. It is listed under 'Questions with no terminal' on the console's Sessions card."
    elif [ "$wait" = 1 ]; then
      echo "Waiting here. Session $session shows as waiting on its console card, with this question and an answer box."
    elif [ "$skind" != worker ]; then
      echo "Session $session now shows as waiting on its console card. Put the question to the owner in your reply here and wait for him."
      echo "When he answers in this terminal, record it: $SCRIPT_DIR/ctl.sh answer $rid --here \"<his answer>\""
      echo "An answer he sends from the card arrives typed into this terminal instead."
    else
      echo "Session $session shows as waiting on its console card. Collect the answer with: $SCRIPT_DIR/ctl.sh await $rid"
    fi
  } >&2
  if [ "$wait" = 1 ]; then wait_loop "$rid" "$chunk"; exit $?; fi
  echo "$rid"
  ;;
forward)
  # The orchestrator hands a worker's ask to the owner, with the reason class
  # (design section 1). No class, no forward.
  rid="${1:-}"; shift 2>/dev/null || true; cls=""; note=""
  while [ $# -gt 0 ]; do case "$1" in
    --class) cls="${2:-}"; shift;; --note) note="${2:-}"; shift;; esac; shift; done
  [ -n "$rid" ] && valid_id "$rid" || die "usage: ctl forward <req-id> --class business|taste|unknowable [--note N]" 2
  case "$cls" in business|taste|unknowable) ;; *) die "forward needs --class business|taste|unknowable" 2;; esac
  out="$(RID="$rid" CLS="$cls" NOTE="$note" python3 - <<PY
$PYLIB
import os
ok, r = sl.forward_request(os.environ["RID"], os.environ["CLS"], "orchestrator", os.environ.get("NOTE", ""))
if not ok:
    print(r); raise SystemExit(3)
print((r.get("sev") or "P1") + "\x1f" + (r.get("bead") or "") + "\x1f" + r.get("question", "").replace("\n", " "))
PY
)" || die "forward refused: $out" 3
  IFS=$'\x1f' read -r fsev fbead fq <<<"$out"
  ring_owner "$fbead" "$fq" "$([ "$fsev" = P0 ] && echo 1 || echo 0)"
  echo "forwarded $rid to the owner ($cls)"
  ;;
orch-sweep)
  # The safety net: an orchestrator ask untouched for 10 minutes forwards
  # itself to the owner (class timeout). Runs on every state compile and from a
  # waiting worker's loop. Prints one line per forward.
  out="$(python3 - <<PY
$PYLIB
for r in sl.orch_fallback_sweep():
    print(r["id"] + "\x1f" + (r.get("sev") or "P1") + "\x1f" + (r.get("bead") or "") + "\x1f" + r.get("question", "").replace("\n", " "))
PY
)" || die "orch-sweep failed" 3
  [ -n "$out" ] || { echo "nothing due"; exit 0; }
  while IFS=$'\x1f' read -r frid fsev fbead fq; do
    [ -n "$frid" ] || continue
    ring_owner "$fbead" "$fq" "$([ "$fsev" = P0 ] && echo 1 || echo 0)"
    echo "forwarded $frid to the owner (timeout)"
  done <<<"$out"
  ;;
cmd)
  # The manual-command store is retired (proposal 58, full trust): agents do these steps themselves.
  echo "ctl cmd is retired (proposal 58): do it yourself; only a real decision goes to the owner via console.sh ask." >&2
  exit 3
  ;;
await)
  rid="${1:-}"; shift 2>/dev/null || true; chunk=480
  while [ $# -gt 0 ]; do case "$1" in --chunk) chunk="${2:-480}"; shift;; esac; shift; done
  [ -n "$rid" ] && valid_id "$rid" || die "usage: ctl await <req-id> [--chunk N]" 2
  wait_loop "$rid" "$chunk"; exit $?
  ;;
answer)
  rid="${1:-}"; shift 2>/dev/null || true; file=""; text=""; here=0
  while [ $# -gt 0 ]; do case "$1" in
    --file) file="${2:-}"; shift;; --here) here=1;; *) [ -z "$text" ] && text="$1";; esac; shift; done
  [ -n "$rid" ] && valid_id "$rid" || die "usage: ctl answer <req-id> [--here] (--file F | \"<text>\")" 2
  [ -n "$file" ] || [ -n "$text" ] || die "answer needs --file or text" 2
  [ -z "$file" ] || [ -f "$file" ] || die "no such file: $file" 2
  if [ "$here" = 1 ]; then
    # --here: the owner already answered inside the asking terminal, so the agent
    # holds the answer. Record it and settle the request as delivered, with no
    # injection (typing the answer back into the asker's own pane would echo it
    # as a new prompt). This is what clears the waiting mark on its card.
    RID="$rid" SRC_FILE="$file" SRC_TEXT="$text" python3 - <<PY || exit 3
$PYLIB
import os, secrets, shutil
rid = os.environ["RID"]
dest = os.path.join(os.environ["ANS"], rid + "-" + secrets.token_hex(4) + ".txt")
src = os.environ.get("SRC_FILE", "")
if src:
    shutil.copyfile(src, dest)
else:
    with open(dest, "w") as fh:
        fh.write(os.environ.get("SRC_TEXT", "") + "\n")
# One transaction, open -> delivered (statelib.record_here). Two CAS steps
# through "answered" left a window in which the delivery paths (a poller, the
# re-delivery sweep, the undeliverable sweep) could claim the request and type
# the answer back into this terminal (lucy, hq-zqqu.1 round 1).
ok, res = sl.record_here(rid, dest)
if not ok:
    try: os.unlink(dest)
    except Exception: pass
    raise SystemExit("ctl: answer --here refused: " + str(res))
r = sl.get_request(rid) or {}
if r.get("status") != "delivered" or r.get("answer_file") != dest:
    raise SystemExit("ctl: answer --here did not settle " + rid)
print("answered " + rid + " (in the asking terminal)")
PY
    exit 0
  fi
  # Resolve the asking terminal's pane BEFORE the answer is routed: the registry
  # can call a running terminal "done", so answer_request takes the live_pane
  # result (exactly one live pane bound to the session on either tmux server)
  # instead of trusting the status (hq-zqqu.1 round 4).
  asid="$(RID="$rid" python3 - <<PY 2>/dev/null
$PYLIB
import os
r = sl.get_request(os.environ["RID"]) or {}
print(r.get("session", "") or "")
PY
)"
  pane_live=0
  if [ -n "$asid" ] && valid_id "$asid" && live_pane "$asid" >/dev/null 2>&1; then pane_live=1; fi
  out="$(RID="$rid" SRC_FILE="$file" SRC_TEXT="$text" PANE_LIVE="$pane_live" python3 - <<PY
$PYLIB
import os, secrets, shutil
rid = os.environ["RID"]
# unique per-attempt file: a losing concurrent answer must never overwrite the
# winner's text (only the CAS winner's path is recorded on the request)
dest = os.path.join(os.environ["ANS"], rid + "-" + secrets.token_hex(4) + ".txt")
src = os.environ.get("SRC_FILE", "")
if src:
    shutil.copyfile(src, dest)
else:
    with open(dest, "w") as fh:
        fh.write(os.environ.get("SRC_TEXT", "") + "\n")
route, res = sl.answer_request(rid, dest, pane_live=os.environ.get("PANE_LIVE") == "1")
if route == "refused":
    try: os.unlink(dest)
    except Exception: pass
if route == "refused":
    print("refused " + str(res)); raise SystemExit(3)
sess = res.get("session", "") if isinstance(res, dict) else ""
print(route + " " + sess)
PY
)" || { echo "ctl: answer failed: $out" >&2; exit 3; }
  route="${out%% *}"; sid="${out#* }"
  case "$route" in
    live)
      if inject "$sid" "$rid"; then
        RID="$rid" python3 - <<PY
$PYLIB
import os
sl.cas(os.environ["RID"], {"answered"}, "delivered", {"delivery": "injected"})
PY
        echo "answered $rid (typed straight into $sid's terminal)"
      else
        echo "answered $rid (live; delivered on the worker's next poll)"
      fi
      ;;
    stale) echo "answered $rid; the asking terminal already finished, so the answer is recorded on the request only";;
    owed) echo "answered $rid; no live pane of $sid to type into, so the answer is recorded and stays on the board as not yet in a terminal";;
    revive)
      if ! RID="$rid" SID="$sid" python3 - <<PY
$PYLIB
import os
rid = os.environ["RID"]; sid = os.environ["SID"]
r = sl.get_request(rid)
sess = sl.sessions().get(sid, {})
obj = sess.get("objectives_file", "")
if obj and not os.path.isabs(obj):
    obj = os.path.join(os.environ["HQ"], obj)
if not obj:
    raise SystemExit("no objectives file for " + sid)
ans = open(r["answer_file"]).read().rstrip("\n")
with open(obj, "a") as fh:
    fh.write("\n## Answer from the owner (" + sl.now() + ")\n")
    fh.write("Question was: " + r.get("question", "") + "\n")
    fh.write("Answer: " + ans + "\n")
    fh.write("Continue the task with this answer. Request " + rid + " is delivered.\n")
PY
      then
        RID="$rid" python3 - <<PY
$PYLIB
import os
sl.cas(os.environ["RID"], {"revival_claimed"}, "answered")
PY
        echo "answered $rid but the objectives append FAILED; not waking $sid" >&2
        exit 5
      fi
      "${HQ_WAKE:-$HQ/ops/scripts/wake.sh}" "$sid" >/dev/null 2>&1; wrc=$?
      if [ "$wrc" = 0 ] || [ "$wrc" = 3 ]; then
        # wake.sh exit 3 = another wake already revived the row (hq-1nkg.15): delivered, but not a fresh revival
        RID="$rid" SID="$sid" DELIV="$([ "$wrc" = 0 ] && echo revived || echo already-revived)" python3 - <<PY
$PYLIB
import os
sl.cas(os.environ["RID"], {"revival_claimed"}, "delivered", {"delivery": os.environ["DELIV"]})
with sl.locked():
    aw = sl.load("awaiting.json", {})
    if aw.get(os.environ["SID"]) == os.environ["RID"]:
        del aw[os.environ["SID"]]
        sl.save("awaiting.json", aw)
PY
        echo "answered $rid (parked session $sid revived with the answer)"
      else
        RID="$rid" python3 - <<PY
$PYLIB
import os
sl.cas(os.environ["RID"], {"revival_claimed"}, "answered")
PY
        echo "answered $rid but revival of $sid FAILED; will deliver if it polls again" >&2
        exit 5
      fi
      ;;
    *) die "unexpected answer route: $route" 1;;
  esac
  ;;
cancel)
  rid="${1:-}"; [ -n "$rid" ] && valid_id "$rid" || die "usage: ctl cancel <req-id>" 2
  RID="$rid" python3 - <<PY
$PYLIB
import os
ok, res = sl.cas(os.environ["RID"], {"open", "answered"}, "cancelled")
print("cancelled" if ok else "not cancelled: " + str(res))
raise SystemExit(0 if ok else 3)
PY
  ;;
park-mark)
  rid="${1:-}"; shift 2>/dev/null || true; session=""
  while [ $# -gt 0 ]; do case "$1" in --session) session="${2:-}"; shift;; esac; shift; done
  [ -n "$rid" ] && [ -n "$session" ] && valid_id "$rid" && valid_id "$session" \
    || die "usage: ctl park-mark <req-id> --session S" 2
  RID="$rid" SID="$session" python3 - <<PY
$PYLIB
import os
rid = os.environ["RID"]; sid = os.environ["SID"]
r = sl.get_request(rid)
if r is None: raise SystemExit("ctl: no such request: " + rid)
if r.get("session") != sid: raise SystemExit("ctl: request " + rid + " is not bound to " + sid)
with sl.locked():
    aw = sl.load("awaiting.json", {})
    aw[sid] = rid
    sl.save("awaiting.json", aw)
print("parked " + sid + " awaiting " + rid)
PY
  ;;
resolve)
  rid="${1:-}"; [ -n "$rid" ] && valid_id "$rid" || die "usage: ctl resolve <req-id>" 2
  RID="$rid" python3 - <<PY
$PYLIB
import os
ok, res = sl.cas(os.environ["RID"], {"open"}, "resolved")
print("resolved 1" if ok else "resolved 0 (" + str(res) + ")")
raise SystemExit(0 if ok else 3)
PY
  ;;
requests)
  python3 - <<PY
$PYLIB
for r in sl.load("requests.json", []):
    if r.get("status", "open") in ("open", "answered", "revival_claimed"):
        b = ("[" + r["bead"] + "] ") if r.get("bead") else ""
        print(f'  {r["id"]}  {r.get("status","open"):16s} {b}{r["question"]}')
PY
  ;;
req-snooze)
  # Defer a question the owner cannot answer yet (waiting on someone else). The
  # request keeps its open status; snooze_until only hides it from Needs-you,
  # so a worker's ask --wait still gets its answer the moment one arrives.
  rid="${1:-}"; shift 2>/dev/null || true; when=""
  while [ $# -gt 0 ]; do case "$1" in
    --until) when="${2:-}"; shift;; *) [ -z "$when" ] && when="$1";; esac; shift; done
  [ -n "$rid" ] && valid_id "$rid" || die "usage: ctl req-snooze <req-id> \"<when>\"" 2
  [ -n "$when" ] || die "req-snooze needs a when (e.g. \"+2 days\", \"tomorrow 09:00\")" 2
  # same charset as the terminal snooze: no shell metacharacters reach date -d
  printf '%s' "$when" | grep -qE '^[ A-Za-z0-9:+-]{1,64}$' \
    || die "bad when (allowed: letters, digits, space, colon, plus, minus)" 2
  epoch="$(date -d "$when" +%s)" || die "cannot parse when: $when" 2
  [ "$epoch" -gt "$(date +%s)" ] || die "when is not in the future: $when" 2
  UNTIL="$(date -u -d "@$epoch" +%Y-%m-%dT%H:%M:%SZ)" RID="$rid" python3 - <<PY
$PYLIB
import os
rid = os.environ["RID"]
with sl.locked():
    reqs = sl.load("requests.json", [])
    i = sl.req_index(reqs, rid)
    if i < 0:
        raise SystemExit("ctl: no such request: " + rid)
    if reqs[i].get("status", "open") != "open":
        raise SystemExit("ctl: only an open request can be snoozed (status is "
                         + reqs[i].get("status", "?") + ")")
    reqs[i]["snooze_until"] = os.environ["UNTIL"]
    sl.save("requests.json", reqs)
print("snoozed " + rid + " until " + os.environ["UNTIL"])
PY
  ;;
req-unsnooze)
  rid="${1:-}"; [ -n "$rid" ] && valid_id "$rid" || die "usage: ctl req-unsnooze <req-id>" 2
  RID="$rid" python3 - <<PY
$PYLIB
import os
rid = os.environ["RID"]
with sl.locked():
    reqs = sl.load("requests.json", [])
    i = sl.req_index(reqs, rid)
    if i < 0:
        raise SystemExit("ctl: no such request: " + rid)
    reqs[i]["snooze_until"] = ""
    # restart the SLA clock: unsnoozing is a touch, not a breach
    reqs[i]["sla_ts"] = sl.now()
    sl.save("requests.json", reqs)
print("unsnoozed " + rid)
PY
  ;;
req-sla-sweep)
  # The SLA clock on Needs-you (design 2026-08-24, section 4.3): every open,
  # unsnoozed question past its severity's threshold (P0 30m, P1 4h, P2 24h)
  # raises itself one level and re-notifies. Two escalations maximum. The
  # state verb runs this on every compile, so the clock ticks as long as the
  # console (or anything else that reads state) is alive; running it by hand
  # or from cron works the same. Prints one line per escalation.
  esc="$(python3 - <<PY
$PYLIB
for r in sl.sla_sweep():
    print("%s %s %s %s" % (r["id"], r.get("sla_from",""), r["sev"], (r.get("bead") or "-")))
PY
)"
  [ -n "$esc" ] || { echo "no breaches"; exit 0; }
  BELL="${HQ_BELL:-$SCRIPT_DIR/bell.sh}"
  NOTIFY="${HQ_NOTIFY:-$HQ/ops/scripts/notify.sh}"
  while IFS=' ' read -r rid from to bead; do
    [ -n "$rid" ] || continue
    [ "$bead" = "-" ] && bead=""
    # same routing policy as ask: the bell for everything, ntfy only at P0
    nopush=""; [ "$to" = P0 ] && nopush=1   # P0 pushes urgent below; no second, quiet push
    [ -x "$BELL" ] && HQ_BELL_NO_PUSH="$nopush" "$BELL" "unanswered ($from -> $to): ${bead:+[$bead] }$rid" >/dev/null 2>&1 || true
    if [ "$to" = P0 ]; then
      [ -x "$NOTIFY" ] && HQ_NO_BELL=1 "$NOTIFY" urgent "Console: question escalated to P0" "${bead:+[$bead] }still unanswered: $rid" >/dev/null 2>&1 || true
    fi
    echo "escalated $rid $from -> $to"
  done <<ESCEOF
$esc
ESCEOF
  ;;
ear-state)
  # The Capri voice ear's live phase, for the console's alive indicator. The ear
  # may run on the desktop or laptop while the console runs on hqbox, so it
  # publishes through the same transport as every other ctl verb (no new
  # credential, no new listener). Only the LATEST phase matters, so this is a
  # single overwritten file, not a queue. Carries no authority: the console only
  # renders it.
  phase="${1:-}"; shift 2>/dev/null || true
  said=""; prog=""; spk=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --progress) prog="${2:-}"; shift;;
      --speaker) spk="${2:-}"; shift;;
      *) [ -z "$said" ] && said="$1";;
    esac
    shift
  done
  case "$phase" in
    idle|wake|listening|thinking|speaking|muted|offline) ;;
    *) die 'usage: ctl ear-state <idle|wake|listening|thinking|speaking|muted|offline> ["text"] [--progress 0..1]' 2;;
  esac
  PHASE="$phase" SAID="$said" PROG="$prog" SPK="$spk" python3 - <<PY
$PYLIB
import os, json, re, tempfile
# same ingestion hygiene as meta-inject: the text is inert display data
said = re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", os.environ.get("SAID", "")).strip()[:200]
rec = {"state": os.environ["PHASE"], "at": sl.now()}
if said:
    rec["text"] = said
# progress is 0..1 or absent. An unparseable or out-of-range figure is DROPPED,
# never clamped: the indicator shows an ember for unknown work, and a clamped
# guess would render as a confident fill that is not true.
spk = os.environ.get("SPK", "").strip()
if spk in ("yours", "unknown", "enrolling"):
    rec["speaker"] = spk
prog = os.environ.get("PROG", "").strip()
if prog:
    try:
        v = float(prog)
        if 0.0 <= v <= 1.0:
            rec["progress"] = v
    except ValueError:
        pass
path = os.path.join(sl.WR, "ear-state.json")
fd, tmp = tempfile.mkstemp(dir=sl.WR, prefix=".ear-state.")
try:
    with os.fdopen(fd, "w") as fh:
        json.dump(rec, fh)
        fh.flush()
        os.fsync(fh.fileno())
    # the console runs as hqconsole and must read this owner-owned file
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)
except Exception:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise
PY
  exit $?
  ;;
ear-wake)
  # The console's wake button for a sleeping ear. No argument stamps the wake
  # request; --check prints the last stamp (empty if none). The ear, asleep,
  # polls --check and wakes when the stamp is newer than when it went to
  # sleep. A stamp is inert data: it carries no text and no authority.
  if [ "${1:-}" = "--check" ]; then
    python3 - <<PY
$PYLIB
import os
path = os.path.join(sl.WR, "ear-wake")
try:
    print(open(path).read().strip())
except OSError:
    pass
PY
  else
    python3 - <<PY
$PYLIB
import os, tempfile, time
fd, tmp = tempfile.mkstemp(dir=sl.WR, prefix=".ear-wake.")
with os.fdopen(fd, "w") as fh:
    fh.write("%d" % int(time.time()))
os.chmod(tmp, 0o644)
os.replace(tmp, os.path.join(sl.WR, "ear-wake"))
PY
  fi
  exit $?
  ;;

meta-inject)
  # Route 3 voice inject (proposal 25, Option A): queue a committed transcript
  # for the open Capri session. This ONLY queues; the console server delivers
  # it to the meta session and ONLY when a passkey-attached tab is present, so
  # this verb grants no authority (an unattached queue entry is surfaced as a
  # card, never silently executed). Runs as owner, same trust as every other
  # ctl verb. Prints the entry id.
  text="${1:-}"; shift 2>/dev/null || true
  [ -n "$text" ] || die 'usage: ctl meta-inject "<text>"' 2
  [ "${#text}" -le 4096 ] || die "inject text too long" 2
  TEXT="$text" python3 - <<PY
$PYLIB
import os, json, re, uuid
# strip CR/LF and control bytes at ingestion (defense in depth): a queued line is
# inert text, never a submit or a terminal control (proposal 25, lucy round 1)
clean = re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", os.environ["TEXT"]).strip()
if not clean:
    raise SystemExit("ctl: nothing to inject after stripping control characters")
rec = {"id": "mi-" + uuid.uuid4().hex[:16], "ts": sl.now(), "text": clean}
# Append under the lock, then cap to the last 200 lines so a box whose console
# is never up cannot grow the queue without bound. The server primes past what
# it has already seen, so trimming old lines never causes a re-delivery.
with sl.locked():
    import os.path
    path = os.path.join(sl.WR, "meta-inject.jsonl")
    lines = []
    try:
        with open(path) as fh:
            lines = [l for l in fh if l.strip()]
    except FileNotFoundError:
        lines = []
    except OSError as e:
        # an unreadable-but-present queue must NOT be treated as empty, or the
        # rewrite below would destroy the pending entries (lucy proposal 25)
        raise SystemExit("ctl: meta-inject queue unreadable: " + str(e))
    lines.append(json.dumps(rec) + "\n")
    # keep the newest 500: on a single-user box the console is rarely down long
    # enough to queue that many; an overflow drops the OLDEST, which is also the
    # least likely to still be wanted. atomic rewrite so a crash mid-write cannot
    # truncate the queue (temp in the same dir, fsync, rename, fsync the dir)
    import tempfile
    fd, tmp = tempfile.mkstemp(dir=sl.WR, prefix=".meta-inject.")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.writelines(lines[-500:])
            fh.flush()
            os.fsync(fh.fileno())
        # mkstemp is 0600; the console runs as hqconsole and must be able to read
        # this owner-owned queue, so make it world-readable like the state dir
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
        dfd = os.open(sl.WR, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
print(rec["id"])
PY
  ;;
clear)
  # Get a request off the board for good. A request whose asker is gone can sit
  # in "delivering" forever: it was answered, but no session will ever poll for
  # it, and the state machine has no exit from a terminal state. So this does
  # two things: move it to cancelled when that transition is legal (which is the
  # honest record, the answer never landed), then set a hidden flag, which is a
  # display filter like snooze_until rather than a new state.
  # --owed (the console's Clear button): only an answered request whose answer
  # has not reached a terminal may be cleared; an open question is refused, so a
  # direct POST cannot cancel a question the owner has not answered (hq-zqqu.1 round 4).
  rid="${1:-}"; owed=0
  [ "${2:-}" = "--owed" ] && owed=1
  [ -n "$rid" ] && valid_id "$rid" || die "usage: ctl clear <req-id> [--owed]" 2
  RID="$rid" OWED="$owed" python3 - <<PY
$PYLIB
import os
rid = os.environ["RID"]
owed = os.environ.get("OWED") == "1"
if sl.get_request(rid) is None:
    raise SystemExit("ctl: no such request: " + rid)
with sl.locked():
    reqs = sl.load("requests.json", [])
    i = sl.req_index(reqs, rid)
    cur = reqs[i].get("status", "open")
    if owed and cur not in ("answered", "revival_claimed"):
        raise SystemExit("ctl: clear --owed refused: " + rid + " is " + cur +
                         "; only an answer not yet in a terminal can be cleared")
    # best effort: already-terminal requests just get hidden
    if cur in ("open", "answered"):
        reqs[i]["status"] = "cancelled"
    reqs[i]["hidden"] = True
    sl.save("requests.json", reqs)
    print("cleared " + rid + " (was " + cur + ")")
PY
  ;;
sink)
  # Deprioritize a question without answering it: rank sorts it below every
  # other open request and it stays there across the dashboard's 3s poll.
  rid="${1:-}"; shift 2>/dev/null || true; top=0
  while [ $# -gt 0 ]; do case "$1" in --top) top=1;; esac; shift; done
  [ -n "$rid" ] && valid_id "$rid" || die "usage: ctl sink <req-id> [--top]" 2
  RID="$rid" TOP="$top" python3 - <<PY
$PYLIB
import os
rid = os.environ["RID"]; top = os.environ["TOP"] == "1"
with sl.locked():
    reqs = sl.load("requests.json", [])
    i = sl.req_index(reqs, rid)
    if i < 0:
        raise SystemExit("ctl: no such request: " + rid)
    ranks = [sl.rank_of(r) for j, r in enumerate(reqs)
             if j != i and r.get("status", "open") == "open"]
    # ranks are relative, not absolute: --top must beat the current minimum,
    # since equal ranks fall back to storage order and would not move at all
    if top:
        rank = (min(ranks) if ranks else 0) - 1
    else:
        rank = (max(ranks) if ranks else 0) + 1
    reqs[i]["rank"] = rank
    reqs[i]["bumped_at"] = sl.now()
    sl.save("requests.json", reqs)
print(("raised " if top else "sank ") + rid + " (rank " + str(rank) + ")")
PY
  ;;
name)
  # A terminal labels its own card: 'ctl name \$(ctl whoami) "acme reconciliation"'.
  sid="${1:-}"; shift 2>/dev/null || true; label=""; clear=0
  while [ $# -gt 0 ]; do case "$1" in
    --clear) clear=1;; *) [ -z "$label" ] && label="$1";; esac; shift; done
  [ -n "$sid" ] && valid_id "$sid" || die "usage: ctl name <session> (\"<label>\" | --clear)" 2
  [ "$clear" = 1 ] || [ -n "$label" ] || die "name needs a label (or --clear)" 2
  SID="$sid" LABEL="$label" CLEAR="$clear" python3 - <<PY
$PYLIB
import os, re
sid = os.environ["SID"]; clear = os.environ["CLEAR"] == "1"
label = re.sub(r"[\x00-\x1f\x7f]", " ", os.environ.get("LABEL", "")).strip()[:60]
if not clear and not label:
    raise SystemExit("ctl: empty label")
# bind the name to this session's generation, exactly like a request's gen:
# ids are only 4 hex chars, so a later session CAN reuse one, and it must not
# inherit a dead terminal's label
sess = sl.sessions()
gen = sess.get(sid, {}).get("started", "")
with sl.locked():
    names = sl.load("names.json", {})
    # The console hides worker asks (up to 10 minutes) while a live session is
    # named "orchestrator" (map.js liveOrchestrator), so the name is reserved:
    # never a worker's, and only one live holder (hq-4npjr.6).
    if not clear and label.lower() == "orchestrator":
        if (sess.get(sid, {}).get("kind") or "") == "worker":
            raise SystemExit("ctl: a worker cannot take the name orchestrator")
        for o, v in names.items():
            s = sess.get(o, {})
            if (o != sid and str(v.get("name", "")).strip().lower() == "orchestrator"
                    and s and s.get("status") != "done" and v.get("gen", "") == s.get("started", "")):
                raise SystemExit("ctl: session %s is already the orchestrator" % o)
    if clear:
        names.pop(sid, None)
    else:
        names[sid] = {"name": label, "ts": sl.now(), "gen": gen}
    sl.save("names.json", names)
print(("cleared " + sid) if clear else ("named " + sid + ": " + label))
PY
  ;;
whoami)
  # Console-v2 interactive terminals run in a runner-owned PTY, not a tmux pane.
  # The runner exports the session's own id as HQ_CONSOLE_SID; that IS the
  # identity, no pane lookup applies.
  if [ -n "${HQ_CONSOLE_SID:-}" ]; then
    valid_id "$HQ_CONSOLE_SID" || die "bad HQ_CONSOLE_SID: $HQ_CONSOLE_SID" 2
    echo "$HQ_CONSOLE_SID"; exit 0
  fi
  pane="${HQ_PANE:-${TMUX_PANE:-}}"
  # Ask tmux only from inside a tmux client (TMUX set). Outside one, the
  # default server answers with ITS current pane, which may be any registered
  # worker: mail-watch's cards then went to the orchestrator as worker asks
  # over sender-written text (hq-an7jw.19). No TMUX means no session.
  if [ -z "$pane" ] && [ -n "${TMUX:-}" ] && [ -z "${HQ_NO_TMUX:-}" ] && command -v tmux >/dev/null; then
    pane="$(tmux display-message -p '#{pane_id}' 2>/dev/null || true)"
  fi
  [ -n "$pane" ] || die "no tmux pane id (run inside tmux, or set HQ_PANE)" 4
  PANE="$pane" python3 - <<PY
$PYLIB
import os
pane = os.environ["PANE"]
# tmux reuses pane ids, so one pane can carry several registrations; the newest
# live one owns it. Registry timestamps are whole seconds, so a tie is genuinely
# ambiguous: refuse rather than name the wrong terminal on a coin flip.
live = sorted((s for s in sl.sessions().values()
               if s.get("tmux_window") == pane and s.get("status") != "done"),
              key=lambda s: s.get("started", ""))
if not live:
    raise SystemExit("ctl: no live session registered for pane " + pane)
newest = live[-1].get("started", "")
tied = [s.get("id", "") for s in live if s.get("started", "") == newest]
if len(tied) > 1:
    raise SystemExit("ctl: pane " + pane + " has " + str(len(tied))
                     + " sessions registered in the same second ("
                     + ", ".join(sorted(tied)) + "); name one explicitly")
print(live[-1].get("id", ""))
PY
  ;;
register-term)
  # Console v2: the server records each runner-spawned interactive terminal here
  # so it exists like any other session. That is what makes the rest work: 'ctl
  # name' binds to a generation, 'ctl ask' has a return address the answer sweep
  # recognises as live, and the card can say more than the raw sid. --done marks
  # the row when the runner reports the PTY exited.
  sid="${1:-}"; shift 2>/dev/null || true; rig=""; model=""; mark_done=0; snooze_at=""; mark_active=0
  while [ $# -gt 0 ]; do case "$1" in
    --rig) rig="${2:-}"; shift;; --model) model="${2:-}"; shift;;
    --snoozed) snooze_at="${2:-}"; shift;; --active) mark_active=1;;
    --done) mark_done=1;; esac; shift; done
  [ -n "$sid" ] && valid_id "$sid" || die "usage: ctl register-term <sid> [--rig R] [--model M] [--done | --snoozed EPOCH | --active]" 2
  # The runner snoozes and wakes console terminals; the row follows it.
  if [ -n "$snooze_at" ]; then
    case "$snooze_at" in *[!0-9]*) die "--snoozed takes an epoch" 2;; esac
    "$REGSH" update "$sid" --status snoozed --wake-at "$snooze_at" >/dev/null 2>&1 || true
    echo "snoozed $sid"
    exit 0
  fi
  if [ "$mark_active" = 1 ]; then
    "$REGSH" update "$sid" --status active --wake-at null >/dev/null 2>&1 || true
    echo "active $sid"
    exit 0
  fi
  if [ "$mark_done" = 1 ]; then
    "$REGSH" update "$sid" --status done >/dev/null 2>&1 || true
    echo "done $sid"
    exit 0
  fi
  worktree=""
  if [ -n "$rig" ]; then
    valid_id "$rig" || die "bad rig name" 2
    if [ -d "$RIGS/$rig/.git" ]; then
      worktree="$RIGS/$rig"
    else
      # A project that is not a rig (acme-financial lives under ops/services):
      # registering it anyway is what lets snooze, names and asks find the
      # terminal. Refusing it left the terminal with no registry row at all.
      worktree="$(jq -r --arg id "$rig" 'if type=="array" then . else (.projects // []) end | map(select(.id==$id)) | .[0].path // empty' "$HQ/ops/projects.json" 2>/dev/null)"
      [ -n "$worktree" ] || die "no such rig or project: $rig" 2
    fi
  fi
  "$REGSH" register --id "$sid" --kind console-term --rig "$rig" \
    --worktree "$worktree" --model "$model" >/dev/null || die "register failed" 3
  echo "$sid"
  ;;
new-term)
  # Start an interactive terminal on a project from the dashboard. Dispatch
  # already covers "run this bead headless"; this covers "I want to sit down and
  # work on that project", which previously meant being at the box for Alt-n.
  rig="${1:-}"; shift 2>/dev/null || true; task=""
  while [ $# -gt 0 ]; do case "$1" in --task) task="${2:-}"; shift;; esac; shift; done
  args=()
  if [ -n "$rig" ] && [ "$rig" != "hq" ]; then
    valid_id "$rig" || die "bad rig name" 2
    [ -d "$RIGS/$rig/.git" ] || die "no such rig: $rig" 2
    args+=("$rig")
  fi
  [ -z "$task" ] || args+=(--task "$task")
  "${HQ_TERM:-$HQ/ops/scripts/term.sh}" "${args[@]}"
  ;;
focus)
  # Clicking a card should take the owner to that terminal. Selecting the pane and
  # its window changes the session's active pane, which every attached client
  # follows, so it works from the browser on the tailnet too.
  sid="${1:-}"; [ -n "$sid" ] && valid_id "$sid" || die "usage: ctl focus <session>" 2
  [ -z "${HQ_NO_TMUX:-}" ] || die "tmux disabled" 4
  command -v tmux >/dev/null || die "no tmux" 4
  entry="$("$REGSH" get "$sid" 2>/dev/null)" || die "no such session: $sid" 2
  pane="$(printf '%s' "$entry" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("tmux_window",""))
except Exception: print("")')"
  # only a pane id from the registry: never an arbitrary tmux target string
  case "$pane" in %[0-9]*) : ;; *) die "session $sid has no pane id ($pane)" 4;; esac
  tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -qx "$pane" \
    || die "pane $pane is gone" 4
  tmux select-pane -t "$pane" 2>/dev/null || true
  tmux select-window -t "$pane" 2>/dev/null || true
  echo "focused $sid ($pane)"
  ;;
phase)
  exec "$HQ/ops/scripts/console.sh" phase "$@"
  ;;
log-change)
  desc="${1:-}"; shift 2>/dev/null || true; session=""
  while [ $# -gt 0 ]; do case "$1" in --session) session="${2:-}"; shift;; esac; shift; done
  [ -n "$desc" ] || die "usage: ctl log-change \"<desc>\" [--session S]" 2
  DESC="$desc" SESSION="$session" python3 - <<PY
$PYLIB
import os
sl.append_jsonl("changes.jsonl", {"ts": sl.now(),
    "session": os.environ.get("SESSION",""), "desc": os.environ["DESC"]})
PY
  echo "logged"
  ;;
tasks)
  refresh=0; [ "${1:-}" = "--refresh" ] && refresh=1
  RF="$refresh" python3 - <<PY
$PYLIB
import json, os, subprocess, tempfile, time
HQ = os.environ["HQ"]; TC = os.environ["TC"]
rigroot = os.path.join(HQ, "rigs")
# main checkouts have a .git DIRECTORY; worker worktrees have a .git file: skip those
rigs = ["."] + sorted(d for d in (os.listdir(rigroot) if os.path.isdir(rigroot) else [])
                      if os.path.isdir(os.path.join(rigroot, d, ".beads"))
                      and os.path.isdir(os.path.join(rigroot, d, ".git")))
BD = os.environ.get("HQ_BD", "bd")
CAP = 30

def first_json(raw, default):
    try:
        val, _ = json.JSONDecoder().raw_decode(raw.lstrip())
        return val
    except Exception:
        return default

def slim(b):
    return {"id": b.get("id", ""), "title": b.get("title", ""),
            "status": b.get("status", ""), "priority": b.get("priority", ""),
            "labels": b.get("labels", [])}

# One bd invocation costs 1.5-3.5s of wall clock on this box (big Go binary,
# mostly non-CPU startup), so 2 calls x N rigs run serially took ~40s: longer
# than the 30s cache TTL, so the cache was ALWAYS stale, every state compile
# paid full price, and /api/state blew the server's 60s timeout (the dashboard
# rendered nothing; that was 2026-08-26's "console can't spawn terminals").
# Rigs are fetched in parallel instead; the two bd calls per rig stay
# sequential so no two processes ever touch the same dolt DB concurrently.
def fetch(rig):
    path = HQ if rig == "." else os.path.join(HQ, "rigs", rig)
    name = "hq" if rig == "." else rig
    cache = os.path.join(TC, name + ".json")
    fresh = False
    try:
        fresh = (time.time() - os.path.getmtime(cache)) < 30 and os.environ.get("RF") != "1"
    except Exception:
        pass
    if fresh:
        try:
            return name, json.load(open(cache))
        except Exception:
            pass
    seen = {}
    okrun = True
    try:
        for cmdargs in (["ready", "--json"], ["list", "--status", "in_progress", "--json"]):
            raw = subprocess.run([BD] + cmdargs, cwd=path,
                                 capture_output=True, text=True, timeout=20).stdout
            for b in first_json(raw or "[]", []):
                seen.setdefault(b.get("id", ""), slim(b))
    except Exception:
        okrun = False
    if not okrun:
        # keep serving the stale cache rather than clobbering it with nothing
        try:
            return name, json.load(open(cache))
        except Exception:
            pass
    beads = sorted(seen.values(), key=lambda b: (str(b.get("priority", 9)), b.get("id", "")))
    entry = {"total": len(beads), "beads": beads[:CAP]}
    fd, tmp = tempfile.mkstemp(dir=TC, suffix=".tmp")
    with os.fdopen(fd, "w") as fh:
        json.dump(entry, fh)
    os.replace(tmp, cache)
    return name, entry

from concurrent.futures import ThreadPoolExecutor
uniq = list(dict.fromkeys(rigs))
with ThreadPoolExecutor(max_workers=min(8, max(1, len(uniq)))) as pool:
    results = list(pool.map(fetch, uniq))
out = dict(results)
print(json.dumps(out, indent=2))
PY
  ;;
dispatch-batch)
  # ledger_dir ID RIGDIR: an hq-* id lives in the hq ledger (~/hq) whatever rig
  # it is dispatched to; any other prefix lives in the rig's own ledger. bd does
  # not walk up from a rig to ~/hq, so running it in the rig dir for an hq-*
  # bead printed 'no beads database' (hq-kptb3.4).
  ledger_dir() { case "$1" in hq-*) echo "$HQ";; *) echo "$2";; esac; }
  # Send SEVERAL beads to ONE terminal. A whole session per bead is the biggest
  # avoidable token cost in HQ: every spawn re-reads CLAUDE.md and the seed
  # before doing any work, so five one-line beads paid that five times. The
  # worker still does them one at a time, it just does not need a fresh session
  # between them. Each bead becomes a console phase, so the card shows progress
  # across the batch and the owner can see which one it is on.
  rig=""; model=""; beads=""; epic=""; opid=""; force=""
  while [ $# -gt 0 ]; do case "$1" in
    --rig) rig="${2:-}"; shift;; --model) model="${2:-}"; shift;;
    --beads) beads="${2:-}"; shift;; --epic) epic="${2:-}"; shift;;
    --op) opid="${2:-}"; shift;; --force) force=1;; esac; shift; done
  [ -n "$rig" ] && valid_id "$rig" || die "usage: ctl dispatch-batch --rig R (--epic E | --beads b1,b2,...)" 2
  [ -n "$beads" ] || [ -n "$epic" ] || die "dispatch-batch needs --epic or --beads" 2
  [ -z "$beads" ] || [ -z "$epic" ] || die "pass --epic or --beads, not both" 2
  # spawn.sh builds a worktree for the rig; a name that is not a rig would fail
  # deep inside spawn with a confusing error, after claiming beads. Rig "hq" is
  # the hq repo itself (spawn.sh puts its worktrees under .claude/worktrees).
  rigd="$RIGS/$rig"; [ "$rig" = hq ] && rigd="$HQ"
  [ -d "$rigd/.git" ] || die "no such rig: $rig" 2
  # The epic is the dispatch unit (CLAUDE.md operating loop, proposal 22): the
  # batch is the epic's READY children in ledger order, capped like a hand list.
  # bd ready already excludes blocked and closed children, so a dependency that
  # is still open keeps its dependents out of this session; the next dispatch
  # of the same epic picks them up. The hand-listed --beads form is unchanged.
  if [ -n "$epic" ]; then
    valid_id "$epic" || die "bad epic id: $epic" 2
    beads="$(cd "$(ledger_dir "$epic" "$rigd")" 2>/dev/null && "${HQ_BD:-bd}" ready --parent "$epic" --limit 0 --json 2>/dev/null \
      | python3 -c 'import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
rows = d if isinstance(d, list) else d.get("issues", [])
ids = [str(r.get("id", "")) for r in rows if isinstance(r, dict) and r.get("issue_type") != "epic"]
print(",".join(i for i in ids if i)[:4096])')"
    [ -n "$beads" ] || die "epic $epic has no ready children in ledger $(ledger_dir "$epic" "$rigd") (bd ready --parent $epic)" 2
    # a larger epic dispatches over successive sessions: take the first 8 only
    beads="$(printf '%s' "$beads" | cut -d, -f1-8)"
  fi
  case "${model:-claude-opus-5-5}" in
    claude-fable-5-2|claude-fable-5-1|claude-fable-5|claude-opus-5-5|claude-opus-5|claude-opus-4-8|claude-opus-4-7|claude-sonnet-5-5|claude-sonnet-5|claude-haiku-5-5)
      model="${model:-claude-opus-5-5}";;
    *) die "model not in allowlist" 2;;
  esac
  # split, validate and cap. A runaway batch would hand one session more work
  # than its context can hold, which costs more than it saves.
  list=""; n=0
  IFS=','; for b in $beads; do
    b="$(printf '%s' "$b" | tr -d ' ')"; [ -n "$b" ] || continue
    valid_id "$b" || die "bad bead id: $b" 2
    # a repeated id would inflate n, tell the worker to do it twice, and write
    # a single claim file, so the claim count would disagree with the batch
    case " $list " in *" $b "*) die "bead $b listed twice in the batch" 2;; esac
    list="$list $b"; n=$((n + 1))
  done; unset IFS
  [ "$n" -gt 0 ] || die "no valid bead ids in --beads" 2
  [ "$n" -le 8 ] || die "batch of $n is too large (max 8); a session that big loses the plot" 2

  # A bead that does not exist, is closed, or is already being worked must not
  # cost a whole terminal. One bd call each, capped at 8, before any claim.
  TMPERR="$(mktemp)"; trap 'rm -f "$TMPERR"' EXIT
  for b in $list; do
    show="$(cd "$(ledger_dir "$b" "$rigd")" 2>&1 && "${HQ_BD:-bd}" show "$b" --json 2>&1 || true)"
    printf '%s' "$show" | BEAD="$b" python3 -c 'import json, os, sys
# ANY failure here is a refusal. Selectively rejecting two exit codes let an
# unexpected shape (an empty list, a dict without status) raise, exit 1, and
# read as "valid" to the shell.
try:
    raw = sys.stdin.read()
    b = json.loads(raw)
    if isinstance(b, list):
        b = b[0]
    if not isinstance(b, dict):
        raise ValueError("not an object")
    if str(b.get("id", "")) != os.environ["BEAD"]:
        raise ValueError("id mismatch")
    # allowlist, not a denylist: in_progress is already being worked, and a
    # second worker on it is the duplicate-dispatch this guard exists to stop
    if b.get("status") not in ("open", "ready", "blocked"):
        raise ValueError("status " + str(b.get("status")))
except Exception as e:
    print(e, file=sys.stderr)
    sys.exit(3)' 2>"$TMPERR"
    [ "$?" = 0 ] || die "bead $b is not dispatchable in $rig, ledger $(ledger_dir "$b" "$rigd") ($(cat "$TMPERR" 2>/dev/null || true))" 2
  done

  claimout="$(FORCE="$force" RIG="$rig" LIST="$list" python3 - <<PY
$PYLIB
import os
rig = os.environ["RIG"]; ids = os.environ["LIST"].split()
with sl.locked():
    # one check for every path that starts a worker (statelib.bead_hold,
    # hq-4npjr.10): a held bead refuses the WHOLE batch, before any claim
    for b in ids:
        why = None if os.environ["FORCE"] else sl.bead_hold(b)
        if why:
            print("refused: " + why)
            raise SystemExit(3)
    nonce = os.urandom(8).hex()
    for b in ids:
        sl.claim_bead(b, rig, nonce, batch=ids, primary=ids[0])
print("claimed %d nonce=%s" % (len(ids), nonce))
PY
)" || { echo "$claimout" >&2; exit 3; }
  echo "$claimout"
  nonce="${claimout##*nonce=}"

  # titles make the seed readable; a missing one is not fatal
  task="Work these $n beads IN ORDER, one at a time, committing between them:"
  for b in $list; do
    t="$(cd "$(ledger_dir "$b" "$rigd")" 2>/dev/null && "${HQ_BD:-bd}" show "$b" --json 2>/dev/null | python3 -c 'import json,sys
try:
    b=json.load(sys.stdin); b=b[0] if isinstance(b,list) else b
    print(b.get("title","")[:70])
except Exception: print("")' || true)"
    task="$task ($b) ${t:-untitled};"
  done
  primary="${list#" "}"; primary="${primary%% *}"   # first id in the batch

  # HQ_CLAIM_NONCE tells spawn.sh the claim on the primary is ours, so its own
  # bead_hold check does not refuse the dispatch that just claimed it
  if ! HQ_CLAIM_NONCE="$nonce" "${HQ_SPAWN:-$HQ/ops/scripts/spawn.sh}" "$rig" "$task" --worker --model "$model" --bead "$primary" ${force:+--force}; then
    LIST="$list" NONCE="$nonce" python3 - <<PY
$PYLIB
import os
# only OUR claims: after ten minutes another dispatch may legitimately own one,
# and blindly deleting it would let that bead be dispatched twice
for b in os.environ["LIST"].split():
    sl.release_claim(b, os.environ["NONCE"])
PY
    die "spawn failed (claims released)" 1
  fi
  # each bead becomes a phase, so the card shows which one it is on
  phases="$(printf '%s' "$list" | sed 's/^ //; s/ /, /g')"
  "$HQ/ops/scripts/console.sh" phase set "$primary" "$phases" --title "$n beads" >/dev/null 2>&1 || true
  echo "dispatched $n beads to one terminal on $rig"
  ;;
dispatch)
  bead="${1:-}"; shift 2>/dev/null || true; rig=""; model=""; opid=""; force=""
  while [ $# -gt 0 ]; do case "$1" in
    --rig) rig="${2:-}"; shift;; --model) model="${2:-}"; shift;;
    --op) opid="${2:-}"; shift;; --force) force=1;; esac; shift; done
  [ -n "$bead" ] && valid_id "$bead" || die "usage: ctl dispatch <bead> --rig R [--model M] [--op ID]" 2
  [ -n "$rig" ] && valid_id "$rig" || die "dispatch needs --rig" 2
  # spawn.sh builds a worktree for the rig; a name that is not a rig would fail
  # deep inside spawn with a confusing error, after claiming beads. Rig "hq" is
  # the hq repo itself (spawn.sh puts its worktrees under .claude/worktrees).
  rigd="$RIGS/$rig"; [ "$rig" = hq ] && rigd="$HQ"
  [ -d "$rigd/.git" ] || die "no such rig: $rig" 2
  [ -z "$opid" ] || valid_id "$opid" || die "bad op id" 2
  # allowlist, strongest first. spawn.sh does not validate --model, so this is
  # the only gate between the dashboard and the claude CLI.
  case "${model:-claude-opus-5-5}" in
    claude-fable-5-2|claude-fable-5-1|claude-fable-5|claude-opus-5-5|claude-opus-5|claude-opus-4-8|claude-opus-4-7|claude-sonnet-5-5|claude-sonnet-5|claude-haiku-5-5)
      model="${model:-claude-opus-5-5}";;
    *) die "model not in allowlist" 2;;
  esac
  claimout="$(FORCE="$force" BEAD="$bead" RIG="$rig" python3 - <<PY
$PYLIB
import os
bead = os.environ["BEAD"]
with sl.locked():
    # hq-4npjr.10: the one check every path shares; --force is a deliberate takeover
    why = None if os.environ["FORCE"] else sl.bead_hold(bead)
    if why:
        print("refused: " + why)
        raise SystemExit(3)
    nonce = os.urandom(8).hex()
    sl.claim_bead(bead, os.environ["RIG"], nonce)
print("claimed nonce=" + nonce)
PY
)" || { echo "$claimout" >&2; exit 3; }
  echo "$claimout"
  nonce="${claimout##*nonce=}"
  rigd="$HQ/rigs/$rig"; [ "$rig" = hq ] && rigd="$HQ"
  title="$(cd "$rigd" 2>/dev/null && bd show "$bead" --json 2>/dev/null | \
    python3 -c 'import json,sys
try:
    b=json.load(sys.stdin)
    b=b[0] if isinstance(b,list) else b
    print(b.get("title","")[:80])
except Exception: print("")' || true)"
  [ -n "$title" ] || title="work bead $bead"
  HQ_CLAIM_NONCE="$nonce" "${HQ_SPAWN:-$HQ/ops/scripts/spawn.sh}" "$rig" "$title" --worker --model "$model" --bead "$bead" ${force:+--force}; rc=$?
  if [ "$rc" != 0 ]; then
    BEAD="$bead" NONCE="$nonce" python3 - <<PY
$PYLIB
import os
sl.release_claim(os.environ["BEAD"], os.environ["NONCE"])
PY
    die "spawn failed (claim released)" "$rc"
  fi
  ;;
kill)
  # Idempotent (hq-je3fk.5): killing a session that is already gone, or was
  # never registered, succeeds, so a card can always be cleared. Only the pane
  # that is provably this session's is killed (statelib.pane_status): tmux
  # reuses pane ids, and a stale row once pointed at the cpu-watch pane.
  sid="${1:-}"; [ -n "$sid" ] && valid_id "$sid" || die "usage: ctl kill <session>" 2
  if ! entry="$("$REGSH" get "$sid" 2>/dev/null)"; then
    echo "killed $sid (not registered, nothing to kill)"; exit 0
  fi
  target=""
  if [ -z "${HQ_NO_TMUX:-}" ] && command -v tmux >/dev/null; then
    target="$(ENTRY="$entry" python3 - <<PY
$PYLIB
import json, os
row = json.loads(os.environ["ENTRY"])
srv = sl.hq_tmux_server()
win = str(row.get("tmux_window") or "")
if row.get("status") != "done" and srv and row.get("kind") != "console-term":
    if win.startswith("%"):
        ps = sl.pane_status(row, sl.hq_panes(srv))
        if ps in ("live", "shell", "dead"):
            print(srv[1], "pane", win)
    elif win:
        # a whole window only when it is this session's alone: hq:work holds
        # every worker, and a stale row naming it must not end them all
        import subprocess
        r = subprocess.run(["tmux"] + srv + ["list-panes", "-t", "=" + win, "-F", "x"],
                           capture_output=True, text=True, timeout=10)
        if r.returncode == 0 and len(r.stdout.split()) == 1 and win != "hq:work":
            print(srv[1], "window", win)
PY
)"
  fi
  if [ -n "$target" ]; then
    set -- $target
    case "$2" in
      pane) tmux -L "$1" kill-pane -t "$3" >/dev/null 2>&1 || true
            tmux -L "$1" list-panes -a -F '#{pane_id}' 2>/dev/null | grep -qx "$3" \
              && die "pane $3 still alive; not marking done" 4 ;;
      window) tmux -L "$1" kill-window -t "=$3" >/dev/null 2>&1 || true
            tmux -L "$1" list-windows -a -F '#S:#W' 2>/dev/null | grep -qx "$3" \
              && die "window $3 still alive; not marking done" 4 ;;
    esac
  fi
  "$REGSH" update "$sid" --status done >/dev/null || die "registry update failed"
  "$SCRIPT_DIR/ctl.sh" log-change "killed session $sid" --session "$sid" >/dev/null 2>&1 || true
  echo "killed $sid"
  ;;
reconcile)
  # One pass that writes what ctl state only shows (hq-je3fk.5): a worker row
  # whose pane is gone, dead, reused or back at a shell is set done when its
  # worktree holds nothing unmerged, else finishable for finish.sh. Never kills
  # a pane, never touches a worktree or branch. --dry-run prints and writes nothing.
  dry=0; [ "${1:-}" = "--dry-run" ] && dry=1
  [ -z "${HQ_NO_TMUX:-}" ] || die "reconcile needs tmux (HQ_NO_TMUX is set)" 3
  DRY="$dry" python3 - <<PY
$PYLIB
import os, subprocess, sys
panes = sl.hq_panes()
if panes is None:
    print("ctl: reconcile refused: the hq tmux server cannot be asked", file=sys.stderr)
    raise SystemExit(3)
kids = sl.proc_kids()
dry = os.environ["DRY"] == "1"
changed = kept = 0
for sid, row in sorted(sl.sessions().items()):
    if row.get("status") not in ("active", "finishable", "exited"):
        continue
    ps = sl.pane_status(row, panes, kids)
    act = sl.reconcile_row(row, ps)
    if not act:
        if row.get("status") in ("finishable", "exited") and ps != "live":
            kept += 1
        continue
    new, why = act
    kept += new == "finishable"
    print("%s %-8s %s -> %s  (%s)" % ("would" if dry else "set  ", sid, row.get("status"), new, why))
    if not dry:
        r = subprocess.run([os.environ["REGSH"], "update", sid, "--status", new],
                           capture_output=True, text=True)
        if r.returncode != 0:
            print("ctl: registry update failed for " + sid, file=sys.stderr)
            continue
    changed += 1
print("%s %d, left %d needing finish" % ("would change" if dry else "changed", changed, kept))
PY
  ;;
finish-check)
  bead=""; sid=""
  while [ $# -gt 0 ]; do case "$1" in
    --session) sid="${2:-}"; shift;; *) [ -z "$bead" ] && bead="$1";; esac; shift; done
  if [ -n "$sid" ]; then valid_id "$sid" || die "bad session id" 2
  else [ -n "$bead" ] && valid_id "$bead" || die "usage: ctl finish-check (<bead> | --session S)" 2; fi
  BEAD="$bead" SID="$sid" python3 - <<PY
$PYLIB
import json, os, re, subprocess
bead = os.environ.get("BEAD", ""); sid = os.environ.get("SID", ""); HQ = os.environ["HQ"]
if sid:
    sess = sl.sessions().get(sid)
    if sess and sess.get("status") == "done":
        sess = None
    bead = (sess or {}).get("bead", bead)
else:
    sess = next((s for s in sl.sessions().values()
                 if s.get("bead") == bead and s.get("status") != "done"), None)
if not sess:
    print(json.dumps({"bead": bead, "ok": False, "reason": "no live session"})); raise SystemExit(0)
rig = sess.get("rig", ""); branch = sess.get("branch", ""); wt = sess.get("worktree", "")
head = ""; dirty = True
try:
    head = subprocess.run(["git", "-C", wt, "rev-parse", "HEAD"],
                          capture_output=True, text=True, timeout=10).stdout.strip()
    dirty = bool(subprocess.run(["git", "-C", wt, "status", "--porcelain"],
                                capture_output=True, text=True, timeout=10).stdout.strip())
except Exception:
    pass
show = ""
rigdir = HQ if rig in ("hq", ".") else os.path.join(HQ, "rigs", rig)
try:
    show = subprocess.run([os.environ.get("HQ_BD", "bd"), "show", bead], cwd=rigdir,
                          capture_output=True, text=True, timeout=20).stdout
except Exception:
    pass
approvals = re.findall(r"Review-Approve:\s*([0-9a-f]{40})", show)
ok = bool(head) and not dirty and bool(approvals) and approvals[-1] == head
reason = ("approved" if ok else
          "uncommitted changes in worktree (not reviewed)" if dirty and head else
          "no approval marker" if not approvals else
          "approval sha " + approvals[-1][:12] + " != head " + (head[:12] or "?"))
print(json.dumps({"bead": bead, "session": sess.get("id", ""), "ok": ok,
                  "head": head, "reason": reason, "branch": branch, "rig": rig}))
raise SystemExit(0)
PY
  ;;
finish)
  sid="${1:-}"; shift 2>/dev/null || true; confirm=0; xhead=""
  while [ $# -gt 0 ]; do case "$1" in
    --confirm) confirm=1;;
    --expect-head) xhead="${2:-}"; shift;;
  esac; shift; done
  [ -n "$sid" ] && valid_id "$sid" || die "usage: ctl finish <session> [--confirm] [--expect-head SHA]" 2
  case "$xhead" in "") ;; *[!0-9a-f]*) die "bad --expect-head" 2;; esac
  FIN="$HQ/ops/scripts/finish.sh"
  if [ "$confirm" != 1 ]; then exec "$FIN" "$sid"; fi
  chk="$("$SCRIPT_DIR/ctl.sh" finish-check --session "$sid")"
  okv="$(printf '%s' "$chk" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ok"])')"
  [ "$okv" = "True" ] || { echo "ctl: finish gate refused: $chk" >&2; exit 3; }
  # pass --require-approval only when finish.sh knows it (proposal 02 applied)
  xargs_=""
  # only pass it on to a finish.sh that understands it, so a mixed checkout degrades
  # to the previous behaviour instead of dying on an unknown argument
  [ -n "$xhead" ] && grep -q 'expect-head' "$FIN" 2>&1 && xargs_="--expect-head $xhead"
  if grep -q 'require-approval' "$FIN" 2>&1; then
    # shellcheck disable=SC2086
    exec "$FIN" "$sid" --confirm --require-approval $xargs_
  fi
  # shellcheck disable=SC2086
  exec "$FIN" "$sid" --confirm $xargs_
  ;;
state)
  # the SLA clock ticks whenever anyone compiles state (the server polls this),
  # so breached questions escalate without a daemon of their own
  "$SCRIPT_DIR/ctl.sh" req-sla-sweep >/dev/null 2>&1 || true
  "$SCRIPT_DIR/ctl.sh" orch-sweep >/dev/null 2>&1 || true
  # legacy state and the tasks cache go through files, not env: on hqbox the
  # tasks JSON alone passes 128 KB and a single env string that large makes
  # exec fail with "Argument list too long" (E2BIG), taking the dashboard down.
  state_tmp="$(mktemp -d "${TMPDIR:-/tmp}/ctl-state.XXXXXX")" || die "mktemp failed" 3
  "$HQ/ops/scripts/console.sh" state >"$state_tmp/legacy.json" 2>/dev/null || printf '{}' >"$state_tmp/legacy.json"
  "$SCRIPT_DIR/ctl.sh" tasks >"$state_tmp/tasks.json" 2>/dev/null || printf '{}' >"$state_tmp/tasks.json"
  STATE_TMP="$state_tmp" python3 - <<PY
$PYLIB
import calendar, json, os, time, shutil
_tmp = os.environ["STATE_TMP"]
def _load(name):
    try:
        with open(os.path.join(_tmp, name)) as fh:
            txt = fh.read().strip()
        return json.loads(txt) if txt else {}
    except Exception:
        return {}
st = _load("legacy.json")
st["tasks"] = _load("tasks.json")
shutil.rmtree(_tmp, ignore_errors=True)
# Token usage from Claude Code's own transcripts. ccusage is not installed on
# this box, which is why the usage tile read n/a. This is incremental (byte
# offsets per file), so the poll costs milliseconds, not a rescan.
try:
    import subprocess
    st["tokens"] = json.loads(subprocess.run(
        ["python3", os.path.join(os.environ["CTL_DIR"], "usage.py"),
         "--state", os.environ["STATE_DIR"]],
        capture_output=True, text=True, timeout=30).stdout or "{}")
except Exception:
    st["tokens"] = {}
# Box health: CPU, memory, temperatures, disks, and what is eating the RAM.
# Reads /proc and /sys only, so it costs about a millisecond.
try:
    import subprocess
    st["hw"] = json.loads(subprocess.run(
        ["python3", os.path.join(os.environ["CTL_DIR"], "hw.py"),
         "--state", os.environ["STATE_DIR"]],
        capture_output=True, text=True, timeout=15).stdout or "{}")
except Exception:
    st["hw"] = {}
def recent(r):
    if r.get("status") != "cancelled": return False
    t = sl.parse_ts(r.get("answered_ts", "") or "")
    if t is None: return False
    # an undeliverable answer is shown briefly so the owner learns it went nowhere,
    # then clears itself; a terminal that merely finished first lingers a day
    window = 900 if r.get("delivery") == "undeliverable" else 86400
    return time.time() - t < window
def just_delivered(r):
    # keep a delivered answer on screen briefly: otherwise it simply vanishes
    # and there is no way to tell delivery from the request being lost
    if r.get("status") != "delivered": return False
    t = sl.parse_ts(r.get("answered_ts", "") or "")
    return t is not None and time.time() - t < 900
# Which panes are actually dead? A worker runs claude -p and exits when its task
# is done; the work window has remain-on-exit on, so the pane lingers, and
# session-registry reconcile counts a listed pane as live. Both the sweep below
# and the session cards need this, so it is gathered once, first.
dead_panes = set()
live_panes = None   # None: tmux could not be asked, so nothing is claimed either way
# Registry pane ids belong to the server that holds the session named exactly
# hq (default or hqterm, see ops/scripts/lib/tmux-server.sh). The console runs
# with no TMUX in its environment, so a bare tmux call asked the default server,
# never saw the hqterm workers die, and their corpses stayed "running" cards
# (2026-10-27). Pane ids are per server, so only that one server is asked.
hq_panes = sl.hq_panes()
if hq_panes is not None:
    dead_panes = {k for k, v in hq_panes.items() if v["dead"]}
    live_panes = {k for k, v in hq_panes.items() if not v["dead"]}

# Sweep answers that can never be delivered. Without this a question whose
# terminal died stays "delivering" until the owner clears it by hand, which is
# indistinguishable on the board from one that is genuinely still in flight.
# Only "answered" is swept; an in-flight revival claim is left to finish or
# revert itself (see statelib.undeliverable).
# Open questions are never closed here, whatever the registry says about the
# asking terminal: the registry can call a running terminal "done" (hqbox runs
# two tmux servers and reconcile lists only one), so an open question stays open
# and answerable, on its card or under "Questions with no terminal" (hq-zqqu.1
# round 3). For the same reason an answered question from an interactive
# terminal is never cancelled as undeliverable: it stays "answered" and on the
# board ("answered, not yet in the terminal") until the owner clears it.
# Only a registered headless worker's answer is ever cancelled here: an answer
# with no bound session, or one whose session is no longer registered, has no
# one who could be shown to be gone, so it stays "answered" and is listed under
# "Answers not yet in a terminal" until the owner clears it (hq-zqqu.1 round 4).
for r in sl.load("requests.json", []):
    why = sl.undeliverable(r, sl.sessions(), dead_panes)
    asker = sl.sessions().get(r.get("session", "") or "")
    if not why or not asker or sl.interactive_ask(r, sl.sessions()):
        continue
    # Re-read the session immediately before committing: it may have restarted
    # since, which would make the answer deliverable again after all. Not fully
    # atomic (the registry is not under the console lock) but it closes the
    # window that matters.
    if sl.undeliverable(r, sl.sessions(), dead_panes) != why:
        continue
    sl.cas(r["id"], {"answered"}, "cancelled",
           {"delivery": "undeliverable", "undeliverable_why": why,
            "answered_ts": r.get("answered_ts") or sl.now()})

allr = sl.load("requests.json", [])
shown = [r for r in allr
         if not r.get("hidden")
         and (r.get("status", "open") in ("open", "answered", "revival_claimed")
              or recent(r) or just_delivered(r))]
# which project is each question about? the asking session knows its rig; a
# bead id's prefix is the fallback, since workers tag questions with a bead.
# This runs BEFORE sorting because the dashboard groups by rig.
sessmap = sl.sessions()
BEAD_RIG = {"hq": "hq", "xd": "acme-dashboard", "gt": "gym-tracker",
            "ck": "chesski", "dh": "fintrack-portfolio"}
for r in shown:
    rig = ""
    s = sessmap.get(r.get("session", "") or "", {})
    if s:
        rig = s.get("rig", "") or sl.derive(s)[0]
    if not rig and r.get("bead"):
        rig = BEAD_RIG.get(r["bead"].split("-")[0], "")
    r["rig"] = rig or "unassigned"

# snoozed questions leave Needs-you until their date, then come back on their own
# sort by rig first so each project's questions sit together; rank still orders
# within a project, so "To bottom" sinks a question inside its own group
st["requests"] = sorted((r for r in shown if not sl.request_snoozed(r)),
                        key=lambda r: (r["rig"] == "unassigned", r["rig"], sl.rank_of(r)))
st["snoozed"] = sorted((r for r in shown if sl.request_snoozed(r)),
                       key=lambda r: r.get("snooze_until", ""))
# a card should say what the terminal is working on, not just t-XXXX
names = sl.load("names.json", {})
kids = sl.proc_kids() if hq_panes is not None else {}
for t in st.get("terminals", []):
    rig, task = sl.derive(t)
    t["derived_rig"] = rig
    t["derived_task"] = task
    nm = names.get(t.get("id", ""), {})
    # a name from a previous session that happened to hold this id is not ours
    t["name"] = nm.get("name", "") if nm.get("gen", "") in ("", t.get("started", "")) else ""
    # Reconcile on read (hq-je3fk.5): the row's pane is bound by evidence, not
    # by its id, since tmux reuses ids (statelib.pane_status). A console
    # terminal is the runner's to judge, so it keeps its registry status.
    ps = "none" if t.get("kind") == "console-term" else sl.pane_status(t, hq_panes, kids)
    t["pane_state"] = ps
    t["pane_dead"] = ps == "dead"
    # pane_live: True only when this row's own pane runs a claude right now; the
    # console then never ages that row out on a stale heartbeat (review 2026-10-27)
    t["pane_live"] = ps == "live"
    if ps in ("dead", "gone", "shell") and t.get("status") == "active":
        t["status"] = "exited"   # its claude is gone; at most a corpse or a shell remains
    # A finishable row whose worktree is gone has nothing left to finish: reviewer
    # workers (verdict to the bead, worktree removed at the end) and workers whose
    # branch was merged elsewhere. The pane-died reaper flips them to finishable
    # anyway, and 81 such rows showed as Finish cards on 2026-10-28.
    if (t.get("status") in ("finishable", "exited") and not t["pane_live"]
            and not (t.get("worktree") and os.path.isdir(t["worktree"]))):
        t["status"] = "done"
    # what is left with no live pane is work waiting for finish.sh, not a terminal
    t["needs_finish"] = (t.get("kind") == "worker" and not t["pane_live"]
                         and t.get("status") in ("finishable", "exited"))
ops = []
opdir = os.environ["OPS"]
def mt(f):
    try: return os.path.getmtime(os.path.join(opdir, f))
    except Exception: return 0
for f in sorted(os.listdir(opdir), key=mt)[-20:]:
    if f.endswith(".tmp"): continue
    try: ops.append(json.load(open(os.path.join(opdir, f))))
    except Exception: pass
st["ops"] = ops
# Turn state per session id, written by ops/scripts/hook-turn-state.sh: working while
# a turn runs, idle once it ends. An ended turn is shown idle (the red "finished, safe to
# kill" card) only when liveness.py finds the claude process really has nothing left:
# Claude Code's own status idle and no child but its MCP servers. Otherwise it reads
# background (never finished): a background Bash, Monitor or Agent still runs, or the
# process could not be checked (hq-6ih29.1). Only live terminals are looked up, so
# stale files of long-gone sessions never reach the console.
turns = {}
raw_turns = {}
turndir = os.path.join(os.environ["STATE_DIR"], "turns")
for t in st.get("terminals", []):
    tid = str((t or {}).get("id") or "")
    if not tid or "/" in tid or tid.startswith("."):
        continue
    try:
        with open(os.path.join(turndir, tid + ".json")) as fh:
            rec = json.load(fh)
    except Exception:
        continue
    if isinstance(rec, dict) and rec.get("turn") in ("working", "idle", "background"):
        raw_turns[tid] = rec
ended = [k for k, r in raw_turns.items() if r.get("turn") != "working"]
try:
    sys.path.insert(0, os.environ["CTL_DIR"])
    import liveness
    live = liveness.liveness(ended)
    settle = liveness.settle
except Exception:
    live = {}
    def settle(rec, lv, now_iso):
        # liveness unavailable: an ended turn is unknown, never idle (never red)
        if rec.get("turn") == "working":
            return {"turn": "working", "at": str(rec.get("at") or "")}
        return {"turn": "background", "at": str(rec.get("at") or ""), "live": "liveness unavailable"}
now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
for tid, rec in raw_turns.items():
    v = settle(rec, live.get(tid), now_iso)
    if v:
        turns[tid] = v
st["turns"] = turns
print(json.dumps(st, indent=2))
PY
  ;;
""|help|-h|--help)
  sed -n '2,34p' "$SCRIPT_DIR/ctl.sh" | sed 's/^# \{0,1\}//'
  ;;
*)
  die "unknown subcommand: $cmd (try: ctl help)" 2
  ;;
esac
