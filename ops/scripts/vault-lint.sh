#!/usr/bin/env bash
# vault-lint.sh - deterministic, zero-token vault structure check. Warn-only
# unless --strict. Usage: vault-lint.sh [ROOT] [--strict]
#
# Checks per workspace under "01 Projects/*" and "02 Bunkers/*":
#   - _index.md hub exists and carries "## Map", "## Decisions", frontmatter "updated:"
#   - no loose .md at the workspace root beyond _index.md / Knowledge.md
#   - no orphan notes: a note is an orphan only if it has NO outgoing [[link]] AND
#     nothing else in the vault links to it (bidirectional graph connectivity).
#   - no ambiguous bare links: [[_index]] and [[Knowledge]] must be path-qualified
#     because those basenames repeat across workspaces and resolve arbitrarily.
# Generated graph dirs (graphify-out, _graph) are ignored.
set -uo pipefail
STRICT=0; ROOT=""
for a in "$@"; do
  case "$a" in
    --strict) STRICT=1 ;;
    *) ROOT="$a" ;;
  esac
done
: "${ROOT:=$("$(dirname "$0")/vault-path.sh")}"

ROOT="$ROOT" python3 - "$STRICT" <<'PY'
import os, re, sys
root = os.environ["ROOT"]; strict = sys.argv[1] == "1"
IGNORE_DIRS = {"graphify-out", "_graph"}
LINK_RE = re.compile(r"\[\[([^\]|#]+)")

# Build a vault-wide index of every wikilink target (by basename, case-insensitive)
# so we can tell whether anything links TO a given note.
linked_targets = set()
note_paths = []
for dpath, dirs, files in os.walk(root):
    dirs[:] = [d for d in dirs if d not in IGNORE_DIRS and not d.startswith(".")]
    for f in files:
        if not f.endswith(".md"):
            continue
        p = os.path.join(dpath, f)
        try:
            text = open(p, encoding="utf-8", errors="replace").read()
        except Exception:
            text = ""
        note_paths.append((p, text))
        for m in LINK_RE.finditer(text):
            t = m.group(1).strip().lower()
            linked_targets.add(t)
            # path-qualified links must still count as incoming for the basename
            linked_targets.add(t.rsplit("/", 1)[-1])

def has_incoming(p):
    return os.path.splitext(os.path.basename(p))[0].strip().lower() in linked_targets

text_by_path = dict(note_paths)
warns = []
def warn(ws, msg): warns.append(f"WARN {ws}: {msg}")

for tree in ("01 Projects", "02 Bunkers"):
    base = os.path.join(root, tree)
    if not os.path.isdir(base): continue
    for name in sorted(os.listdir(base)):
        wsdir = os.path.join(base, name)
        if not os.path.isdir(wsdir): continue
        ws = f"{tree}/{name}"
        hub = os.path.join(wsdir, "_index.md")
        if not os.path.isfile(hub):
            warn(ws, "missing _index.md hub"); continue
        htext = text_by_path.get(hub, "")
        if "## Map" not in htext:       warn(ws, "hub missing '## Map' section")
        if "## Decisions" not in htext: warn(ws, "hub missing '## Decisions' section")
        if not re.search(r"^updated:", htext, re.M): warn(ws, "hub missing frontmatter 'updated:'")
        for f in os.listdir(wsdir):
            if f.endswith(".md") and f not in ("_index.md", "Knowledge.md"):
                warn(ws, f"loose file at workspace root: {f} (file it into a category)")
        for dpath, dirs, files in os.walk(wsdir):
            dirs[:] = [d for d in dirs if d not in IGNORE_DIRS and not d.startswith(".")]
            for f in files:
                if not f.endswith(".md"): continue
                p = os.path.join(dpath, f)
                text = text_by_path.get(p, "")
                bare = sorted({m.strip() for m in LINK_RE.findall(text)
                               if m.strip().lower() in ("_index", "knowledge")})
                if bare:
                    warn(ws, f"ambiguous bare link(s) {bare} in {os.path.relpath(p, wsdir)}"
                             f" (path-qualify: [[{tree}/{name}/_index|...]])")
                if f == "_index.md": continue
                outgoing = "[[" in text
                if not outgoing and not has_incoming(p):
                    warn(ws, f"orphan note (no link in or out): {os.path.relpath(p, wsdir)}")

for w in warns: print(w)
print(f"vault-lint: {len(warns)} warning(s)")
sys.exit(1 if (strict and warns) else 0)
PY
