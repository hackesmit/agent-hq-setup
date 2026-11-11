#!/usr/bin/env bash
# Backfill state/artifacts.jsonl from the session archive (/srv/session-archive, hq-0yagv.1):
# every Artifact tool_use whose result carries a published artifact URL becomes a row
# {ts, url, title, session, rig, bead, cwd}. Rows already in the ledger win on a tie; for
# one url the newest ts wins. Idempotent. Usage: artifact-backfill.sh [archive-dir]
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ARCHIVE="${1:-/srv/session-archive/claude/projects}"
export DIR ARCHIVE
python3 - <<'PY'
import glob, json, os, re, subprocess
root = os.path.dirname(os.path.realpath(os.path.join(os.environ["DIR"], subprocess.run(
    ["git", "-C", os.environ["DIR"], "rev-parse", "--git-common-dir"], capture_output=True, text=True).stdout.strip())))
state = os.environ.get("HQ_STATE_DIR") or os.path.join(root, "state")
ledger = os.path.join(state, "artifacts.jsonl")
URL = re.compile(r"^https://claude\.ai/artifact/[A-Za-z0-9_-]+$")
rows = {}
def keep(r):
    cur = rows.get(r["url"])
    if cur is None or r["ts"] >= cur["ts"]:
        if cur and not r.get("title"): r["title"] = cur.get("title", "")
        rows[r["url"]] = r
if os.path.exists(ledger):
    for l in open(ledger):
        try: keep(json.loads(l))
        except Exception: pass
for f in glob.glob(os.environ["ARCHIVE"] + "/*/*.jsonl.zst"):
    p = subprocess.run(["zstd", "-dc", f], capture_output=True)
    uses = {}
    for l in p.stdout.decode("utf-8", "replace").splitlines():
        if "Artifact" not in l: continue
        try: d = json.loads(l)
        except Exception: continue
        c = (d.get("message") or {}).get("content")
        if not isinstance(c, list): continue
        for b in c:
            if b.get("type") == "tool_use" and b.get("name") == "Artifact":
                uses[b["id"]] = b.get("input") or {}
            elif b.get("type") == "tool_result" and b.get("tool_use_id") in uses:
                ti = uses[b["tool_use_id"]]
                r = d.get("toolUseResult")
                if isinstance(r, str):
                    try: r = json.loads(r)
                    except Exception: r = None
                if not isinstance(r, dict) or r.get("opened") or b.get("is_error"): continue
                if ti.get("action") in ("open", "quickstart", "list"): continue
                url = r.get("url") or ""
                if not URL.match(url): continue
                cwd = d.get("cwd") or ""
                m = re.search(r"/rigs/([^/]+)", cwd)
                rig = re.sub(r"-[0-9a-f]{4}$", "", m.group(1)) if m else "hq"
                keep({"ts": (d.get("timestamp") or "")[:19] + "Z", "url": url,
                      "title": str(r.get("title") or ti.get("title") or "")[:200],
                      "session": d.get("sessionId") or "", "rig": rig, "bead": "", "cwd": cwd})
os.makedirs(state, exist_ok=True)
out = sorted(rows.values(), key=lambda r: r["ts"])[-500:]
with open(ledger + ".tmp", "w") as fh:
    for r in out: fh.write(json.dumps(r) + "\n")
os.replace(ledger + ".tmp", ledger)
print(f"artifact-backfill: {len(out)} artifacts in {ledger}")
PY
