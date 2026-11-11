#!/usr/bin/env bash
# hq-public-export.sh: build a shareable copy of the HQ machinery (hq-an7jw.1).
#
# Three passes, all fail-closed:
#   1. select: only git-tracked files that match ops/config/public-export.allow
#      (path prefixes and globs, "!" lines exclude, the last matching line wins).
#      Binary files are skipped. The denylist itself is never exported.
#      ops/share/public.gitignore ships as the export's root .gitignore (hq-an7jw.21).
#   2. scrub:  every denylist term (ops/config/public-export.deny) becomes its
#      neutral placeholder, in file contents and in file names alike (so a
#      reference still points at the renamed file); a markdown table whose
#      header starts "| Rig |" becomes an example table.
#   3. gate:   the scrubbed tree is searched for every denylist term and for
#      generic leak shapes (emails, phones, tailnet names, API keys, Bearer
#      tokens, JWTs, private keys, secret assignments in any case or JSON/YAML
#      form, RFCs, public IPv4, Supabase project refs). Any hit: exit 2 and print
#      file:line. A file name or symlink target that still carries a term or
#      shape after the scrub is refused the same way, as is a symlink whose
#      target is not exported. Exceptions are "ok <regex>" lines in the allowlist.
#
# Config (hq-an7jw.16): --allow, --deny and --public are paths relative to the root, checked as strings
# (no leading /, no empty, . or .. component; else exit 1). Every mode reads them from the committed
# tree of the root's HEAD only: the two lists as blobs, the public dir as a tree. No filesystem path is
# mapped into the root and no working-tree byte at those paths is read, so a working-tree edit,
# symlink or case alias changes nothing; commit a config change before it takes effect.
#
# Snapshot (hq-an7jw.17): --out, --check and --push export the committed tree of HEAD, written from the
# object store into a temp dir, never the working tree, so an uncommitted edit changes no output byte and
# untracked files never ship. Only --gate DIR reads a working tree. A failed listing, mkdir or copy
# inside the shared core exits non-zero with nothing written.
#
# The output is assembled in a temp dir and moved into --out only when the gate
# is clean, so a refused run leaves nothing behind. The run log (replacement map
# with counts, skipped files, gate hits) is written OUTSIDE the output tree,
# mode 600; a log that cannot be written 600 exits 1 before any work.
#
# --gate DIR runs pass 3 alone on DIR as it is (no select, no scrub; its git-tracked
# files when DIR is a checkout), with the "ok" lines of the root's committed allowlist: the proof that a
# published tree is clean. A listed path it cannot read as text (binary, not UTF-8,
# unreadable, missing, not a regular file or symlink) is a refusal, never a skip.
# It reads working-tree bytes, so it proves a checkout's HEAD only when the checkout is clean.
#
# --push CHECKOUT (hq-an7jw.2, hq-an7jw.11) publishes to the origin of CHECKOUT, a checkout of the
# public repo that is read for its one origin push url (a relative path resolved from its toplevel)
# and never written. The run works in a new temp repo: it fetches origin main (none: an unborn
# branch), writes the committed tree of the root's HEAD from the object store (never a working-tree
# byte), exports that, adds the public files of the committed dir --public (default ops/public:
# README.md and LICENSE required, CONTRIBUTING.md optional, each a committed regular file, nothing
# else in the dir), --gates that whole tree, and computes its tree id from the raw bytes and modes. The commit
# "export from hq <sha>" is built with commit-tree and verified before the push: its tree is that
# gated tree id (else exit 2: a filter or attribute config changed bytes), its one parent is the
# fetched start, its identity is the one public identity below (HQ_PUBLIC_NAME / HQ_PUBLIC_EMAIL
# override it, gated) with UTC dates. The push sends one branch ref, no tag, with a lease on the
# start, hooks and signing off. Then origin is read: the new commit means pushed (exit 0). Refused:
# a root that is not a repository's own toplevel (a plain dir, a subdirectory, any git read fault),
# a root with an uncommitted tracked change (defence in depth), a committed entry that is not a file
# or symlink (gitlink), a failed or short blob read, an origin with more than one push url, an origin
# that does not answer, an unreadable start tree. Any failure or INT/TERM/HUP before the
# push deletes the temp dir and leaves nothing else to undo. After success, pull the checkout.
#
# Usage: hq-public-export.sh (--out DIR | --check | --gate DIR | --push CHECKOUT)
#                            [--root DIR] [--allow RELPATH] [--deny RELPATH] [--log FILE]
#                            [--public RELPATH]
# Exit: 0 clean; 1 usage or config error; 2 leak or refusal (gate hit, denylist
#       term in a filename, .env file, symlink leaving the root, unread file);
#       3 empty output; 4 push failed and origin still holds the start commit; 5 push
#       outcome unknown (origin holds neither, or did not answer): the temp repo with the
#       export commit is kept and its path printed.
set -euo pipefail
# git reads the root named by -C, never a repository, work tree or index the environment points at
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_CEILING_DIRECTORIES GIT_DISCOVERY_ACROSS_FILESYSTEM

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="" CHECK=0 LOG=""
# repo-relative paths of committed entries in the config root's HEAD (hq-an7jw.16)
ALLOW=ops/config/public-export.allow DENY=ops/config/public-export.deny PUBLIC=ops/public

usage() { sed -n '2,67p' "$0" | sed 's/^# \{0,1\}//'; }
# the one public commit identity for --push (the GitHub noreply address of the repo owner);
# HQ_PUBLIC_NAME / HQ_PUBLIC_EMAIL override it, gated
PUBLIC_NAME="your-gh-user" PUBLIC_EMAIL="71735134+your-gh-user@users.noreply.github.com"
GATE="" PUSH=""

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:-}"; shift 2 ;;
    --check) CHECK=1; shift ;;
    --gate) GATE="${2:-}"; [ -n "$GATE" ] || { echo "hq-public-export: --gate needs a DIR" >&2; exit 1; }; shift 2 ;;
    --push) PUSH="${2:-}"; [ -n "$PUSH" ] || { echo "hq-public-export: --push needs a CHECKOUT" >&2; exit 1; }; shift 2 ;;
    --public) PUBLIC="${2:-}"; shift 2 ;;
    --root) ROOT="${2:-}"; shift 2 ;;
    --allow) ALLOW="${2:-}"; shift 2 ;;
    --deny) DENY="${2:-}"; shift 2 ;;
    --log) LOG="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "hq-public-export: unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

modes=$(( $([ -n "$OUT" ] && echo 1 || echo 0) + CHECK + $([ -n "$GATE" ] && echo 1 || echo 0) + $([ -n "$PUSH" ] && echo 1 || echo 0) ))
if [ "$modes" -eq 0 ]; then
  echo "hq-public-export: give --out DIR, --check, --gate DIR or --push CHECKOUT" >&2; exit 1
fi
if [ "$modes" -gt 1 ]; then
  echo "hq-public-export: --out, --check, --gate and --push are exclusive" >&2; exit 1
fi
# --allow, --deny and --public name entries of the committed tree by repo-relative path, checked as
# strings only: nothing is resolved on disk, so no filesystem alias (symlink, case-insensitive name,
# bind mount) can name a file outside HEAD (hq-an7jw.16, lucy round 4 on hq-an7jw.14)
for v in ALLOW DENY PUBLIC; do
  case "/${!v}/" in
    *//*|*/./*|*/../*)
      echo "hq-public-export: --${v,,} wants a path relative to the root, with no leading /, empty, . or .. component: '${!v}'" >&2; exit 1 ;;
  esac
