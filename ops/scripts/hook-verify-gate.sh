#!/usr/bin/env bash
# PreToolUse hook (Bash): the bead-completion verification gate.
# Fires on every bd command that can close a bead (close_targets below: close/done,
# update --status, batch, duplicate, supersede, sql, todo done, import,
# epic close-eligible). Reads each bead from the HQ
# ledger or any rig ledger, decides its change class from the files it owns, and requires a
# `Verification:` receipt in the bead's text with the documented shape
# (`Verification: <class> <sep> <command or tool> <sep> <result>`; separator: plain
# hyphen or em dash; `not run` and `docs-only` take a single evidence field):
#   - receipt present, or `Verification: not run - <blocker>`  -> pass
#   - code/deploy class, receipt absent, HQ_VERIFY_BLOCK != 0  -> BLOCK (exit 2)
#   - any other class, or blocking disabled                    -> log would-block, pass
# Invariant 6: a green DoD is necessary, not sufficient. This is where DoD becomes
# falsifiable at merge. Fail-open: any parse trouble or uncertainty passes (a false
# block is worse than a missed one, per the rollout's own lesson).
# The receipt's CLASS is checked as well: a docs-flavored class (docs-only,
# markdown, memory, report) is refused when the bead owns actual code FILES.
# That check reads the owned-file signal ONLY, never the labels, so a redteam
# pass whose deliverable is a written report still closes on `docs-only`.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="${CLAUDE_PROJECT_DIR:-$(cd "$DIR/../.." && pwd)}"
# A session in an hq worktree records to the main checkout, which outlives the worktree.
_hq_main="$(git -C "$HQ" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
case "$_hq_main" in */.git) [ -d "${_hq_main%/.git}/ops/scripts" ] && HQ="${_hq_main%/.git}" ;; esac
export PATH="$HOME/.local/bin:$PATH"
HOOK_PAYLOAD="$(cat)" export HOOK_PAYLOAD HQ

# Fast path: this gate only fires on a bd command that can close a bead, so a pure-bash
# substring test on the raw payload keeps python off the per-Bash hot path (idiom:
# hook-cdp-password-guard). The test is a deliberate SUPERSET of close_targets() below:
# every close path names one of these subcommands (`--status closed` contains `close`;
# a custom done status still goes through `update`), and JSON encoding cannot hide the
# literals once a backslash-newline continuation (JSON text `\\\n`, or `\\\r\n`) is
# dropped the way bash drops it: `bd cl\<newline>ose` is `bd close`. The raw payload
# is matched too, so the stripping can only add matches, never remove one.
_bs='\'
_fast="${HOOK_PAYLOAD//"$_bs$_bs$_bs"r"$_bs"n/}"
_fast="${_fast//"$_bs$_bs$_bs"n/}"
case "$HOOK_PAYLOAD $_fast" in
  *bd*close*|*bd*done*|*bd*update*|*bd*batch*|*bd*duplicate*|*bd*supersede*|*bd*sql*|*bd*import*) ;;
  *) exit 0 ;;
esac

REASON="$(python3 - <<'PY'
import json, os, re, subprocess, sys, datetime

# Every bd command that can move a bead to closed, not only `bd close <id>`. bd 1.3
# made `bd update --status closed` honor bd's OWN close policy (open children, live
# blockers), which says nothing about receipts, so this gate has to see each path
# itself. The paths: `bd close` and its alias `bd done` (every id, flags anywhere),
# `bd update -s/--status <done>`, `bd batch` (close / update status= lines from a
# heredoc, -f file, < file or inline printf), `bd duplicate` and `bd supersede`
# (both close the first id), and `bd sql` writes that touch status. A close whose
# ids the gate cannot read (`$ID`, xargs, a piped batch) is UNRESOLVED, and since
# this is a guard it blocks rather than passes.
# Round 2 (hq-pgbpq.12 review): a backslash-newline continuation is joined before
# tokenizing; `bd todo done <id>` is the same close; a short or partial id (`d87`,
# `zz-d8`) is resolved through `bd show` exactly as bd itself resolves it, and fails
# closed when no ledger resolves it; `bd import` is gated on every row that would move
# an existing not-closed bead to a done status; `bd epic close-eligible` is refused
# (close epics one at a time). Round 3 (hq-pgbpq.18): a continuation joins with no
# space, as in bash, and after a cd, pushd or popd a relative import path fails closed.
# Round 4: that cd is also seen behind builtin/command/sudo/env, inside an eval, and
# as `env -C DIR` / `env --chdir DIR` in front of bd.
# Known limit: an obfuscated command word
# (`$(echo bd) close`, an alias, a script file) is not seen by this gate.
import shlex

ID_RE = re.compile(r"\A[A-Za-z]+-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*\Z")
ID_IN = r"[A-Za-z]+-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*"
# bd's built-in statuses that are not in the done category. Anything else (closed,
# a custom done status, a value the gate cannot read) is treated as a close.
NOT_DONE = {"open", "in_progress", "blocked", "deferred", "pinned", "hooked"}
GLOBAL_VALUE = {"--actor", "--db", "-C", "--directory", "--database",
                "--dolt-auto-commit", "--mem-profile"}
