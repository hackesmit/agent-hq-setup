#!/usr/bin/env python3
"""Daily and weekly token usage, read straight from Claude Code's own
transcripts. ccusage is not installed on this box, which is why the console's
usage tile had been showing n/a since it was built.

Efficiency matters here: this runs behind the dashboard's poll, so it must not
re-read every transcript each time. It keeps a byte offset per file and parses
only what was appended since the last run, and it string-tests each line for
'"usage"' before paying for json.loads. A cold first run costs one full scan;
every run after that is proportional to new output, not to history.

Attribution: every transcript line carries the cwd it was written from, so the
same scan that totals tokens can also say which project spent them. A rig path
maps to that rig, a spawn.sh worktree (rigs/<rig>-<4 hex> or ~/hq-<rig>-<suffix>)
maps back to its rig, the session registry settles anything ambiguous, and
everything else under ~/hq is hq. Nothing is ever split by guesswork: a cwd that
resolves to nothing lands in "unattributed" rather than being spread around.

usage: usage.py [--state <dir>] [--days N] [--project-days N]
                [--projects <projects.json>] [--registry <sessions.json>]
prints one JSON object: today, week (rolling 7 days), per-model split, the day
series for a sparkline, and byProject over the last 30 days.
"""
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

# The env var exists so a test can point the scan at a fixture tree; nothing in
# the console sets it.
PROJECTS = os.environ.get("HQ_USAGE_TRANSCRIPTS") or os.path.expanduser("~/.claude/projects")
HQ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Bump when the cached day rows gain a dimension. A cache written by an older
# version has already consumed the bytes that carry the new field, so an
# in-place upgrade would report empty history forever: the cache is dropped and
# one cold scan pays for the new dimension honestly.
CACHE_VERSION = 3

# Anthropic API list prices, USD per million tokens:
#   (input, output, cache read, cache write 5m TTL, cache write 1h TTL)
# Cache reads are 0.1x input (0.025x on Fable 5.1 and 5.2: 0.25 and 0.20/MTok) and cache writes are
# 1.25x input at the 5 minute TTL, 2x at the 1 hour TTL. The two write rates
# are NOT interchangeable here: on this box most cache-write volume is 1h, so
# pricing it all at 1.25x understated the bill by about 8 percent.
# the owner works on a subscription, so these are a list-price EQUIVALENT of the
# tokens spent, not an invoice. Every consumer labels it that way.
PRICES = {
    # Fable 5.2: platform.claude.com/docs/en/about-claude/pricing, read 2026-11-10.
    "claude-fable-5-2": (8.0, 40.0, 0.20, 10.00, 16.00),
    "claude-fable-5-1": (10.0, 50.0, 0.25, 12.50, 20.00),
    "claude-mythos-5-1": (10.0, 50.0, 0.25, 12.50, 20.00),
    "claude-fable-5": (10.0, 50.0, 1.00, 12.50, 20.00),
    "claude-mythos-5": (10.0, 50.0, 1.00, 12.50, 20.00),
    "claude-opus-5": (5.0, 25.0, 0.50, 6.25, 10.00),
    "claude-opus-4-8": (5.0, 25.0, 0.50, 6.25, 10.00),
    "claude-opus-4-7": (5.0, 25.0, 0.50, 6.25, 10.00),
    "claude-opus-4-6": (5.0, 25.0, 0.50, 6.25, 10.00),
    "claude-sonnet-5": (2.0, 10.0, 0.20, 2.50, 4.00),
    "claude-sonnet-4-6": (3.0, 15.0, 0.30, 3.75, 6.00),
    "claude-haiku-4-5": (1.0, 5.0, 0.10, 1.25, 2.00),
}
# A dated snapshot id prices as its base model.
DATE_SUFFIX = re.compile(r"-\d{8}$")
# spawn.sh names a worktree "<rig>-$(printf '%04x' ...)".
WORKTREE_SUFFIX = re.compile(r"^(.+)-[0-9a-f]{4}$")
UNATTRIBUTED = "unattributed"


def price_of(model):
    """(in, out, cache_read, write_5m, write_1h) per MTok, or None if unpriced."""
    m = DATE_SUFFIX.sub("", str(model or ""))
    return PRICES.get(m)