done
[ -d "$ROOT" ] || { echo "hq-public-export: root not found: $ROOT" >&2; exit 1; }
ROOT="$(cd "$ROOT" && pwd -P)"
CFGROOT="$ROOT"  # the repository whose HEAD holds the allowlist, denylist and public dir
GATE_ONLY=0
if [ -n "$GATE" ]; then
  # the gated tree becomes the scanned root; the config stays the source root's
  [ -d "$GATE" ] || { echo "hq-public-export: --gate dir not found: $GATE" >&2; exit 1; }
  ROOT="$(cd "$GATE" && pwd -P)"; GATE_ONLY=1; CHECK=1
fi

if [ -n "$OUT" ]; then
  # canonical --out: every component resolved, the last one included (a symlink to a real dir
  # becomes that dir), so the emptiness, root and log tests and the final copy see the same path.
  # The parent must already exist; a path that cannot be resolved exits 1.
  OUT_ABS="$(realpath -e -- "$(dirname -- "$OUT")" 2>/dev/null)" \
    && [ -d "$OUT_ABS" ] && OUT_ABS="$(realpath -q -- "$OUT")" && [ -n "$OUT_ABS" ] \
    || { echo "hq-public-export: cannot resolve --out (missing parent or no access): $OUT" >&2; exit 1; }
  if [ -e "$OUT_ABS" ] && { [ ! -d "$OUT_ABS" ] || [ -n "$(ls -A "$OUT_ABS" 2>&1)" ]; }; then
    echo "hq-public-export: --out exists and is not empty: $OUT_ABS" >&2; exit 1
  fi
  case "$OUT_ABS/" in
    "$ROOT"/*) echo "hq-public-export: --out must be outside the root: $OUT_ABS" >&2; exit 1 ;;
  esac
fi
LOG="${LOG:-${TMPDIR:-/tmp}/hq-public-export.$(date -u +%Y%m%dT%H%M%SZ).$$.log}"
# The log holds the real term map: refuse, before any work, a log inside the output or the root.
LOG_ABS="$(realpath -m -- "$LOG")"
case "$LOG_ABS/" in
  "$ROOT"/*) echo "hq-public-export: --log must be outside the root: $LOG_ABS" >&2; exit 1 ;;
esac
if [ -n "$OUT" ]; then
  case "$LOG_ABS/" in
    "$OUT_ABS"/*) echo "hq-public-export: --log must be outside --out: $LOG_ABS" >&2; exit 1 ;;
  esac
fi

# repo_toplevel: ROOT is its repository's own toplevel, read from one rev-parse call; a git fault,
# an empty answer or another directory exits 1 (s-1107 B1: a failed git read is never "not a checkout")
repo_toplevel() { # repo_toplevel <dir>
  local top
  top="$(git -C "$1" rev-parse --show-toplevel 2>/dev/null)" && [ -n "$top" ] \
    || { echo "hq-public-export: git cannot read the repository at $1; refused" >&2; exit 1; }
  top="$(cd -- "$top" 2>/dev/null && pwd -P)" && [ "$top" = "$1" ] \
    || { echo "hq-public-export: $1 is not its repository's toplevel (git says: ${top:-unreadable}); refused" >&2; exit 1; }
}

# The config root must be a repository's own toplevel with a commit: the allowlist, denylist and public
# dir are read from the committed tree of its HEAD only, by path in the object store (no working-tree
# byte, index, filter or symlink is involved), in every mode.
{ [ -e "$CFGROOT/.git" ] || [ -L "$CFGROOT/.git" ]; } \
  || { echo "hq-public-export: the root must be a repository toplevel (no .git in $CFGROOT): the allowlist, denylist and public dir are read from its HEAD" >&2; exit 1; }
repo_toplevel "$CFGROOT"
export GIT_NO_REPLACE_OBJECTS=1
SHA="$(git -C "$CFGROOT" rev-parse --verify -q 'HEAD^{commit}')" \
  || { echo "hq-public-export: the root needs a commit: $CFGROOT" >&2; exit 1; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/hq-public-$([ -n "$PUSH" ] && echo push || echo export).XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
GC() { git -C "$CFGROOT" --literal-pathspecs -c core.ignorecase=false "$@"; }
# head_entry <path>: prints "mode type oid" of the entry at exactly <path> in $SHA (nothing: none);
# a git fault exits 1
head_entry() {
  local e
  GC ls-tree -z --full-tree "$SHA" -- "$1" >"$WORK/.ent" \
    || { echo "hq-public-export: git ls-tree failed in $CFGROOT; refused" >&2; exit 1; }
  while IFS= read -r -d '' e; do
    [ "${e#*$'\t'}" = "$1" ] && printf '%s\n' "${e%%$'\t'*}"
  done <"$WORK/.ent"
  return 0
}
# head_blob <oid> <dest>: the blob's bytes from the object store, re-hashed against its id
head_blob() {
  GC cat-file blob "$1" >"$2" && [ "$(GC hash-object --no-filters -- "$2")" = "$1" ] \
    || { echo "hq-public-export: short or wrong read of blob $1; refused" >&2; exit 1; }
}
# build_snap <dest>: the snapshot, the committed tree of $SHA written to <dest> from the object store
# (ls-tree plus cat-file --batch, no filter, attribute, index or working-tree byte), each blob re-hashed
# against its id. --out, --check and --push all export from it; only --gate reads a working tree
# (lucy hq-an7jw.12 finding 1, lucy hq-an7jw.16 finding 1). Any fault exits non-zero.
build_snap() {
python3 -I - "$CFGROOT" "$SHA" "$1" <<'PY' || exit $?
import hashlib, os, subprocess, sys
root, sha, snap = sys.argv[1:4]
def die(code, msg):
    print("hq-public-export: " + msg, file=sys.stderr); sys.exit(code)
def git(args, data=None):
    try:
        r = subprocess.run(["git", "-C", root] + args, input=data, capture_output=True)
    except OSError as e:
        die(1, "cannot run git: %s" % e)
    if r.returncode != 0:
        die(1, "git %s failed in %s (%d); refused" % (args[0], root, r.returncode))
    return r.stdout
fmt = git(["rev-parse", "--show-object-format"]).decode().strip()
if fmt not in ("sha1", "sha256"):
    die(1, "unknown object format %r; refused" % fmt)
ents = []
for e in git(["ls-tree", "-r", "-z", "--full-tree", sha]).split(b"\0"):
    if not e:
        continue
    meta, tab, path = e.partition(b"\t")
    parts = meta.split(b" ")
    if not tab or len(parts) != 3 or not path:
        die(1, "unreadable ls-tree entry %r; refused" % e)
    mode, kind, oid = parts
    if kind != b"blob" or mode not in (b"100644", b"100755", b"120000"):
        die(2, "%s: %s %s is not a file or symlink (a gitlink?); refused" % (os.fsdecode(path), mode.decode(), kind.decode()))
    if any(c in (b"", b".", b"..") or c.lower() == b".git" for c in path.split(b"/")):
        die(1, "unsafe path in the committed tree: %r; refused" % path)
    ents.append((mode, oid, path))
if not ents:
    die(1, "the commit %s lists no files; refused" % sha)
out = git(["cat-file", "--batch"], b"".join(oid + b"\n" for _, oid, _ in ents))
pos = 0
for mode, oid, path in ents:
    nl = out.find(b"\n", pos)
    head = out[pos:nl].split(b" ") if nl >= 0 else []
    if len(head) != 3 or head[0] != oid or head[1] != b"blob" or not head[2].isdigit():
        die(1, "cat-file did not return blob %s for %s; refused" % (oid.decode(), os.fsdecode(path)))
    size = int(head[2]); data = out[nl + 1:nl + 1 + size]; pos = nl + 1 + size + 1
    h = hashlib.new(fmt); h.update(b"blob %d\0" % size); h.update(data)
    if len(data) != size or out[pos - 1:pos] != b"\n" or h.hexdigest().encode() != oid:
        die(1, "short or wrong read of blob %s for %s; refused" % (oid.decode(), os.fsdecode(path)))
    dst = os.path.join(os.fsencode(snap), path)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if mode == b"120000":
        os.symlink(data, dst)
    else:
        fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            os.fchmod(fh.fileno(), 0o755 if mode == b"100755" else 0o644)
if pos != len(out):
    die(1, "cat-file returned more than was asked; refused")
PY
}

mkdir "$WORK/cfg"
for v in ALLOW DENY; do
  w=allowlist; [ "$v" = DENY ] && w=denylist
  ent="$(head_entry "${!v}")"
  case "$ent" in
    "100644 blob "*|"100755 blob "*) head_blob "${ent##* }" "$WORK/cfg/${v,,}" ;;
    *) echo "hq-public-export: the $w is not a committed non-empty file at $SHA: ${!v}" >&2; exit 1 ;;
  esac
  [ -s "$WORK/cfg/${v,,}" ] || { echo "hq-public-export: the $w is not a committed non-empty file at $SHA: ${!v}" >&2; exit 1; }
done

# core <root> <gate_only> <check> <out> <log>: list <root>, then select, scrub and gate it with the
# committed config in $WORK/cfg (gate_only: pass 3 alone, as it is); write the result to <out>
# unless <check>. The one code path of every mode; --push runs it in a subshell.
# --push calls it as ( core ... ) || exit, where bash ignores errexit for the whole call (lucy
# hq-an7jw.16 finding 2), so every step below checks its own status and exits non-zero on a fault.
core() {
local root="$1" gate_only="$2" check="$3" out="$4" log="$5" STAGE LIST rc made=0
STAGE="$(mktemp -d "$WORK/core.XXXXXX")" && [ -d "$STAGE" ] \
  || { echo "hq-public-export: cannot make the staging dir in $WORK; refused" >&2; exit 1; }

# File list: a root holding .git (dir or file) lists git-tracked files only, and every git fault
# there is a refusal; only a root with no .git at all (a plain dir of files) lists every file.
LIST="$STAGE/.files"
if [ -e "$root/.git" ] || [ -L "$root/.git" ]; then
  repo_toplevel "$root"
  git -C "$root" ls-files -z >"$LIST" 2>/dev/null \
    || { echo "hq-public-export: git ls-files failed in $root; refused" >&2; exit 1; }
  [ -s "$LIST" ] || { echo "hq-public-export: the repository at $root tracks no files; refused" >&2; exit 1; }
else
  # every entry but a dir: a FIFO, socket or device is listed so the gate refuses it
  # each step's status is tested: a find that prints part of the tree and then fails is a refusal,
  # never a short list (a partial NUL list plus a non-zero status refuses)
  (cd "$root" && find . \( -name .git -prune \) -o ! -type d -print0) >"$STAGE/.found" \
    || { echo "hq-public-export: listing the files of $root failed (find); refused" >&2; exit 1; }
  sed -z 's|^\./||' <"$STAGE/.found" >"$LIST" \
    || { echo "hq-public-export: listing the files of $root failed (sed); refused" >&2; exit 1; }
fi

set +e
python3 -I - "$root" "$WORK/cfg/allow" "$WORK/cfg/deny" "$LIST" "$STAGE/tree" "$log" "$gate_only" "$DENY" "$ALLOW" <<'PY'
import fnmatch, os, re, sys

root, allow_f, deny_f, list_f, stage, log_f, gate_only, deny_rel, allow_rel = sys.argv[1:10]
gate_only = gate_only == "1"
log = []
def say(msg, err=False):
    print(msg, file=sys.stderr if err else sys.stdout)

def die(code, msg):
    log.append("FATAL " + msg)
    write_log()
    say("hq-public-export: " + msg, err=True)
    sys.exit(code)

def write_log():
    # The log holds the real term map: owner-only (600), or the run fails.
    try:
        os.makedirs(os.path.dirname(os.path.abspath(log_f)), exist_ok=True)
        fd = os.open(log_f, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as fh:
            os.fchmod(fh.fileno(), 0o600)
            if os.fstat(fh.fileno()).st_mode & 0o777 != 0o600:
                raise OSError("mode is not 600")
            fh.write("\n".join(log) + "\n")
    except OSError as e:
        say("hq-public-export: cannot write the run log 600 (%s): %s" % (e, log_f), err=True)
        sys.exit(1)

write_log()  # fail before any work when the log cannot be written 600

# ---- config -------------------------------------------------------------
rules, oks = [], []
for raw in open(allow_f, encoding="utf-8"):
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    if line.startswith("ok "):
        oks.append((None, re.compile(line[3:].strip())))
        continue
    if line.startswith("ok@"):
        # "ok@<path> <regex>": the exception holds in that one file only
        scope, _, rx = line[3:].partition(" ")
        if not scope or not rx.strip():
            die(1, "allowlist: want ok@<path> <regex>: " + line)
        oks.append((scope, re.compile(rx.strip())))
        continue
    neg = line.startswith("!")
    pat = line[1:].strip() if neg else line
    rules.append((neg, pat))
if not any(not n for n, _ in rules):
    die(1, "allowlist has no include lines: " + allow_rel)

def rule_hit(pat, path):
    if pat.endswith("/"):
        return path.startswith(pat)
    if any(c in pat for c in "*?["):
        return fnmatch.fnmatchcase(path, pat)
    return path == pat or path.startswith(pat + "/")

def allowed(path):
    verdict = False
    for neg, pat in rules:
        if rule_hit(pat, path):
            verdict = not neg
    return verdict

terms = []  # (term, replacement, flags)
for n, raw in enumerate(open(deny_f, encoding="utf-8"), 1):
    line = raw.rstrip("\n")
    if not line.strip() or line.lstrip().startswith("#"):
        continue
    parts = line.split("\t")
    if len(parts) < 2 or not parts[0]:
        die(1, "denylist line %d: want term<TAB>replacement[<TAB>flags]" % n)
    flags = parts[2] if len(parts) > 2 else ""
    if set(flags) - set("cw"):
        die(1, "denylist line %d: unknown flags %r (c = case-sensitive, w = whole word)" % (n, flags))
    terms.append((parts[0], parts[1], flags))
if not terms:
    die(1, "denylist has no terms: " + deny_rel)

def term_re(term, flags, force_i=False, idx=None):
    body = re.escape(term)
    if "w" in flags:
        # a plural or possessive without an apostrophe (Quillas, Quillaes) is still the word;
        # the suffix is kept by the scrub (named group s<idx>)
        suf = "(?P<s%d>es|s)?" % idx if idx is not None else "(?:es|s)?"
        # a source escape (\t, \n, \r) ends in a letter but is a boundary: "\tQuilla" is the word
        body = r"(?:(?<![A-Za-z0-9])|(?<=\\[ntr]))" + body + suf + r"(?![A-Za-z0-9])"
    if force_i or "c" not in flags:
        body = "(?i:" + body + ")"
    return body

order = sorted(range(len(terms)), key=lambda i: -len(terms[i][0]))
scrub_re = re.compile("|".join("(?P<t%d>%s)" % (i, term_re(terms[i][0], terms[i][2], idx=i)) for i in order))
gate_terms = [(t, re.compile(term_re(t, f, force_i=True))) for t, _, f in terms]
for t, r, f in terms:
    for gt, grx in gate_terms:
        if grx.search(r):
            die(1, "denylist replacement for one term contains another denylist term (line with replacement %r)" % r)

counts = [0] * len(terms)
def scrub(text):
    def sub(m):
        i = int(m.lastgroup[1:])
        counts[i] += 1
        return terms[i][1] + ((m.group("s%d" % i) or "") if "w" in terms[i][2] else "")
    return scrub_re.sub(sub, text)

EXAMPLE_TABLE = """| Rig | Path | Branch | Notes |
|---|---|---|---|
| example-app | rigs/example-app | main | own ledger; finish.sh deploys by API |
| example-site | rigs/example-site | main | hq ledger; public-facing (redteam) |
| example-pos | rigs/example-pos | main | hq ledger; money surface (redteam); no deploy |"""
TABLE_RE = re.compile(r"^\| *Rig *\|[^\n]*\n(?:\|[^\n]*(?:\n|$))*", re.M)
tables = 0
def swap_tables(text):
    global tables
    def sub(m):
        global tables
        tables += 1
        return EXAMPLE_TABLE + ("\n" if m.group(0).endswith("\n") else "")
    return TABLE_RE.sub(sub, text)

# ---- generic leak shapes for the gate ------------------------------------
SECRET_NAME = r"(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|private[_-]?key|auth[_-]?key|access[_-]?key)"
SECRET_BODY = r"(?:(?=[A-Za-z0-9_+=.-]*\d)[A-Za-z0-9_+=.-]{12,}|[A-Za-z0-9_+=.-]{24,})(?![A-Za-z0-9_+=./-])"
# an unquoted dotted code reference (cfg.n8nToken, env.CONSOLE_TOKEN, out.stdout) is not a value;
# a quoted literal is a value whatever it contains ("Sup3r.S3cretValue")
# a quoted (or backtick) literal is gated on its whole content, "/" and punctuation included, with no
# path or reference exemption ("aB3dE5/gH7iJ9kL2"); only an unquoted value gets the exemptions
QUOTED_BODY = r"[\"'`](?:(?=[^\"'`\s]*\d)[^\"'`\s]{12,}|[^\"'`\s]{24,})[\"'`]"
SECRET_VALUE = r"(?:" + QUOTED_BODY + r"|[\"']" + SECRET_BODY + r"|(?![A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_])" + SECRET_BODY + r")"
# phone edges: no word character or digit-separator-digit on either side (longer runs, decimals,
# hashes, ids stay out), but sentence punctuation, tel:, a colon, a slash or a file extension may touch
PL = r"(?<!\w)(?<!\d[.,:/-])"
PT = r"(?!\w)(?![.,:/-]\d)"
MX_PREFIX = r"(?:\+52|0052|52)[ .-]?(?:1[ .-]?)?"
MX_LOCAL = r"(?:\([2-9]\d{2}\)|[2-9]\d{2})[ .-]?\d{3}[ .-]?(?:\d{2}[ .-]?\d{2}|\d{4})"
SHAPES = [
    ("email", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")),
    ("phone", re.compile(PL + r"\+\d{1,3}[ .-]?\(?\d{2,3}\)?[ .-]?\d{3,4}[ .-]?\d{4}" + PT +
                         r"|\(\d{3}\) ?\d{3}[ .-]\d{4}\b"
                         r"|" + PL + r"\d{3}[ .-]\d{3}[ .-]\d{4}" + PT +
                         # Mexican 3-3-2-2 grouping (NNN NNN NN NN, with space, dash or dot)
                         r"|" + PL + r"\d{3}([ .-])\d{3}\1\d{2}\1\d{2}" + PT +
                         # bare 10 digits; a leading 0 or 1 (unix timestamps, ids) and longer runs never match
                         r"|" + PL + r"(?<!\+)[2-9]\d{9}" + PT +
                         # one complete Mexican number: country prefix (+52, 0052, 52, then an optional
                         # mobile 1), area code bare or in parens, 3-3-2-2 or 3-7 with optional separators
                         r"|" + PL + MX_PREFIX + MX_LOCAL + PT +
                         r"|" + PL + r"\([2-9]\d{2}\)[ .-]?\d{3}[ .-]?\d{2}[ .-]?\d{2}" + PT +
                         r"|" + PL + r"[2-9]\d{2}[ .-]\d{7}" + PT)),
    ("tailnet", re.compile(r"\btail[0-9a-f]{4,}\.ts\.net\b", re.I)),
    ("public-ipv4", re.compile(r"(?<![\w.])(?!(?:10|127|0)\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\."
                               r"|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|255\.)"
                               r"(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\w.])")),
    ("hex32", re.compile(r"(?<![0-9A-Za-z])(?=[0-9a-fA-F]*\d)(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{32}(?![0-9A-Za-z])")),
    ("api-key", re.compile(r"(?<![A-Za-z0-9])(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|sbp_[0-9a-f]{20,}"
                           r"|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}"
                           r"|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|sb_secret_[A-Za-z0-9_-]{20,}"
                           r"|tskey-[A-Za-z0-9-]{10,}"
                           r"|re_(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Z])[A-Za-z0-9_]{20,})"
                           r"|(?i:\bBearer)\s+[A-Za-z0-9._~+/-]{20,}=*")),
    ("supabase-ref", re.compile(r"\b[a-z0-9]{2,}\.supabase\.co\b|postgres\.[a-z]{20}\b")),
    ("jwt", re.compile(r"(?<![A-Za-z0-9+/=])eyJ[A-Za-z0-9_-]{20,}")),
    ("private-key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    # KEY=value where the value looks generated: 12+ token chars with a digit, not a path or a reference
    ("env-secret", re.compile(r"^\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*"
                              r"\s*[=:]\s*['\"]?(?=[A-Za-z0-9_+=.-]*\d)[A-Za-z0-9_+=.-]{12,}['\"]?\s*$", re.M)),
    # any case, any position: name=value, name: value, "name": "value", --name value, --name=value.
    # value: 12+ token chars with a digit, or 24+ without one. A bare "key" needs 16+ chars that mix
    # upper, lower and digit, with no ".", so code keys (hq.console.x, cache_5m_tokens) stay out.
    # No "/" or "$" in a value, so paths and variable references stay out.
    ("secret-assign", re.compile(
        r"(?i:(?<![A-Za-z0-9])[\"']?[A-Za-z0-9_.-]*?" + SECRET_NAME + r"[A-Za-z0-9_-]*[\"']?\s*[=:]\s*" + SECRET_VALUE +
        r"|(?<![A-Za-z0-9-])--[a-z-]*?" + SECRET_NAME + r"[a-z-]*\s+" + SECRET_VALUE +
        r"|(?<![A-Za-z0-9_-])[\"']?key[\"']?\s*[=:]\s*[\"']?(?-i:(?=[A-Za-z0-9_+=-]*\d)(?=[A-Za-z0-9_+=-]*[a-z])(?=[A-Za-z0-9_+=-]*[A-Z]))"
        r"[A-Za-z0-9_+=-]{16,}(?![A-Za-z0-9_+=./-]))")),
    ("rfc", re.compile(r"\b[A-Z\u00d1&]{3,4}\d{6}[A-Z0-9]{3}\b")),
    # Windows identity (hq-an7jw.22): a machine or account SID (S-1-5-21 plus three 6 to 10 digit
    # subauthorities, with or without a RID) and a default device name (desktop- or laptop- plus a
    # suffix holding a digit). Builtin SIDs (S-1-5-18, S-1-5-32-544) and desktop-share stay out.
    # Round 2 (hq-an7jw.26): a SID ends at any non-digit, so HKEY_USERS\<SID>_Classes is caught; a
    # device suffix is 1 to 15 letters, digits and internal hyphens, as in a two-character suffix
    # or one with a hyphen inside.
    ("windows-sid", re.compile(r"(?i)(?<![A-Za-z0-9])S-1-5-21(?:-\d{6,10}){3}(?:-\d+)?(?!\d)")),
    ("device-name", re.compile(r"(?i)(?<![A-Za-z0-9-])(?:desktop|laptop)-(?=[A-Za-z0-9-]{0,14}\d)"
                               r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,13}[A-Za-z0-9])?(?![A-Za-z0-9])")),
]
WHOLE_TEXT = {"secret-assign"}  # shapes the gate runs over the whole file, not line by line

# a secret key whose value is not on its line: nothing, a # or // comment, or a block indicator
# (| or >, with - or +) after the colon. The next non-blank non-comment line is the value (a "- "
# list item included) and goes through the same value test; a value this cannot evaluate is refused.
# No YAML parser: a key with an empty value followed by another key ("user: bob") is a mapping.
KEY_LINE = re.compile(r"(?i)^\s*(?:[{\[,]\s*)*(?:-\s+)?[\"'`]?[A-Za-z0-9_.-]*?" + SECRET_NAME +
                      r"[A-Za-z0-9_-]*[\"'`]?\s*:\s*(?:#.*|//.*|(?P<block>[|>][-+]?\d?\s*(?:#.*)?))?$")
COMMENT_LINE = re.compile(r"^\s*(?:#|//)")
MAPPING_LINE = re.compile(r"^\s*[\"']?[A-Za-z0-9_.-]+[\"']?\s*:(?:\s|$)|^\s*[}\]]")
LIST_ITEM = re.compile(r"^\s*-(?:\s+(.*))?$")
UNQUOTED_VALUE = re.compile(r"(?:" + r"(?![A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_])" + SECRET_BODY + r")")

def value_verdict(v):
    """None (not a secret), "leak", or "unsupported" for a value taken from the line after its key."""
    v = v.strip().rstrip(",;").rstrip("}]").rstrip(",").strip()
    if not v:
        return None
    if v[0] in "\"'`":
        if len(v) < 2 or v[-1] != v[0]:
            return "unsupported"
        return "leak" if re.fullmatch(QUOTED_BODY, v) else None
    if v[0] in "{[&*!|>%@":
        return "unsupported"
    return "leak" if any(UNQUOTED_VALUE.fullmatch(w) for w in v.split()) else None

def split_secret_values(lines, rel):
    """(key line index from 1, verdict) for each secret key whose value sits on a later line."""
    found = []
    for i, line in enumerate(lines):
        m = KEY_LINE.match(line)
        if not m:
            continue
        j = i + 1
        while j < len(lines) and (not lines[j].strip() or COMMENT_LINE.match(lines[j])):
            j += 1
        if j == len(lines):
            continue
        nxt = lines[j]
        item = LIST_ITEM.match(nxt)
        if item:
            v = item.group(1) or ""
        elif not m.group("block") and MAPPING_LINE.match(nxt):
            continue  # an empty value, then the next key
        else:
            v = nxt
        verdict = value_verdict(v)
        if verdict and not ok_hit(v.strip(), rel):
            found.append((i + 1, verdict))
    return found

# numeric character references (hq-an7jw.26): XML and HTML decode &#45; and &#x2D; to "-", so a
# value spelled with them escapes every shape and denylist term on the raw text. The gate scans a
# decoded copy next to the raw text, line by line and as a whole file (hq-an7jw.29: a key name
# spelled with a reference hid a secret assignment from the whole-file shapes); the export keeps the
# text as written. The ";" is optional (HTML decodes without it). A reference to no character (past
# U+10FFFF, a surrogate, NUL) is a refusal with or without the ";": the gate passes only what it can
# read. REF_LITERALS names the only exceptions, each an exact text the tree needs as written.
CHAR_REF = re.compile(r"&#(?:[xX]([0-9a-fA-F]+)|([0-9]+))(;?)")
REF_LITERALS = [
    # ops/security/news.sh: a perl regex that matches the apostrophe reference with an optional zero
    ("perl apostrophe regex", re.compile(r"&#" r"0\?39;")),
]
class BadRef(ValueError):
    pass
def decode_refs(text, strict=True):
    """text with each valid reference decoded; an invalid one raises BadRef (strict) or stays as is."""
    def sub(m):
        n = int(m.group(1), 16) if m.group(1) is not None else int(m.group(2))
        if n == 0 or n > 0x10FFFF or 0xD800 <= n <= 0xDFFF:
            if strict and not any(rx.match(text, m.start()) for _, rx in REF_LITERALS):
                raise BadRef(m.group(0))
            return m.group(0)
        return chr(n)
    return CHAR_REF.sub(sub, text)

def ok_hit(text, rel=None):
    return any(o.fullmatch(text) for scope, o in oks if scope is None or scope == rel)

def name_leak(text):
    """The gate for a file name or a symlink target: a shape or a denylist term, else None."""
    try:
        views = [text, decode_refs(text)] if CHAR_REF.search(text) else [text]
    except BadRef:
        return "undecodable character reference"
    for view in views:
        shape = next((n for n, rx in SHAPES if any(not ok_hit(m.group(0)) for m in rx.finditer(view))), None)
        if shape:
            return shape
        if any(grx.search(view) for _, grx in gate_terms):
            return "denylist term"
    return None

# --gate: the tree is checked as it is; every listed file is in scope and nothing is rewritten
if gate_only:
    allowed = lambda path: True
    scrub = lambda text: text
    swap_tables = lambda text: text

# ---- select and stage -----------------------------------------------------
raw = open(list_f, "rb").read().split(b"\0")
paths = sorted(p.decode("utf-8", "surrogateescape") for p in raw if p)
refusals, skipped, renamed = [], [], []
outs = {}  # output path -> source path
# a public file that ships under another name (hq-an7jw.21): the root .gitignore of the export is
# its own committed source, never the hq one; --gate checks a tree as it is, so it maps nothing
PUBLIC_AS = {} if gate_only else {"ops/share/public.gitignore": ".gitignore"}
links = []  # (source path, target, scrubbed target, staged path)

for rel in paths:
    if not allowed(rel):
        continue
    if rel == deny_rel and not gate_only:
        skipped.append((rel, "denylist itself"))
        continue
    src = os.path.join(root, rel)
    base = os.path.basename(rel)
    is_env = base == ".env" or (base.endswith(".env") and not base.endswith(".example.env")) \
        or (base.startswith(".env.") and base != ".env.example")
    if is_env:
        refusals.append("%s: env file selected by the allowlist" % rel)
        continue
    out = PUBLIC_AS.get(rel) or scrub(rel)  # names are scrubbed like content, so references stay consistent
    leak = name_leak(out)
    if leak:
        refusals.append("%s: unscrubbable file name (%s)" % (rel, leak))
        continue
    if out in outs:
        refusals.append("%s: scrubbed name collides with %s" % (rel, outs[out]))
        continue
    dst = os.path.join(stage, out)
    if os.path.islink(src):
        target = os.readlink(src)
        real = os.path.realpath(src)
        if os.path.isabs(target) or not (real == root or real.startswith(root + os.sep)):
            refusals.append("%s: symlink points outside the root (%s)" % (rel, target))
            continue
        new_target = scrub(target)
        leak = name_leak(new_target)
        if leak:
            refusals.append("%s: unscrubbable symlink target (%s)" % (rel, leak))
            continue
        # staged after every regular file, then checked against the staged tree (below)
        links.append((rel, target, new_target, dst))
        outs[out] = rel
        continue
    # --gate passes only what it read: a file it cannot read as text is a refusal, not a skip
    if not os.path.isfile(src):
        if gate_only:
            refusals.append("%s: %s; the gate cannot read it" % (rel, "not a regular file" if os.path.lexists(src) else "missing"))
        continue
    try:
        data = open(src, "rb").read()
    except OSError as e:
        refusals.append("%s: unreadable (%s)" % (rel, e.strerror))
        continue
    if b"\0" in data[:8192]:
        if gate_only:
            refusals.append("%s: binary; the gate cannot read it" % rel)
        else:
            skipped.append((rel, "binary"))
        continue
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        if gate_only:
            refusals.append("%s: not utf-8; the gate cannot read it" % rel)
        else:
            skipped.append((rel, "not utf-8"))
        continue
    text = scrub(swap_tables(text))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)
    os.chmod(dst, os.stat(src).st_mode & 0o777)
    outs[out] = rel
    if out != rel:
        renamed.append((rel, out))

# ---- symlinks: the target must be a file or directory in the staged tree, after every skip
# and rename; a link to a private, skipped or binary path would dangle or name it
for rel, target, new_target, dst in links:
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    os.symlink(new_target, dst)
stage_real = os.path.realpath(stage)
for rel, target, new_target, dst in links:
    sreal = os.path.realpath(dst)
    inside = sreal == stage_real or sreal.startswith(stage_real + os.sep)
    if not inside or not (os.path.isfile(sreal) or os.path.isdir(sreal)):
        refusals.append("%s: symlink target is not exported (%s)" % (rel, target))

# ---- gate -------------------------------------------------------------------
hits = []
for out, rel in sorted(outs.items()):
    dst = os.path.join(stage, out)
    if os.path.islink(dst):
        continue
    text = open(dst, encoding="utf-8", newline="").read()
    lines = text.split("\n")
    decoded = None  # the decoded copy, one entry per source line, when the file holds a reference
    if CHAR_REF.search(text):
        decoded = []
        for ln, line in enumerate(lines, 1):
            try:
                decoded.append(decode_refs(line))
            except BadRef as e:
                refusals.append("%s:%d: character reference %s names no character; the gate cannot read it" % (rel, ln, e))
                decoded.append(decode_refs(line, strict=False))
    for ln, line in enumerate(lines, 1):
        views = [line]
        if decoded is not None and decoded[ln - 1] != line:
            views.append(decoded[ln - 1])
        found = []
        for view in views:
            for t, grx in gate_terms:
                if grx.search(view):
                    found.append("denylist term survived scrub")
            for name, rx in SHAPES:
                if name in WHOLE_TEXT:
                    continue
                for m in rx.finditer(view):
                    if not ok_hit(m.group(0), rel):
                        found.append(name)
        for f in dict.fromkeys(found):
            hits.append("%s:%d: %s" % (rel, ln, f))
    # an assignment may put its value on the next line (JSON, YAML): scan the whole text, raw and
    # decoded, and name the source line where the match (the key) starts. A decoded &#10; splits a
    # line in the decoded copy; each part keeps its source line number.
    wholes = [(lines, list(range(1, len(lines) + 1)))]
    if decoded is not None:
        dlines, src = [], []
        for ln, line in enumerate(decoded, 1):
            for part in line.split("\n"):
                dlines.append(part)
                src.append(ln)
        wholes.append((dlines, src))
    file_hits = []
    for wlines, src in wholes:
        wtext = "\n".join(wlines)
        for name, rx in SHAPES:
            if name not in WHOLE_TEXT:
                continue
            for m in rx.finditer(wtext):
                if not ok_hit(m.group(0), rel):
                    file_hits.append("%s:%d: %s" % (rel, src[wtext.count("\n", 0, m.start())], name))
        for i, verdict in split_secret_values(wlines, rel):
            file_hits.append("%s:%d: %s" % (rel, src[i - 1], "secret-assign" if verdict == "leak"
                                            else "secret key with unsupported value syntax"))
    hits.extend(dict.fromkeys(file_hits))

log.append("root %s" % root)
log.append("files written %d" % len(outs))
log.append("files renamed %d" % len(renamed))
log.append("rig tables replaced %d" % tables)
log.append("replacements (term -> placeholder: count); this map never goes in the output")
for i, (t, r, f) in enumerate(terms):
    if counts[i]:
        log.append("  %r -> %r: %d" % (t, r, counts[i]))
log.append("replacements total %d over %d terms" % (sum(counts), sum(1 for c in counts if c)))
for rel, out in renamed:
    log.append("renamed %s -> %s" % (rel, out))
for rel, why in skipped:
    log.append("skipped %s (%s)" % (rel, why))
for r in refusals:
    log.append("REFUSED " + r)
for h in hits:
    log.append("LEAK " + h)

if refusals or hits:
    for r in refusals:
        say("REFUSED " + r, err=True)
    for h in hits:
        say("LEAK " + h, err=True)
    write_log()
    say("hq-public-export: %d refusal(s), %d leak(s); nothing written. log: %s" % (len(refusals), len(hits), log_f), err=True)
    sys.exit(2)
if not outs:
    die(3, "the allowlist selected no exportable files")
write_log()
say("files %d (renamed %d), replacements %d over %d terms, rig tables %d, skipped %d" %
    (len(outs), len(renamed), sum(counts), sum(1 for c in counts if c), tables, len(skipped)))
PY
rc=$?
set -e
[ "$rc" -eq 0 ] || exit "$rc"

if [ "$check" -eq 1 ]; then
  echo "check clean; log: $log"
  return 0
fi
# --out was checked absent or empty at the start; a failed copy removes what it wrote
[ -e "$out" ] || made=1
mkdir -p -- "$out" && [ -d "$out" ] \
  || { echo "hq-public-export: cannot make the output dir $out; nothing written" >&2; exit 1; }
if ! cp -a -- "$STAGE/tree/." "$out/"; then
  if [ "$made" -eq 1 ]; then rm -rf -- "$out"; else (shopt -s dotglob nullglob; rm -rf -- "${out:?}"/*); fi
  echo "hq-public-export: copying the export to $out failed (cp); nothing written" >&2; exit 1
fi
[ -n "$(ls -A "$out")" ] || { echo "hq-public-export: output is empty" >&2; exit 3; }
echo "wrote $out; log: $log"
}

if [ -n "$PUSH" ]; then
  # --push works in a temp repo of its own (hq-an7jw.11): CHECKOUT is read for its origin url only and
  # is never written, so a failed or killed run has nothing to roll back anywhere
  P="$(realpath -e -- "$PUSH" 2>/dev/null)" && [ -d "$P" ] \
    || { echo "hq-public-export: --push wants a checkout of the public repo: $PUSH" >&2; exit 1; }
  PURLS="$(git -C "$P" remote get-url --push --all origin 2>/dev/null)" \
    || { echo "hq-public-export: --push wants a checkout with an origin: $P" >&2; exit 1; }
  # one push url: the one place this run reads the tip from and pushes to
  [ "$(printf '%s\n' "$PURLS" | grep -c .)" -eq 1 ] \
    || { echo "hq-public-export: origin must have exactly one push url: $P" >&2; exit 1; }
  PURL="$PURLS" BR=main
  # a relative filesystem url names a path from the checkout's toplevel (where git resolves it), not
  # from this run's cwd: resolve it now; a url with a scheme or an scp-like host:path stays as it is
  case "$PURL" in
    *://*|/*) ;;
    *) pre="${PURL%%:*}"
       if [ "$pre" = "$PURL" ] || [ "${pre#*/}" != "$pre" ]; then
         top="$(git -C "$P" rev-parse --show-toplevel 2>/dev/null)" && [ -n "$top" ] \
           || { echo "hq-public-export: cannot find the toplevel of $P to resolve its origin url" >&2; exit 1; }
         PURL="$(realpath -e -- "$top/$PURL" 2>/dev/null)" \
           || { echo "hq-public-export: the relative origin url does not resolve from $top: $PURLS" >&2; exit 1; }
       fi ;;
  esac
  # (the root is a repository's own toplevel with a commit, $SHA: checked above for every mode)
  st="$(git -C "$ROOT" status --porcelain --untracked-files=no)" \
    || { echo "hq-public-export: git failed reading the root status; refused" >&2; exit 1; }
  [ -z "$st" ] \
    || { echo "hq-public-export: the root has uncommitted tracked changes; commit them first" >&2; exit 1; }
  # the public files: the committed dir at $PUBLIC in $SHA, read by path in the object store; it holds
  # README.md and LICENSE (required), CONTRIBUTING.md (optional), each a committed regular file, and
  # nothing else. The working tree at that path is never listed or read.
  ent="$(head_entry "$PUBLIC")"
  case "$ent" in
    "040000 tree "*) ;;
    *) echo "hq-public-export: the public dir is not a committed directory at $SHA: $PUBLIC" >&2; exit 1 ;;
  esac
  GC ls-tree -z "${ent##* }" >"$WORK/.pub" || { echo "hq-public-export: git ls-tree failed on the public dir; refused" >&2; exit 1; }
  PUBF=() extra=""
  while IFS= read -r -d '' e; do
    n="${e#*$'\t'}" m="${e%%$'\t'*}"
    case "$n" in
      README.md|LICENSE|CONTRIBUTING.md)
        case "$m" in
          "100644 blob "*|"100755 blob "*) PUBF+=("$n" "$m") ;;
          *) echo "hq-public-export: public file is not a committed regular file at $SHA: $PUBLIC/$n" >&2; exit 1 ;;
        esac ;;
      *) extra="$extra $n" ;;
    esac
  done <"$WORK/.pub"
  [ -z "$extra" ] || { echo "hq-public-export: the committed --public dir holds files outside README.md, LICENSE, CONTRIBUTING.md:$extra" >&2; exit 2; }
  for f in README.md LICENSE; do
    case " ${PUBF[*]} " in *" $f 100"*) ;; *) echo "hq-public-export: required public file missing at $SHA: $PUBLIC/$f" >&2; exit 1 ;; esac
  done
  W="$WORK"
  R="$W/repo" KEEP=0 PUSHING=0 START="" NEW=""
  # every git call on the temp repo: no hooks, replace refs, attributes file or line-ending rewrite,
  # whatever the user or system config says (the global config stays: it holds the credential helper)
  G() {
    git --git-dir="$R" -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null -c core.autocrlf=false \
        -c core.eol=lf -c core.safecrlf=false -c core.fileMode=true -c core.symlinks=true "$@"
  }
  # origin_tip: origin's branch tip, read now; "" when the branch is absent; non-zero when origin does not answer
  origin_tip() {
    local refs
    refs="$(G ls-remote --refs -- "$PURL" 2>/dev/null)" || return 1
    printf '%s\n' "$refs" | awk -v r="refs/heads/$BR" '$2 == r { print $1 }'
  }
  # Before the push nothing outside $W was written: any exit or signal deletes $W and that is all.
  # After a push attempt origin decides the exit: NEW pushed (0), START absent (4), anything else or
  # no answer unknown (5, $W kept with the commit).
  # shellcheck disable=SC2317  # reached through the EXIT trap
  on_exit() {
    rc=$?
    trap '' INT TERM HUP
    if [ "$PUSHING" -eq 1 ]; then
      if ! tip="$(origin_tip)"; then rc=5 tip="no answer"
      elif [ "$tip" = "$NEW" ]; then rc=0
      elif [ "$tip" = "$START" ]; then rc=4
      else rc=5
      fi
      case "$rc" in
        0) echo "pushed $NEW to $PURL $BR; the checkout $P is not updated: git -C $P pull --ff-only" ;;
        4) echo "hq-public-export: origin $BR (${START:-absent}) does not hold the export commit; nothing pushed" >&2 ;;
        *) KEEP=1
           echo "hq-public-export: PUSH OUTCOME UNKNOWN (origin $BR: ${tip:-absent}); the export commit $NEW is kept in $R" >&2 ;;
      esac
    fi
    [ "$KEEP" -eq 1 ] || rm -rf "$W"
    exit "$rc"
  }
  trap on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  # the snapshot of $SHA (build_snap); everything below reads the root through it only (lucy
  # hq-an7jw.12 finding 1: assume-unchanged, skip-worktree and clean filters hide working-tree bytes)
  SNAP="$W/snap"
  build_snap "$SNAP"
  git init -q --bare --template= "$R" >/dev/null || { echo "hq-public-export: cannot make the temp repo" >&2; exit 1; }
  # the start is origin's tip as fetched now (no tip: an unborn branch, the export has no parent)
  tip="$(origin_tip)" || { echo "hq-public-export: cannot read origin: $PURL" >&2; exit 1; }
  if [ -n "$tip" ]; then
    G fetch -q --no-tags --no-recurse-submodules -- "$PURL" "+refs/heads/$BR:refs/heads/$BR" >/dev/null 2>&1 \
      && START="$(G rev-parse --verify -q "refs/heads/$BR^{commit}")" \
      || { echo "hq-public-export: cannot fetch origin $BR: $PURL" >&2; exit 1; }
  fi
  ( core "$SNAP" 0 0 "$W/tree" "$LOG" ) || exit $?
  for ((i = 0; i < ${#PUBF[@]}; i += 2)); do
    f="${PUBF[i]}" m="${PUBF[i+1]}"
    rm -f -- "$W/tree/$f"; head_blob "${m##* }" "$W/tree/$f"
    chmod "$([ "${m%% *}" = 100755 ] && echo 755 || echo 644)" "$W/tree/$f"
  done
  # one public identity, never the ambient git config; UTC dates so no timezone rides along.
  # The built-in default is reviewed code (its login is the repo owner's, already in the repo URL);
  # an override from the environment goes through the gate like the message does.
  NAME="${HQ_PUBLIC_NAME:-$PUBLIC_NAME}" EMAIL="${HQ_PUBLIC_EMAIL:-$PUBLIC_EMAIL}"
  MSG="export from hq $SHA"
  mkdir "$W/meta"
  if [ "$NAME <$EMAIL>" = "$PUBLIC_NAME <$PUBLIC_EMAIL>" ]; then
    printf '%s\n' "$MSG" >"$W/meta/commit"
  else
    printf '%s\n%s <%s>\n' "$MSG" "$NAME" "$EMAIL" >"$W/meta/commit"
  fi
  ( core "$W/meta" 1 1 "" "$LOG.meta" ) >/dev/null \
    || { rc=$?; echo "hq-public-export: the commit identity or message failed the gate; nothing pushed" >&2; exit "$rc"; }
  # the whole tree to publish, public files included, as it is
  ( core "$W/tree" 1 1 "" "$LOG.gate" ) \
    || { rc=$?; echo "hq-public-export: the export failed the gate; nothing pushed" >&2; exit "$rc"; }
  # The gated tree id, computed from the gated files' raw bytes and modes with no git involved; the
  # tree git builds must be exactly this one, whatever filter or attribute config git reads
  FMT="$(G rev-parse --show-object-format)" || { echo "hq-public-export: cannot read the object format" >&2; exit 1; }
  GATED="$(python3 -I - "$W/tree" "$FMT" <<'PY'
import hashlib, os, stat, sys
fmt = sys.argv[2]
def obj(kind, data):
    h = hashlib.new(fmt)
    h.update(b"%s %d\0" % (kind, len(data))); h.update(data)
    return h.digest()
def tree(d):
    ents = []
    for name in os.listdir(d):
        full = os.path.join(d, name); st = os.lstat(full)
        if stat.S_ISLNK(st.st_mode):
            ents.append((name, b"120000", obj(b"blob", os.readlink(full))))
        elif stat.S_ISREG(st.st_mode):
            ents.append((name, b"100755" if st.st_mode & stat.S_IXUSR else b"100644",
                         obj(b"blob", open(full, "rb").read())))
        elif stat.S_ISDIR(st.st_mode):
            sub = tree(full)
            if sub is not None:  # git keeps no empty tree
                ents.append((name + b"/", b"40000", sub))  # git sorts a tree as name + "/"
        else:
            sys.exit("hq-public-export: not a file, link or dir in the export: %s" % os.fsdecode(full))
    if not ents:
        return None
    ents.sort(key=lambda e: e[0])
    return obj(b"tree", b"".join(b"%s %s\0%s" % (m, n.rstrip(b"/"), oid) for n, m, oid in ents))
t = tree(os.fsencode(sys.argv[1]))
if t is None:
    sys.exit("hq-public-export: the export is empty")
print(t.hex())
PY
)" || exit 2
  GIT_INDEX_FILE="$W/index" G --work-tree="$W/tree" -C "$W/tree" add -A --force . \
    || { echo "hq-public-export: git add failed in the temp repo" >&2; exit 1; }
  TREE="$(GIT_INDEX_FILE="$W/index" G write-tree)" || { echo "hq-public-export: write-tree failed" >&2; exit 1; }
  [ "$TREE" = "$GATED" ] || {
    echo "hq-public-export: git built tree $TREE, not the gated tree $GATED (a filter or attribute config?); nothing pushed" >&2; exit 2; }
  if [ -n "$START" ]; then
    START_TREE="$(G rev-parse --verify -q "$START^{tree}")" && [ -n "$START_TREE" ] \
      || { echo "hq-public-export: cannot read the tree of the start $START; nothing pushed" >&2; exit 1; }
    if [ "$TREE" = "$START_TREE" ]; then
      echo "no change since the last export (hq $SHA)"
      exit 0
    fi
  fi
  # the commit object: the gated tree, one parent (the fetched start; none on an unborn branch), the
  # public identity and message; built with commit-tree (no hook, template or signature) and verified
  EPOCH="$(date -u +%s)"; NOW="@$EPOCH +0000"
  PARENT=(); [ -z "$START" ] || PARENT=(-p "$START")
  NEW="$(GIT_AUTHOR_NAME="$NAME" GIT_AUTHOR_EMAIL="$EMAIL" GIT_AUTHOR_DATE="$NOW" \
         GIT_COMMITTER_NAME="$NAME" GIT_COMMITTER_EMAIL="$EMAIL" GIT_COMMITTER_DATE="$NOW" \
         G -c commit.gpgSign=false -c i18n.commitEncoding=UTF-8 \
           commit-tree --no-gpg-sign "$TREE" "${PARENT[@]}" -m "$MSG")" \
    || { echo "hq-public-export: commit failed" >&2; exit 1; }
  want="tree $GATED"
  [ -z "$START" ] || want="$want"$'\n'"parent $START"
  want="$want"$'\n'"author $NAME <$EMAIL> $EPOCH +0000"$'\n'"committer $NAME <$EMAIL> $EPOCH +0000"$'\n\n'"$MSG"
  got="$(G cat-file commit "$NEW")" || { echo "hq-public-export: cannot read the new commit" >&2; exit 1; }
  [ "$got" = "$want" ] \
    || { echo "hq-public-export: the new commit is not the one built (tree, parents, identity, headers or message differ); nothing pushed" >&2; exit 2; }
  echo "committed $NEW: $MSG"
  # one ref, no tags, whatever the config says; origin takes it only while its tip is still START
  # (compare-and-swap; an empty START means the branch must not exist yet)
  PUSHING=1
  G -c push.followTags=false -c push.gpgSign=false -c push.recurseSubmodules=no \
    push -q --no-verify --no-follow-tags --no-signed --no-recurse-submodules \
      --force-with-lease="refs/heads/$BR:$START" -- "$PURL" "$NEW:refs/heads/$BR" 2>&1 \
    || echo "hq-public-export: the push reported a failure; asking origin" >&2
  exit 0  # on_exit asks origin and sets the exit status
fi

# --gate scans DIR as it is; --out and --check export the snapshot of $SHA, never the working tree
if [ "$GATE_ONLY" -eq 1 ]; then
  core "$ROOT" 1 1 "" "$LOG"
else
  build_snap "$WORK/snap"
  core "$WORK/snap" 0 "$CHECK" "${OUT_ABS:-}" "$LOG"
fi
