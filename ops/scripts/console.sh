#!/usr/bin/env bash
# console.sh — the HQ console: task phases, requests-to-the owner, change log, and the
# aggregated state the dashboard renders. Terminals AND the owner call this; it owns the JSON
# under state/console/ (gitignored, like the registry). One source of truth; the node
# server just serves HTML and shells to `state`/`resolve`/`phase` here.
#
# Subcommands:
#   phase set <bead> "p1,p2,p3" [--session S] [--title T]   define/replace a bead's phases
#   phase check|uncheck <bead> "<phase substr>"             toggle a phase (fuzzy match)
#   phase list <bead>                                        print a bead's phases
#   ask "<question>" [--bead B] [--session S] [--wait]      file a request-to-the owner via ctl.sh ask (+ping)
#   requests                                                 list open requests
#   resolve <req-id>                                         clear a request
#   log-change "<desc>" [--session S]                        append to the change log
#   state [--json]                                           aggregated dashboard state
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="${HQ_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
STATE_DIR="${HQ_STATE_DIR:-$HQ/state}"
WR="$STATE_DIR/console"; PH="$WR/phases"
REGSH="$SCRIPT_DIR/session-registry.sh"
mkdir -p "$PH"
[ -f "$WR/requests.json" ] || printf '[]\n' > "$WR/requests.json"
export HQ STATE_DIR WR PH REGSH
die(){ echo "console: $1" >&2; exit "${2:-1}"; }

cmd="${1:-}"; shift 2>/dev/null || true

case "$cmd" in
phase)
  sub="${1:-}"; bead="${2:-}"; shift 2 2>/dev/null || true
  [ -n "$sub" ] && [ -n "$bead" ] || die "usage: console phase set|check|uncheck|list <bead> ..." 2
  arg="${1:-}"; session=""; title=""
  # parse trailing flags
  a=("$@"); i=0
  while [ $i -lt ${#a[@]} ]; do
    case "${a[$i]}" in
      --session) session="${a[$((i+1))]:-}"; i=$((i+2));;
      --title) title="${a[$((i+1))]:-}"; i=$((i+2));;
      *) [ -z "$arg" ] && arg="${a[$i]}"; i=$((i+1));;
    esac
  done
  BEAD="$bead" SUB="$sub" ARG="$arg" SESSION="$session" TITLE="$title" python3 - <<'PY'
import json, os, time
PH=os.environ["PH"]; bead=os.environ["BEAD"]; sub=os.environ["SUB"]
arg=os.environ.get("ARG",""); sess=os.environ.get("SESSION",""); title=os.environ.get("TITLE","")
f=os.path.join(PH, bead+".json")
def load():
    try: return json.load(open(f))
    except Exception: return {"bead":bead,"title":bead,"session":"","phases":[]}
def save(d):
    d["updated"]=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    tmp=f+".tmp"; json.dump(d, open(tmp,"w"), indent=2); os.replace(tmp,f)
d=load()
if sess: d["session"]=sess
if title: d["title"]=title
if sub=="set":
    names=[p.strip() for p in arg.split(",") if p.strip()]
    d["phases"]=[{"name":n,"done":False} for n in names]
    save(d); print(f"{bead}: {len(names)} phases set")
elif sub in ("check","uncheck"):
    want=arg.lower(); hit=None
    for p in d["phases"]:
        if want in p["name"].lower(): hit=p; break
    if not hit: raise SystemExit(f"console: no phase matching '{arg}' in {bead}")
    hit["done"]= (sub=="check")
    save(d); print(f"{bead}: {hit['name']} -> {'done' if hit['done'] else 'open'}")
elif sub=="list":
    for p in d.get("phases",[]): print(f"  [{'x' if p['done'] else ' '}] {p['name']}")
else:
    raise SystemExit("console: phase set|check|uncheck|list")
PY
  ;;
ask)
  q="${1:-}"; shift 2>/dev/null || true; bead=""; session=""; pass=()
  while [ $# -gt 0 ]; do case "$1" in
    --bead) bead="${2:-}"; shift;; --session) session="${2:-}"; shift;;
    --wait|--urgent) pass+=("$1");;
    --chunk|--kind|--sev|--why|--link) pass+=("$1" "${2:-}"); shift;;
    esac; shift; done
  [ -n "$q" ] || die "usage: console ask \"<question>\" [--bead B] [--session S] [--wait] [--kind K] [--sev P0|P1|P2]" 2
  # Questions to the owner are in ASD-STE100 Simplified Technical English (CLAUDE.md).
  # The one rule a script can measure is sentence length: 25 words maximum.
  long="$(Q="$q" python3 -c '
import os, re
for s in re.split(r"(?<=[.?!:;])\s+|\n+", os.environ["Q"]):
    if len(s.split()) > 25:
        print(" ".join(s.split()[:12]) + " ..."); break