def cache_writes(u):
    """(total cache-write tokens, of which 1 hour TTL) for one usage record.

    `usage.cache_creation` splits the write by TTL and is what Claude Code
    writes today (37,894 of 37,894 lines on this box carry it). It is also the
    more complete of the two: 20 lines here report a zero rollup beside a
    non-zero split, so the split is treated as authoritative where it exists
    and the rolled-up cache_creation_input_tokens is the fallback for a
    producer that does not send one, priced entirely at the 5 minute rate.
    """
    rollup = int(u.get("cache_creation_input_tokens") or 0)
    cc = u.get("cache_creation")
    if isinstance(cc, dict):
        five = int(cc.get("ephemeral_5m_input_tokens") or 0)
        hour = int(cc.get("ephemeral_1h_input_tokens") or 0)
        if five or hour:
            return five + hour, hour
    return rollup, 0


def parse_args(argv):
    """--state/--days as before; the rest exist so a test can point the
    attribution at fixtures instead of this box."""
    opts = {"state": None, "days": 14, "project_days": 30,
            "projects": None, "registry": None}
    i = 0
    while i < len(argv):
        if argv[i] == "--state" and i + 1 < len(argv):
            opts["state"] = argv[i + 1]; i += 2
        elif argv[i] == "--days" and i + 1 < len(argv):
            opts["days"] = max(1, int(argv[i + 1])); i += 2
        elif argv[i] == "--project-days" and i + 1 < len(argv):
            opts["project_days"] = max(1, int(argv[i + 1])); i += 2
        elif argv[i] == "--projects" and i + 1 < len(argv):
            opts["projects"] = argv[i + 1]; i += 2
        elif argv[i] == "--registry" and i + 1 < len(argv):
            opts["registry"] = argv[i + 1]; i += 2
        else:
            i += 1
    return opts


def local_day(ts):
    """Transcript timestamps are UTC; the owner reads days in local time."""
    try:
        d = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return d.astimezone().strftime("%Y-%m-%d")
    except Exception:
        return ""


def _norm(path):
    """An absolute path with no trailing separator, so prefix tests are exact."""
    p = os.path.abspath(os.path.expanduser(str(path or "")))
    return p.rstrip(os.sep) or os.sep


def _under(child, parent):
    """True when child IS parent or sits inside it. Segment-aware on purpose:
    a plain startswith makes /home/owner/hq-worker look like it lives in
    /home/owner/hq, which is exactly the worktree case this has to get right."""
    return child == parent or child.startswith(parent + os.sep)


def slugify(path):
    """Claude Code's own project-directory name for a cwd: every non
    alphanumeric byte becomes a dash. Used only to read a scratchpad path back
    to the session that owns it."""
    return re.sub(r"[^A-Za-z0-9]", "-", _norm(path))


