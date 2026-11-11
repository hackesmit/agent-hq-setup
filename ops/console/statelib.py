# statelib.py: the console's locked state machine. Every read-modify-write of
# console state goes through here under ONE global flock (state/console/.lock),
# which is what makes request transitions compare-and-swap and keeps concurrent
# writers from losing updates. Spec: docs/superpowers/specs/
# 2026-08-11-console-control-center-design.md
import calendar
import fcntl
import json
import os
import secrets
import re
import time

WR = os.environ["WR"]

# Request lifecycle. Terminal states have no exits.
TRANSITIONS = {
    "open": {"answered", "resolved", "cancelled"},
    "answered": {"revival_claimed", "delivered", "cancelled"},
    "revival_claimed": {"delivered", "answered"},
    "delivered": set(),
    "resolved": set(),
    "cancelled": set(),
}


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def parse_ts(s):
    """ISO Z timestamp to epoch seconds, or None when unparseable."""
    try:
        return calendar.timegm(time.strptime(s, "%Y-%m-%dT%H:%M:%SZ"))
    except Exception:
        return None


HEX4_SUFFIX = re.compile(r"-[0-9a-f]{4}$")
BRANCH_RE = re.compile(r"^(.*?)-[0-9a-f]{4}-(.+)$")


def derive(t):
    """Best-effort (rig, task) for a session card. spawn.sh names worktrees
    rigs/<rig>-<hex4> and branches <rig>-<hex4>-<slug>, so both stay parseable
    when the registry row itself carries an empty rig (interactive terminals
    register with no rig/bead/branch at all, which is why cards read '?')."""
    rig = (t.get("rig") or "").strip()
    wt = (t.get("worktree") or "").rstrip("/")
    if not rig and wt:
        if os.path.basename(os.path.dirname(wt)) == "rigs":
            base = os.path.basename(wt)
            rig = HEX4_SUFFIX.sub("", base) or base
    task = ""
    branch = (t.get("branch") or "").strip()
    if branch:
        if rig:
            # the rig is known, so only its exact prefix may be stripped: the
            # loose pattern would read rig 'foo' out of a real rig named
            # foo-dead-bar, since 'dead' is itself four hex characters. A branch
            # that does not match the spawn.sh shape is shown whole rather than
            # guessed at.
            exact = re.match(re.escape(rig) + r"-[0-9a-f]{4}-(.+)$", branch)
            task = exact.group(1) if exact else branch
        else:
            m = BRANCH_RE.match(branch)
            task = m.group(2) if m else branch
            if m:
                rig = m.group(1)
        task = task.replace("-", " ").strip()
    return rig, task


class locked:
    """Global console lock. Hold for the whole read-modify-write transaction."""

    def __enter__(self):
        self.fh = open(os.path.join(WR, ".lock"), "w")
        fcntl.flock(self.fh, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.fh, fcntl.LOCK_UN)
        self.fh.close()
        return False


def load(name, default):
    try:
        with open(os.path.join(WR, name)) as fh:
            return json.load(fh)
    except Exception:
        return default


def save(name, data):
    path = os.path.join(WR, name)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=2)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def append_jsonl(name, record):
    with locked():
        with open(os.path.join(WR, name), "a") as fh:
            fh.write(json.dumps(record) + "\n")


def sessions(strict=False):
    """The session registry as a dict. A missing sessions.json is a fresh box: {}.
    A file that exists but cannot be read, does not parse, or is not a JSON object
    is {} for display callers, and raises under strict=True: bead_hold must not
    read a corrupt registry as "nobody holds anything" (hq-4npjr.22)."""
    path = os.path.join(os.path.dirname(WR), "sessions.json")
    try:
        with open(path) as fh:
            d = json.load(fh)
        if not isinstance(d, dict):
            raise ValueError("sessions.json is not a JSON object")
        return d
    except FileNotFoundError:
        return {}
    except Exception:
        if strict:
            raise
        return {}


