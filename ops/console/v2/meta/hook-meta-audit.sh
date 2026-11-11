#!/usr/bin/env bash
# PostToolUse hook (matcher "*"): the meta terminal's audit trail.
#
# Console v2, spec section 3b: the meta terminal is the owner's one uncaged session.
# Its PTY stream is deliberately never written to disk (a terminal stream contains
# echoed keystrokes, so a pasted token would land in the file). The audit trail is
# therefore this hook's tool-call lines and nothing else: WHAT tool ran and WHAT it
# was pointed at, never the arguments, never the output, never the input.
#
# Contract:
#   - log only, never blocks, always exits 0, fail-open on every error
#   - one JSON object per line appended to $HQ_META_AUDIT
#     (default /var/lib/hqconsole/meta/audit.jsonl)
#   - fields: ts, session_id, tool, target
#   - target: file_path for Write/Edit/MultiEdit/NotebookEdit, the first 120
#     characters of the command for Bash, url for WebFetch, empty otherwise
#
# This is a trail, not a tamper-proof log: the meta session runs as the same Unix
# user, so it can delete the file mid-run. What it cannot do is unsee what the
# runner already forwarded, and the close-time canaries plus the cage-integrity
# diff are the real control (spec section 3b).
set -uo pipefail
export HQ_META_AUDIT="${HQ_META_AUDIT:-/var/lib/hqconsole/meta/audit.jsonl}"

# the payload goes to python on STDIN: an environment variable over 128 KB makes
# execve fail with E2BIG and the record of exactly the big Write you want audited
# would be lost silently
python3 -c '
import json, os, sys, time

def main():
    try:
        d = json.loads(sys.stdin.read())
    except Exception:
        return
    if not isinstance(d, dict):
        return
    tool = d.get("tool_name") or ""
    ti = d.get("tool_input")
    if not isinstance(ti, dict):
        ti = {}

    target = ""
    if tool in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
        target = ti.get("file_path") or ti.get("notebook_path") or ""
    elif tool == "Bash":
        target = ti.get("command") or ""
        target = target[:120]
    elif tool == "WebFetch":
        target = ti.get("url") or ""
    if not isinstance(target, str):
        target = str(target)

    rec = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "session_id": str(d.get("session_id") or ""),
        "tool": str(tool),
        "target": target,
    }
    line = json.dumps(rec, ensure_ascii=False) + "\n"

    path = os.environ["HQ_META_AUDIT"]
    try:
        parent = os.path.dirname(path)
        if parent and not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)
        # O_APPEND with a single write() keeps concurrent sessions from
        # interleaving a partial line; no lock file is needed for one short line.
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o640)
        try:
            os.write(fd, line.encode("utf-8"))
        finally:
            os.close(fd)
    except Exception:
        return

try:
    main()
except Exception:
    pass
sys.exit(0)
'

exit 0
