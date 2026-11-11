#!/usr/bin/env python3
"""decision-record.py (hq-0yagv.3): the owner's decision record.

One JSON line per decision the owner made, built deterministically (no LLM) from:
  1. the console request store (state/console/requests.json plus answers/):
     every ask that carries answer text;
  2. the session archive (/srv/session-archive/<host>/projects/**.jsonl[@v].zst):
     every answered AskUserQuestion (one record per question), and every
     genuine user turn that follows an assistant turn ending in a question;
  3. the beads ledgers (hq, xd, dp, gt, ck): the outcome of each bead the
     decision names (status, closed_at, close_reason).

Each record keeps the question as asked, the options and the recommended one,
the owner's answer verbatim, the evidence names cited in the question or the
preceding agent turn (files, links without query strings, numbers), bead ids,
and the outcome. Tool outputs are never read into a record, and secret-shaped
strings are redacted, so the file holds no secrets.

Idempotent: the same inputs give a byte-identical file (records sorted, no run
timestamp); the file is rewritten only when its content changes. Local only,
directory 0700, file 0600; nothing is sent anywhere.

  decision-record.py [--out FILE] [--quiet] [--refresh-george]

George's WSL hq ledger holds beads hqbox never saw (the lodgeco POS work);
--refresh-george copies its outcome fields to ledger-george-wsl.json beside
the output, and every run reads that snapshot after the hqbox ledgers.

Env (fixtures): DR_ARCHIVE (/srv/session-archive), DR_CONSOLE
(~/hq/state/console), DR_REGISTRY (~/hq/state/sessions.json), DR_HQ (~/hq),
DR_LEDGER_JSON (a JSON list of bead rows used instead of calling bd).
Exit: 0 ok, 1 input error (console store or an hqbox ledger unreadable), 4 fewer than half of the closed console asks link
to an answer (the bead's stop condition: ask the owner).
"""
import argparse
import collections
import glob
import json
import os
import re
import shutil
import subprocess
import sys

HOME = os.path.expanduser("~")
HQ = os.environ.get("DR_HQ", os.path.join(HOME, "hq"))
ARCHIVE = os.environ.get("DR_ARCHIVE", "/srv/session-archive")
CONSOLE = os.environ.get("DR_CONSOLE", os.path.join(HQ, "state", "console"))
REGISTRY = os.environ.get("DR_REGISTRY", os.path.join(HQ, "state", "sessions.json"))
DEFAULT_OUT = os.path.join(ARCHIVE, "decisions", "decisions.jsonl")
# the systemd user manager's PATH has no ~/.local/bin, where bd lives
BD = shutil.which("bd") or os.path.join(HOME, ".local", "bin", "bd")

LEDGERS = {"hq": ".", "xd": "rigs/acme-dashboard", "dp": "rigs/fintrack-portfolio",
           "gt": "rigs/gym-tracker", "ck": "rigs/chesski"}
PREFIX_RIG = {"xd": "acme-dashboard", "dp": "fintrack-portfolio",
              "gt": "gym-tracker", "ck": "chesski"}

ANSWER_MAX = 8000      # a pasted dictation can be huge; keep the head, flag the cut
QUESTION_MAX = 3000
EVIDENCE_MAX = 12

# ---------------------------------------------------------------- scrubbing
SECRET_RES = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S),
    re.compile(r"\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}"),
    re.compile(r"\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\b(?:sbp|vercel|npm|glpat|pk_live|sk_live|rk_live)_[A-Za-z0-9_-]{16,}"),
    re.compile(r"(?i)\b(postgres(?:ql)?://[^:\s/]+:)[^@\s]+(@)"),
]
KV_SECRET = re.compile(
    r"(?i)\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*)"
    r"([\"']?)[^\s\"']{6,}\2")