def request_snoozed(r, at=None):
    """True while an open request is deferred to a future date. Snoozing is a
    display filter, never a state-machine state, so an answer can still land on
    a snoozed request."""
    if r.get("status", "open") != "open":
        return False
    t = parse_ts(r.get("snooze_until") or "")
    return t is not None and t > (time.time() if at is None else at)


def undeliverable(r, sess, dead_panes=()):
    """Why an answered request can never reach anyone, or '' if it still can.

    An answer sits in "delivering" until something consumes it. If the asker is
    gone, nothing ever will, and the question stays on the owner's board forever
    (that is exactly how two of them wedged on 2026-08-12).

    Only "answered" is swept. "revival_claimed" means a delivery attempt is IN
    FLIGHT: some claimant is injecting the answer right now. Unwinding that
    would race the claimant, fail its transition to delivered even after it had
    delivered, and briefly expose the request as answered for another poller to
    consume. A failed revival reverts itself to answered, and the sweep picks it
    up on a later pass, so nothing is lost by leaving claims alone."""
    if r.get("status") != "answered":
        return ""
    sid = r.get("session", "") or ""
    if not sid:
        return "no terminal was bound to this question"
    s = sess.get(sid)
    if not s:
        return "terminal " + sid + " is no longer registered"
    if s.get("status") == "done":
        return "terminal " + sid + " has finished"
    if r.get("gen") and s.get("started", "") != r.get("gen"):
        return "terminal " + sid + " restarted since it asked"
    # The registry can still say active while the process is gone: a worker
    # exits and the work window keeps the corpse, and reconcile counts a dead
    # pane as live. Such a session will never poll either.
    if s.get("tmux_window", "") in dead_panes:
        return "terminal " + sid + " exited (its pane is dead)"
    return ""


def rank_of(r):
    """Sort key for the Needs-you list: sunk requests last. Ties keep the
    stored insertion order, since Python's sort is stable. Timestamps are whole
    seconds, so tie-breaking on ts would shuffle the list between 3s polls."""
    try:
        return int(r.get("rank", 0) or 0)
    except Exception:
        return 0


def req_index(reqs, rid):
    for i, r in enumerate(reqs):
        if r.get("id") == rid:
            return i
    return -1


def cas(rid, from_states, to_state, extra=None):
    """Atomically move request rid from one of from_states to to_state.
    Returns (ok, request_or_reason). Must NOT be called while already holding
    the lock (it takes it)."""
    with locked():
        reqs = load("requests.json", [])
        i = req_index(reqs, rid)
        if i < 0:
            return False, "no such request"
        r = reqs[i]
        cur = r.get("status", "open")
        if cur not in from_states:
            return False, "status is " + cur
        if to_state not in TRANSITIONS.get(cur, set()):
            return False, "illegal transition " + cur + " to " + to_state
        r["status"] = to_state
        for k, v in (extra or {}).items():
            r[k] = v
        save("requests.json", reqs)
        return True, dict(r)



# SLA on open questions (design: docs/superpowers/specs/
# 2026-08-24-capri-voice-hermes-jira-gastown.md section 4.3). A filed question
# has a clock: open longer than its severity allows, it raises its own severity
# one level and re-notifies, so a P1 filed while the owner was out does not sit at
# day-three salience equal to minute-one. The clock pauses while snoozed
# (snoozing is the owner saying "later", which is an answer of sorts) and restarts
# when the snooze expires or is lifted. Two escalations maximum: a question
# the owner is deliberately ignoring must not become a siren. Gas Town's
# escalation config (stale_threshold 4h, max_reescalations 2) independently
# landed on the same shape.
SLA_THRESHOLD_S = {"P0": 30 * 60, "P1": 4 * 3600, "P2": 24 * 3600}
SLA_MAX_ESCALATIONS = 2
# A P1 never climbs to P0 on its own: P0 pushes urgent to the phone, and an
# unanswered P1 is a re-ring, not an emergency (stack audit 2026-11-04: all 28
# P0 asks in 30 days came from this raise). Only the asker sets P0.
SLA_RAISE = {"P2": "P1", "P1": "P1", "P0": "P0"}


