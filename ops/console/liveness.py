"""Is a Claude Code session really done, or does it still have work outstanding?

hq-6ih29.1 (the owner, 2026-11-03: use a process signal). The turn hook
(ops/scripts/hook-turn-state.sh) says when a turn ends, but a turn can end while work
it started is still running: a run_in_background Bash, a Monitor script, a background
Agent. Counting those from hook events went wrong twice in review (a prompt the owner
sends mid-build, an Agent call with no run_in_background flag), so the console asks
the process instead. Two signals, both read from the box, either one is enough to say
"busy":

1. Claude Code's own presence file, ~/.claude/sessions/<pid>.json. Claude Code writes
   its status there: "busy" while a turn runs OR while any background agent, remote
   agent, teammate or workflow is active; "shell" when the turn is idle but a
   background Bash task still runs; "waiting" when a dialog is open; "idle" otherwise.
   Background subagents run in-process, so this is the one place they show.
2. The claude process's children under /proc. A Bash or Monitor tool call is a child
   shell (it sources ~/.claude/shell-snapshots/, which marks it as work whenever it
   started); MCP stdio servers are children too, but they start with the process
   (within MCP_WINDOW_S of it), so any other child started later is work. This also covers a status
   file that lags or a Claude Code version that does not track a task.

The session id is the one the launcher exported (CDP_TERMINAL_ID, then n, then
HQ_CONSOLE_SID: the same order hook-turn-state.sh uses), read from the process
environment. A process with HQ_SESSION_EVAL=1 is the session evaluator, not the pane.

Anything that cannot be read makes the answer unknown (None), never idle: the console
paints idle as red "finished, safe to kill", so unknown must not be red.
"""
import json
import os

MCP_WINDOW_S = 20
ID_VARS = ("CDP_TERMINAL_ID", "n", "HQ_CONSOLE_SID")


def _stat(proc_root, pid):
    """(state, ppid, starttime) from /proc/<pid>/stat, or None."""
    try:
        with open(os.path.join(proc_root, str(pid), "stat")) as fh:
            raw = fh.read()
    except OSError:
        return None
    # comm is in parentheses and may itself hold spaces or parentheses
    rest = raw.rsplit(")", 1)[-1].split()
    try:
        return rest[0], int(rest[1]), int(rest[19])
    except (IndexError, ValueError):
        return None


def _environ(proc_root, pid):
    try:
        with open(os.path.join(proc_root, str(pid), "environ"), "rb") as fh:
            raw = fh.read()
    except OSError:
        return None
    env = {}
    for item in raw.split(b"\0"):
        k, sep, v = item.partition(b"=")
        if sep:
            env[k.decode("utf-8", "replace")] = v.decode("utf-8", "replace")
    return env


def _cmd(proc_root, pid):
    try:
        with open(os.path.join(proc_root, str(pid), "cmdline"), "rb") as fh:
            return fh.read().replace(b"\0", b" ").decode("utf-8", "replace").strip()[:80]
    except OSError:
        return ""


def _is_tool_shell(proc_root, pid):
    """A Bash or Monitor tool process: Claude Code starts each one by sourcing its shell
    snapshot. A session launched with a prompt can start one within seconds, inside the
    MCP window, so this signature overrides the start-time rule."""
    try:
        with open(os.path.join(proc_root, str(pid), "cmdline"), "rb") as fh:
            return b"/shell-snapshots/" in fh.read(4096)
    except OSError:
        return False


def session_id_of(env):
    if not env or env.get("HQ_SESSION_EVAL") == "1":
        return None
    for k in ID_VARS:
        if env.get(k):
            return env[k]
    return None