# a URL query parameter whose name looks like a credential (?key=, &token=, &sig=)
QUERY_SECRET = re.compile(
    r"(?i)([?&][\w.-]*(?:key|token|secret|sig|signature|auth|code|pass|pwd|credential)[\w.-]*=)"
    r"[^&\s#\"'<>]+")
# a long mixed-case alphanumeric run with digits and no path or word shape
HIGH_ENTROPY = re.compile(r"(?<![A-Za-z0-9/._-])[A-Za-z0-9+_-]{32,}(?![A-Za-z0-9/._-])")


def _entropic(tok):
    return bool(re.search(r"[a-z]", tok) and re.search(r"[A-Z]", tok)
                and re.search(r"[0-9]", tok) and not re.fullmatch(r"[0-9a-f-]+", tok))


def scrub(text):
    if not text:
        return text
    for rx in SECRET_RES:
        if rx.groups == 2:
            text = rx.sub(lambda m: m.group(1) + "[REDACTED]" + m.group(2), text)
        else:
            text = rx.sub("[REDACTED]", text)
    text = KV_SECRET.sub(lambda m: m.group(1) + "[REDACTED]", text)
    text = QUERY_SECRET.sub(lambda m: m.group(1) + "[REDACTED]", text)
    text = HIGH_ENTROPY.sub(lambda m: "[REDACTED]" if _entropic(m.group(0)) else m.group(0), text)
    return text


def clip(text, n):
    text = scrub(text or "")
    if len(text) > n:
        return text[:n], True
    return text, False


# ---------------------------------------------------------------- evidence
BEAD_RE = re.compile(r"\b(?:hq|xd|dp|gt|ck)-[a-z0-9]{3,6}(?:\.\d+)*\b")
REQ_RE = re.compile(r"\br-[0-9a-f]{4,8}\b")
URL_RE = re.compile(r"https?://[^\s<>\"'`)\]]+")
PATH_RE = re.compile(
    r"(?<![\w/.:-])(?:~/|/(?:home|srv|mnt|etc|tmp|var|opt)/|"
    r"(?:ops|state|rigs|docs|src|app|lib|api|scripts|bunkers|tests?|web|public|supabase|\.claude)/)"
    r"[\w@%+.,/-]*[\w/]")
FILE_RE = re.compile(r"(?<![\w/.-])[\w-]+\.(?:md|py|sh|ts|tsx|js|jsx|json|jsonl|sql|csv|xlsx|xls|pdf|"
                     r"yaml|yml|toml|html|css|txt|png|jpg|docx|pptx)\b")
NUM_RE = re.compile(
    r"(?:(?:US)?\$\s?\d[\d,]*(?:\.\d+)?(?:\s?[kKmM]\b)?"
    r"|\b\d[\d,]*(?:\.\d+)?\s?(?:%|USD|MXN|pesos?|dollars?|ms|GB|MB|KB|TB|hours?|hrs?|"
    r"minutes?|mins?|days?|weeks?|months?|lines?|files?|rows?|beads?|rounds?|tests?|checks?|"
    r"sessions?|calls?|tokens?|requests?|users?|items?|points?)(?![\w]))")


def _uniq(items, n=EVIDENCE_MAX):
    out, seen = [], set()
    for it in items:
        it = it.rstrip(".,;:")
        if it and it not in seen:
            seen.add(it)
            out.append(it)
        if len(out) >= n:
            break
    return out


def evidence(*texts):
    blob = scrub("\n".join(t for t in texts if t))
    links = _uniq(u.split("?")[0].split("#")[0] if "mail.google" not in u else u.split("?")[0]
                  for u in URL_RE.findall(blob))
    noweb = URL_RE.sub(" ", blob)
    files = _uniq(PATH_RE.findall(noweb) + FILE_RE.findall(noweb))
    nums = _uniq(m.group(0).strip() for m in NUM_RE.finditer(noweb))
    return {"files": files, "links": links, "numbers": nums}