def sla_anchor(r):
    """Epoch second the SLA clock measures from: the newest of filing time,
    the last snooze expiry, and the last escalation."""
    times = [parse_ts(r.get("ts") or "")]
    su = parse_ts(r.get("snooze_until") or "")
    if su is not None and su <= time.time():
        times.append(su)
    times.append(parse_ts(r.get("sla_ts") or ""))
    times = [t for t in times if t is not None]
    return max(times) if times else None


def asker_gone(r, sess):
    """Why the session bound to request r can no longer take an answer in its
    terminal, or '' when it still can (or no session was bound at all)."""
    sid = r.get("session", "") or ""
    if not sid:
        return ""
    s = sess.get(sid)
    if not s:
        return "terminal " + sid + " is no longer registered"
    if s.get("status") == "done":
        return "terminal " + sid + " has finished"
    if r.get("gen") and s.get("started", "") != r.get("gen"):
        return "terminal " + sid + " restarted since it asked"
    return ""


def interactive_ask(r, sess):
    """True when r was filed by a terminal the owner drives (anything but a
    headless worker). Such a question is put to him in that terminal, and he
    answers there; the agent records it with 'ctl answer --here'."""
    s = sess.get(r.get("session", "") or "")
    return bool(s) and (s.get("kind") or "") != "worker"


def sla_sweep(at=None):
    """Escalate every open, unsnoozed request past its severity's threshold.
    Returns the escalated requests (dicts, post-escalation) so the caller can
    notify. Safe to run on every state compile: a request escalates at most
    once per threshold crossing because the crossing resets its anchor.

    Never escalated (hq-zqqu.1 round 1): a request that already carries a
    recorded answer, one whose asking session has ended (nobody waits on it
    any more), and one asked by an interactive terminal. The last is the
    forgotten 'answer --here' case: the owner answered in the terminal, the agent
    did not record it, and re-ringing him for a question he already answered
    is the false alarm that teaches him to ignore the bell. The waiting mark on
    the card and the waiting count on the top strip still show it."""
    at = time.time() if at is None else at
    escalated = []
    sess = sessions()
    with locked():
        reqs = load("requests.json", [])
        changed = False
        for r in reqs:
            if r.get("status", "open") != "open" or r.get("hidden"):
                continue
            if r.get("to") == "orchestrator":
                continue   # its own 10-minute fallback forwards it (orch_fallback_sweep)
            if request_snoozed(r, at):
                continue
            if r.get("answer_file") or asker_gone(r, sess) or interactive_ask(r, sess):
                continue
            if int(r.get("sla_escalations") or 0) >= SLA_MAX_ESCALATIONS:
                continue
            sev = r.get("sev") or "P1"
            if sev not in SLA_THRESHOLD_S:
                sev = "P1"
            anchor = sla_anchor(r)
            if anchor is None or at - anchor < SLA_THRESHOLD_S[sev]:
                continue
            r["sev"] = SLA_RAISE[sev]
            r["sla_escalations"] = int(r.get("sla_escalations") or 0) + 1
            r["sla_ts"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(at))
            r["sla_from"] = sev
            changed = True
            escalated.append(dict(r))
        if changed:
            save("requests.json", reqs)
    return escalated


# Ask routing (docs/designs/2026-11-04-orchestrator.md section 1). A worker's
# ask is filed "to": "orchestrator"; the orchestrator answers it with the normal
# answer verb or forwards it to the owner with a class. One not forwarded or
# answered within ORCH_FALLBACK_S forwards itself, so a dead orchestrator never
# blocks a worker. Records with no "to" predate routing and mean the owner.
ORCH_FALLBACK_S = 10 * 60
try:   # test seam only; a bad value keeps the 10 minutes
    ORCH_FALLBACK_S = max(0, int(os.environ.get("HQ_ORCH_FALLBACK_S") or ORCH_FALLBACK_S))
except ValueError:
    pass
FORWARD_CLASSES = ("business", "taste", "unknowable")


