#!/usr/bin/env bash
# PostToolUse hook (Bash): cap runaway tool output before it fills the worker's
# context. If a Bash result exceeds ~300 lines or ~8000 chars, keep the first 40
# and last 60 lines, replace the middle with a pointer, and write the full output
# to /tmp/hq-out/<ts>.log so a worker can grep it if genuinely needed.
# Emits a PostToolUse hookSpecificOutput that replaces the tool result.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="${CLAUDE_PROJECT_DIR:-$(cd "$DIR/../.." && pwd)}"
PAYLOAD="$(cat)"
export HQ PAYLOAD

python3 <<'PY'
import json, os, sys, time

hq = os.environ["HQ"]
try:
    d = json.loads(os.environ["PAYLOAD"])
except Exception:
    sys.exit(0)

if d.get("tool_name") != "Bash":
    sys.exit(0)

out = d.get("tool_output")
if not isinstance(out, dict):
    sys.exit(0)
text = out.get("stdout")
if not isinstance(text, str):
    sys.exit(0)

MAX_LINES, MAX_CHARS, HEAD, TAIL = 300, 8000, 40, 60
lines = text.splitlines()
if len(lines) <= MAX_LINES and len(text) <= MAX_CHARS:
    sys.exit(0)

outdir = "/tmp/hq-out"
os.makedirs(outdir, exist_ok=True)
# time.time() is available in the hook process (not a workflow script)
ts = time.strftime("%Y%m%d-%H%M%S")
path = os.path.join(outdir, f"{ts}.log")
try:
    with open(path, "w") as f:
        f.write(text)
except OSError:
    sys.exit(0)

dropped = len(lines) - HEAD - TAIL
kept = lines[:HEAD] + [f"[... {dropped} lines truncated, full output at {path} — grep it if needed ...]"] + lines[-TAIL:]
truncated = "\n".join(kept)

# log the firing for metrics
try:
    with open(os.path.join(hq, "ops", "metrics", "truncations.log"), "a") as f:
        f.write(f"{ts}\t{len(lines)} lines\t{len(text)} chars\t{path}\n")
except OSError:
    pass

print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "updatedToolOutput": {
            "exitCode": out.get("exitCode", 0),
            "stdout": truncated,
            "stderr": out.get("stderr", ""),
        },
    }
}))
PY
exit 0
