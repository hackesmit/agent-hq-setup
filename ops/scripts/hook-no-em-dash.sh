#!/usr/bin/env bash
# PreToolUse hook: block em dashes and AI-decoration characters in content that
# gets written to files or committed. the owner's outputs (vault notes, bead
# summaries, commit messages, rig docs) should read as clean human prose, not
# machine-decorated text.
#
# Scope:
#   - Write / Edit / MultiEdit  -> the content being written (Write.content,
#     Edit.new_string, MultiEdit.edits[].new_string).
#   - Bash                       -> only `git commit` message text (the -m value
#     or a commit heredoc). CLI flags legitimately use `--` and are never checked.
# Conversational replies in the terminal are NOT gated (this is a write-time
# guard, not a style police on chat).
#
# Blocks: em dash (U+2014), non-breaking hyphen (U+2011), arrows (U+2190-2199),
# check/cross marks (U+2713/2717/2705/274C), box-drawing (U+2500-257F), bullet
# (U+2022). Everything else passes. Fail-open on any parse trouble.
set -uo pipefail
HOOK_PAYLOAD="$(cat)" export HOOK_PAYLOAD

REASON="$(python3 - <<'PY'
import json, os, re, sys
try:
    d = json.loads(os.environ.get("HOOK_PAYLOAD", ""))
except Exception:
    sys.exit(0)

tool = d.get("tool_name", "")
ti = d.get("tool_input") or {}

# Collect the text spans this call would persist.
spans = []
if tool == "Write":
    spans.append(ti.get("content", "") or "")
elif tool == "Edit":
    spans.append(ti.get("new_string", "") or "")
elif tool == "MultiEdit":
    for e in (ti.get("edits") or []):
        if isinstance(e, dict):
            spans.append(e.get("new_string", "") or "")
elif tool == "Bash":
    cmd = ti.get("command", "") or ""
    if not re.search(r'(^|[;&|]\s*|\s)git\s+commit(\s|$)', cmd):
        sys.exit(0)  # only commit messages are prose; skip other bash
    # -m "msg" / -m 'msg'
    for m in re.finditer(r'-m\s+(["\'])(.*?)\1', cmd, re.S):
        spans.append(m.group(2))
    # heredoc body: git commit -F- <<'EOF' ... EOF  (or -m "$(cat <<EOF ...)")
    for m in re.finditer(r'<<-?\s*["\']?(\w+)["\']?\n(.*?)\n\1', cmd, re.S):
        spans.append(m.group(2))
else:
    sys.exit(0)

BANNED = {
    "—": "em dash",
    "‑": "non-breaking hyphen",
    "–": "en dash (in prose; use a hyphen or 'to')",
    "→": "arrow", "←": "arrow", "↑": "arrow", "↓": "arrow",
    "✓": "checkmark", "✔": "checkmark", "✅": "check emoji",
    "✗": "cross", "✘": "cross", "❌": "cross emoji",
    "•": "bullet (use '-')",
}
def is_banned(ch):
    if ch in BANNED:
        return BANNED[ch]
    if "─" <= ch <= "╿":
        return "box-drawing"
    return None

hits = {}
for s in spans:
    for ch in s:
        lbl = is_banned(ch)
        if lbl:
            hits[ch] = lbl
if not hits:
    sys.exit(0)

names = sorted(set(hits.values()))
print("; ".join(names))
sys.exit(2)
PY
)"
rc=$?
if [ "$rc" -eq 2 ]; then
  cat >&2 <<EOF
BLOCKED: this write contains characters the owner does not want persisted: $REASON.

Fix before retrying:
  - em / en dash        -> colon, comma, parentheses, or restructure the sentence
  - arrows              -> "to", "->", or plain words
  - check / cross marks -> words ("done", "passing", "blocked")
  - box-drawing         -> plain markdown headers / lists
  - bullet (U+2022)     -> markdown "-"
Hyphens in compound words (post-job, 30-day) and CLI flags (--flag) are fine.
EOF
  exit 2
fi
exit 0