def _forward(r, cls, by, note=""):
    r["to"] = "owner"
    r["forward_class"] = cls
    r["forwarded_by"] = by
    r["forwarded_ts"] = now()
    if note:
        r["forward_note"] = note
    # the owner's SLA clock starts when the question reaches him, not at filing
    r["sla_ts"] = r["forwarded_ts"]


def forward_request(rid, cls, by="orchestrator", note=""):
    """Hand an orchestrator-routed open request to the owner. Refuses an unknown
    class, a request not routed to the orchestrator, and one no longer open.
    Returns (ok, request_or_reason)."""
    if cls not in FORWARD_CLASSES:
        return False, "class must be one of " + "|".join(FORWARD_CLASSES)
    with locked():
        reqs = load("requests.json", [])
        i = req_index(reqs, rid)
        if i < 0:
            return False, "no such request"
        r = reqs[i]
        if r.get("status", "open") != "open":
            return False, "status is " + r.get("status", "?")
        if r.get("to") != "orchestrator":
            return False, "not routed to the orchestrator"
        _forward(r, cls, by, note)
        save("requests.json", reqs)
        return True, dict(r)


def reroute_to_owner(rid, why):
    """Internal fail-closed path: an orchestrator request that could not be
    handed to the orchestrator (its event did not land) goes to the owner now."""
    with locked():
        reqs = load("requests.json", [])
        i = req_index(reqs, rid)
        if i < 0 or reqs[i].get("to") != "orchestrator" or reqs[i].get("status", "open") != "open":
            return False
        _forward(reqs[i], why, "ctl")
        save("requests.json", reqs)
        return True


def orch_fallback_sweep(at=None):
    """Forward every open orchestrator request filed ORCH_FALLBACK_S or more ago
    (class "timeout", by "fallback"). Returns the forwarded requests. A request
    with an unreadable timestamp forwards at once: fail toward the owner."""
    at = time.time() if at is None else at
    out = []
    with locked():
        reqs = load("requests.json", [])
        for r in reqs:
            if r.get("status", "open") != "open" or r.get("to") != "orchestrator":
                continue
            t = parse_ts(r.get("ts") or "")
            if t is not None and at - t < ORCH_FALLBACK_S:
                continue
            _forward(r, "timeout", "fallback")
            out.append(dict(r))
        if out:
            save("requests.json", reqs)
    return out


def add_request(rid, question, bead, session, kind="", cmd="", link="", why="", sev="", meta=None, to="owner"):
    """File a new request bound to the session's current generation.

    kind/cmd/link/why/sev are the structured handoff fields (console v2 design,
    section 5): kind in run|decide|login|info|autofix|keep-or-revert, cmd is a
    copyable command for kind=run, sev in P0|P1|P2 (default P1). Old callers
    pass only the first four arguments and get the same record shape as before
    plus empty fields, so v1 readers keep working.
    """
    gen = ""
    if session:
        gen = sessions().get(session, {}).get("started", "")
    kind = kind if kind in ("run", "decide", "login", "info", "autofix", "keep-or-revert") else ("run" if cmd else "decide")
    sev = sev if sev in ("P0", "P1", "P2") else "P1"
    with locked():
        reqs = load("requests.json", [])
        reqs.append({
            "id": rid, "question": question, "bead": bead, "session": session,
            "gen": gen, "status": "open", "ts": now(),
            "answered_ts": "", "answer_file": "",
            "snooze_until": "", "rank": 0,
            "kind": kind, "cmd": cmd or "", "link": link or "", "why": why or "", "sev": sev,
            "meta": meta if isinstance(meta, dict) else {},
            "to": "orchestrator" if to == "orchestrator" else "owner",
        })
        save("requests.json", reqs)


def get_request(rid):
    reqs = load("requests.json", [])
    i = req_index(reqs, rid)
    return None if i < 0 else reqs[i]