class Attribution:
    """Which project a transcript's cwd belongs to.

    Two registries feed it, both read-only: ops/projects.json for the declared
    project paths and ids, and state/sessions.json (what ctl.sh/spawn.sh write)
    for the worktrees a spawned session was given. Neither is required; without
    them the path shapes alone still resolve rigs, worktrees and hq.
    """

    def __init__(self, projects=None, sessions=None, hq=HQ, home=None):
        self.home = _norm(home or os.path.expanduser("~"))
        self.ids = set()
        self.paths = []          # (normalised path, project id), longest first
        for p in (projects or {}).get("projects", []) if isinstance(projects, dict) else (projects or []):
            if not isinstance(p, dict):
                continue
            pid = str(p.get("id") or "")
            if not pid:
                continue
            self.ids.add(pid)
            if p.get("path"):
                self.paths.append((_norm(p["path"]), pid))
        self.paths.sort(key=lambda pair: -len(pair[0]))
        # The workspace root the transcripts talk about, which is where the hq
        # project says it lives, NOT where this file happens to sit: usage.py
        # is read out of a worktree as often as out of the checkout, and the
        # cwds being attributed are always the real ones.
        declared_hq = next((path for path, pid in self.paths if pid == "hq"), None)
        self.hq = declared_hq or _norm(hq)
        self.rigs_dir = os.path.join(self.hq, "rigs")
        self.worktrees = []      # (normalised worktree, rig id), longest first
        rows = (sessions or {}).values() if isinstance(sessions, dict) else (sessions or [])
        for s in rows:
            if not isinstance(s, dict):
                continue
            wt, rig = s.get("worktree"), s.get("rig")
            if not (wt and rig):
                continue
            wt = _norm(wt)
            # A registry row is only allowed to outrank the path rules when it
            # names something NARROWER than the workspace. A row whose worktree
            # is the hq root (or an ancestor of it, or the rigs directory
            # itself) would otherwise capture every cwd on the box and file the
            # whole month under one rig.
            if _under(self.hq, wt) or wt in (self.rigs_dir, self.home):
                continue
            self.worktrees.append((wt, str(rig)))
        self.worktrees.sort(key=lambda pair: -len(pair[0]))

    def _rig_name(self, name):
        """A rigs/ directory name read back to a project id: strip a spawn.sh
        worktree suffix only when what is left is a rig that actually exists,
        so a project genuinely called foo-1a2b keeps its own name."""
        if name in self.ids:
            return name
        m = WORKTREE_SUFFIX.match(name)
        if m and (m.group(1) in self.ids or os.path.isdir(os.path.join(self.rigs_dir, m.group(1)))):
            return m.group(1)
        return name

    def project_for(self, cwd, _depth=0):
        if not cwd:
            return UNATTRIBUTED
        p = _norm(cwd)

        # 1. The session registry is the authority when it has an answer: a
        # worker's rig was recorded at spawn, not inferred from a path shape.
        for wt, rig in self.worktrees:
            if _under(p, wt):
                return rig

        # 2. Anything under rigs/, worktree suffix and all.
        if _under(p, self.rigs_dir) and p != self.rigs_dir:
            return self._rig_name(p[len(self.rigs_dir) + 1:].split(os.sep)[0])

        # 3. A declared project path, longest first. The hq root is skipped
        # here: it is a prefix of every other project on the box and would
        # swallow all of them, so it stays the fallback in step 6.
        for path, pid in self.paths:
            if _under(p, path) and path != self.hq:
                return pid

        # 4. A directory named after a known project, anywhere under hq. This
        # is what catches a project whose registry path has drifted from where
        # the work actually happens (bunkers/acme-financial today).
        if _under(p, self.hq):
            for seg in reversed(p[len(self.hq):].split(os.sep)):
                if seg in self.ids:
                    return seg

        # 5. The other worktree spelling CLAUDE.md documents, ~/hq-<rig>-<suffix>,
        # matched by prefix like the rigs/ rule above: a session that cd's one
        # level into its own worktree must not lose its rig. Only a name that
        # resolves to a real rig is accepted here, so an unrelated ~/hq-something
        # falls through instead of inventing a project.
        if _under(p, self.home) and p != self.home:
            seg = p[len(self.home) + 1:].split(os.sep)[0]
            if seg.startswith("hq-"):
                m = WORKTREE_SUFFIX.match(seg[3:])
                name = self._rig_name(m.group(1) if m else seg[3:])
                if name in self.ids or os.path.isdir(os.path.join(self.rigs_dir, name)):
                    return name

        # 6. Everything else inside the workspace is hq itself.
        if _under(p, self.hq):
            return "hq"

        # 7. A scratchpad is named after the session that owns it, so read the
        # owner's cwd back out of the slug rather than losing the session.
        if _depth == 0:
            for seg in p.split(os.sep):
                for known in [self.hq] + [q for q, _ in self.paths]:
                    if seg == slugify(known):
                        return self.project_for(known, _depth + 1)

        return UNATTRIBUTED


def read_json(path, default=None):
    """A registry that is missing or unparseable costs attribution accuracy,
    never the totals: usage.py has to keep answering either way."""
    if not path:
        return default
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return default


def load_cache(path):
    try:
        with open(path) as fh:
            c = json.load(fh)
        if isinstance(c, dict) and "files" in c and "days" in c and c.get("v") == CACHE_VERSION:
            return c
    except Exception:
        pass
    return {"v": CACHE_VERSION, "files": {}, "days": {}}