SUB_VALUE = {
    "close": {"-r", "--reason", "--reason-file", "--session"},
    "update": {"-a", "-d", "-e", "-p", "-s", "-t", "--acceptance", "--add-label",
               "--append-notes", "--assignee", "--await-id", "--body-file",
               "--defer", "--description", "--design", "--design-file", "--due",
               "--estimate", "--external-ref", "--if-assignee", "--if-status",
               "--metadata", "--notes", "--parent", "--priority", "--remove-label",
               "--session", "--set-labels", "--set-metadata", "--spec-id",
               "--status", "--title", "--type", "--unset-metadata"},
    "duplicate": {"--of"},
    "supersede": {"--with"},
    "batch": {"-f", "--file"},
}
SUB_VALUE["done"] = SUB_VALUE["close"]
SUB_VALUE["import"] = {"-i", "--input"}
SHELLS = {"bash", "sh", "zsh", "dash"}
# A first command word that only prints or searches text: `echo bd close x` and
# `grep -n bd close notes` run no bd at all.
NONEXEC = {"echo", "printf", "grep", "egrep", "fgrep", "rg", "ag", "git", "man",
           "which", "whatis", "apropos", "tldr"}
FEEDERS = {"xargs", "parallel"}
OPS = {";", "&&", "||", "|", "&", "|&", "(", ")", "\n", ";;"}
HEREDOC = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n(.*?)\n[ \t]*\2[ \t]*(?=\n|$)",
                     re.S)

def literal(tok):
    return not any(c in tok for c in "$`*?")

def done_status(v):
    return not literal(v) or v.strip().lower() not in NOT_DONE

def batch_ops(text):
    """(ids closed, any op line seen) for bd batch grammar in TEXT. Literal `\\n`
    escapes count as line breaks so an inline printf source reads the same."""
    text = text.replace("\\n", "\n")
    ids, seen = set(), False
    for ln in re.split(r"[\n'\"]", text):
        ln = ln.strip()
        m = re.match(r"(close|update|create|dep)\s+(\S+)(.*)", ln)
        if not m:
            continue
        seen = True
        verb, tgt, rest = m.groups()
        if verb == "close" and ID_RE.match(tgt):
            ids.add(tgt)
        elif verb == "update" and ID_RE.match(tgt):
            for v in re.findall(r"\bstatus=(\S+)", rest):
                if done_status(v):
                    ids.add(tgt)
    return ids, seen

def read_file(path):
    try:
        with open(os.path.expanduser(path), encoding="utf-8", errors="replace") as f:
            return f.read(200000)
    except OSError:
        return None

PAYLOAD_CWD = None

def base_dir(gdir):
    """The directory a bd call runs in: its -C value (relative to the session cwd),
    else the session cwd from the hook payload, else HQ."""
    root = PAYLOAD_CWD or os.environ["HQ"]
    if gdir and literal(gdir):
        return os.path.join(root, os.path.expanduser(gdir))
    return root

def import_rows(text):
    """Ids of bd import JSONL rows that carry a done status (memory and tombstone rows
    are skipped by bd itself). A line that is not JSON closes nothing."""
    ids = set()
    for ln in text.splitlines():
        ln = ln.strip()
        if not ln.startswith("{"):
            continue
        try:
            row = json.loads(ln)
        except ValueError:
            continue
        if not isinstance(row, dict) or row.get("_type") == "memory":
            continue
        st, rid = row.get("status"), row.get("id")
        if (isinstance(st, str) and isinstance(rid, str) and rid
                and st.strip().lower() != "tombstone" and done_status(st)):
            ids.add(rid)
    return ids

def tokenize(cmd):
    lex = shlex.shlex(cmd, posix=True, punctuation_chars=";&|()<>\n")
    lex.whitespace = " \t\r"
    lex.whitespace_split = True
    lex.commenters = ""
    return list(lex)

# Words that run the word after them as the command: `builtin cd x` and `sudo env cd x`
# are a cd. Each maps to its flags that take a separate value.
PREFIX = {"builtin": set(), "command": set(), "exec": {"-a"}, "time": set(),
          "nohup": set(), "nice": {"-n"}, "stdbuf": {"-i", "-o", "-e"},
          "sudo": {"-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U"}, "doas": {"-u"},
          "env": {"-u", "--unset", "-C", "--chdir", "-S", "--split-string"},
          "timeout": {"-s", "--signal", "-k", "--kill-after"}}
CHDIR = ("cd", "pushd", "popd")