def record_here(rid, answer_file):
    """Record an answer the asker already holds (the owner typed it in the asking
    terminal) and settle the request in ONE transaction: open -> delivered with
    delivery "terminal". There is no intermediate "answered" state, so no poller,
    sweep or injector can claim it and type the answer back into the terminal.
    Returns (ok, request_or_reason)."""
    with locked():
        reqs = load("requests.json", [])
        i = req_index(reqs, rid)
        if i < 0:
            return False, "no such request"
        r = reqs[i]
        cur = r.get("status", "open")
        if cur != "open":
            return False, "status is " + cur
        r["status"] = "delivered"
        r["answered_ts"] = now()
        r["answer_file"] = answer_file
        r["delivery"] = "terminal"
        save("requests.json", reqs)
        return True, dict(r)


def answer_request(rid, answer_file, pane_live=False):
    """CAS open -> answered, then decide the delivery route in the same lock:
    returns (route, request) where route is one of live, revive, stale, refused.
    stale means the asking session's generation changed or it is gone/done:
    nobody is left to deliver to, but the owner's answer is still RECORDED (the
    answer file, answered_ts) and the request settles as delivered with
    delivery "recorded", in this one lock. Dropping it (the old cancel) lost
    the answer for the request history and for a restarted asker that runs
    'ctl await' (poll_once returns a delivered answer). revive means we claimed
    revival.

    The registry's "done" is not trusted on its own (hqbox runs two tmux servers
    and reconcile can call a running terminal done; hq-zqqu.1 round 4). pane_live
    is the caller's live_pane result for the asking session (exactly one live pane
    bound to it by its claude process identity). For a terminal the registry calls
    done in the same generation:
      - pane_live: route "live", so the answer is typed once like any other;
      - not pane_live, interactive asker: the answer is recorded and the request
        stays "answered" (owed), listed as "not yet in a terminal" until it is
        polled or the owner clears it; route "owed";
      - not pane_live, worker asker: the old "stale" settle (delivered,
        recorded), which a worker's 'ctl await' poll still returns.
    A changed generation (the terminal restarted) is still "stale"."""
    with locked():
        reqs = load("requests.json", [])
        i = req_index(reqs, rid)
        if i < 0:
            return "refused", "no such request"
        r = reqs[i]
        if r.get("status") != "open":
            return "refused", "status is " + r.get("status", "?")
        sess = sessions().get(r.get("session", ""), {})
        gen_ok = (not r.get("session")) or (
            sess and sess.get("started", "") == r.get("gen", ""))
        said_done = bool(r.get("session")) and gen_ok and sess.get("status") == "done"
        if said_done and not pane_live and (sess.get("kind") or "") != "worker":
            r["status"] = "answered"
            r["answered_ts"] = now()
            r["answer_file"] = answer_file
            r["recorded_why"] = ("terminal " + r.get("session", "") +
                                 " has no live pane to type into")
            save("requests.json", reqs)
            return "owed", dict(r)
        if said_done and pane_live:
            pass   # the registry is wrong: the terminal is running, deliver normally
        elif r.get("session") and (not gen_ok or sess.get("status") == "done"):
            r["status"] = "delivered"
            r["answered_ts"] = now()
            r["answer_file"] = answer_file
            r["delivery"] = "recorded"
            r["recorded_why"] = ("terminal " + r.get("session", "") +
                                 (" has finished" if sess and gen_ok else " is gone or restarted"))
            save("requests.json", reqs)
            return "stale", dict(r)
        r["status"] = "answered"
        r["answered_ts"] = now()
        r["answer_file"] = answer_file
        route = "live"
        awaiting = load("awaiting.json", {})
        if sess.get("status") == "snoozed" and awaiting.get(r.get("session", "")) == rid:
            r["status"] = "revival_claimed"
            route = "revive"
        save("requests.json", reqs)
        return route, dict(r)


# ---- registry rows vs the tmux panes they claim (hq-je3fk.5) ----------------
# A registry row keeps the pane id it was given at spawn. The pane can be gone
# (finish.sh or a tmux restart), dead (remain-on-exit corpse), back at a bare
# shell, or REUSED: tmux numbers panes per server and restarts from %0, so on
# 2026-10-30 the finished worker s-79c4 still pointed at %9, which was by then
# the cpu-watch pane. Trusting the id alone kept 30 pane-less workers as cards
# and would have let Kill end cpu-watch. pane_status() binds a row to its pane
# by evidence, the same evidence ctl.sh live_pane uses for answers.

