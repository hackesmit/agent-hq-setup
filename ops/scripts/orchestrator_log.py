#!/usr/bin/env python3
"""Orchestrator records and audit (hq-4npjr.6, docs/designs/2026-11-04-orchestrator.md
sections 4 and 7; seed ops/templates/orchestrator.md).

  orchestrator_log.py approved <kind> "<text>" --why "<why>" [--bead B] [--rig R]
      append one decision to state/orchestrator/approved.jsonl (the console's
      Orchestrator approved log). kind: merge review answer snooze wake dispatch
      forward fix block.
  orchestrator_log.py update <rig> "<text>"
      set the one update line for a project in state/console/project-updates.json.
  orchestrator_log.py audit [--dry-run]
      the mechanism behind "the orchestrator never answers the owner's questions"
      (invariant 8): read every ask the orchestrator answered itself (requests.json:
      to orchestrator, answered, never forwarded) since the last audit, and flag an
      answer that cites no source or whose question looks like the owner's call
      (business, taste) without citing a request id that owner-facts.md records,
      and every orchestrator ask resolved with no answer and no forward. Unknowable
      questions have no detector (no word marks them); the source rule is the only
      check there. Any flags file
      ONE P1 bead for the day listing them. Run daily by hq-orchestrator-audit.timer.

Writes hold a flock on state/orchestrator/log.lock. Text fields are one line,
control characters stripped, at most 240 characters (the console's limit).
Seams: HQ_ROOT, HQ_ORCH_DIR, HQ_CONSOLE_DIR, HQ_BD, HQ_FACTS.
"""
import argparse
import datetime as dt
import fcntl
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("HQ_ROOT") or os.path.dirname(os.path.dirname(HERE))
D = os.environ.get("HQ_ORCH_DIR") or os.path.join(ROOT, "state", "orchestrator")
CONSOLE = os.environ.get("HQ_CONSOLE_DIR") or os.path.join(ROOT, "state", "console")
BD = os.environ.get("HQ_BD") or "bd"
KINDS = ("merge", "review", "answer", "snooze", "wake", "dispatch", "forward", "fix", "block")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

# Words that mark a question as the owner's own call (CLAUDE.md invariant 9: a
# business decision, taste, or something not in the files). Deliberately broad:
# a flag costs one line in a daily P1 bead, a missed one costs a wrong decision.
OWNER_CALL = re.compile(
    # business: money, clients, pricing, what to build next (the seed's forward classes)
    r"\b(price|pricing|prices|priced|charge|fee|fees|quote|budget|spend|pay|paid|invoice|"
    r"subscription|revenue|cost us|money|buy|purchase|plan tier|client|clients|customer|"
    r"customers|contract|legal|lawyer|accountant|tax|hire|partner|"
    r"roadmap|build next|next (feature|project|epic|product|thing)|what (should|do|would) "
    r"(we|i) build|what to build|which (feature|project|epic|product) (next|first)|"
    r"work on next|start next|go live|deadline|priority|prioriti[sz]e|"
    r"should (we|i) (launch|publish|announce|charge|offer|sell|cancel|drop|build|start|stop|ship)|"
    r"keep or revert|delete .*(data|account)|email (to|the)|send .* to|"
    # taste: look, copy, naming, tone
    r"brand|logo|colou?rs?|font|fonts|style|look and feel|how (should|will|does) .{0,40} look|visual design|layout|tone|"
    r"wording|copy text|site copy|ui copy|headline|tagline|naming|name (it|the)|"
    r"prefer|preference|taste|like better|nicer|prettier|"
    r"which (one|option) (do|would|should) (you|owner|we)|"
    r"owner (want|wants|prefer|prefers|like|likes))\b", re.I)
SOURCE_RE = re.compile(r"source:\s*\S", re.I)
REQ_ID_RE = re.compile(r"\br-[0-9a-f]{8}\b")
FACTS = os.environ.get("HQ_FACTS") or os.path.join(ROOT, "ops", "reference", "owner-facts.md")


