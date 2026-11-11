#!/usr/bin/env bash
# Stop hook: block ending a turn that presents a CONTROLLED url (localhost, LAN,
# *.vercel.app, cloud-function/tunnel hosts) as live/ready/working when nothing
# in this turn actually fetched it. Extends HQ's verification culture (a claim
# needs a receipt) to the conversational "it's deployed" claim.
#
# HQ has no browser, so evidence = the url (or its host) was hit via curl / wget /
# WebFetch in the transcript window after the last real user prompt. Third-party
# urls (github.com, google.com, ...) are never gated.
#
# Respects stop_hook_active. Fail-open on any parse trouble. Exit 2 = block.
set -uo pipefail
HOOK_PAYLOAD="$(cat)" export HOOK_PAYLOAD

REASON="$(python3 - <<'PY'
import json, os, re, sys
try:
    d = json.loads(os.environ.get("HOOK_PAYLOAD", ""))
except Exception:
    sys.exit(0)
if d.get("stop_hook_active"):
    sys.exit(0)
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
        return not all(isinstance(it, dict) and it.get("type") == "tool_result" for it in c) and bool(c)
    return False

lines = []
try:
    with open(tpath) as f:
        for ln in f:
            ln = ln.strip()
            if not ln:
                continue
            try:
                lines.append(json.loads(ln))
            except Exception:
                pass
except Exception:
    sys.exit(0)

last_user = -1
for i, ev in enumerate(lines):
    if is_real_user(ev.get("message", {})):
        last_user = i
window = lines[last_user + 1:] if last_user >= 0 else lines

assistant_text, tool_blob = [], []
for ev in window:
    msg = ev.get("message", {})
    if not isinstance(msg, dict):
        continue
    role = msg.get("role")
    c = msg.get("content")
    if role == "assistant":
        if isinstance(c, str):
            assistant_text.append(c)
        elif isinstance(c, list):
            for it in c:
                if isinstance(it, dict):
                    if it.get("type") == "text":
                        assistant_text.append(it.get("text", ""))
                    elif it.get("type") == "tool_use":
                        tool_blob.append(json.dumps(it.get("input", {})))
    # tool_result content (curl/WebFetch output) also counts as fetch evidence
    if isinstance(c, list):
        for it in c:
            if isinstance(it, dict) and it.get("type") == "tool_result":
                tool_blob.append(json.dumps(it.get("content", "")))

text = "\n".join(assistant_text)
if not text.strip():
    sys.exit(0)
tool_text = "\n".join(tool_blob)
low = text.lower()

CONTROLLED = re.compile(
    r'https?://[^\s\)\]>`"\']*(?:localhost|127\.0\.0\.1|0\.0\.0\.0|'
    r'192\.168\.|10\.\d|172\.(?:1[6-9]|2\d|3[01])\.|'
    r'\.vercel\.app|\.cloudfunctions\.net|\.trycloudflare\.com|\.ngrok[^\s]*)'
    r'[^\s\)\]>`"\']*', re.I)
urls = CONTROLLED.findall(text)
# findall with groups returns the group; re-run with finditer for full match
urls = [m.group(0) for m in CONTROLLED.finditer(text)]
if not urls:
    sys.exit(0)

PRESENT = [
    r'is (now )?(live|working|ready|up|deployed|accessible)',
    r'(deployed|live|running|available|up) (at|on) http',
    r'(dashboard|app|site|page|server|preview|endpoint) (is )?(live|up|ready|at) ',
    r'you can (now )?(see|access|open|visit|view|browse)',
    r'(visit|open|go to|head to|navigate to)\b',
    r'it.?s (live|up|deployed|ready)',
]
if not any(re.search(p, low) for p in PRESENT):
    sys.exit(0)

def host(u):
    m = re.match(r'https?://([^/\s:]+)', u)
    return m.group(1) if m else u

unverified = []
for u in dict.fromkeys(urls):
    h = re.escape(host(u))
    fetched = re.search(r'(curl|wget|WebFetch|http\.get|fetch\()[^\n]*' + h, tool_text, re.I) \
        or re.search(h + r'[^\n]*(200 OK|HTTP/)', tool_text, re.I)
    if not fetched:
        unverified.append(u)

if not unverified:
    sys.exit(0)
print("\n".join("  - " + u for u in unverified))
sys.exit(2)
PY
)"
rc=$?
if [ "$rc" -eq 2 ]; then
  cat >&2 <<EOF
STOP: you are presenting controlled url(s) as live/ready but nothing in this turn
fetched them:
$REASON

Before finishing, actually hit each url (curl -sS -o /dev/null -w '%{http_code}' <url>,
or WebFetch) and confirm it responds, THEN present it. A deploy from a prior turn
does not count; you may have changed things since. If you cannot verify (no egress,
build still running), say so plainly instead of asserting it is live.
EOF
  exit 2
fi
exit 0