def hq_tmux_server():
    """The tmux server that holds the session named exactly hq, as ["-L", s],
    or None. Registry pane ids are that server's (see ops/scripts/lib/tmux-server.sh)."""
    import subprocess
    for s in os.environ.get("HQ_TMUX_SERVERS", "default hqterm").split():
        try:
            if subprocess.run(["tmux", "-L", s, "has-session", "-t", "=hq"],
                              capture_output=True, timeout=10).returncode == 0:
                return ["-L", s]
        except Exception:
            pass
    return None


def hq_panes(srv=None):
    """{pane_id: {dead, pid, cmd, path}} on the hq server, or None when tmux
    cannot be asked (then nothing may be claimed about any pane)."""
    import subprocess
    fx = os.environ.get("HQ_PANES_FIXTURE")   # tests only: a JSON file in this same shape
    if fx:
        try:
            with open(fx) as fh:
                return json.load(fh)
        except Exception:
            return None
    if os.environ.get("HQ_NO_TMUX"):
        return None
    srv = srv or hq_tmux_server()
    if not srv:
        return None
    fmt = "#{pane_id}\t#{pane_dead}\t#{pane_pid}\t#{pane_start_path}\t#{pane_start_command}"
    try:
        r = subprocess.run(["tmux"] + srv + ["list-panes", "-a", "-F", fmt],
                           capture_output=True, text=True, timeout=10)
    except Exception:
        return None
    if r.returncode != 0:
        return None
    out = {}
    for line in r.stdout.splitlines():
        bits = line.split("\t", 4)
        if len(bits) == 5 and bits[0].startswith("%"):
            out[bits[0]] = {"dead": bits[1] == "1", "pid": bits[2],
                            "path": bits[3], "cmd": bits[4]}
    return out


def proc_kids():
    """ppid -> [pid] for every process; {} when /proc cannot be read."""
    kids = {}
    try:
        entries = os.listdir("/proc")
    except Exception:
        return kids
    for e in entries:
        if not e.isdigit():
            continue
        try:
            with open("/proc/%s/stat" % e) as fh:
                ppid = fh.read().rsplit(")", 1)[1].split()[1]
            kids.setdefault(ppid, []).append(e)
        except Exception:
            pass
    return kids


def _tree(root, kids):
    seen, stack = {root}, [root]
    while stack:
        for c in kids.get(stack.pop(), []):
            if c not in seen:
                seen.add(c)
                stack.append(c)
    return seen


def _argv(pid):
    try:
        with open("/proc/%s/cmdline" % pid, "rb") as fh:
            return [a for a in fh.read().decode("utf-8", "replace").split("\0") if a]
    except Exception:
        return []


def _identity(pid):
    try:
        with open("/proc/%s/environ" % pid, "rb") as fh:
            raw = fh.read().decode("utf-8", "replace").split("\0")
    except Exception:
        return ""
    env = dict(kv.split("=", 1) for kv in raw if "=" in kv)
    return env.get("CDP_TERMINAL_ID") or env.get("HQ_CONSOLE_SID") or ""


def is_claude(argv):
    """A claude process by its argv: the binary itself, or node running it.
    Only argv[0] and argv[1] count, so a path that merely contains .claude
    (a worktree) or a log named after a session never matches."""
    names = [os.path.basename(a) for a in argv[:2]]
    return bool(names) and (names[0] == "claude" or (names[0].startswith("node") and "claude" in names[1:]))