')"
  [ -z "$long" ] || die "ask refused: a sentence has more than 25 words (\"$long\"). Write the question again in ASD-STE100 Simplified Technical English: short sentences, active voice, present tense, one topic for each sentence, context first, then one question, then the options." 2
  # One request path (2026-10-20): the legacy entrypoint files through ctl.sh, so
  # the question is printed in the asking terminal, bound to its session (the
  # waiting mark and the answer box on that terminal's console card), and goes
  # through the same lock and answer/revival machinery. ctl rings the bell and,
  # with --notify-ping, sends the notify ping this command always sent, but only
  # when the request goes to the owner: a worker ask the orchestrator takes first
  # pings nobody (hq-4npjr.1). ctl pings after filing and before any --wait.
  CTL="$HQ/ops/console/ctl.sh"
  args=(ask "$q" --notify-ping); [ -n "$bead" ] && args+=(--bead "$bead"); [ -n "$session" ] && args+=(--session "$session")
  "$CTL" "${args[@]}" "${pass[@]}"; rc=$?
  exit "$rc"
  ;;
resolve)
  rid="${1:-}"; [ -n "$rid" ] || die "usage: console resolve <req-id>" 2
  RID="$rid" python3 - <<'PY'
import json, os
WR=os.environ["WR"]; f=os.path.join(WR,"requests.json"); rid=os.environ["RID"]
try: reqs=json.load(open(f))
except Exception: reqs=[]
n=0
for r in reqs:
    if r["id"]==rid and r["status"]=="open": r["status"]="resolved"; n+=1
tmp=f+".tmp"; json.dump(reqs, open(tmp,"w"), indent=2); os.replace(tmp,f)
print(f"resolved {n}")
PY
  ;;
requests)
  python3 - <<'PY'
import json, os
WR=os.environ["WR"]
try: reqs=json.load(open(os.path.join(WR,"requests.json")))
except Exception: reqs=[]
for r in reqs:
    if r["status"]=="open": print(f'  {r["id"]}  {("["+r["bead"]+"] ") if r["bead"] else ""}{r["question"]}')
PY
  ;;
log-change)
  desc="${1:-}"; shift 2>/dev/null || true; session=""
  while [ $# -gt 0 ]; do case "$1" in --session) session="${2:-}"; shift;; esac; shift; done
  [ -n "$desc" ] || die "usage: console log-change \"<desc>\" [--session S]" 2
  DESC="$desc" SESSION="$session" python3 - <<'PY'
import json, os, time
WR=os.environ["WR"]
rec={"ts":time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
     "session":os.environ.get("SESSION",""),"desc":os.environ["DESC"]}
open(os.path.join(WR,"changes.jsonl"),"a").write(json.dumps(rec)+"\n")
PY
  echo "logged"
  ;;
state)
  # usage-cache.json is written by the plan-usage timer (ops/services/plan-usage), which
  # runs as owner and reads the real /usage windows. The old ccusage estimate is retired.
  # aggregate: terminals (registry) + phases + open requests + recent changes + usage
  # The registry goes through a file, not env: past 128 KB one env string makes
  # exec fail with E2BIG, the state comes back empty and every card loses its name
  # (2026-11-04, sessions.json at 140 KB hid the orchestrator terminal).
  sessions_file="$(mktemp "${TMPDIR:-/tmp}/console-sessions.XXXXXX")" || die "mktemp failed" 3
  "$REGSH" list --json >"$sessions_file" 2>/dev/null || echo '[]' >"$sessions_file"
  SESSIONS_FILE="$sessions_file" python3 - <<'PY'
import json, os, glob
WR=os.environ["WR"]; PH=os.environ["PH"]; HQ=os.environ["HQ"]
try:
    with open(os.environ["SESSIONS_FILE"]) as fh: sessions=json.loads(fh.read() or "[]")
except Exception: sessions=[]
os.unlink(os.environ["SESSIONS_FILE"])
def rd(f, default):
    try: return json.load(open(f))
    except Exception: return default
phases={}
for pf in glob.glob(os.path.join(PH,"*.json")):
    d=rd(pf,None)
    if d: phases[d.get("bead")]=d
reqs=[r for r in rd(os.path.join(WR,"requests.json"),[]) if r.get("status")=="open"]
changes=[]
try:
    for line in open(os.path.join(WR,"changes.jsonl")):
        line=line.strip()
        if line: changes.append(json.loads(line))
except Exception: pass
changes=changes[-15:][::-1]
# usage: the cached current-5h-window summary (% of your peak block + reset time)
usage=rd(os.path.join(WR,"usage-cache.json"),{})
active=[s for s in sessions if s.get("status")=="active"]
out={"terminals":sessions,"active_count":len(active),"phases":phases,
     "requests":reqs,"changes":changes,"usage":usage}
print(json.dumps(out, indent=2))
PY
  ;;
""|help|-h|--help)
  sed -n '2,20p' "$SCRIPT_DIR/console.sh" | sed 's/^# \{0,1\}//'
  ;;
*)
  die "unknown subcommand: $cmd (try: console help)" 2
  ;;
esac