def command_word(sc):
    """(the word a simple command runs after assignments and PREFIX words,
    True when an `env -C DIR` / `env --chdir DIR` in that prefix moves its cwd)."""
    k, chdir = 0, False
    while k < len(sc):
        t = sc[k]
        if re.match(r"[A-Za-z_][A-Za-z0-9_]*=", t):
            k += 1; continue
        base = os.path.basename(t)
        if base not in PREFIX:
            return base, chdir
        vflags = PREFIX[base]
        k += 1
        if base == "timeout":
            while k < len(sc) and sc[k].startswith("-"):
                k += 2 if sc[k] in vflags else 1
            k += 1                                   # the duration
            continue
        while k < len(sc) and (sc[k].startswith("-") or
                               (base == "env" and re.match(r"[A-Za-z_][A-Za-z0-9_]*=", sc[k]))):
            a = sc[k]
            if base == "env" and (a in ("-C", "--chdir") or a.startswith("--chdir=")
                                  or (a.startswith("-C") and len(a) > 2)):
                chdir = True
            if a == "--":
                k += 1; break
            k += 2 if a in vflags else 1
    return "", chdir

def close_targets(cmd, depth=0, moved=False):
    """(set of bead ids a command would close, list of unresolved close reasons)."""
    t, u, _ = _close_targets(cmd, depth, moved)
    return t, u