def pane_status(row, panes, kids=None):
    """What a registry row's pane is now:
      none     the row names no pane id (a window name, or a console terminal)
      unknown  tmux could not be asked: claim nothing
      gone     no such pane, or the id now belongs to someone else
      dead     the pane is a remain-on-exit corpse
      shell    the pane is alive but no claude runs in it any more
      live     the pane runs a claude
    """
    win = str(row.get("tmux_window") or "")
    if not (win.startswith("%") and win[1:].isdigit()):
        return "none"
    if panes is None:
        return "unknown"
    p = panes.get(win)
    if not p:
        return "gone"
    sid = str(row.get("id") or "")
    kids = proc_kids() if kids is None else kids
    procs = _tree(p["pid"], kids) if (kids and not p["dead"]) else set()
    claudes = [q for q in procs if is_claude(_argv(q))]
    ids = {i for i in (_identity(q) for q in procs) if i}
    wt = str(row.get("worktree") or "")
    worker = row.get("kind") == "worker"
    same_path = bool(wt) and os.path.normpath(p["path"]) == os.path.normpath(wt)
    if ids and sid not in ids:
        return "gone"            # an explicit identity that is not this row wins over any path
    if sid and (sid in ids or ("launch-%s.sh" % sid) in p["cmd"] or (worker and same_path)):
        pass                     # evidence it is this row's pane
    else:
        return "gone"            # no evidence this pane is the row's: tmux reuses ids for every kind
    if p["dead"]:
        return "dead"
    if kids and not claudes:
        return "shell"
    return "live"


def _age_s(row):
    """Seconds since the row started; unknown or unparseable counts as fresh (fail closed)."""
    import datetime
    try:
        t = datetime.datetime.fromisoformat(str(row.get("started") or "").replace("Z", "+00:00"))
        return (datetime.datetime.now(datetime.timezone.utc) - t).total_seconds()
    except Exception:
        return 0


def reconcile_row(row, status):
    """What a reconcile should do with one registry row whose pane status is
    known: (new_status, reason) or None to leave it. Never touches a pane or a
    worktree; a branch with unmerged work stays finishable for finish.sh."""
    import subprocess
    st = row.get("status")
    if row.get("kind") == "console-term" or status in ("live", "unknown"):
        return None
    if st == "active" and status == "shell" and _age_s(row) < 600:
        return None              # a fresh launch: its claude may not have started yet
    if st == "active" and status in ("gone", "dead", "shell"):
        pass
    elif st in ("finishable", "exited"):
        pass
    else:
        return None
    wt = str(row.get("worktree") or "")
    why = {"gone": "pane gone", "dead": "pane dead", "shell": "claude exited",
           "none": "no pane"}[status]
    if not wt or not os.path.isdir(wt):
        return ("done", why + ", worktree gone")

    def git(*a):
        return subprocess.run(["git", "-C", wt] + list(a), capture_output=True,
                              text=True, timeout=20)
    try:
        # Fail closed: any git error keeps the row finishable, never "nothing unmerged".
        stat = git("status", "--porcelain")
        if stat.returncode != 0:
            raise RuntimeError("git status failed")
        dirty = bool(stat.stdout.strip())
        # the default is what the rig's main checkout (the first worktree) has
        # out: finish.sh merges there, before git-sync pushes it anywhere
        base = ""
        for line in git("worktree", "list", "--porcelain").stdout.splitlines():
            if line.startswith("branch "):
                base = line.split(" ", 1)[1]
                break
            if line == "" and base == "":
                break
        if base and git("rev-parse", "--verify", "-q", base).returncode != 0:
            base = ""
        if not base:
            return ("finishable", why + ", default branch unknown") if st != "finishable" else None
        rl = git("rev-list", "--count", base + "..HEAD")
        if rl.returncode != 0 or not rl.stdout.strip().isdigit():
            raise RuntimeError("git rev-list failed")
        ahead = int(rl.stdout.strip())
    except Exception:
        return ("finishable", why + ", git unreadable") if st != "finishable" else None
    if not dirty and ahead == 0:
        return ("done", why + ", nothing unmerged")
    if st == "finishable":
        return None
    return ("finishable", "%s, needs finish (%d ahead%s)" % (why, ahead, ", dirty" if dirty else ""))


# ---- one worker per bead (hq-4npjr.10) ---------------------------------------
# On 2026-11-04 the orchestrator and the coordinator both dispatched the same
# ready beads: hq-4npjr.6 got three workers. Every path that starts a worker
# (spawn.sh, ctl dispatch, ctl dispatch-batch, the orchestrator through them)
# asks bead_hold() under locked() before it starts one.
HOLD_STATUSES = ("active", "snoozed", "finishable")
CLAIM_TTL_S = 600


