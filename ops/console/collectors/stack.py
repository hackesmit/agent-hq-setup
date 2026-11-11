#!/usr/bin/env python3
"""Stack collector (console v2 P2.1, design 4.3): inventory + evidence.

Measures which tools, skills, hooks, MCP servers, CLIs and domains are actually
used, how often and with what outcome, so the weekly retro decides keep/revert
on evidence instead of vibes. Runs as owner through spawn-as-owner.sh (the
transcripts live in owner's home); prints one JSON document on stdout.

Windows (7/30/90 days) are applied by RECORD TIMESTAMP, never file mtime.
Records without a timestamp land in an all-time bucket shown apart from the
windowed columns. Verdicts are HINTS for a human, not decisions.

Sources:
  ~/.claude/projects/**/*.jsonl   tool_use/tool_result records (incl. subagents),
                                  hook blocks (parsed from tool_result errors),
                                  per-session token usage
  <hq>/ops/egress.log             domains contacted (TSV: ts, domain, tool, url)
  <hq>/ops/metrics/session-eval.log  the session-eval automation's own runs
  <hq>/.claude/settings.json      registered hooks per event (inventory + stale)
  <hq>/.claude/skills, ~/.claude/skills   skills (inventory + stale)
  <hq>/ops/mcp/*.json             MCP profiles (inventory)
  bd list -l acquisition --json   acquisition beads, matched to items by name

Seams for tests: --home, --hq, --now (ISO), --no-bd.
"""

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
from datetime import datetime, timezone

WINDOWS = (7, 30, 90)
DAY_S = 86400.0
CLOCK_SKEW_S = 3600.0          # future-dated records beyond this are quarantined as unstamped
MAX_FILES = 2000               # transcript files per run
MAX_ITEMS = 500                # report rows; the rest is counted, not listed
SECRET_RE = re.compile(r"(?i)(bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|(?:token|password|secret|api[_-]?key)\s*[=:]\s*\S+)")

# The CLI surface the design names (lucy and review are one tool).
CLI_TOOLS = {"bd", "graphify", "lucy", "vault", "pp", "notify", "spawn", "finish", "snooze", "console", "ctl"}
CLI_ALIASES = {"review": "lucy", "notify.sh": "notify", "spawn.sh": "spawn", "finish.sh": "finish",
               "snooze.sh": "snooze", "console.sh": "console", "ctl.sh": "ctl", "lucy.sh": "lucy",
               "review.sh": "lucy", "vault.sh": "vault"}
WRAPPERS = {"sudo", "env", "exec", "nohup", "command", "time"}

HOOK_ERR_RE = re.compile(r"hook error: \[[^\]]*?/?(hook-[A-Za-z0-9_-]+)(?:\.sh)?\]:?\s*(.*)", re.S)


def usable_ts(ts, now_s):
    """A future-dated record (beyond clock skew) is quarantined as unstamped
    rather than counted in every window forever (lucy)."""
    if ts is None or ts > now_s + CLOCK_SKEW_S:
        return None
    return ts


def parse_ts(v):
    if not v or not isinstance(v, str):
        return None
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


# ---------------------------------------------------------------- tokenizer

def split_segments(command):
    """Quote-aware split of a shell command into segments on ; | & && || and
    newlines. Quotes and backslashes keep separators literal; an unquoted #
    comments out the rest of its line (lucy: `echo ok # ; bd delete` must not
    count bd). Command substitutions $(...) outside single quotes are emitted
    as their own segments, because their contents execute even inside double
    quotes (lucy: `echo "$(bd list)"` runs bd)."""
    segs, buf = [], []
    q = None
    esc = False
    comment = False
    text = str(command)
    for ch in text:
        if comment:
            if ch == "\n":
                comment = False
            continue
        if esc:
            buf.append(ch)
            esc = False
            continue
        if ch == "\\":
            buf.append(ch)
            esc = True
            continue
        if q:
            buf.append(ch)
            if ch == q:
                q = None
            continue
        if ch in "'\"":
            q = ch
            buf.append(ch)
            continue
        if ch == "#":
            seg = "".join(buf).strip()
            if seg:
                segs.append(seg)
            buf = []
            comment = True
            continue
        if ch in ";|&\n":
            seg = "".join(buf).strip()
            if seg:
                segs.append(seg)
            buf = []
            continue
        buf.append(ch)
    seg = "".join(buf).strip()
    if seg:
        segs.append(seg)
    # $(...) contents execute wherever they appear except inside single quotes;
    # a nesting-naive span scan is enough for head counting.
    out = list(segs)
    for m in re.finditer(r"\$\(([^()]{1,500})\)", strip_single_quoted(text)):
        out.extend(split_segments(m.group(1)))
    return out