def _close_targets(cmd, depth=0, moved=False):
    """(targets, unresolved, moved). Import rows land in IMPORTED; they close only a
    bead that exists and is not yet closed, which main() checks. MOVED: a cd, pushd
    or popd ran earlier on the line (also behind builtin/command/sudo, or inside an
    eval), so a relative path no longer resolves from the session cwd; it is
    returned so an eval's cd moves the rest of the outer line too."""
    targets, unresolved = set(), []
    # bash drops a backslash-newline before it splits words, joining the halves
    # (`bd cl\<nl>ose` is `bd close`); shlex would keep the newline as a separator
    cmd = re.sub(r"\\\r?\n", "", cmd)
    bodies = [m.group(3) for m in HEREDOC.finditer(cmd)]
    flat = HEREDOC.sub(lambda m: cmd[m.start():m.start(3)].split("\n")[0] + "\n", cmd)
    try:
        toks = tokenize(flat)
    except ValueError:
        # unbalanced quoting: fall back to a plain scan, and if a close-shaped bd call
        # is there but no id can be read, that is unresolved, never a pass
        hits = re.findall(r"\bbd\b[^\n;&|]*?\b(?:close|done)\b((?:\s+-\S+(?:\s+\S+)?)*)\s+(" + ID_IN + ")", cmd)
        targets |= {h[1] for h in hits}
        if not hits and re.search(r"\bbd\b[^\n]*\b(close|done|--status|-s|batch|duplicate|supersede)\b", cmd):
            unresolved.append("unparsable command")
        return targets, unresolved, moved
    simple, cur = [], []
    for t in toks:
        if t in OPS or (t and set(t) <= set(";&|()\n")):
            simple.append(cur); cur = []
        else:
            cur.append(t)
    simple.append(cur)
    for sc in simple:
        first = next((t for t in sc if not re.match(r"[A-Za-z_][A-Za-z0-9_]*=", t)), "")
        word, chdir = command_word(sc)
        # nested shells and eval carry a whole command line in one token
        for i, t in enumerate(sc):
            base = os.path.basename(t)
            if depth < 3 and base in SHELLS and i + 2 < len(sc) and sc[i + 1] == "-c":
                # a child shell: its cd stays inside it
                t2, u2, _ = _close_targets(sc[i + 2], depth + 1, moved)
                targets |= t2; unresolved += u2
            if depth < 3 and base == "eval" and i + 1 < len(sc):
                # eval runs in this shell: its cd moves the rest of the line
                t2, u2, m2 = _close_targets(" ".join(sc[i + 1:]), depth + 1, moved)
                targets |= t2; unresolved += u2; moved = moved or m2
        if word in CHDIR:
            moved = True
            continue
        here = moved or chdir           # `env -C DIR bd import rel` reads rel under DIR
        idx = next((i for i, t in enumerate(sc) if os.path.basename(t) == "bd"), None)
        if idx is None:
            continue
        if os.path.basename(first) in NONEXEC:
            continue
        fed = any(os.path.basename(t) in FEEDERS for t in sc[:idx])
        args = sc[idx + 1:]
        j = 0
        gdir = None
        while j < len(args) and args[j].startswith("-"):
            if args[j] in ("-C", "--directory") and j + 1 < len(args):
                gdir = args[j + 1]
            elif args[j].startswith("--directory="):
                gdir = args[j].split("=", 1)[1]
            j += 2 if args[j] in GLOBAL_VALUE else 1
        if j >= len(args):
            continue
        sub, rest = args[j], args[j + 1:]
        if sub in ("todo", "epic"):
            # cobra lets global flags sit before the nested subcommand too
            n = 0
            while n < len(rest) and rest[n].startswith("-"):
                n += 2 if rest[n] in GLOBAL_VALUE else 1
            nested = rest[n] if n < len(rest) else ""
            if sub == "todo" and nested == "done":
                sub, rest = "done", rest[:n] + rest[n + 1:]   # bd todo done <id> == bd close
            elif sub == "epic" and nested == "close-eligible":
                if "--dry-run" not in rest:
                    unresolved.append("bd epic close-eligible closes epics the gate "
                                      "cannot name; close each epic with bd close <id>")
                continue
            else:
                continue
        if sub not in SUB_VALUE and sub != "sql":
            continue
        if sub == "import" and "--dry-run" in rest:
            continue
        if sub == "sql":
            sql = " ".join(rest)
            if (re.search(r"\b(update|replace|insert)\b", sql, re.I)
                    and re.search(r"\bstatus\b|closed", sql, re.I)):
                ids = set(re.findall(r"['\"](" + ID_IN + r")['\"]", sql))
                if ids:
                    targets |= ids
                else:
                    unresolved.append("bd sql status write")
            continue
        pos, opts, redirect = [], [], None
        k, vflags = 0, SUB_VALUE[sub] | GLOBAL_VALUE
        while k < len(rest):
            a = rest[k]
            if a == "<" and k + 1 < len(rest):
                redirect = rest[k + 1]; k += 2; continue
            if a in ("<<", "<<<", ">", ">>", "<<-", ">&", "<&", "&>", "&>>", ">|") and k + 1 < len(rest):
                k += 2; continue
            # a file-descriptor number before a redirect (`2>&1`, `2>/dev/null`) is
            # not a bead id: shlex splits `2>&1` into `2`, `>&`, `1` (retro W45)
            if (re.fullmatch(r"\d+", a) and k + 1 < len(rest)
                    and rest[k + 1] in (">", ">>", ">&", "<&", "<", ">|")):
                k += 1; continue
            if a.startswith("--") and "=" in a:
                opts.append(tuple(a.split("=", 1))); k += 1; continue
            if re.match(r"-[a-zA-Z].+", a) and not a.startswith("--") and a[:2] in vflags:
                opts.append((a[:2], a[2:].lstrip("="))); k += 1; continue
            if a.startswith("-") and len(a) > 1:
                if a in vflags and k + 1 < len(rest):
                    opts.append((a, rest[k + 1])); k += 2
                else:
                    opts.append((a, "")); k += 1
                continue
            pos.append(a); k += 1
        if sub == "import":
            src = [v for o, v in opts if o in ("-i", "--input")] + pos[:1]
            texts = []
            def seen(path):
                # after a cd only an absolute path (or one under an absolute -C) still
                # names the file the gate can read; a relative one fails closed
                path = os.path.expanduser(path)
                return not here or os.path.isabs(path) or (
                    gdir is not None and os.path.isabs(os.path.expanduser(gdir)))
            for p in src:
                if p == "-":
                    if redirect and literal(redirect) and seen(redirect):
                        texts.append(read_file(os.path.join(base_dir(gdir), os.path.expanduser(redirect))))
                    elif redirect:
                        texts.append(None)
                    elif bodies:
                        texts += bodies
                    else:
                        texts.append(None)        # a pipe: rows the gate cannot read
                elif literal(p) and seen(p):
                    texts.append(read_file(os.path.join(base_dir(gdir), os.path.expanduser(p))))
                else:
                    texts.append(None)
            if not src:
                # no file: bd reads the ledger's import.path (default .beads/issues.jsonl).
                # A `cd` earlier on the line moves that ledger out of the gate's sight.
                if not seen(".beads"):
                    texts.append(None)
                else:
                    texts.append(read_file(os.path.join(base_dir(gdir), ".beads", "issues.jsonl")))
            if any(t is None for t in texts):
                unresolved.append("bd import from a source the gate cannot read")
                continue
            for t in texts:
                IMPORTED.update(import_rows(t))
            continue
        if sub in ("close", "done"):
            closing = pos
            if (not pos and re.search(r"BD_LAST_TOUCHED_FALLBACK=(?!0)", cmd)):
                unresolved.append("bd close of the last touched issue")
        elif sub == "update":
            closing = pos if any(o in ("-s", "--status") and done_status(v)
                                 for o, v in opts) else []
        elif sub in ("duplicate", "supersede"):
            closing = pos[:1]
        else:  # batch
            src = [v for o, v in opts if o in ("-f", "--file")] + ([redirect] if redirect else [])
            texts = [read_file(p) if literal(p) else None for p in src]
            if any(t is None for t in texts):
                unresolved.append("bd batch from an unreadable file")
                continue
            if not texts:
                # stdin: a heredoc or herestring or an inline printf/echo is literal
                texts = bodies + [cmd]
            ids, seen = set(), False
            for t in texts:
                i2, s2 = batch_ops(t)
                ids |= i2; seen = seen or s2
            if not seen:
                unresolved.append("bd batch fed from a pipe")
            targets |= ids
            continue
        if fed and not closing:
            unresolved.append(f"bd {sub} fed by xargs")
        for p in closing:
            if ID_RE.match(p):
                targets.add(p)
            elif not literal(p):
                unresolved.append(f"bd {sub} {p}")
            else:
                # a short id (`d87`) that bd resolves itself; main() resolves it the
                # same way through bd show, and fails closed when nothing matches
                SHORT.add(p)
    return targets, unresolved, moved