def fact_ids():
    """Request ids that ops/reference/owner-facts.md records as the owner's standing answers.
    Ids under a heading starting "## Open" are asks still waiting on the owner, not answers."""
    ids, live = set(), True
    try:
        with open(FACTS, encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("## "):
                    live = not line[3:].lstrip().lower().startswith("open")
                elif live:
                    ids.update(REQ_ID_RE.findall(line))
    except OSError:
        pass
    return ids


def now_iso():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def one_line(v, n=240):
    return re.sub(r"[\x00-\x1f\x7f]", " ", str(v or "")).strip()[:n]


class Lock:
    def __enter__(self):
        os.makedirs(D, exist_ok=True)
        self.fh = open(os.path.join(D, "log.lock"), "a")
        fcntl.flock(self.fh, fcntl.LOCK_EX)
        return self

    def __exit__(self, *a):
        fcntl.flock(self.fh, fcntl.LOCK_UN)
        self.fh.close()


def write_json(path, obj):
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            v = json.load(fh)
        return v if isinstance(v, type(default)) else default
    except (OSError, ValueError):
        return default


def die(msg, code=2):
    print("orchestrator_log: " + msg, file=sys.stderr)
    sys.exit(code)


def cmd_approved(a):
    if a.kind not in KINDS:
        die("kind must be one of " + " ".join(KINDS))
    text, why = one_line(a.text), one_line(a.why)
    if not text or not why:
        die("approved needs a text and --why")
    rec = {"ts": now_iso(), "kind": a.kind, "text": text, "why": why}
    for k in ("bead", "rig"):
        v = getattr(a, k)
        if v:
            if not ID_RE.match(v):
                die("bad --%s" % k)
            rec[k] = v
    with Lock():
        with open(os.path.join(D, "approved.jsonl"), "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, sort_keys=True) + "\n")
    print("logged %s: %s" % (a.kind, text))


def cmd_update(a):
    if not ID_RE.match(a.rig or ""):
        die("bad rig")
    text = one_line(a.text)
    if not text:
        die("update needs a text")
    os.makedirs(CONSOLE, exist_ok=True)
    path = os.path.join(CONSOLE, "project-updates.json")
    with Lock():
        cur = load_json(path, {})
        cur[a.rig] = {"at": now_iso(), "text": text}
        write_json(path, cur)
    print("updated %s: %s" % (a.rig, text))


def answer_text(r):
    try:
        with open(r.get("answer_file") or "", encoding="utf-8") as fh:
            return fh.read(4000)
    except OSError:
        return ""


def flags_for(r, facts):
    """Why one orchestrator answer needs the owner's eyes, or []."""
    if r.get("status") == "resolved" and not r.get("answered_ts"):
        return ["resolved with no answer and no forward"]
    ans = answer_text(r)
    out = []
    if not SOURCE_RE.search(ans):
        out.append("no source cited")
    q = " ".join(str(r.get(k) or "") for k in ("question", "why"))
    m = OWNER_CALL.search(q)
    # A the owner's-call question clears only by citing a request id owner-facts.md
    # actually records; the bare file name proves nothing.
    if m and not (set(REQ_ID_RE.findall(ans)) & facts):
        out.append("looks like the owner's call (%s) and cites no owner-facts.md request id" % m.group(0).lower())
    return out


def cmd_audit(a):
    state_path = os.path.join(D, "audit.json")
    with Lock():
        st = load_json(state_path, {})
        seen = set(st.get("seen") or [])
        reqs = load_json(os.path.join(CONSOLE, "requests.json"), [])
        mine = [r for r in reqs if isinstance(r, dict) and r.get("to") == "orchestrator"
                and (r.get("answered_ts") or r.get("status") == "resolved")
                and not r.get("forward_class") and r.get("id") not in seen]
        facts = fact_ids()
        flagged = [(r, f) for r in mine for f in [flags_for(r, facts)] if f]
        print("audited %d orchestrator answers, %d flagged" % (len(mine), len(flagged)))
        if a.dry_run:
            for r, f in flagged:
                print("  %s: %s" % (r.get("id"), "; ".join(f)))
            return
        if flagged:
            day = now_iso()[:10]
            lines = ["The daily orchestrator audit (ops/scripts/orchestrator_log.py audit) found "
                     "answers the orchestrator gave itself that may be the owner's call or cite no source. "
                     "Check each one; correct a wrong answer with the worker and add the right one to "
                     "ops/reference/owner-facts.md. A real miss is a seed defect: fix "
                     "ops/templates/orchestrator.md.", ""]
            for r, f in flagged:
                lines.append("%s (bead %s): Q: %s | A: %s | %s" % (
                    r.get("id"), r.get("bead") or "none", one_line(r.get("question"), 200),
                    one_line(answer_text(r), 200), "; ".join(f)))
            lines += ["", "Definition of Done: every listed answer checked; each wrong one corrected "
                      "and recorded in owner-facts.md; a seed fix filed when the miss repeats."]
            p = subprocess.run([BD, "create", "Orchestrator audit %s: %d answers to check" % (day, len(flagged)),
                                "-d", "\n".join(lines), "-p", "1", "-t", "task",
                                "-l", "P1,hq,orchestrator-audit"],
                               capture_output=True, text=True, cwd=ROOT)
            if p.returncode != 0:
                die("bd create failed: %s" % (p.stderr or p.stdout).strip()[-300:], 3)
            print(p.stdout.strip().splitlines()[0] if p.stdout.strip() else "filed")
        seen.update(r.get("id") for r in mine)
        st = {"seen": sorted(x for x in seen if x), "last_run": now_iso()}
        write_json(state_path, st)


def main(argv):
    ap = argparse.ArgumentParser(prog="orchestrator_log.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("approved")
    p.add_argument("kind")
    p.add_argument("text")
    p.add_argument("--why", default="")
    p.add_argument("--bead", default="")
    p.add_argument("--rig", default="")
    p = sub.add_parser("update")
    p.add_argument("rig")
    p.add_argument("text")
    p = sub.add_parser("audit")
    p.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    {"approved": cmd_approved, "update": cmd_update, "audit": cmd_audit}[a.cmd](a)


if __name__ == "__main__":
    main(sys.argv[1:])
