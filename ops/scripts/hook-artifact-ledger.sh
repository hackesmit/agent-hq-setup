#!/usr/bin/env bash
# PostToolUse hook for the Artifact tool: append every published or updated artifact to
# state/artifacts.jsonl ({ts, url, title, session, rig, bead, cwd}) so the console can list
# recent artifacts with the project that built them (bead hq-7llgp.9).
#   - Records only a result that carries an artifact URL; open, quickstart and list calls
#     return none (or opened=true) and are skipped.
#   - Dedupe by url, newest wins: the file is rewritten without older rows of that url.
#   - State lives in the CANONICAL hq tree (git common dir), because a worktree session has
#     its own near-empty state/ and the console reads the main one.
#   - Never blocks a tool call: exit 0 always, errors go to state/artifacts.err.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_PAYLOAD="$(cat)" DIR="$DIR" export HOOK_PAYLOAD DIR
python3 - <<'PY' 2>/dev/null || true
import json, os, re, subprocess, sys, time, traceback

state = os.environ.get("HQ_STATE_DIR")
if not state:
    root = ""
    try:
        r = subprocess.run(["git", "-C", os.environ["DIR"], "rev-parse", "--git-common-dir"],
                           capture_output=True, text=True, timeout=5)
        g = r.stdout.strip()
        if r.returncode == 0 and g:
            root = os.path.dirname(os.path.realpath(os.path.join(os.environ["DIR"], g)))
    except Exception:
        pass
    state = os.path.join(root or os.path.realpath(os.path.join(os.environ["DIR"], "..", "..")), "state")
LEDGER = os.path.join(state, "artifacts.jsonl")
URL_RE = re.compile(r"https://claude\.ai/artifact/[A-Za-z0-9_-]+")

def main():
    d = json.loads(os.environ.get("HOOK_PAYLOAD", ""))
    if d.get("tool_name") != "Artifact":
        return
    ti = d.get("tool_input") or {}
    if str(ti.get("action") or "") in ("open", "quickstart", "list"):
        return
    resp = d.get("tool_response")
    if isinstance(resp, str):
        try:
            parsed = json.loads(resp)
            resp = parsed if isinstance(parsed, dict) else {"text": resp}
        except Exception:
            resp = {"text": resp}
    if not isinstance(resp, dict):
        resp = {}
    if resp.get("opened") or resp.get("error") or resp.get("is_error"):
        return
    url = resp.get("url") if isinstance(resp.get("url"), str) else ""
    if not URL_RE.fullmatch(url or ""):
        # a result string such as "Published <file> at https://claude.ai/artifact/X"
        txt = json.dumps(resp.get("text") or resp.get("content") or "")
        m = re.search(r"(?:Created a new Artifact|Updated the Artifact|Published)[^\"]*?(https://claude\.ai/artifact/[A-Za-z0-9_-]+)", txt)
        url = m.group(1) if m else ""
    if not url:
        return
    title = resp.get("title") or ti.get("title") or ""

    cwd = d.get("cwd") or os.getcwd()
    sess = os.environ.get("CDP_TERMINAL_ID") or ""
    reg = {}
    try:
        reg = json.load(open(os.path.join(state, "sessions.json")))
    except Exception:
        pass
    rec = reg.get(sess) if sess else None
    if rec is None:
        for r in reg.values():
            wt = (r or {}).get("worktree") or ""
            if wt and (cwd == wt or cwd.startswith(wt + os.sep)):
                rec = r; sess = r.get("id") or sess; break
    rec = rec or {}
    rig = rec.get("rig") or ""
    if not rig:
        m = re.search(r"/rigs/([^/]+)", cwd)
        if m:
            rig = re.sub(r"-[0-9a-f]{4}$", "", m.group(1))
        else:
            rig = "hq"
    row = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "url": url,
           "title": str(title)[:200], "session": sess or str(d.get("session_id") or ""),
           "rig": rig, "bead": rec.get("bead") or "", "cwd": cwd}
    os.makedirs(state, exist_ok=True)
    rows = []
    if os.path.exists(LEDGER):
        for line in open(LEDGER):
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("url") == url:
                row["title"] = row["title"] or o.get("title", "")
                continue
            rows.append(o)
    rows.append(row)
    tmp = LEDGER + ".tmp"
    with open(tmp, "w") as f:
        for o in rows[-500:]:
            f.write(json.dumps(o) + "\n")
    os.replace(tmp, LEDGER)

try:
    main()
except Exception:
    try:
        with open(os.path.join(state, "artifacts.err"), "a") as f:
            f.write(time.strftime("%FT%TZ", time.gmtime()) + " " + traceback.format_exc() + "\n")
    except Exception:
        pass
PY
exit 0