hq = os.environ["HQ"]
try:
    d = json.loads(os.environ.get("HOOK_PAYLOAD", ""))
except Exception:
    sys.exit(0)  # fail-open

if d.get("tool_name") != "Bash":
    sys.exit(0)
cmd = str((d.get("tool_input") or {}).get("command", ""))
if isinstance(d.get("cwd"), str) and os.path.isdir(d["cwd"]):
    PAYLOAD_CWD = d["cwd"]

SHORT, IMPORTED = set(), set()
targets, unresolved = close_targets(cmd)
if not targets and not unresolved and not SHORT and not IMPORTED:
    sys.exit(0)

# Ledgers to search, in order: the HQ repo's OWN .beads first (hq-* beads used to close
# ungated because only rigs were scanned), then every rig ledger.
LEDGERS = []
if os.path.isdir(os.path.join(hq, ".beads")):
    LEDGERS.append(hq)
try:
    for name in sorted(os.listdir(os.path.join(hq, "rigs"))):
        p = os.path.join(hq, "rigs", name)
        if os.path.isdir(os.path.join(p, ".beads")):
            LEDGERS.append(p)
except OSError:
    pass

def shows(bead, every=False):
    """[(bd show text, ledger)] for BEAD: the first ledger that has it, or with EVERY
    each ledger that resolves it (a short id can match in more than one). None when bd
    itself cannot be run."""
    out = []
    try:
        for p in LEDGERS:
            r = subprocess.run(["bd", "show", bead], cwd=p, capture_output=True,
                               text=True, timeout=20)
            if r.returncode == 0 and r.stdout.strip():
                out.append((r.stdout, p))
                if not every:
                    break
    except Exception:
        return None
    return out

def canonical(show, fallback):
    m = re.search(ID_IN, show.split("\n", 1)[0])
    return m.group(0) if m else fallback

def is_closed(show):
    return bool(re.search(r"\bCLOSED\b", show.split("\n", 1)[0]))

