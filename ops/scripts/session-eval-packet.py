#!/usr/bin/env python3
# Build the post-hoc session-eval packet from a Claude Code transcript.
# Usage: session-eval-packet.py <transcript_path> <hq_dir>
# Prints one JSON object to stdout:
#   {tool_count, mutation_count, hook_blocks, claim_gap, tier, rig, packet}
# Pure transcript analysis + a best-effort `git diff` for mutation sessions.
# Never raises: on any trouble it prints a minimal object and exits 0.
import json, os, re, subprocess, sys

def emit(obj):
    print(json.dumps(obj))
    sys.exit(0)

try:
    tpath = sys.argv[1]
    hq = sys.argv[2]
except Exception:
    emit({"tool_count": 0, "mutation_count": 0, "hook_blocks": 0,
          "claim_gap": False, "tier": "haiku", "rig": "", "packet": ""})

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
    emit({"tool_count": 0, "mutation_count": 0, "hook_blocks": 0,
          "claim_gap": False, "tier": "haiku", "rig": "", "packet": ""})

MUTATE_BASH = re.compile(
    r"(git\s+(push|commit|merge|rebase|reset|checkout|switch|revert)"
    r"|\brm\b|\bmv\b|\bcp\b|\btee\b|npm\s+publish|vercel\b|docker\s+(build|push)"
    r"|curl[^|]*-X\s*(POST|PUT|PATCH|DELETE)|\bpsql\b|supabase\b|>>?\s*\S)", re.I)
MCP_WRITE = re.compile(r"(create|update|delete|write|send|upload|move|copy|commit|"
                       r"publish|insert|remove|edit)", re.I)
VERIFY_BASH = re.compile(r"\b(pytest|vitest|jest|go\s+test|cargo\s+test|test|tsc|mypy|"
                         r"ruff|eslint|lint|bash\s+-n|jq|git\s+diff\s+--check|screenshot)\b", re.I)
DONE_WORDS = re.compile(r"\b(done|complete[d]?|fixed|passing|works|shipped|all set|"
                        r"ready to merge|good to go)\b", re.I)

user_msgs, decisions = [], []
mutations, failed = [], []
tool_count = hook_blocks = 0
last_verify_idx = -10**9
saw_receipt = False
last_assistant_text = ""
rig = ""
call_idx = 0

def is_real_user(msg):
    if not isinstance(msg, dict) or msg.get("role") != "user":
        return False
    c = msg.get("content")
    if isinstance(c, str):
        return bool(c.strip())
    if isinstance(c, list):
        return any(isinstance(it, dict) and it.get("type") == "text" for it in c)
    return False

for ev in lines:
    msg = ev.get("message", {})
    if not isinstance(msg, dict):
        continue
    role = msg.get("role")
    c = msg.get("content")
    if role == "user":
        if is_real_user(msg):
            if isinstance(c, str):
                user_msgs.append(c[:500])
            elif isinstance(c, list):
                for it in c:
                    if isinstance(it, dict) and it.get("type") == "text":
                        user_msgs.append(str(it.get("text", ""))[:500])
        # tool_result (error detection)
        if isinstance(c, list):
            for it in c:
                if isinstance(it, dict) and it.get("type") == "tool_result":
                    txt = it.get("content")
                    if isinstance(txt, list):
                        txt = " ".join(str(x.get("text", "")) if isinstance(x, dict) else str(x) for x in txt)
                    txt = str(txt)
                    if it.get("is_error") or re.search(r"\berror\b|failed|exit code [1-9]", txt, re.I):
                        failed.append(txt[:160])
                    if re.search(r"blocked|permission denied|exit code 2|not permitted", txt, re.I):
                        hook_blocks += 1
                    if "Verification:" in txt:
                        saw_receipt = True
    elif role == "assistant":
        items = c if isinstance(c, list) else ([{"type": "text", "text": c}] if isinstance(c, str) else [])
        for it in items:
            if not isinstance(it, dict):
                continue
            if it.get("type") == "text":
                t = str(it.get("text", ""))
                last_assistant_text = t or last_assistant_text
                if t.strip():
                    decisions.append(t[:300])
                if "Verification:" in t:
                    saw_receipt = True
            elif it.get("type") == "tool_use":
                tool_count += 1
                call_idx += 1
                name = it.get("name", "")
                inp = it.get("input") or {}
                p = str(inp.get("file_path") or inp.get("path") or "")
                m = re.search(r"rigs/([A-Za-z0-9._-]+)/", p)
                if m and not rig:
                    rig = m.group(1)
                if name in ("Edit", "Write", "MultiEdit"):
                    mutations.append(f"{name} {p}")
                elif name == "Bash":
                    cmd = str(inp.get("command", ""))
                    if VERIFY_BASH.search(cmd):
                        last_verify_idx = call_idx
                    if MUTATE_BASH.search(cmd):
                        mutations.append(f"Bash {cmd[:120]}")
                    mm = re.search(r"rigs/([A-Za-z0-9._-]+)/", cmd)
                    if mm and not rig:
                        rig = mm.group(1)
                elif name.startswith("mcp__"):
                    if MCP_WRITE.search(name):
                        mutations.append(f"{name}")

claim_gap = bool(DONE_WORDS.search(last_assistant_text)) and \
            (not saw_receipt and (call_idx - last_verify_idx) > 10)

mutation_count = len(mutations)
tier = "sonnet" if (mutation_count > 15 or hook_blocks > 3 or claim_gap) else "haiku"

diff = ""
if mutation_count > 0 and rig:
    rigpath = os.path.join(hq, "rigs", rig)
    if os.path.isdir(os.path.join(rigpath, ".git")) or os.path.exists(os.path.join(rigpath, ".git")):
        try:
            r = subprocess.run(["git", "-C", rigpath, "diff", "HEAD"],
                               capture_output=True, text=True, timeout=20)
            diff = "\n".join(r.stdout.splitlines()[:200])
        except Exception:
            diff = ""

def block(title, items, n=12):
    if not items:
        return f"{title}: (none)\n"
    return f"{title}:\n" + "".join(f"  - {re.sub(chr(10),' ',x)[:200]}\n" for x in items[:n])

packet = (
    "=== SESSION EVAL PACKET ===\n"
    f"rig: {rig or '(unknown)'}   tools: {tool_count}   mutations: {mutation_count}   "
    f"hook-blocks: {hook_blocks}   claim-vs-evidence gap: {claim_gap}\n\n"
    + block("USER REQUESTS", user_msgs)
    + "\n" + block("MUTATIONS", mutations)
    + "\n" + block("FAILED TOOL CALLS", failed)
    + "\n" + block("KEY DECISIONS (assistant)", decisions[-8:], 8)
    + ("\n=== git diff HEAD (first 200 lines) ===\n" + diff + "\n" if diff else "")
)

emit({"tool_count": tool_count, "mutation_count": mutation_count,
      "hook_blocks": hook_blocks, "claim_gap": claim_gap, "tier": tier,
      "rig": rig, "packet": packet})