def strip_single_quoted(text):
    """Blank out single-quoted spans so $() inside them is not scanned."""
    return re.sub(r"'[^']*'", "''", text)


def segment_head(segment):
    """The command a segment invokes: leading env assignments, wrappers and
    timeout arguments are skipped; the head is the basename, alias-mapped."""
    toks = segment.split()
    i = 0
    while i < len(toks):
        t = toks[i].strip("(")
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", t):
            i += 1
            continue
        base = os.path.basename(t)
        if base in WRAPPERS:
            i += 1
            while i < len(toks) and toks[i].startswith("-"):
                if toks[i] in ("-u", "--user") and i + 1 < len(toks):
                    i += 2
                else:
                    i += 1
            continue
        if base == "timeout":
            i += 1
            while i < len(toks) and re.match(r"^(-\w+|\d+[smh]?)$", toks[i]):
                i += 1
            continue
        return CLI_ALIASES.get(base, base)
    return None


def cli_heads(command):
    out = set()
    for seg in split_segments(command):
        head = segment_head(seg)
        if head in CLI_TOOLS:
            out.add(head)
    return out


# ---------------------------------------------------------------- items

class Item:
    def __init__(self, id_, name, kind):
        self.id = id_
        self.name = name
        self.kind = kind
        self.events = []          # (ts|None, session) uses
        self.errs = []            # (ts|None, session) failed results
        self.blocks = []          # (ts|None, reason) for hooks
        self.inventory = False    # discovered by inventory scan
        self.stale = None         # reason string when the item points nowhere
        self.detail = None        # kind-specific inventory line
        self.acquisitions = []    # [{id, title}]

    def add(self, ts, session):
        self.events.append((ts, session))

    def err(self, ts, session):
        self.errs.append((ts, session))


class Stack:
    def __init__(self, now_s):
        self.now = now_s
        self.items = {}

    def item(self, id_, name, kind):
        it = self.items.get(id_)
        if not it:
            it = self.items[id_] = Item(id_, name, kind)
        return it


# ---------------------------------------------------------------- transcripts

def safe_int(v, cap=10**9):
    try:
        n = int(v)
    except (TypeError, ValueError):
        return 0
    return min(max(n, 0), cap)