def cited_ids(*texts):
    blob = "\n".join(t for t in texts if t)
    return _uniq(BEAD_RE.findall(blob), 50), _uniq(REQ_RE.findall(blob), 50)


# ---------------------------------------------------------------- options
OPT_LINE = re.compile(r"^\s*(?:[-*\N{BULLET}]|\d+[.)]|\(?[a-eA-E][.)])\s+(.+?)\s*$")


def options_from_text(q):
    opts = [m.group(1) for m in map(OPT_LINE.match, q.splitlines()) if m]
    rec = next((o for o in opts if re.search(r"(?i)recommend", o)), None)
    return [{"label": o} for o in opts], rec


def recommended_of(opts):
    for o in opts:
        if re.search(r"(?i)\brecommended\b", o.get("label", "")):
            return o["label"]
    return None


# ---------------------------------------------------------------- rigs
def rig_names():
    dirs = [os.path.join(HQ, x, "*") for x in ("rigs", "ops/services", "bunkers")]
    return {re.sub(r"-[0-9a-f]{4}$", "", os.path.basename(d))
            for g in dirs for d in glob.glob(g) if os.path.isdir(d)}


RIGS = rig_names()


def rig_of_cwd(cwd):
    cwd = (cwd or "").replace("\\", "/")
    m = re.search(r"/hq/rigs/([^/]+)", cwd)
    if m:
        return re.sub(r"-[0-9a-f]{4}$", "", m.group(1))
    m = re.search(r"/hq/(?:ops/services|bunkers)/([^/]+)", cwd)
    if m:
        return m.group(1)
    if re.search(r"/hq(?:/|$)", cwd):
        return "hq"
    return "other:" + (cwd.rstrip("/").rsplit("/", 1)[-1] or cwd)


def rig_of_project_dir(name):
    # archive dir names are the cwd with / replaced by -
    m = re.match(r"-home-owner-hq-rigs-(.+)$", name)
    if m:
        return re.sub(r"-[0-9a-f]{4}$", "", m.group(1))
    if re.match(r"-home-owner-hq(?:-|$)", name):
        return "hq"
    return "other:" + name.strip("-")


# ---------------------------------------------------------------- ledger
def _trim(r, ledger):
    return {"status": r.get("status", ""), "closed_at": r.get("closed_at") or "",
            "close_reason": scrub(r.get("close_reason") or "")[:300],
            "title": scrub(r.get("title") or "")[:200],
            "labels": sorted(r.get("labels") or []), "ledger": ledger}


def bd_rows(cmd, cwd=None, timeout=120):
    out = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if out.returncode != 0:
        raise OSError("exit %d: %s" % (out.returncode, out.stderr.strip()[-200:]))
    return json.loads(out.stdout or "[]")


def refresh_george(snap):
    """Best effort: copy George's WSL hq ledger (id, status, close fields, title,
    labels only) to a local snapshot. George asleep or off keeps the old one."""
    cmd = ["ssh", "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "george",
           'wsl -e bash -lc "cd ~/hq && bd list --all -n 0 --json"']
    try:
        rows = bd_rows(cmd, timeout=180)
    except (OSError, ValueError, subprocess.SubprocessError) as e:
        print("WARN george ledger not refreshed (kept the old snapshot): %s" % e, file=sys.stderr)
        return
    trimmed = {r["id"]: _trim(r, "george-wsl") for r in rows if r.get("id")}
    tmp = snap + ".tmp.%d" % os.getpid()
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(trimmed, fh, sort_keys=True, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, snap)