def judge(bead, found=None):
    """None when BEAD may close, else the block message."""
    if found is None:
        found = shows(bead)
        if found is None:
            return None  # can't inspect -> fail-open
        if not found:
            return None  # unknown bead -> not our business
        found = found[0]
    show, rig = found

    # A receipt must have the DOCUMENTED SHAPE, not merely contain a hopeful word. The
    # full form carries a class, the command or tool that produced the evidence, and the
    # result, separated twice:
    #     Verification: <class> <sep> <command or tool> <sep> <result>
    # CLAUDE.md documents two single-evidence forms as well, and both are accepted:
    #     Verification: not run <sep> <specific blocker>
    #     Verification: docs-only <sep> <what was diffed and read back>
    # <sep> is a plain hyphen or a long dash, so the plain-hyphen standard and older
    # receipts pass alike. Rejected outright: unfilled angle-bracket placeholders copied
    # from the bead template, and evidence that is only a hopeful word ("ok", "test",
    # "jq"). The previous regex accepted any string containing one of those words, which
    # the template's own unfilled DoD line already satisfied.
    # The class vocabulary is the left column of the Verification table in CLAUDE.md
    # plus the aliases workers actually write. Rejecting `docs` or `build` taught
    # nobody anything, it just stopped an honest close. Longest alternative first,
    # because Python alternation takes the first branch that matches.
    CLASS = (r"(?:docs-only|docs|doc|not[ ]run|markdown|memory|report|json|settings|"
             r"shell[ _-]?hook|shell|code|url|ui|deploy|data|tests|test|lint|build|"
             r"config|script|hook)")
    # Matched as a PREFIX, with the remainder required to start with whitespace or with
    # the separator itself. Anchoring the whole expression cannot work once the
    # separator widens below, because a spaced union ("url / ui") splits on its own
    # slash. The prefix form is also what keeps `codex` and `code/banana` out.
    # A TIGHT hyphen also joins a union: workers write `url-ui` as often as `url/ui`.
    # A SPACED hyphen stays a separator, so `code - build - 12 passed` keeps its shape
    # instead of having `build` swallowed into the class expression.
    JOIN = r"(?:\s*[/,+]\s*|-)"
    CLASS_RE = re.compile(r"\A" + CLASS + r"(?:" + JOIN + CLASS + r")*", re.I)
    # <sep> is whitespace, a run of punctuation, whitespace: identical to receipt_ok()
    # in finish.sh. A flag inside the command keeps its own hyphen, because `pytest -q`
    # has no whitespace after the dash.
    SEP_RE = re.compile(r"\s+[^0-9A-Za-z\s]+\s+")
    # Only the bead template's own tokens count as an unfilled placeholder. The old
    # catch-all rejected an honest receipt that merely mentioned <div> or an HTML tag.
    PLACEHOLDER = re.compile(r"<\s*(?:class|command or tool|command/tool|command|tool|"
                             r"result|blocker)\s*>", re.I)
    PAD = "`*_.,;:! \t"
    # `jq` is deliberately NOT here: the JSON row of the table in CLAUDE.md prescribes
    # exactly that command, so treating it as a hopeful word blocked the documented
    # receipt for its own change class.
    JUNK = {"", "ok", "okay", "test", "tests", "pass", "passed", "passes",
            "done", "yes", "fine", "good", "green", "true", "n/a", "na"}
    # Prose and shell glue that opens a Proof line but names no command. Picking one as
    # the proof token blocked real receipts (2026-10 retro: "new", "cd", "the" made 6 of
    # 8 code/deploy blocks false).
    PROOF_STOP = {"the", "an", "new", "run", "runs", "cd", "and", "then", "with", "on",
                  "in", "from", "after", "both", "each", "every", "all", "its", "that",
                  "this", "env", "sudo", "exec", "time", "timeout"}
    # A receipt with a single evidence field is accepted when that field is long enough
    # to be naming both a tool and an outcome. A third of the real corpus is written
    # that way ("code - npm run build exit 0 plus curl readback plus screenshot read").
    LONE_FIELD_MIN = 20

    def substantive(s, minlen=2):
        """A field that actually names a tool or a blocker: not a hopeful word, not a
        stub. Equality against JUNK, never substring, so `npm test`, `cargo test` and
        `jq empty` are all fine while a bare `test` is not."""
        s = s.strip().strip(PAD)
        return len(s) >= minlen and s.lower() not in JUNK

    def present(s):
        """A RESULT field only has to be there. Honest results read `PASS`, `0`,
        `clean`, `exit 0`, so triviality is not judged here: the tool named in the
        field before it is what makes the receipt checkable."""
        return bool(s.strip().strip(PAD))

    def valid_receipt(body):
        """The receipt's CLASS token when the body has the documented shape, else None.
        The class is returned rather than a bare True so the caller can also ask whether
        that class matches what the bead actually changed."""
        body = re.sub(r"\s+", " ", body).strip().strip("`")
        if not body or PLACEHOLDER.search(body):
            return None                       # unfilled template line, never a receipt
        m = CLASS_RE.match(body)
        if not m:
            return None
        klass, rest = m.group(0), body[m.end():]
        if rest and not rest[:1].isspace():
            # the class may also end at the punctuation that IS the separator: workers
            # write `Shell hook: bash -n plus 11 fixtures` as often as `shell hook - ...`
            if not re.match(r"[^0-9A-Za-z\s]+\s", rest):
                return None                   # codex, codebase, code/banana, shellcheck
            rest = " " + rest
        norm = re.sub(r"\s+", " ", klass).strip().lower()
        parts = [p.strip() for p in SEP_RE.split(rest)]
        if parts and parts[0].strip(PAD):
            return None                       # text between the class and the separator
        if len(parts) < 2:
            return None                       # a class with no evidence at all
        evidence = " ".join(parts[1:])
        if norm in ("not run", "docs-only"):
            # single-evidence forms: that one field carries the whole burden. The floor
            # is 2 characters, not 8: an 8-char floor newly blocks `no GPU` and
            # `no sudo`, and a length threshold cannot judge whether a blocker is
            # specific. Today's live gate accepts a bare `not run` with no reason at
            # all, so requiring any reason is already a tightening.
            return norm if substantive(evidence, 2) else None
        if len(parts) == 2:
            # ONE separator: the field has to carry both halves, so it is judged by
            # length rather than split further.
            return norm if len(evidence.strip(PAD)) >= LONE_FIELD_MIN else None
        # command plus result, judged apart: the COMMAND must name a real tool, the
        # RESULT only has to be present. Judging the result strictly would reject
        # `code - pytest - PASS`, an honest receipt the repo's own finish.test.sh writes.
        # The command floor is 2, so `go`, `ls`, `gh` and `cc` are all real commands.
        if substantive(parts[1], 2) and present(" ".join(parts[2:])):
            return norm
        return None

    def receipt_bodies(text):
        """Each `Verification:` tail, per LINE first; `bd show` hard-wraps and pads its
        output, so also offer the line joined with its next one or two continuation lines
        (stopping at a blank line or at another receipt) so a wrapped receipt still reads
        as one. Deliberately NOT a flatten of the whole bead: that let an unrelated later
        line supply the separator a malformed receipt was missing."""
        lines = text.split("\n")
        for i, ln in enumerate(lines):
            m = re.search(r"Verification:(.*)$", ln, re.I)
            if not m:
                continue
            yield m.group(1)
            acc = m.group(1)
            # 6 continuation lines, not 2: bd show hard-wraps, and 35% of real receipts
            # span 4 or more display lines once wrapped.
            for nxt in lines[i + 1:i + 7]:
                if (not nxt.strip() or re.search(r"Verification:", nxt, re.I)
                        or re.match(r"\s*[A-Za-z][A-Za-z0-9_]*:\s", nxt)):
                    break
                acc += " " + nxt
                if len(acc) > 600:
                    break
                yield acc

    # The class of every well-formed receipt on the bead, in bead order. The exit is
    # DEFERRED until the owned files below are known: a receipt can have the documented
    # shape and still be the wrong KIND of evidence for what the bead changed.
    receipt_classes = [k for k in (valid_receipt(b) for b in receipt_bodies(show)) if k]

    # Completion contract (proposal 23): a bead may pin, in its own body, the command
    # that proves it done:
    #     Proof: <command, e.g. pnpm test src/x.test.js exits 0>
    # When a filled-in Proof line exists, at least one well-formed receipt must
    # reference it (the proof's first real token appears in the receipt) or be
    # `not run`. Beads without a Proof line keep the class-table behavior exactly.
    # Fail-open like everything else: an unreadable or template-placeholder proof
    # line is no contract.
    proof_tok, proof_line = None, ""
    # bd show renders a markdown "- Proof:" as a bullet glyph, so the prefix is
    # any run of non-word characters, not just a hyphen
    mp = re.search(r"^\W*Proof:\s*(.+)$", show, re.M)
    if mp:
        pv = mp.group(1).strip()
        if pv and not pv.startswith("<") and not PLACEHOLDER.search(pv):
            proof_line = pv
            # VAR=value prefixes are environment, not the command
            cmd_pv = re.sub(r"(?<!\S)[A-Za-z_][A-Za-z0-9_]*=\S*", " ", pv)
            for t in re.findall(r"[A-Za-z0-9_./-]{2,}", cmd_pv):
                if t.lower() not in JUNK and t.lower() not in PROOF_STOP:
                    proof_tok = t.lower()
                    break
    contract_miss = False
    if proof_tok and receipt_classes:
        ok_bodies = [b for b in receipt_bodies(show) if valid_receipt(b)]
        # bd show hard-wraps inside a hyphenated word (`copy-` / `check`), and the
        # continuation join adds a space there, so the match also tries the body with
        # in-word hyphen wraps undone. Under bd 1.1.2 this miss was hidden: its
        # renderer dropped `<result>`, so the unfilled template line satisfied the
        # contract instead of the real receipt.
        contract_miss = not any(
            proof_tok in b.lower()
            or proof_tok in re.sub(r"(?<=[A-Za-z0-9])-\s+", "-", b.lower())
            or valid_receipt(b) == "not run" for b in ok_bodies)

    # Decide the change class from the bead's owned files.
    owned = ""
    mo = re.search(r"Files owned:\s*(.+)", show)
    if mo:
        owned = mo.group(1)
    CODE_EXT = (".js",".jsx",".ts",".tsx",".py",".go",".rs",".java",".rb",".php",".c",
                ".cc",".cpp",".h",".hpp",".sh",".sql",".prisma",".vue",".svelte",".kt",
                ".swift",".scala",".ex",".exs")
    DEPLOY_HINT = re.compile(r"dockerfile|vercel\.json|migration|\.env|deploy|schema\.sql", re.I)
    tokens = re.findall(r"[^\s,]+", owned)
    # TWO signals, deliberately kept apart. file_is_code comes from the files the bead
    # actually owns; label_is_code from its labels (which also mark a deploy/data
    # surface). Their UNION drives the missing-receipt block exactly as before. Only the
    # FILE signal may reject a receipt's class, because a redteam pass is label-tagged
    # `redteam` while its deliverable is a written report: `docs-only` is the CORRECT
    # receipt there, and keying the class check on labels would block it every time.
    file_is_code = (any(t.lower().endswith(CODE_EXT) for t in tokens)
                    or bool(DEPLOY_HINT.search(owned)))
    label_is_code = bool(re.search(r"labels?.*\b(redteam|deploy|data|migration)\b",
                                   show, re.I))
    is_code = file_is_code or label_is_code

    # A docs-flavored receipt is not evidence for a bead that owns real code files.
    # Only a bead whose receipts are ALL docs-flavored is rejected, so one carrying both
    # a docs receipt and a code receipt still passes, and `not run` never lands here.
    DOCS_CLASSES = {"docs-only", "markdown", "memory", "report"}

    def docs_flavored(k):
        parts = [p.strip() for p in re.split(r"[/,+]", k) if p.strip()]
        return bool(parts) and all(p in DOCS_CLASSES for p in parts)

    wrong_class = (bool(receipt_classes) and file_is_code
                   and all(docs_flavored(k) for k in receipt_classes))

    if receipt_classes and not wrong_class and not contract_miss:
        return None                           # a receipt that fits what changed

    # A receipt that was found but did not parse is NOT "no receipt", and saying so
    # sent workers hunting for a line that was sitting right there.
    found_bodies = [b.strip() for b in receipt_bodies(show) if b.strip()]
    unparsed = bool(found_bodies) and not receipt_classes
    detail = ("docs-class receipt" if wrong_class
              else "contract miss" if contract_miss
              else "unparsed receipt" if unparsed else "no receipt")
    klass = "code/deploy" if is_code else "docs/other"
    block = is_code and os.environ.get("HQ_VERIFY_BLOCK", "1") != "0"

    # Log the would-block either way (audit trail).
    ts = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    try:
        os.makedirs(os.path.join(hq, "state", "verify"), exist_ok=True)
        with open(os.path.join(hq, "state", "verify", "gate.log"), "a") as f:
            f.write(f"{ts}\t{'BLOCK' if block else 'would-block'}\t{bead}\t{klass}\t"
                    f"{detail}\t{os.path.basename(rig) if rig else '?'}\n")
    except OSError:
        pass

    if block and wrong_class:
        return (f"Blocked closing `{bead}`: the receipt's class is "
                f"`{receipt_classes[0]}`, but this bead owns code files, so a docs-class "
                f"receipt (docs-only, markdown, memory, report) is not evidence for what "
                f"changed. Verify the code itself and add a matching receipt, e.g.\n"
                f'  bd comment {bead} "Verification: code - pytest -q tests/test_x.py'
                f' - 3 passed"\n'
                f"If it genuinely could not run: "
                f'`Verification: not run - <specific blocker>`. '
                f"(Audit-only override: HQ_VERIFY_BLOCK=0.)")

    if block and contract_miss:
        return (f"Blocked closing `{bead}`: this bead pins its own proof\n"
                f"  Proof: {proof_line[:120]}\n"
                f"but no receipt on the bead references it. Run the pinned command and "
                f"add the receipt, e.g.\n"
                f'  bd comment {bead} "Verification: code - {proof_line[:80]} - <result>"\n'
                f"If it genuinely could not run: "
                f'`Verification: not run - <specific blocker>`. '
                f"(Audit-only override: HQ_VERIFY_BLOCK=0.)")

    if block and unparsed:
        bad = found_bodies[0]
        if len(bad) > 160:
            bad = bad[:157] + "..."
        return (f"Blocked closing `{bead}`: a Verification line IS on the bead, but it "
                f"does not parse as a receipt.\n"
                f"  found: Verification:{bad}\n"
                f"  needed: a known class, then evidence. The class comes from the "
                f"Verification table in CLAUDE.md (code, url/ui, deploy/data, json, "
                f"shell hook, docs, build, test, ...), and what follows it has to name "
                f"what ran and what came back.\n"
                f'  fix: bd comment {bead} "Verification: code - pytest -q tests/test_x.py'
                f' - 3 passed"\n'
                f"If it genuinely could not run: "
                f'`Verification: not run - <specific blocker>`. '
                f"(Audit-only override: HQ_VERIFY_BLOCK=0.)")

    if block:
        return (f"Blocked closing `{bead}`: no Verification receipt for a {klass} change. "
                f"Add one to the bead before closing, e.g.\n"
                f'  bd comment {bead} "Verification: code - <test/lint cmd> - <result>"\n'
                f"If it genuinely could not run: "
                f'`Verification: not run - <specific blocker>`. '
                f"(Audit-only override: HQ_VERIFY_BLOCK=0.)")
    return None