def save_cache(path, cache):
    # per-process temp name: two polls racing on a shared ".tmp" could replace
    # each other's file mid-write and lose the totals
    tmp = "%s.%d.tmp" % (path, os.getpid())
    try:
        with open(tmp, "w") as fh:
            json.dump(cache, fh)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def scan(cache, attribution=None):
    """Fold new transcript lines into the day totals. Returns files touched."""
    touched = 0
    attribution = attribution or Attribution()
    # One cwd per transcript in practice, so resolving it once per file keeps
    # the per-line cost at a dict lookup.
    cwd_cache = {}
    if not os.path.isdir(PROJECTS):
        return touched
    for root, _dirs, files in os.walk(PROJECTS):
        for name in files:
            if not name.endswith(".jsonl"):
                continue
            p = os.path.join(root, name)
            try:
                st = os.stat(p)
            except OSError:
                continue
            rec = cache["files"].get(p) or {"offset": 0, "size": 0}
            # a shrunk file was rotated or rewritten: start it over
            if st.st_size < rec.get("size", 0):
                rec = {"offset": 0, "size": 0}
            if st.st_size == rec.get("offset", 0):
                continue
            try:
                with open(p, "r", errors="replace") as fh:
                    fh.seek(rec["offset"])
                    # Only advance past COMPLETE lines. Claude appends to these
                    # files live, so the last line is often still being written;
                    # consuming it would fail to parse and skip the record for
                    # good once the remainder landed.
                    safe = rec["offset"]
                    for line in fh:
                        if not line.endswith("\n"):
                            break
                        safe += len(line.encode("utf-8", "replace"))
                        if '"usage"' not in line:
                            continue
                        try:
                            d = json.loads(line)
                        except Exception:
                            continue
                        msg = d.get("message") or {}
                        u = msg.get("usage")
                        if not isinstance(u, dict):
                            continue
                        day = local_day(d.get("timestamp", ""))
                        if not day:
                            continue
                        model = msg.get("model") or "unknown"
                        slot = cache["days"].setdefault(day, {"models": {}, "sessions": []})
                        # how many distinct sessions ran that day: the transcript
                        # filename is the session id
                        sid = name[:-6]
                        if sid not in slot.setdefault("sessions", []):
                            slot["sessions"].append(sid)
                        counts = {}
                        for k, field in (("input", "input_tokens"),
                                         ("output", "output_tokens"),
                                         ("cache_read", "cache_read_input_tokens")):
                            counts[k] = int(u.get(field) or 0)
                            slot[k] = slot.get(k, 0) + counts[k]
                        # Cache writes carry a TTL, and the two TTLs list at
                        # different prices. The day total stays the total, so
                        # byProject still reconciles against it; the 1 hour
                        # share rides alongside for the pricing pass.
                        counts["cache_write"], counts["cache_write_1h"] = cache_writes(u)
                        slot["cache_write"] = slot.get("cache_write", 0) + counts["cache_write"]
                        slot["cache_write_1h"] = slot.get("cache_write_1h", 0) + counts["cache_write_1h"]
                        slot["models"][model] = slot["models"].get(model, 0) + counts["output"]
                        # Same fold again, split by the project the cwd names.
                        # Per model as well as per project, because the price
                        # of a token is a property of the model that made it.
                        cwd = d.get("cwd") or ""
                        if cwd not in cwd_cache:
                            cwd_cache[cwd] = attribution.project_for(cwd)
                        pslot = slot.setdefault("projects", {}).setdefault(
                            cwd_cache[cwd], {"models": {}, "sessions": []})
                        if sid not in pslot["sessions"]:
                            pslot["sessions"].append(sid)
                        pm = pslot["models"].setdefault(model, {})
                        for k, v in counts.items():
                            pm[k] = pm.get(k, 0) + v
                    rec["offset"] = safe
                rec["size"] = st.st_size
                cache["files"][p] = rec
                touched += 1
            except OSError:
                continue
    return touched