def claude_processes(sessions_dir, proc_root):
    """{session id: {"pid", "start", "status"}} for each live claude with a presence file."""
    out = {}
    try:
        names = os.listdir(sessions_dir)
    except OSError:
        return out
    for name in names:
        if not name.endswith(".json") or not name[:-5].isdigit():
            continue
        pid = int(name[:-5])
        try:
            with open(os.path.join(sessions_dir, name)) as fh:
                rec = json.load(fh)
        except (OSError, ValueError):
            continue
        if not isinstance(rec, dict):
            continue
        st = _stat(proc_root, pid)
        if st is None or st[0] == "Z":
            continue
        # tmux and the kernel reuse pids: the file must belong to THIS process
        ps = str(rec.get("procStart") or "")
        if ps and ps != str(st[2]):
            continue
        sid = session_id_of(_environ(proc_root, pid))
        if not sid:
            continue
        cur = out.get(sid)
        # a claude started from inside another session's Bash inherits its id; the
        # oldest process is the pane's own (and the newer one is its child: busy anyway)
        if cur is None or st[2] < cur["start"]:
            out[sid] = {"pid": pid, "start": st[2], "status": str(rec.get("status") or "")}
    return out


def _children(proc_root):
    """{ppid: [(pid, state, starttime), ...]} for every process."""
    kids = {}
    try:
        names = os.listdir(proc_root)
    except OSError:
        return None
    for name in names:
        if not name.isdigit():
            continue
        st = _stat(proc_root, int(name))
        if st is None:
            continue
        kids.setdefault(st[1], []).append((int(name), st[0], st[2]))
    return kids


def liveness(ids, sessions_dir=None, proc_root="/proc", clk_tck=None, mcp_window_s=MCP_WINDOW_S):
    """{id: {"live": "idle"|"busy"|None, "why": str}} for each wanted session id.

    idle: Claude Code says idle and the process has no child but its MCP servers.
    busy: Claude Code says busy/shell/waiting, or a later-started child runs.
    None: no live claude process found for the id (unknown, never red).
    """
    ids = [i for i in ids if i]
    if not ids:
        return {}
    if sessions_dir is None:
        sessions_dir = os.path.join(os.path.expanduser("~"), ".claude", "sessions")
    if clk_tck is None:
        try:
            clk_tck = os.sysconf("SC_CLK_TCK")
        except (ValueError, OSError):
            clk_tck = 100
    procs = claude_processes(sessions_dir, proc_root)
    kids = None
    out = {}
    for sid in ids:
        p = procs.get(sid)
        if p is None:
            out[sid] = {"live": None, "why": "no claude process"}
            continue
        if p["status"] != "idle":
            out[sid] = {"live": "busy" if p["status"] else None,
                        "why": "status " + (p["status"] or "missing")}
            continue
        if kids is None:
            kids = _children(proc_root)
        if kids is None:
            out[sid] = {"live": None, "why": "proc unreadable"}
            continue
        work = [c for c in kids.get(p["pid"], [])
                if c[1] != "Z" and (c[2] - p["start"] > mcp_window_s * clk_tck
                                    or _is_tool_shell(proc_root, c[0]))]
        if work:
            c = work[0]
            out[sid] = {"live": "busy", "why": "child %d %s" % (c[0], _cmd(proc_root, c[0]))}
        else:
            out[sid] = {"live": "idle", "why": "status idle, no work child"}
    return out


def settle(rec, live, now_iso):
    """The turn the console shows, from the hook's record and liveness().

    working stays working (the hook is the fast signal for a new prompt or tool call).
    An ended turn (idle; or background from an older hook) is idle only when liveness
    says idle; busy reads background stamped now (it is live, not stale); unknown reads
    background with the hook's own time, so it greys out after 30 minutes, never red.
    """
    turn = rec.get("turn")
    at = str(rec.get("at") or "")
    if turn == "working":
        return {"turn": "working", "at": at}
    if turn not in ("idle", "background"):
        return None
    lv = (live or {}).get("live")
    why = (live or {}).get("why") or "not checked"
    if lv == "idle":
        return {"turn": "idle", "at": at, "live": why}
    return {"turn": "background", "at": now_iso if lv == "busy" else at, "live": why}


if __name__ == "__main__":
    import sys
    print(json.dumps(liveness(sys.argv[1:]), indent=2))
