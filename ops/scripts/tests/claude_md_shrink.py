"""Checks for the CLAUDE.md shrink (hq-pgbpq.9). Run through
claude-md-shrink.test.sh. Static mode proves no rule was lost; --live proves
every path-scoped rule loads on its path in a real Claude Code session."""
import glob
import json
import os
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from claude_md_units import units  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
OLD_COMMIT = "7858dc0"  # main at the last merge of main into this branch (was 9d7abd8 at bead start); the inventory is keyed to it
INVENTORY = os.path.join(ROOT, "docs/plans/claude-md-shrink.rules.tsv")
LIMIT = 20000
NO_FILE_HOMES = ("trimmed", "superseded")
FAILS = []


def fail(msg):
    FAILS.append(msg)
    print("FAIL " + msg)


def norm(x):
    return re.sub(r"\s+", " ", x.replace("**", "").replace("\u2014", "-")).strip().lower()


def read(rel):
    with open(os.path.join(ROOT, rel)) as f:
        return f.read()


def rule_files():
    return sorted(os.path.relpath(p, ROOT) for p in glob.glob(os.path.join(ROOT, ".claude/rules/**/*.md"), recursive=True))


def frontmatter_paths(text):
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not m:
        return None
    return re.findall(r'^\s*-\s*"([^"]+)"\s*$', m.group(1), re.M)


def load_inventory():
    rows = {}
    for n, line in enumerate(open(INVENTORY), 1):
        if line.startswith("#") or not line.strip():
            continue
        cells = line.rstrip("\n").split("\t")
        cells += [""] * (4 - len(cells))
        unit, home, anchor, note = cells[:4]
        if not unit.isdigit():
            fail("inventory line %d: unit is not a number" % n)
            continue
        if int(unit) in rows:
            fail("inventory line %d: unit %s listed twice" % (n, unit))
        rows[int(unit)] = (home, anchor, note)
    return rows


def static():
    old = subprocess.run(["git", "-C", ROOT, "show", OLD_COMMIT + ":CLAUDE.md"],
                         capture_output=True, text=True, check=True).stdout
    new = read("CLAUDE.md")
    size = len(new.encode())
    print("size: old %d bytes, new %d bytes (limit %d)" % (len(old.encode()), size, LIMIT))
    if size >= LIMIT:
        fail("CLAUDE.md is %d bytes, limit is %d" % (size, LIMIT))

    homes = ["CLAUDE.md"] + rule_files()
    corpus = {h: norm(read(h)) for h in homes}
    old_units = units(old)
    inv = load_inventory()
    lost, kinds = [], {}
    for i, u in enumerate(old_units):
        if i in inv:
            home, anchor, note = inv[i]
            if home in NO_FILE_HOMES:
                if not note:
                    fail("unit %d is %s with no reason" % (i, home))
                kinds[home] = kinds.get(home, 0) + 1
                continue
            if home not in corpus:
                fail("unit %d: home %s is not CLAUDE.md or a rule file" % (i, home))
                continue
            if not anchor or norm(anchor) not in corpus[home]:
                fail("unit %d: anchor not found in %s: %s" % (i, home, anchor[:80]))
                continue
            kinds[home] = kinds.get(home, 0) + 1
            continue
        hit = [h for h in homes if norm(u) in corpus[h]]
        if hit:
            kinds[hit[0]] = kinds.get(hit[0], 0) + 1
        else:
            lost.append(i)
    for i in sorted(set(inv) - set(range(len(old_units)))):
        fail("inventory names unit %d; the old file has only %d units" % (i, len(old_units)))
    print("rule units: %d before; accounted after: %d; lost: %d" % (len(old_units), len(old_units) - len(lost), len(lost)))
    for i in lost:
        fail("unit %d has no home (diff of rule list is not empty): %s" % (i, old_units[i][:100]))
    for k in sorted(kinds):
        print("  %-48s %d" % (k, kinds[k]))

    # Every moved rule is path-scoped: an unscoped rule file loads always and saves nothing.
    for rf in rule_files():
        paths = frontmatter_paths(read(rf))
        if not paths:
            fail("%s has no paths: frontmatter" % rf)

    # The Rigs table and the per-rig rule files name the same rigs.
    m = re.search(r"^\| Rig \| Path \|.*\n\|[-| ]+\|\n((?:\|.*\n?)*)", new, re.M)
    if not m:
        fail("Rigs table anchor missing (drift-check rigs_table claim)")
    else:
        table = {l.strip().strip("|").split("|")[0].strip() for l in m.group(1).splitlines() if l.strip()}
        files = {os.path.basename(p)[:-3] for p in rule_files() if p.startswith(".claude/rules/rigs/")}
        if table != files:
            fail("Rigs table %s differs from rule files %s" % (sorted(table ^ files), sorted(files)))

    # drift-check claims still find their sentence in the file they now point at.
    man = json.loads(read("ops/config/runtime.json"))
    for c in man.get("claims", []):
        if c.get("regex") and not re.search(c["regex"], read(c.get("file", "CLAUDE.md"))):
            fail("drift claim %s: regex finds nothing in %s" % (c["id"], c.get("file")))


def sample_for(pattern):
    p = re.sub(r"\{([^,}]+)[^}]*\}", r"\1", pattern)
    p = p.replace("**", "x").replace("*", "sample")
    return p + "/f.txt" if p.endswith("/x") else p