def load_ledger(snap=None):
    """Bead id to outcome fields: hqbox ledgers first, then George's snapshot."""
    led = {}
    fx = os.environ.get("DR_LEDGER_JSON")
    if fx:
        with open(fx) as fh:
            for r in json.load(fh):
                if r.get("id"):
                    led[r["id"]] = _trim(r, r.get("ledger", "hqbox"))
    else:
        for rel in LEDGERS.values():
            d = os.path.join(HQ, rel)
            if not os.path.isdir(os.path.join(d, ".beads")):
                continue
            # an unreadable ledger is fatal: a partial one would blank outcomes in the record
            for r in bd_rows([BD, "list", "--all", "-n", "0", "--json"], cwd=d):
                if r.get("id"):
                    led[r["id"]] = _trim(r, "hqbox")
    if snap and os.path.isfile(snap):
        try:
            with open(snap) as fh:
                for k, v in json.load(fh).items():
                    led.setdefault(k, v)
        except (OSError, ValueError) as e:
            print("WARN george ledger snapshot unreadable: %s" % e, file=sys.stderr)
    return led


def rig_of_bead(bid, led):
    pfx = bid.split("-", 1)[0]
    if pfx in PREFIX_RIG:
        return PREFIX_RIG[pfx]
    for lb in (led.get(bid) or {}).get("labels") or []:
        if lb in RIGS and lb != "hq":
            return lb
    return "hq" if pfx == "hq" and bid in led else ""


def outcome(beads, led):
    return {b: {k: led[b][k] for k in ("status", "closed_at", "close_reason", "title", "ledger")}
            for b in beads if b in led}


# ---------------------------------------------------------------- console
def console_records(led, reg):
    with open(os.path.join(CONSOLE, "requests.json")) as fh:
        reqs = json.load(fh)
    by_id = collections.defaultdict(list)
    for f in sorted(glob.glob(os.path.join(CONSOLE, "answers", "r-*.txt"))):
        by_id[re.sub(r"-[0-9a-f]+\.txt$", "", os.path.basename(f))].append(f)
    recs, stats = [], collections.Counter()
    for r in reqs:
        rid = r.get("id", "")
        stats["asks"] += 1
        st = r.get("status", "open")
        if st != "open":
            stats["closed_asks"] += 1
        files = []
        af = r.get("answer_file") or ""
        if af and os.path.isfile(af):
            files.append(af)
        files += [f for f in by_id.get(rid, []) if f not in files]
        texts = []
        for f in files:
            try:
                with open(f, errors="replace") as fh:
                    t = fh.read().rstrip("\n")
            except OSError:
                continue
            if t.strip():
                texts.append(t)
        if not texts:
            continue
        stats["answered"] += 1
        q = r.get("question", "")
        qtxt, qcut = clip(q, QUESTION_MAX)
        ans, acut = clip(texts[0], ANSWER_MAX)
        opts, rec = options_from_text(q)
        cited, _ = cited_ids(q, r.get("why", ""))
        beads = _uniq(([r["bead"]] if r.get("bead") else []) + [b for b in cited if b in led], 50)
        sess = r.get("session", "")
        rig = ((reg.get(sess) or {}).get("rig") or "") if sess else ""
        if not rig and beads:
            rig = rig_of_bead(beads[0], led)
        o = {
            "id": "console:" + rid,
            "source": "console",
            "when": r.get("answered_ts") or r.get("ts") or "",
            "asked_at": r.get("ts") or "",
            "answered_at": r.get("answered_ts") or "",
            "rig": rig,
            "session": sess,
            "request_id": rid,
            "request_status": st,
            "kind": r.get("kind", ""),
            "severity": r.get("sev", ""),
            "question": qtxt,
            "options": [{"label": scrub(x["label"])} for x in opts],
            "recommended": scrub(rec) if rec else None,
            "answer": ans,
            "answer_kind": "text",
            "evidence": evidence(q, r.get("why", ""), r.get("link", "")),
            "bead_ids": beads,
            "outcome": outcome(beads, led),
        }
        if len(texts) > 1:
            o["other_answers"] = [clip(t, ANSWER_MAX)[0] for t in texts[1:]]
        if qcut or acut:
            o["truncated"] = True
        recs.append(o)
    return recs, stats