def by_project(cache, days, now=None):
    """The last `days` days folded per project, priced per model.

    One row per project that actually spent something, biggest cost first.
    `costUsd` is the API list-price equivalent of those tokens; models with no
    entry in the price table contribute tokens but no dollars, and say so in
    `unpricedModels` rather than being quietly valued at zero.
    """
    now = now or datetime.now().astimezone()
    window = {(now - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(days)}
    rows = {}
    for day, row in cache.get("days", {}).items():
        if day not in window:
            continue
        for pid, pslot in (row.get("projects") or {}).items():
            r = rows.setdefault(pid, {"project": pid, "inputTokens": 0, "outputTokens": 0,
                                      "cacheReadTokens": 0, "cacheWriteTokens": 0,
                                      "cacheWrite1hTokens": 0, "costUsd": 0.0, "sessions": 0,
                                      "_sessions": set(), "_unpriced": set()})
            r["_sessions"].update(pslot.get("sessions", []))
            for model, c in (pslot.get("models") or {}).items():
                i, o = int(c.get("input", 0)), int(c.get("output", 0))
                cr, cw = int(c.get("cache_read", 0)), int(c.get("cache_write", 0))
                # A day row written before the TTL split existed has no 1h
                # counter; treating it as all 5 minute matches how it was
                # counted, and the cache version bump means that only happens
                # for a row this process wrote itself.
                cw1h = min(int(c.get("cache_write_1h", 0)), cw)
                cw5m = cw - cw1h
                r["inputTokens"] += i
                r["outputTokens"] += o
                r["cacheReadTokens"] += cr
                r["cacheWriteTokens"] += cw
                r["cacheWrite1hTokens"] += cw1h
                price = price_of(model)
                if price is None:
                    if i or o or cr or cw:
                        r["_unpriced"].add(model)
                    continue
                r["costUsd"] += (i * price[0] + o * price[1] + cr * price[2]
                                 + cw5m * price[3] + cw1h * price[4]) / 1e6
    out = []
    for r in rows.values():
        r["sessions"] = len(r.pop("_sessions"))
        r["unpricedModels"] = sorted(r.pop("_unpriced"))
        # `tokens` is what the money tab's effortByProject() already reads.
        r["tokens"] = (r["inputTokens"] + r["outputTokens"]
                       + r["cacheReadTokens"] + r["cacheWriteTokens"])
        r["costUsd"] = round(r["costUsd"], 4)
        out.append(r)
    out.sort(key=lambda r: (-r["costUsd"], r["project"]))
    return out


def main():
    opts = parse_args(sys.argv[1:])
    days = opts["days"]
    state = opts["state"] or os.path.join(HQ, "state")
    wr = os.path.join(state, "console")
    os.makedirs(wr, exist_ok=True)
    cpath = os.path.join(wr, "usage-tokens.json")

    # The registry is read from the real state dir, not from --state: --state
    # is the console's scratch cache location (a throwaway dir in check mode)
    # and sessions.json would not be there.
    registry = opts["registry"] or os.path.join(
        os.environ.get("HQ_STATE_DIR") or os.path.join(HQ, "state"), "sessions.json")
    attribution = Attribution(read_json(opts["projects"] or os.path.join(HQ, "ops", "projects.json")),
                              read_json(registry))

    cache = load_cache(cpath)
    touched = scan(cache, attribution)
    # keep the cache bounded: day rows older than 60 days are dead weight
    cutoff = (datetime.now().astimezone() - timedelta(days=60)).strftime("%Y-%m-%d")
    for k in [k for k in cache["days"] if k < cutoff]:
        del cache["days"][k]
    if touched:
        save_cache(cpath, cache)

    today = datetime.now().astimezone().strftime("%Y-%m-%d")
    series = []
    for i in range(days - 1, -1, -1):
        d = (datetime.now().astimezone() - timedelta(days=i)).strftime("%Y-%m-%d")
        row = cache["days"].get(d, {})
        series.append({"day": d,
                       "sessions": len(row.get("sessions", [])),
                       "output": row.get("output", 0),
                       "input": row.get("input", 0),
                       "cache_read": row.get("cache_read", 0),
                       "cache_write": row.get("cache_write", 0)})

    def total(rows, field):
        return sum(r.get(field, 0) for r in rows)

    week_rows = series[-7:]
    t = cache["days"].get(today, {})
    models = dict(sorted(t.get("models", {}).items(), key=lambda kv: -kv[1])[:4])
    print(json.dumps({
        "today": {"output": t.get("output", 0), "input": t.get("input", 0),
                  "cache_read": t.get("cache_read", 0),
                  "cache_write": t.get("cache_write", 0), "models": models,
                  "sessions": len(t.get("sessions", []))},
        "week": {"output": total(week_rows, "output"), "input": total(week_rows, "input"),
                 "cache_read": total(week_rows, "cache_read"),
                 "cache_write": total(week_rows, "cache_write"),
                 "sessions": sum(r.get("sessions", 0) for r in week_rows)},
        "series": series,
        "byProject": by_project(cache, opts["project_days"]),
        "byProjectDays": opts["project_days"],
        "files_scanned": touched,
    }))


if __name__ == "__main__":
    main()