def live():
    with tempfile.TemporaryDirectory() as t:
        root = os.path.join(t, "hq")
        os.makedirs(os.path.join(root, ".claude"))
        subprocess.run(["cp", "-r", os.path.join(ROOT, ".claude/rules"), os.path.join(root, ".claude/rules")], check=True)
        subprocess.run(["cp", os.path.join(ROOT, "CLAUDE.md"), root], check=True)
        expect, samples = {}, []
        for rf in rule_files():
            for pat in frontmatter_paths(read(rf)):
                s = sample_for(pat)
                full = os.path.join(root, s)
                os.makedirs(os.path.dirname(full), exist_ok=True)
                with open(full, "w") as f:
                    f.write("fixture\n")
                samples.append(s)
                expect.setdefault(rf, []).append(s)
        subprocess.run(["git", "init", "-q", root], check=True)
        log = os.path.join(t, "loaded.jsonl")
        settings = os.path.join(t, "settings.json")
        with open(settings, "w") as f:
            json.dump({"hooks": {"InstructionsLoaded": [{"hooks": [{"type": "command",
                       "command": "cat >> '%s'; echo >> '%s'" % (log, log)}]}]}}, f)
        prompt = ("Use the Read tool on each of these files, one call per file, in order. "
                  "Do nothing else, then reply DONE.\n" + "\n".join(samples))
        r = subprocess.run(["claude", "-p", "--model", "claude-haiku-5-5", "--settings", settings,
                            "--dangerously-skip-permissions", prompt],
                           cwd=root, capture_output=True, text=True, timeout=900)
        print("live session exit %d: %s" % (r.returncode, r.stdout.strip()[-60:]))
        events = [json.loads(l) for l in open(log) if l.strip()] if os.path.exists(log) else []
        at_start = {os.path.relpath(e["file_path"], root) for e in events
                    if e.get("load_reason") == "session_start" and e["file_path"].startswith(root)}
        matched = {os.path.relpath(e["file_path"], root) for e in events if e.get("load_reason") == "path_glob_match"}
        for rf in expect:
            if rf in at_start:
                fail("%s loaded at session start; a path rule must not" % rf)
            if rf not in matched:
                fail("%s did not load on its paths %s" % (rf, expect[rf]))
        if "CLAUDE.md" not in at_start:
            fail("CLAUDE.md did not load at session start")
        print("live: %d rule files, %d loaded on their paths, %d at start" % (len(expect), len(matched & set(expect)), len(at_start)))

        # Nested rig worktree: a session in rigs/<rig>-<id> (its own git repo)
        # gets the hq rules as ancestors, and only that rig's notes load.
        wt = os.path.join(root, "rigs", "acme-avance-f1x7")
        os.makedirs(wt, exist_ok=True)
        with open(os.path.join(wt, "app.js"), "w") as f:
            f.write("fixture\n")
        subprocess.run(["git", "init", "-q", wt], check=True)
        open(log, "w").close()
        r = subprocess.run(["claude", "-p", "--model", "claude-haiku-5-5", "--settings", settings,
                            "--dangerously-skip-permissions", "Use the Read tool on app.js, then reply DONE."],
                           cwd=wt, capture_output=True, text=True, timeout=300)
        events = [json.loads(l) for l in open(log) if l.strip()]
        got = {os.path.relpath(e["file_path"], root) for e in events}
        if "CLAUDE.md" not in got:
            fail("nested rig session did not load the hq CLAUDE.md")
        if ".claude/rules/rigs/acme-avance.md" not in got:
            fail("nested rig session did not load its rig rule")
        others = sorted(g for g in got if g.startswith(".claude/rules/rigs/") and "acme-avance" not in g)
        if others:
            fail("nested rig session loaded other rigs' rules: %s" % others)
        print("nested rig: loaded %s" % sorted(got))


def table():
    """Print the rule-by-rule mapping as a markdown table (for the plan doc)."""
    old = subprocess.run(["git", "-C", ROOT, "show", OLD_COMMIT + ":CLAUDE.md"],
                         capture_output=True, text=True, check=True).stdout
    homes = ["CLAUDE.md"] + rule_files()
    corpus = {h: norm(read(h)) for h in homes}
    inv = load_inventory()
    print("| # | Old rule (start) | New home | How |")
    print("|---|---|---|---|")
    for i, u in enumerate(units(old)):
        # Quoted old text drops the em dashes and arrows hook-no-em-dash blocks.
        cell = re.sub(r"\s+", " ", u).replace("\u2014", "-").replace("\u2192", "to").replace("\u00b7", ",")
        cell = cell.replace("|", "\\|")
        cell = cell[:110] + ("..." if len(cell) > 110 else "")
        if i in inv:
            home, anchor, note = inv[i]
            how = "reworded" if home not in NO_FILE_HOMES else home
            if note:
                how += ": " + note.replace("|", "\\|")
        else:
            home = next((h for h in homes if norm(u) in corpus[h]), "LOST")
            how = "verbatim"
        print("| %d | %s | %s | %s |" % (i, cell, home, how))


if __name__ == "__main__":
    if "--table" in sys.argv:
        table()
        sys.exit(0)
    static()
    if "--live" in sys.argv:
        live()
    print("FAILED %d" % len(FAILS) if FAILS else "PASS")
    sys.exit(1 if FAILS else 0)