# ---------------------------------------------------------------- transcripts
def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text")
    return ""


NOT_HUMAN = re.compile(r"^\s*(?:<(?:command-|local-command|system-reminder|task-notification|"
                       r"bash-|user-prompt-submit-hook)|\[Request interrupted|Caveat:)")


def is_human_turn(o):
    if o.get("type") != "user" or o.get("isMeta") or o.get("isSidechain") \
            or o.get("isCompactSummary") or o.get("isVisibleInTranscriptOnly"):
        return False
    if o.get("userType") not in (None, "external"):
        return False
    c = (o.get("message") or {}).get("content")
    if isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
        return False
    t = text_of(c)
    return bool(t.strip()) and not NOT_HUMAN.match(t)


def last_question(text):
    """The final paragraph of an assistant turn when it ends in a question mark."""
    t = re.sub(r"[\s*_`)\]]+$", "", text or "")
    if not t.endswith("?"):
        return ""
    paras = [p for p in re.split(r"\n\s*\n", t) if p.strip()]
    q = paras[-1] if paras else t
    # keep an option list that sits right above the question line
    if len(paras) >= 2 and all(OPT_LINE.match(l) for l in paras[-2].splitlines() if l.strip()):
        q = paras[-2] + "\n\n" + q
    return q


def transcript_files():
    out = []
    hosts = sorted(os.listdir(ARCHIVE)) if os.path.isdir(ARCHIVE) else []
    for host in hosts:
        proj = os.path.join(ARCHIVE, host, "projects")
        if not os.path.isdir(proj):
            continue
        for root, dirs, files in os.walk(proj):
            dirs[:] = sorted(d for d in dirs if d not in ("subagents", "tool-results"))
            out += [os.path.join(root, f) for f in files
                    if re.search(r"\.jsonl(?:@[\w-]+)?\.zst$", f)]
    # the live copy before its kept-both versions, so first-seen wins deterministically
    return sorted(out, key=lambda p: (re.sub(r"@[\w-]+\.zst$", ".zst", p), "@" in os.path.basename(p), p))


def read_zst(path):
    try:
        p = subprocess.run(["zstd", "-dc", "--", path], capture_output=True, timeout=300)
    except (OSError, subprocess.SubprocessError) as e:
        print("WARN cannot read %s: %s" % (path, e), file=sys.stderr)
        return []
    lines = []
    for l in p.stdout.decode("utf-8", "replace").splitlines():
        try:
            lines.append(json.loads(l))
        except ValueError:
            continue
    return lines