def bead_hold(bead, own_nonce="", panes=None, kids=None):
    """Why bead may not get a new worker, or None when it is free. Call under locked().
    A registry row holds the bead while it is snoozed (no pane, by design) or
    finishable (its work waits on a merge). An active row holds it unless its pane
    is provably over (gone, dead, or a bare shell older than ten minutes) AND its
    worktree is gone or holds nothing unmerged (reconcile_row says done). A pane
    tmux cannot be asked about holds (fail closed). A dispatch claim file holds it
    for ten minutes, or as long as its batch's primary session holds; own_nonce
    names the caller's own claim, which never blocks the caller. A reviewer row
    (spawn --review, role=reviewer) never holds (hq-oq30g.2). A sessions.json
    that exists but is unreadable or corrupt raises (callers refuse on it)."""
    # strict: a corrupt registry raises, so every caller refuses (fail closed)
    rows = [r for r in sessions(strict=True).values()
            if isinstance(r, dict) and r.get("bead") == bead and r.get("status") in HOLD_STATUSES
            and r.get("kind") != "console-term" and r.get("role") != "reviewer"]
    if panes is None and any(r.get("status") == "active" for r in rows):
        panes = hq_panes()
    held_by = {}
    for r in rows:
        sid = str(r.get("id") or "?")
        if r.get("status") != "active":
            return "%s is held by %s (%s)" % (bead, sid, r.get("status"))
        ps = pane_status(r, panes, kids)
        if ps in ("gone", "dead") or (ps == "shell" and _age_s(r) >= CLAIM_TTL_S):
            # The worker is over, but its work may not be (hq-4npjr.19, 2026-11-04:
            # s-1fee exited at 20:54:14 with its commits unmerged, the reconcile had
            # not marked it finishable yet, and s-340d took hq-63nvj.2 19 s later).
            # Free only when the worktree is gone or has nothing unmerged; anything
            # else, an unreadable worktree included, still holds (fail closed).
            try:
                verdict = reconcile_row(r, ps)
            except Exception:
                verdict = None
            if verdict and verdict[0] == "done":
                continue
            return "%s is held by %s (active, pane %s, %s)" % (
                bead, sid, ps, verdict[1] if verdict else "worktree state unknown")
        return "%s is held by %s (active, pane %s)" % (bead, sid, ps)
    cf = os.path.join(WR, "dispatch", bead + ".json")
    try:
        with open(cf) as fh:
            claim = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(claim, dict) or (own_nonce and claim.get("nonce") == own_nonce):
        return None
    owner = claim.get("primary") or claim.get("bead")
    if owner and owner != bead:
        why = bead_hold(owner, own_nonce, panes, kids)
        if why:
            return "%s is in a batch: %s" % (bead, why)
    try:
        age = time.time() - float(claim.get("epoch", 0))
    except (TypeError, ValueError):
        age = 0
    if age < CLAIM_TTL_S:
        return "%s has a live dispatch claim from %s" % (bead, claim.get("ts", "?"))
    return None


def claim_bead(bead, rig, nonce, batch=None, primary=None):
    """Write a dispatch claim (call under locked(), after bead_hold said free)."""
    d = os.path.join(WR, "dispatch")
    os.makedirs(d, exist_ok=True)
    cf = os.path.join(d, bead + ".json")
    rec = {"bead": bead, "rig": rig, "ts": now(), "epoch": time.time(), "nonce": nonce}
    if batch:
        rec.update(batch=batch, primary=primary or batch[0])
    tmp = cf + "." + nonce + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(rec, fh)
    os.replace(tmp, cf)


def release_claim(bead, nonce):
    """Delete bead's claim only if it is ours (nonce matches)."""
    cf = os.path.join(WR, "dispatch", bead + ".json")
    try:
        with open(cf) as fh:
            if json.load(fh).get("nonce") == nonce:
                os.unlink(cf)
    except Exception:
        pass