def scan_transcripts(stack, home, sessions_tokens):
    root = os.path.join(home, ".claude", "projects")
    files = []
    # Recursive: subagent transcripts may nest below the session file (lucy).
    for dirpath, _dirnames, filenames in os.walk(root):
        for f in filenames:
            if f.endswith(".jsonl"):
                files.append(os.path.join(dirpath, f))
        if len(files) > MAX_FILES:
            break
    dropped = max(0, len(files) - MAX_FILES)
    if dropped:
        print(f"stack.py: {dropped} transcript files beyond the cap were skipped", file=sys.stderr)
    for path in files[:MAX_FILES]:
        session = os.path.basename(path)[:-6]
        use_map = {}  # tool_use_id -> [item ids]
        try:
            fh = open(path, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                # One adversarial but valid-JSON record must cost itself, never
                # the collector (lucy): everything per-record is fenced.
                try:
                    d = json.loads(line)
                    if not isinstance(d, dict):
                        continue
                    scan_record(stack, d, session, use_map, sessions_tokens)
                except Exception:
                    continue


def scan_record(stack, d, session, use_map, sessions_tokens):
    t = d.get("type")
    ts = usable_ts(parse_ts(d.get("timestamp")), stack.now)
    if t == "assistant":
        m = d.get("message")
        if not isinstance(m, dict):
            return
        usage = m.get("usage")
        if isinstance(usage, dict):
            tok = sessions_tokens.setdefault(session, 0)
            sessions_tokens[session] = tok + safe_int(usage.get("input_tokens")) + safe_int(usage.get("output_tokens"))
        content = m.get("content")
        for c in content if isinstance(content, list) else []:
            if not isinstance(c, dict) or c.get("type") != "tool_use":
                continue
            ids = classify_tool_use(stack, c, ts, session)
            if isinstance(c.get("id"), str):
                use_map[c["id"]] = ids
    elif t == "user":
        m = d.get("message")
        cont = m.get("content") if isinstance(m, dict) else None
        if not isinstance(cont, list):
            return
        for c in cont:
            if not isinstance(c, dict) or c.get("type") != "tool_result":
                continue
            text = flatten_text(c.get("content"))
            hook = HOOK_ERR_RE.search(text) if text else None
            if hook:
                hid = f"hook:{hook.group(1)}"
                it = stack.item(hid, hook.group(1), "hook")
                # Block text can quote the offending command, which can quote a
                # secret: scrub known shapes before anything is retained (lucy).
                reason = SECRET_RE.sub("[redacted]", " ".join(hook.group(2).split()))[:120]
                it.blocks.append((ts, reason))
            if c.get("is_error"):
                for iid in use_map.get(c.get("tool_use_id"), []):
                    it = stack.items.get(iid)
                    if it:
                        it.err(ts, session)


def flatten_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(x.get("text", "") for x in content if isinstance(x, dict))
    return ""


def classify_tool_use(stack, c, ts, session):
    name = str(c.get("name") or "")
    inp = c.get("input") or {}
    ids = []
    if name.startswith("mcp__"):
        parts = name.split("__")
        server = parts[1] if len(parts) > 1 else "unknown"
        it = stack.item(f"mcp:{server}", server, "mcp")
        it.add(ts, session)
        ids.append(it.id)
        return ids
    if name == "Skill":
        skill = str(inp.get("skill") or "unknown")
        it = stack.item(f"skill:{skill}", skill, "skill")
        it.add(ts, session)
        ids.append(it.id)
        return ids
    tool = stack.item(f"tool:{name}", name, "tool")
    tool.add(ts, session)
    ids.append(tool.id)
    if name in ("Task", "Agent"):
        agent = str(inp.get("subagent_type") or "general-purpose")
        it = stack.item(f"agent:{agent}", agent, "agent")
        it.add(ts, session)
        ids.append(it.id)
    if name == "Bash":
        for head in cli_heads(str(inp.get("command") or "")):
            it = stack.item(f"cli:{head}", head, "cli")
            it.add(ts, session)
            ids.append(it.id)
    return ids


# ---------------------------------------------------------------- flat logs

def scan_egress(stack, hq):
    try:
        fh = open(os.path.join(hq, "ops", "egress.log"), encoding="utf-8", errors="replace")
    except OSError:
        return
    domains_capped = 0
    with fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2:
                continue
            ts = usable_ts(parse_ts(parts[0]), stack.now)
            domain = parts[1].strip()[:120]
            if not domain or "=" in domain:
                continue
            key = f"domain:{domain}"
            if key not in stack.items and sum(1 for i in stack.items.values() if i.kind == "domain") >= 300:
                domains_capped += 1
                continue
            it = stack.item(key, domain, "domain")
            it.add(ts, parts[2] if len(parts) > 2 else "egress")
    if domains_capped:
        print(f"stack.py: {domains_capped} egress lines beyond the 300-domain cap were skipped", file=sys.stderr)


def scan_session_eval(stack, hq):
    try:
        fh = open(os.path.join(hq, "ops", "metrics", "session-eval.log"), encoding="utf-8", errors="replace")
    except OSError:
        return
    it = stack.item("auto:session-eval", "session-eval", "automation")
    with fh:
        for line in fh:
            parts = line.split("\t")
            if not parts:
                continue
            ts = usable_ts(parse_ts(parts[0]), stack.now)
            sid = parts[1].removeprefix("sid=") if len(parts) > 1 else "unknown"
            it.add(ts, sid)


# ---------------------------------------------------------------- inventory

def inventory(stack, home, hq):
    # hooks registered in settings.json, per event; stale when the script is gone
    try:
        s = json.load(open(os.path.join(hq, ".claude", "settings.json")))
        for event, matchers in (s.get("hooks") or {}).items():
            for m in matchers if isinstance(matchers, list) else []:
                for h in (m.get("hooks") or []) if isinstance(m, dict) else []:
                    cmd = str(h.get("command") or "")
                    base = re.search(r"(hook-[A-Za-z0-9_-]+)\.sh", cmd)
                    name = base.group(1) if base else os.path.basename(cmd.split()[0] if cmd.split() else cmd)
                    if not name:
                        continue
                    it = stack.item(f"hook:{name}", name, "hook")
                    it.inventory = True
                    events = (it.detail or "").split(", ") if it.detail else []
                    if event not in events:
                        it.detail = ", ".join(events + [event]) if events else event
                    # Stale only means "points at a path that no longer exists";
                    # a bare command (bd prime) resolves on PATH and is not
                    # judged. shlex keeps a quoted path whole (lucy).
                    try:
                        toks = shlex.split(cmd.replace("$CLAUDE_PROJECT_DIR", hq))
                    except ValueError:
                        toks = cmd.replace("$CLAUDE_PROJECT_DIR", hq).split()
                    path = toks[0] if toks else ""
                    if "/" in path and not os.path.exists(path):
                        it.stale = f"command missing: {path}"
    except Exception:
        pass
    # skills: project and user
    for root, scope in ((os.path.join(hq, ".claude", "skills"), "project"), (os.path.join(home, ".claude", "skills"), "user")):
        try:
            for name in os.listdir(root):
                d = os.path.join(root, name)
                if not os.path.isdir(d):
                    continue
                it = stack.item(f"skill:{name}", name, "skill")
                it.inventory = True
                it.detail = scope
                if not os.path.exists(os.path.join(d, "SKILL.md")):
                    it.stale = "no SKILL.md"
        except OSError:
            pass
    # MCP profiles
    try:
        for f in os.listdir(os.path.join(hq, "ops", "mcp")):
            if f.endswith(".json"):
                it = stack.item(f"mcp-profile:{f[:-5]}", f[:-5], "mcp-profile")
                it.inventory = True
    except OSError:
        pass
    # the CLI surface is inventory even at zero use
    for cli in sorted(CLI_TOOLS):
        stack.item(f"cli:{cli}", cli, "cli").inventory = True


def acquisitions(stack, hq, skip):
    if skip:
        return []
    try:
        r = subprocess.run(["bd", "list", "-l", "acquisition", "--json"], cwd=hq,
                           capture_output=True, text=True, timeout=30)
        rows = json.loads(r.stdout) if r.returncode == 0 else []
    except Exception:
        rows = []
    out = []
    for b in rows if isinstance(rows, list) else []:
        bid = str(b.get("id") or "")
        title = str(b.get("title") or "")
        if not bid:
            continue
        out.append({"id": bid, "title": title})
        low = title.lower()
        for it in stack.items.values():
            if it.name.lower() in low and len(it.name) >= 3:
                it.acquisitions.append({"id": bid, "title": title[:120]})
    return out


# ---------------------------------------------------------------- report

def windowed(events, errs, now, days):
    cut = now - days * DAY_S
    uses = 0
    sessions = set()
    for ts, session in events:
        if ts is None or ts < cut:
            continue
        uses += 1
        sessions.add(session)
    errors = sum(1 for ts, _ in errs if ts is not None and ts >= cut)
    return {"uses": uses, "sessions": len(sessions), "errors": errors}


def verdict_hint(it, w90, blocks90):
    if it.stale:
        return "stale"
    if it.kind == "hook":
        if blocks90 >= 15:
            return "friction"
        return "value" if it.inventory else "value"
    if w90["uses"] == 0:
        return "unused" if it.inventory else "quiet"
    if w90["uses"] <= 2:
        return "low-use"
    if w90["uses"] and w90["errors"] * 10 > w90["uses"]:
        return "friction"
    return "value"


def report(stack, sessions_tokens, acq):
    now = stack.now
    items = []
    for it in stack.items.values():
        wins = {str(d): windowed(it.events, it.errs, now, d) for d in WINDOWS}
        blocks90 = sum(1 for ts, _ in it.blocks if ts is not None and ts >= now - 90 * DAY_S)
        stamped = [ts for ts, _ in it.events if ts is not None] + [ts for ts, _ in it.blocks if ts is not None]
        unstamped = sum(1 for ts, _ in it.events if ts is None)
        # Token attribution is session-level and coarse by design: the tokens
        # of every session that used the item inside the 90-day window.
        cut = now - 90 * DAY_S
        used_sessions = {s for ts, s in it.events if ts is not None and ts >= cut}
        tokens90 = sum(sessions_tokens.get(s, 0) for s in used_sessions)
        top_reason = None
        if it.blocks:
            counts = {}
            for _, reason in it.blocks:
                key = reason[:60]
                counts[key] = counts.get(key, 0) + 1
            top_reason = max(counts, key=counts.get)
        items.append({
            "id": it.id,
            "name": it.name,
            "kind": it.kind,
            "windows": wins,
            "lastUsed": datetime.fromtimestamp(max(stamped), tz=timezone.utc).isoformat() if stamped else None,
            "unstamped": unstamped,
            "blocks90": blocks90,
            "topBlockReason": top_reason,
            "tokens90": tokens90,
            "inventory": it.inventory,
            "stale": it.stale,
            "detail": it.detail,
            "acquisitions": it.acquisitions[:5],
            "verdictHint": verdict_hint(it, wins["90"], blocks90),
        })
    items.sort(key=lambda x: (-x["windows"]["90"]["uses"], x["id"]))
    truncated = max(0, len(items) - MAX_ITEMS)
    items = items[:MAX_ITEMS]
    if truncated:
        # never a silent cap: the report says what it dropped
        print(f"stack.py: {truncated} items beyond the {MAX_ITEMS}-row cap were dropped", file=sys.stderr)
    return {
        "generatedAt": datetime.fromtimestamp(now, tz=timezone.utc).isoformat(),
        "windows": list(WINDOWS),
        "items": items,
        "truncatedItems": truncated,
        "acquisitionBeads": acq,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", default=os.path.expanduser("~"))
    ap.add_argument("--hq", default=os.environ.get("HQ_ROOT", os.path.expanduser("~/hq")))
    ap.add_argument("--now", default=None, help="ISO timestamp seam for tests")
    ap.add_argument("--no-bd", action="store_true", help="skip the bd acquisition lookup")
    args = ap.parse_args()

    now_s = parse_ts(args.now) if args.now else datetime.now(tz=timezone.utc).timestamp()
    if now_s is None:
        print("stack.py: bad --now", file=sys.stderr)
        sys.exit(2)

    stack = Stack(now_s)
    sessions_tokens = {}
    scan_transcripts(stack, args.home, sessions_tokens)
    scan_egress(stack, args.hq)
    scan_session_eval(stack, args.hq)
    inventory(stack, args.home, args.hq)
    acq = acquisitions(stack, args.hq, args.no_bd)
    json.dump(report(stack, sessions_tokens, acq), sys.stdout)
    print()


if __name__ == "__main__":
    main()