def transcript_records(led, seen, stats):
    recs = []
    for path in transcript_files():
        rel = os.path.relpath(path, ARCHIVE)
        parts = rel.split(os.sep)
        host, projdir = parts[0], (parts[2] if len(parts) > 3 else "")
        pending = {}           # tool_use_id -> (tool_use block, its record, turn context)
        turn_text = []         # assistant text since the last human turn
        last_asst = ""         # text of the last assistant message, if it ended the turn
        last_asst_id = None
        declined_wait = []     # declined AskUserQuestion records waiting for the owner's next message
        for o in read_zst(path):
            if o.get("isSidechain"):
                continue
            typ = o.get("type")
            msg = o.get("message") or {}
            c = msg.get("content")
            if typ == "assistant" and isinstance(c, list):
                mid = msg.get("id") or o.get("uuid")
                if mid != last_asst_id:
                    last_asst, last_asst_id = "", mid
                for b in c:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "text":
                        last_asst = (last_asst + "\n" + b.get("text", "")).strip()
                        turn_text.append(b.get("text", ""))
                    elif b.get("type") == "tool_use":
                        last_asst = ""      # a tool call after the text: the turn did not end on it
                        if b.get("name") == "AskUserQuestion":
                            pending[b.get("id")] = (b, o, "\n".join(turn_text))
                continue
            if typ != "user":
                continue
            if isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result"
                                           for b in c):
                for b in c:
                    if not (isinstance(b, dict) and b.get("type") == "tool_result"):
                        continue
                    tid = b.get("tool_use_id")
                    if tid not in pending:
                        continue
                    use, uo, ctx = pending.pop(tid)
                    if ("auq", tid) in seen:
                        continue
                    seen.add(("auq", tid))
                    new = auq_records(use, uo, o, b, ctx, host, projdir, rel, led)
                    stats["auq_calls"] += 1
                    stats["auq_questions"] += len(new)
                    recs.extend(new)
                    if b.get("is_error"):
                        declined_wait.extend(new)
                continue
            if not is_human_turn(o):
                continue
            utext = text_of(c)
            for d in declined_wait:
                d["followup"] = clip(utext, ANSWER_MAX)[0]
            declined_wait = []
            q = last_question(last_asst)
            uid = o.get("uuid")
            if q and uid and ("turn", uid) not in seen:
                seen.add(("turn", uid))
                recs.append(turn_record(q, "\n".join(turn_text), utext, o, host, projdir, rel, led))
                stats["turn_questions"] += 1
            turn_text, last_asst, last_asst_id = [], "", None
        for k in pending:
            if ("auq", k) not in seen and ("auq-open", k) not in seen:
                seen.add(("auq-open", k))
                stats["auq_unanswered"] += 1
    return recs


def _base(o, host, projdir, rel):
    cwd = o.get("cwd") or ""
    return {"host": host, "rig": rig_of_cwd(cwd) if cwd else rig_of_project_dir(projdir),
            "session": o.get("sessionId", ""), "transcript": rel}


def _refine_rig(r, beads, led):
    if r["rig"] == "hq" and beads:
        r["rig"] = rig_of_bead(beads[0], led) or "hq"


def auq_records(use, uo, ro, res, ctx, host, projdir, rel, led):
    inp = use.get("input") or {}
    tur = ro.get("toolUseResult") if isinstance(ro.get("toolUseResult"), dict) else {}
    answers = tur.get("answers") or {}
    notes = tur.get("annotations") or {}
    err = bool(res.get("is_error"))
    out = []
    for i, qd in enumerate(inp.get("questions") or []):
        q = qd.get("question", "")
        opts = [{"label": scrub(op.get("label", "")), "description": scrub(op.get("description", ""))}
                for op in qd.get("options") or []]
        labels = {op.get("label", "") for op in qd.get("options") or []}
        if err:
            ans, kind = "", "declined"
        elif q not in answers:
            ans, kind = "", "no_answer"
        else:
            ans = str(answers[q])
            picked = [p.strip() for p in ans.split(",")] if qd.get("multiSelect") else [ans]
            kind = "option" if all(p in labels for p in picked) else "other"
        desc = "\n".join(op.get("description", "") for op in qd.get("options") or [])
        beads = [b for b in cited_ids(q, desc, ctx)[0] if b in led]
        qtxt, qcut = clip(q, QUESTION_MAX)
        atxt, acut = clip(ans, ANSWER_MAX)
        r = {"id": "auq:%s:%d" % (use.get("id"), i), "source": "ask_user_question",
             "when": ro.get("timestamp") or uo.get("timestamp") or "",
             "asked_at": uo.get("timestamp") or "", "answered_at": ro.get("timestamp") or ""}
        r.update(_base(uo, host, projdir, rel))
        r.update({"tool_use_id": use.get("id"), "header": scrub(qd.get("header", "")),
                  "multi_select": bool(qd.get("multiSelect")),
                  "question": qtxt, "options": opts, "recommended": recommended_of(opts),
                  "answer": atxt, "answer_kind": kind,
                  "evidence": evidence(q, desc, ctx), "bead_ids": beads,
                  "outcome": outcome(beads, led)})
        if notes.get(q):
            n = notes[q] if isinstance(notes[q], str) else json.dumps(notes[q], sort_keys=True,
                                                                      ensure_ascii=False)
            r["notes"] = clip(n, ANSWER_MAX)[0]
        _refine_rig(r, beads, led)
        if qcut or acut:
            r["truncated"] = True
        out.append(r)
    return out