blocks = [m for m in (judge(b) for b in sorted(targets)) if m]
for s in sorted(SHORT):
    found = shows(s, every=True)
    if not found:
        unresolved.append(f"bead id `{s}` does not resolve in any ledger")
        continue
    for show, rig in found:
        m = judge(canonical(show, s), (show, rig))
        if m:
            blocks.append(m)
for b in sorted(IMPORTED - targets):
    found = shows(b)
    if not found:
        continue  # a new row or an unreadable ledger: it closes nothing that exists
    show, rig = found[0]
    if is_closed(show):
        continue  # already closed: the import changes no status
    m = judge(b, (show, rig))
    if m:
        blocks.append(m)
if unresolved:
    # Ids the gate cannot read are not "no bead": a guard fails closed here. Logged
    # either way, blocked unless the audit-only override is set.
    block_u = os.environ.get("HQ_VERIFY_BLOCK", "1") != "0"
    ts = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    try:
        os.makedirs(os.path.join(hq, "state", "verify"), exist_ok=True)
        with open(os.path.join(hq, "state", "verify", "gate.log"), "a") as f:
            for u in unresolved:
                f.write(f"{ts}\t{'BLOCK' if block_u else 'would-block'}\t?\t"
                        f"unresolved\t{u[:80]}\t?\n")
    except OSError:
        pass
    if block_u:
        blocks.append(
            f"Blocked: this command can close a bead the verification gate cannot "
            f"name ({'; '.join(sorted(set(unresolved)))[:200]}). Write each bead id "
            f"literally, one `bd close <id>` (or `bd update <id> --status closed`) per "
            f"bead, so its receipt can be checked. "
            f"(Audit-only override: HQ_VERIFY_BLOCK=0.)")
if blocks:
    print("\n\n".join(blocks))
    sys.exit(2)
sys.exit(0)
PY
)"
rc=$?
if [ $rc -eq 2 ]; then
  # PreToolUse: exit 2 blocks the tool; stderr is fed back to the model.
  printf '%s\n' "$REASON" >&2
  exit 2
fi
exit 0
