#!/usr/bin/env bash
# Stop hook: memory-promise enforcement (invariant 8).
# A behavior rule is not captured until enforcement exists. After the last real user
# prompt of the session, if the agent wrote a rule-shaped memory (bd remember / vault
# inbox note / memory file with >=2 imperative markers) OR made a first-person promise
# ("won't happen again", "going forward I'll..."), but shipped NO enforcing artifact
# (a hook edit, a CLAUDE.md proposal, a DoD change, or a bead naming the mechanism),
# file a P1 "unenforced correction" bead so the promise becomes real work.
# Turn-scoped + deduped so one legitimate write doesn't re-trigger every later turn.
# Respects stop_hook_active; fail-open on any parse trouble.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="${CLAUDE_PROJECT_DIR:-$(cd "$DIR/../.." && pwd)}"
# A session in an hq worktree records to the main checkout, which outlives the worktree.
_hq_main="$(git -C "$HQ" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
case "$_hq_main" in */.git) [ -d "${_hq_main%/.git}/ops/scripts" ] && HQ="${_hq_main%/.git}" ;; esac
export PATH="$HOME/.local/bin:$PATH"
HOOK_PAYLOAD="$(cat)" export HOOK_PAYLOAD HQ

python3 - <<'PY'
import json, os, re, subprocess, sys, hashlib

hq = os.environ["HQ"]
try:
    d = json.loads(os.environ.get("HOOK_PAYLOAD", ""))
except Exception:
    sys.exit(0)

if d.get("stop_hook_active"):     # never re-trigger our own continuation
    sys.exit(0)
sid = str(d.get("session_id") or "unknown")
tpath = d.get("transcript_path") or ""
if not tpath or not os.path.exists(tpath):
    sys.exit(0)

def is_real_user(msg):
    if not isinstance(msg, dict) or msg.get("role") != "user":
        return False
    c = msg.get("content")
    if isinstance(c, str):
        return bool(c.strip())
    if isinstance(c, list):
        return any(isinstance(it, dict) and it.get("type") == "text" for it in c) or \
               all(not (isinstance(it, dict) and it.get("type") == "tool_result") for it in c) and bool(c)
    return False

lines = []
try:
    with open(tpath) as f:
        for ln in f:
            ln = ln.strip()
            if ln:
                try:
                    lines.append(json.loads(ln))
                except Exception:
                    pass
except Exception:
    sys.exit(0)

# window = entries after the last real user prompt
last_user = -1
for i, ev in enumerate(lines):
    if is_real_user(ev.get("message", {})):
        last_user = i
window = lines[last_user + 1:] if last_user >= 0 else lines

assistant_text = []
tool_calls = []   # (name, input_dict)
for ev in window:
    msg = ev.get("message", {})
    if not isinstance(msg, dict) or msg.get("role") != "assistant":
        continue
    c = msg.get("content")
    if isinstance(c, str):
        assistant_text.append(c)
    elif isinstance(c, list):
        for it in c:
            if not isinstance(it, dict):
                continue
            if it.get("type") == "text":
                assistant_text.append(str(it.get("text", "")))
            elif it.get("type") == "tool_use":
                tool_calls.append((it.get("name", ""), it.get("input") or {}))

# strip code blocks + inline code so quoted examples don't match
prose = "\n".join(assistant_text)
prose = re.sub(r"```.*?```", " ", prose, flags=re.S)
prose = re.sub(r"`[^`]*`", " ", prose)

IMPERATIVE = re.compile(r"\b(never|always|must|do not|don't|going forward|from now on|"
                        r"standing rule|no fallback)\b", re.I)
PROMISE = re.compile(r"\b(won't happen again|will not happen again|i'?ll remember|"
                     r"i will remember|won'?t repeat|i'?ll make sure|going forward i)\b", re.I)

def rule_shaped(text):
    return len(set(m.group(1).lower() for m in IMPERATIVE.finditer(text or ""))) >= 2

def path_of(inp):
    return str(inp.get("file_path") or inp.get("path") or "")

MEM_PATH = re.compile(r"(memory/|feedback_|00 Inbox/|/instincts|MEMORY\.md)", re.I)
ENFORCE_PATH = re.compile(r"(ops/scripts/|ops/githooks/|CLAUDE\.md|settings\.json|"
                          r"\.claude/hooks|Definition of Done|DoD)", re.I)
MECH_WORDS = re.compile(r"\b(hook|guard|enforce|DoD|Definition of Done|CLAUDE\.md|gate)\b", re.I)
# A memory typed user/project/reference records a fact, not a rule (2026-W44 retro:
# hq-ffi0t flagged a project memory about Person A's job). Only feedback memories count.
FACT_MEMORY = re.compile(r"^\s*type:\s*(user|project|reference)\b", re.I | re.M)

rule_write = False
enforcing = False
matched = ""
for name, inp in tool_calls:
    p = path_of(inp)
    content = str(inp.get("content") or inp.get("new_string") or "")
    cmd = str(inp.get("command") or "")
    if name in ("Write", "Edit", "MultiEdit"):
        if MEM_PATH.search(p) and rule_shaped(content) and not FACT_MEMORY.search(content):
            rule_write = True; matched = matched or content[:200]
        if ENFORCE_PATH.search(p):
            enforcing = True
    if name == "Bash":
        if re.search(r"\bbd\s+remember\b", cmd) and rule_shaped(cmd):
            rule_write = True; matched = matched or cmd[:200]
        if re.search(r"\bbd\s+create\b", cmd) and MECH_WORDS.search(cmd):
            enforcing = True

promise = bool(PROMISE.search(prose))
if promise and not matched:
    m = PROMISE.search(prose)
    matched = prose[max(0, m.start()-40):m.end()+80].strip()

if not (rule_write or promise) or enforcing:
    sys.exit(0)

# dedup so long sessions file once per distinct promise
key = hashlib.sha1((sid + "|" + re.sub(r"\s+", " ", matched)[:200]).encode()).hexdigest()[:16]
seen = os.path.join(hq, "state", "eval", "promise-seen")
try:
    os.makedirs(os.path.dirname(seen), exist_ok=True)
    prior = set(open(seen).read().split()) if os.path.exists(seen) else set()
except Exception:
    prior = set()
if key in prior:
    sys.exit(0)

kind = "rule-write" if rule_write else "promise"
desc = (f"What: an {kind} was made with no enforcing mechanism shipped alongside it.\n"
        f"Why: invariant 8 — a correction is not captured until enforcement exists "
        f"(a hook, a CLAUDE.md diff, a DoD change). A note is not the fix.\n"
        f"Detected: {matched[:300]}\n"
        f"Session: {sid}\n"
        f"Resolve at retro: build the mechanism (keep) or drop the rule as noise.")
try:
    subprocess.run(["bd", "create", f"Unenforced correction ({kind})", "-t", "task",
                    "-p", "1", "-l", "P1,unenforced-correction", "-d", desc],
                   cwd=hq, capture_output=True, timeout=30)
    with open(seen, "a") as f:
        f.write(key + "\n")
    subprocess.run([os.path.join(hq, "ops", "scripts", "notify.sh"), "low",
                    "Unenforced correction", matched[:120]], capture_output=True, timeout=15)
except Exception:
    pass
sys.exit(0)
PY
exit 0