def turn_record(q, ctx, utext, o, host, projdir, rel, led):
    beads = [b for b in cited_ids(q, ctx)[0] if b in led]
    qtxt, qcut = clip(q, QUESTION_MAX)
    atxt, acut = clip(utext, ANSWER_MAX)
    opts, rec = options_from_text(q)
    r = {"id": "turn:" + o.get("uuid", ""), "source": "turn_question",
         "when": o.get("timestamp", ""), "asked_at": "", "answered_at": o.get("timestamp", "")}
    r.update(_base(o, host, projdir, rel))
    r.update({"message_uuid": o.get("uuid", ""), "question": qtxt,
              "options": [{"label": scrub(x["label"])} for x in opts],
              "recommended": scrub(rec) if rec else None,
              "answer": atxt, "answer_kind": "text",
              "evidence": evidence(q, ctx), "bead_ids": beads, "outcome": outcome(beads, led)})
    _refine_rig(r, beads, led)
    if qcut or acut:
        r["truncated"] = True
    return r


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="Build the owner's decision record (hq-0yagv.3).")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--refresh-george", action="store_true",
                    help="first copy George's WSL ledger to a local snapshot (best effort)")
    a = ap.parse_args()
    os.umask(0o077)
    try:
        with open(REGISTRY) as fh:
            reg = json.load(fh)
    except (OSError, ValueError):
        reg = {}
    d = os.path.dirname(os.path.abspath(a.out))
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    snap = os.path.join(d, "ledger-george-wsl.json")
    if a.refresh_george:
        refresh_george(snap)
    try:
        led = load_ledger(snap)
    except (OSError, ValueError, subprocess.SubprocessError) as e:
        print("FAIL ledger unreadable, record left as it was: %s" % e, file=sys.stderr)
        return 1
    try:
        crecs, cstats = console_records(led, reg)
    except (OSError, ValueError) as e:
        print("FAIL console store unreadable: %s" % e, file=sys.stderr)
        return 1
    stats = collections.Counter()
    trecs = transcript_records(led, set(), stats)
    recs = sorted(crecs + trecs, key=lambda r: (r.get("when", ""), r["id"]))
    body = "".join(json.dumps(r, sort_keys=True, ensure_ascii=False) + "\n" for r in recs)

    old = None
    if os.path.exists(a.out):
        with open(a.out, encoding="utf-8") as fh:
            old = fh.read()
    if old != body:
        tmp = a.out + ".tmp.%d" % os.getpid()
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(body)
        os.replace(tmp, a.out)
    os.chmod(a.out, 0o600)

    closed, linked = cstats["closed_asks"], cstats["answered"]
    if not a.quiet:
        by_month = collections.Counter((r.get("when") or "")[:7] or "unknown" for r in recs)
        by_src = collections.Counter(r["source"] for r in recs)
        print("decision-record: %d records to %s (%s)" % (
            len(recs), a.out, "unchanged" if old == body else "written"))
        print("sources: " + ", ".join("%s=%d" % kv for kv in sorted(by_src.items())))
        print("console: %d asks, %d closed, %d with an answer" % (cstats["asks"], closed, linked))
        print("ask_user_question: %d answered calls, %d questions, %d unanswered calls" % (
            stats["auq_calls"], stats["auq_questions"], stats["auq_unanswered"]))
        print("by month: " + ", ".join("%s=%d" % kv for kv in sorted(by_month.items())))
    if closed and linked * 2 < closed:
        print("STOP fewer than half of the closed console asks link to an answer (%d of %d): ask the owner"
              % (linked, closed), file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main())
