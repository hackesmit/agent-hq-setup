#!/usr/bin/env bash
# hook-tripwire.sh (hq-8cry.4): alarm on any change to agent and editor hooks
# that did not come from a git commit in ~/hq.
#
# The August 2026 npm worm persisted by writing Claude Code and VS Code hooks.
# This hashes every file under:
#   ~/.claude/settings*.json  ~/.claude/hooks/
#   .claude/ in ~/hq and in every rig main checkout (worktrees excluded)
#   ~/.vscode*/extensions/
#   ~/hq/ops/scripts/hook-*.sh, and every file a settings hook command names by
#     path (system dirs such as /usr and /bin excluded; a bare command found on
#     PATH, like `bd`, is not followed)                              (hq-8cry.8)
#   ~/.claude.json, its MCP servers only (user and per project)      (hq-8cry.8)
#   .mcp.json at the root of ~/hq and of each rig, and the files its
#     servers name                                                   (hq-8cry.10)
#   ~/.claude/plugins, the files that can run code: hooks/, .mcp.json,
#     plugin.json, scripts and executables, and known_marketplaces.json minus
#     lastUpdated. Session markers (.in_use, .last_inuse_sweep), .trash, the
#     directory cache and the marketplaces/ catalog churn on their own and are
#     skipped: a catalog plugin runs only once installed into cache/ or synced/,
#     and enabledPlugins lives in settings.json, which is watched. (hq-8cry.8)
# and compares with the last run. A change is legitimate only when the path is
# tracked in its repo and the working copy matches HEAD (a committed change,
# a merge or a pull), or when a deleted path left the repo by a commit. Anything
# else raises one `notify.sh urgent` naming the paths (never the content) and
# a line in the log; the baseline then moves on, so one change alerts once.
#
# settings*.json are hashed after dropping WebFetch(domain:...) grants from
# permissions.allow and string entries from sandbox.network.allowedDomains
# (with the empty objects that leaves): the egress ledger hook writes both on
# its own, and a domain grant cannot run code. Every other key, hooks and the
# rest of sandbox included, counts. (hq-8cry.14)
#
# The baseline is also copied to $MIRROR (default /var/lib/hq-tripwire, written
# with sudo -n so it is root owned). When that copy exists it is the reference:
# a baseline in state/security that is missing or differs from it alerts, so
# deleting both the baseline and the log, or editing the baseline to hide a
# hook, is seen (hq-8cry.8). A baseline whose #coverage line is older than
# COVERAGE adopts paths new to it once, quietly, so widening the scan does not
# page the owner.
#
# usage: hook-tripwire.sh          (first run records the baseline quietly)
# ~/hq is the main checkout even when this runs from a worktree.
# Env (tests): TRIPWIRE_HOME, TRIPWIRE_HQ, TRIPWIRE_STATE, TRIPWIRE_NOTIFY,
# TRIPWIRE_MIRROR.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
H="${TRIPWIRE_HOME:-$HOME}"
HQ="${TRIPWIRE_HQ:-${HQ_ROOT:-$(dirname "$(git -C "$DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "$DIR/../../.git")")}}"
STATE="${TRIPWIRE_STATE:-$HQ/state/security}"
NOTIFY="${TRIPWIRE_NOTIFY:-$HQ/ops/scripts/notify.sh}"
BASE="$STATE/hook-tripwire.tsv"
LOG="$STATE/hook-tripwire.log"
MIRROR="${TRIPWIRE_MIRROR:-/var/lib/hq-tripwire}"
MBASE="$MIRROR/hook-tripwire.tsv"
COVERAGE=3
SYNCED="$H/.claude/plugins/synced"
mkdir -p "$STATE"

hash_file() {
  local f="$1"
  # a symlink hashes its link text and the content it points at, so swapping
  # the target file is seen too
  if [ -L "$f" ]; then
    printf 'link:%s:%s' "$(readlink "$f")" "$( [ -f "$f" ] && sha256sum "$f" 2>/dev/null | cut -c1-64 || echo none)"
    return
  fi
  if [ "$f" = "$H/.claude.json" ]; then
    # Claude Code rewrites this file all day; only MCP servers can run code.
    # Projects with no servers are dropped, so a new project entry is quiet.
    jq -cS '{user: (.mcpServers // {}),
             projects: ((.projects // {}) | map_values(.mcpServers // {}) | with_entries(select(.value != {})))}' \
      "$f" 2>/dev/null | sha256sum | cut -c1-64
    return
  fi
  case "${f##*/}" in
    known_marketplaces.json)
      jq -cS 'if type == "object" then map_values(if type == "object" then del(.lastUpdated) else . end) else . end' \
        "$f" 2>/dev/null | sha256sum | cut -c1-64 && return ;;
    settings*.json)
      # Only the egress ledger's own file, settings.local.json, drops plain domain
      # grants, and never a wildcard one.
      jq -cS --argjson local "$([ "${f##*/}" = settings.local.json ] && echo true || echo false)" 'def drop_empty(p): if (getpath(p) == {}) then delpaths([p]) else . end;
              (if (.permissions.allow | type) == "array"
               then .permissions.allow |= map(select((type == "string" and test("^WebFetch\\(domain:[^)]*\\)$")) | not))
               else . end)
              | if $local and (.sandbox | type) == "object" and (.sandbox.network | type) == "object"
                   and (.sandbox.network.allowedDomains | type) == "array"
                then .sandbox.network.allowedDomains |= map(select(type != "string" or test("[*]")))
                     | if .sandbox.network.allowedDomains == [] then del(.sandbox.network.allowedDomains) else . end
                else . end
              | if $local and (.sandbox | type) == "object" and (.sandbox.network | type) == "object"
                then drop_empty(["sandbox", "network"]) else . end
              | if $local and (.sandbox | type) == "object" then drop_empty(["sandbox"]) else . end' "$f" 2>/dev/null | sha256sum | cut -c1-64 && return ;;
  esac
  sha256sum "$f" 2>/dev/null | cut -c1-64
}

# repos: ~/hq and each rig main checkout (.git is a directory), once per real path
repos() {
  local seen="" d real
  for d in "$HQ" "$HQ"/rigs/*; do
    real="$(readlink -f "$d")"
    [ -d "$real/.git" ] || continue
    # a symlinked rig counts once, under its real path (an alias of a rig
    # already listed is dropped, an external target is still scanned)
    [ -L "$d" ] && d="$real"
    case " $seen " in *" $real "*) continue ;; esac
    seen="$seen $real"; printf '%s\n' "$d"
  done
}

# Files that hook, statusLine and MCP entry points name by path. stdin carries
# one "kind<TAB>file" per config: settings (hooks and statusLine.command, run
# from the repo that holds the file), claude (~/.claude.json MCP servers), or
# plugin (a plugin's hooks/hooks.json, .mcp.json or plugin.json, with
# ${CLAUDE_PLUGIN_ROOT} as the plugin dir). Shell commands are split with
# shlex, never run, so a quoted path with spaces stays one path; a token with
# whitespace (the string of bash -c, sh -c, an MCP arg) is split again; a
# relative path or bare name resolves against the project or plugin dir and
# counts when that file exists. System dirs are root owned and change with
# apt, so they are left out; PATH is never searched, so `bd` is not followed.
# A "project" line is a repo-root .mcp.json. (hq-8cry.8, hq-8cry.10)
# The -c string of sh, bash, zsh and dash is split as shell even with no
# whitespace (sh -c 'a;b'); after --directory DIR (uv, uvx) a relative path
# resolves against DIR; a path holding .. resolves through its symlinks the way
# the kernel opens it; the settings command helpers (apiKeyHelper and the rest)
# are followed like statusLine.command; MCP args that name data files (db,
# sqlite, json) are left out, as a database write is not code. One entry that
# breaks the parser is skipped and reported on stderr as "malformed<TAB>file",
# so it never hides the other targets. (hq-8cry.13)
read -r -d '' TARGETS_PY <<'PY'
import json, os, re, shlex, sys
home = sys.argv[1]
SYSTEM = ("/usr/", "/bin/", "/sbin/", "/lib", "/etc/", "/proc/", "/dev/")
SHELLS = ("sh", "bash", "zsh", "dash")
HELPERS = ("apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "otelHeadersHelper")
DATA = (".db", ".db3", ".sqlite", ".sqlite3", ".duckdb", ".json", ".jsonl", ".ndjson", ".csv", ".parquet")
CUR = [""]  # the config file being read, for the malformed report

def each(fn, *a):
    try:
        fn(*a)
    except Exception:
        sys.stderr.write("malformed\t%s\n" % CUR[0])

def subst(s, root, plugin):
    pairs = [("${CLAUDE_PROJECT_DIR}", root), ("$CLAUDE_PROJECT_DIR", root),
             ("${HOME}", home), ("$HOME", home)]
    if plugin:
        pairs[:0] = [("${CLAUDE_PLUGIN_ROOT}", root), ("$CLAUDE_PLUGIN_ROOT", root)]
    for a, b in pairs:
        s = s.replace(a, b)
    return s

def resolve(t):
    # the kernel follows a symlink before it applies the .. after it, so a path
    # with .. resolves its directory with realpath; the last component is kept,
    # so a symlinked script still hashes as a link. Other paths only normalize.
    if ".." in t.split("/"):
        d, _, b = t.rpartition("/")
        return os.path.join(os.path.realpath(d or "/"), b)
    return os.path.normpath(t)

def absolute(t, root):
    if t.startswith("~/"):
        t = home + t[1:]
    if not t.startswith("/"):
        # a bare name (guard.rb) or a relative path resolves against the
        # project or plugin dir only; PATH is never searched, so `bd` is no target
        t = os.path.join(root, t)
    return resolve(t)

def emit(t, root, data=False):
    if not t:
        return
    t = absolute(t, root)
    if data and t.lower().endswith(DATA):
        return
    if t.startswith(SYSTEM) or not os.path.isfile(t):
        return
    print(t)

def candidates(tok, root, plugin=False, depth=0, data=False):
    # FOO=/x, --config=/x and backticks also hide paths
    emit(tok, root, data)
    for part in re.split("[=`]", tok)[1:]:
        emit(part, root, data)
    if "`" in tok:
        emit(tok.split("`")[0], root, data)
    # a token with whitespace may be a command string: bash -c "bash /x.sh",
    # sh -c 'exec /x.rb', an MCP arg "bash /x.sh". It is split again, never run.
    if depth < 4 and re.search(r"\s", tok):
        shell(tok, root, plugin, depth + 1, data)

def words(toks, root, plugin, depth, data=False):
    # the word after -c (or -lc, -ec) of a shell is a command string whatever
    # its whitespace; after uv or uvx --directory DIR relative paths resolve
    # against DIR until the next shell separator, where the root comes back
    base = root
    sh = cmd = uv = False
    for i, t in enumerate(toks):
        if cmd:
            cmd = False
            if depth < 4:
                shell(t, root, plugin, depth + 1, data)
            else:
                candidates(t, root, plugin, depth, data)
            continue
        candidates(t, root, plugin, depth, data)
        if t and set(t) <= set("();<>|&"):
            sh = uv = False
            root = base
        elif os.path.basename(t) in SHELLS:
            sh = True
        elif os.path.basename(t) in ("uv", "uvx"):
            uv = True
        elif sh and re.fullmatch(r"-[A-Za-z]*c[A-Za-z]*", t):
            cmd = True
        elif uv and t.startswith("--directory="):
            root = absolute(t.partition("=")[2], root)
        elif uv and t == "--directory" and i + 1 < len(toks):
            root = absolute(toks[i + 1], root)

def shell(cmd, root, plugin=False, depth=0, data=False):
    # a newline ends a shell command like ; does, so it is a separator here too
    cmd = re.sub(r"[\r\n]+", " ; ", subst(cmd, root, plugin))
    try:
        lex = shlex.shlex(cmd, posix=True, punctuation_chars=True)
        lex.whitespace_split = True
        toks = list(lex)
    except ValueError:  # unbalanced quotes: fall back to a plain split
        toks = cmd.replace('"', " ").replace("'", " ").split()
    words(toks, root, plugin, depth, data)

def server(srv, root, plugin):
    # MCP command and args are passed to exec as they are, no shell; an arg
    # may name a data file, which is never hashed
    if not isinstance(srv, dict):
        return
    argv = [subst(w, root, plugin) for w in [srv.get("command")] + list(srv.get("args") or []) if isinstance(w, str)]
    if isinstance(srv.get("command"), str):
        candidates(argv[0], root, plugin)
    words(argv, root, plugin, 0, True)

def hook_cmds(o):
    if isinstance(o, dict):
        if isinstance(o.get("command"), str):
            yield o["command"]
        for v in o.values():
            yield from hook_cmds(v)
    elif isinstance(o, list):
        for v in o:
            yield from hook_cmds(v)

def servers(o, root, plugin):
    if not isinstance(o, dict):
        return
    for srv in o.values():
        each(server, srv, root, plugin)

def load(f):
    try:
        with open(f) as fh:
            return json.load(fh)
    except Exception:
        return None

def plugin_file(f, root, depth=0):
    d = load(f)
    if not isinstance(d, dict):
        return
    for c in hook_cmds(d.get("hooks", {})):
        each(shell, c, root, True)
    m = d.get("mcpServers")
    servers(m if isinstance(m, dict) else (d if os.path.basename(f) == ".mcp.json" else {}), root, True)
    # plugin.json may point at a hooks or MCP file instead of inlining it
    for key in ("hooks", "mcpServers"):
        v = d.get(key)
        for ref in ([v] if isinstance(v, str) else v if isinstance(v, list) else []):
            if isinstance(ref, str) and depth == 0:
                p = resolve(os.path.join(root, subst(ref, root, True)))
                if os.path.isfile(p):
                    print(p)
                    plugin_file(p, root, 1)

def config(kind, f):
    if kind == "settings":
        root = f.rpartition("/.claude/")[0] or home
        d = load(f)
        if not isinstance(d, dict):
            return
        for c in hook_cmds(d.get("hooks", {})):
            each(shell, c, root)
        sl = d.get("statusLine")
        if isinstance(sl, dict) and isinstance(sl.get("command"), str):
            each(shell, sl["command"], root)
        for k in HELPERS:
            if isinstance(d.get(k), str):
                each(shell, d[k], root)
    elif kind == "project":  # a repo-root .mcp.json, run from that repo
        d = load(f)
        if isinstance(d, dict):
            servers(d.get("mcpServers"), os.path.dirname(f), False)
    elif kind == "claude":
        d = load(f)
        if not isinstance(d, dict):
            return
        servers(d.get("mcpServers"), home, False)
        for proj, v in (d.get("projects") or {}).items():
            if isinstance(v, dict):
                servers(v.get("mcpServers"), proj, False)
    elif kind == "plugin":
        if os.path.basename(f) == ".mcp.json":
            root = os.path.dirname(f)
        else:  # hooks/hooks.json and .claude-plugin/plugin.json
            root = os.path.dirname(os.path.dirname(f))
        plugin_file(f, root)

for line in sys.stdin:
    kind, _, f = line.rstrip("\n").partition("\t")
    CUR[0] = f
    each(config, kind, f)
PY

# A helper that fails (python3 missing, a crash) would drop every target from
# the scan and the next run would read them as gone, so the failure is flagged
# in $helperf: the run alerts at default, exits nonzero and keeps the baseline.
# A malformed entry the helper skipped is listed in $malformedf (config path
# only) and alerts at default; the rest of the scan still counts. (hq-8cry.13)
helperf="$(mktemp)"; malformedf="$(mktemp)"
entry_targets() {
  local err; err="$(mktemp)"
  if python3 -I -c "$TARGETS_PY" "$H" 2>"$err"; then
    awk -F'\t' '$1 == "malformed" { print $2 }' "$err" > "$malformedf"
  else
    printf 'rc=%s %s\n' "$?" "$(tail -1 "$err" | cut -c1-200)" > "$helperf"
  fi
  rm -f "$err"
}

# coverage 2 followed every absolute path a settings hook command named. It is
# kept as it was so the upgrade run can tell which new paths coverage 2 already
# saw (see old_class); it is not used for the scan itself.
cov2_targets() {
  local f proj c t
  while IFS= read -r f; do
    proj="${f%/.claude/*}"
    jq -r '.hooks // {} | .. | objects | select(has("command")) | .command | strings' "$f" 2>/dev/null |
    while IFS= read -r c; do
      c="${c//\$\{CLAUDE_PROJECT_DIR\}/$proj}"; c="${c//\$CLAUDE_PROJECT_DIR/$proj}"
      c="${c//\$\{HOME\}/$H}"; c="${c//\$HOME/$H}"
      c="${c//\"/}"; c="${c//\'/}"
      tr -s " \t;|&()<>=\`" '\n' <<<"$c" | while IFS= read -r t; do
        t="${t/#\~\//$H/}"
        case "$t" in /usr/*|/bin/*|/sbin/*|/lib*|/etc/*|/proc/*|/dev/*) continue ;; /*) ;; *) continue ;; esac
        [ -f "$t" ] && printf '%s\n' "$t"
      done
    done
  done
}
settings_files() {
  local e r
  for e in "$H"/.claude/settings*.json; do [ -f "$e" ] && printf '%s\n' "$e"; done
  while IFS= read -r r; do for e in "$r"/.claude/settings*.json; do [ -f "$e" ] && printf '%s\n' "$e"; done; done < <(repos)
}

scan() {
  local r e
  {
    for e in "$H"/.claude/settings*.json; do [ -e "$e" ] || [ -L "$e" ] && printf '%s\n' "$e"; done
    [ -d "$H/.claude/hooks" ] && find -L "$H/.claude/hooks" -type f
    for e in "$H"/.vscode*/extensions; do [ -d "$e" ] && find -L "$e" -type f; done
    while IFS= read -r r; do
      [ -d "$r/.claude" ] && find -L "$r/.claude" -path "$r/.claude/worktrees" -prune -o -type f -print
    done < <(repos)
    [ -f "$H/.claude.json" ] && printf '%s\n' "$H/.claude.json"
    [ -d "$H/.claude/plugins" ] && find -L "$H/.claude/plugins" \
      \( -name .trash -o -name .in_use -o -path "$H/.claude/plugins/marketplaces" \) -prune -o -type f \
      \( -path '*/hooks/*' -o -path '*/scripts/*' -o -name .mcp.json -o -name plugin.json -o -name known_marketplaces.json \
         -o -name installed_plugins.json -o -name '*.sh' -o -name '*.py' -o -name '*.js' -o -name '*.mjs' \
         -o -name '*.cjs' -o -name '*.ts' -o -perm -u+x \) -print
    for e in "$HQ"/ops/scripts/hook-*.sh; do [ -e "$e" ] && printf '%s\n' "$e"; done
    # a project-scoped MCP config at the root of ~/hq or a rig
    while IFS= read -r r; do [ -e "$r/.mcp.json" ] || [ -L "$r/.mcp.json" ] && printf '%s\n' "$r/.mcp.json"; done < <(repos)
    {
      settings_files | sed 's/^/settings\t/'
      while IFS= read -r r; do [ -f "$r/.mcp.json" ] && printf 'project\t%s\n' "$r/.mcp.json"; done < <(repos)
      [ -f "$H/.claude.json" ] && printf 'claude\t%s\n' "$H/.claude.json"
      [ -d "$H/.claude/plugins" ] && find -L "$H/.claude/plugins" \
        \( -name .trash -o -name .in_use -o -path "$H/.claude/plugins/marketplaces" \) -prune -o -type f \
        \( -path '*/hooks/hooks.json' -o -name .mcp.json -o -path '*/.claude-plugin/plugin.json' \) -printf 'plugin\t%p\n'
    } | entry_targets
  } 2>/dev/null | LC_ALL=C sort -u | while IFS= read -r e; do
    # a file name with a newline splits into paths that do not exist; such a
    # path gets a fresh hash every run, so it alerts until someone removes it
    if [ ! -e "$e" ] && [ ! -L "$e" ]; then printf '%s\t%s\n' "$e" "unreadable-name-$(date +%s%N)"; continue; fi
    printf '%s\t%s\n' "$e" "$(hash_file "$e")"
  done
}

# which repo holds path p (longest matching repo root), empty when none
repo_of() {
  local p="$1" r best=""
  while IFS= read -r r; do
    case "$p" in "$r"/*) [ "${#r}" -gt "${#best}" ] && best="$r" ;; esac
  done < <(repos)
  printf '%s' "$best"
}

committed() {  # $1 path, $2 present|gone
  local p="$1" r rel
  r="$(repo_of "$p")"; [ -n "$r" ] || return 1
  rel="${p#"$r"/}"
  if [ "$2" = present ]; then
    # compare content with the HEAD blob directly: git status trusts index
    # flags (assume-unchanged, skip-worktree) that a payload can set
    local head; head="$(git -C "$r" rev-parse -q --verify "HEAD:$rel" 2>/dev/null)" || return 1
    [ -L "$p" ] && return 1
    [ "$head" = "$(git -C "$r" hash-object --no-filters -- "$rel" 2>/dev/null)" ]
  else
    ! git -C "$r" cat-file -e "HEAD:$rel" 2>/dev/null \
      && [ -n "$(git -C "$r" log -1 --format=%H -- "$rel" 2>/dev/null)" ]
  fi
}

# record the baseline in state and in the root-side copy. A mirror that cannot
# be written leaves the deleted-baseline check blind, so it is an alert and a
# nonzero exit (see finish), not only a log line (hq-8cry.10). Both copies are
# staged first and published both or neither: a state baseline that moved
# without its mirror reads as tampering on the next run. With no mirror yet
# there is nothing to diverge from, so the state copy still moves. (hq-8cry.13)
mirror_failed=0
save_base() {
  if [ -s "$helperf" ]; then echo "$now entry point helper failed, baseline not advanced" >> "$LOG"; return; fi
  cp "$cur" "$BASE.new" 2>/dev/null || { echo "$now state write failed ($BASE)" >> "$LOG"; rm -f "$BASE.new"; return; }
  local su=""
  if { mkdir -p "$MIRROR" && cp "$cur" "$MBASE.new"; } 2>/dev/null; then
    mv -f "$MBASE.new" "$MBASE" 2>/dev/null && { mv -f "$BASE.new" "$BASE"; return; }
  elif sudo -n install -D -m 644 "$cur" "$MBASE.new" 2>/dev/null; then
    su="sudo -n"
    sudo -n mv -f "$MBASE.new" "$MBASE" 2>/dev/null && { mv -f "$BASE.new" "$BASE"; return; }
  fi
  $su rm -f "$MBASE.new" 2>/dev/null
  echo "$now mirror write failed ($MBASE)" >> "$LOG"; mirror_failed=1
  # Keep the previous local baseline whenever one exists; only a first run, with
  # nothing to keep, writes it without the mirror.
  if [ -f "$BASE" ]; then rm -f "$BASE.new"; echo "$now baseline kept, mirror not written" >> "$LOG"; else mv -f "$BASE.new" "$BASE"; fi
}

# exit with $1, or 2 when the mirror write failed and the run was otherwise clean
finish() {
  local rc="$1"
  if [ -s "$helperf" ]; then
    echo "$now ALERT entry point helper failed: $(cat "$helperf")" >> "$LOG"
    "$NOTIFY" default "Hook tripwire" "The tripwire could not list hook and MCP entry points (python3 helper failed), so their scripts were not checked this run and the baseline was kept. Log: $LOG" >/dev/null 2>&1 \
      || echo "$now notify failed (helper)" >> "$LOG"
    echo "tripwire: entry point helper failed, baseline kept"
    [ "$rc" = 0 ] && rc=3
  fi
  if [ "$mirror_failed" = 1 ]; then
    "$NOTIFY" default "Hook tripwire" "The tripwire could not write its root-side baseline copy at $MBASE, so a deleted baseline would go unseen. Log: $LOG" >/dev/null 2>&1 \
      || echo "$now notify failed (mirror write)" >> "$LOG"
    echo "tripwire: mirror write failed ($MBASE)"
    [ "$rc" = 0 ] && rc=2
  fi
  if [ -s "$malformedf" ]; then
    local l; l="$(LC_ALL=C sort -u "$malformedf" | sed "s#^$H/#~/#" | head -8 | paste -sd ',' | sed 's/,/, /g')"
    echo "$now ALERT malformed entries skipped in: $l" >> "$LOG"
    "$NOTIFY" default "Hook tripwire" "Malformed hook or MCP entries were skipped in: $l. Their targets were not checked; the rest of the scan ran. Log: $LOG" >/dev/null 2>&1 \
      || echo "$now notify failed (malformed)" >> "$LOG"
    echo "tripwire: malformed entries skipped"
    [ "$rc" = 0 ] && rc=4
  fi
  exit "$rc"
}

now="$(date -u +%FT%TZ)"
cur="$(mktemp)"; trap 'rm -f "$cur" "$helperf" "$malformedf"' EXIT
{ printf '#coverage\t%s\n' "$COVERAGE"; scan; } > "$cur"

# the reference: the root-side copy when there is one, else the state file
REF="$BASE"; tamper=0
if [ -f "$MBASE" ]; then
  REF="$MBASE"
  if ! cmp -s "$BASE" "$MBASE"; then
    tamper=1; echo "$now ALERT baseline in state missing or edited, checked against $MBASE" >> "$LOG"
  fi
fi

if [ ! -f "$REF" ]; then
  # A baseline that vanished after an earlier run is itself suspicious: a
  # payload could delete it so its own hook becomes the new trusted state.
  if [ -s "$LOG" ] && grep -q ' baseline ' "$LOG"; then
    echo "$now ALERT baseline missing, re-recorded" >> "$LOG"
    # the new baseline is kept only once the alert is delivered, so a failed
    # notify is retried on the next run
    if "$NOTIFY" urgent "Hook tripwire" "The tripwire baseline was deleted after an earlier run; a new one was recorded. Check hooks by hand. Log: $LOG" >/dev/null 2>&1; then
      save_base
    else
      echo "$now notify failed, baseline not re-recorded" >> "$LOG"
    fi
    echo "tripwire: ALERT baseline was missing"
    finish 1
  fi
  save_base
  echo "$now baseline $(grep -vc '^#' "$cur") files" >> "$LOG"
  echo "tripwire: baseline recorded ($(grep -vc '^#' "$cur") files)"
  finish 0
fi

# a baseline from before the current coverage adopts its new paths quietly, but
# only paths the earlier coverage could not see: a new file where the old scan
# already looked (user settings and hooks, editor extensions, a repo's .claude;
# from coverage 2 on also ~/.claude.json, hq hook-*.sh and the plugin files
# that scan matched) still alerts, so the upgrade run cannot launder a planted hook
old_class() {
  [ -n "${cov2_set:-}" ] && grep -Fxq -- "$1" <<<"$cov2_set" && return 0
  case "$1" in
    "$H"/.claude/settings*.json|"$H"/.claude/hooks/*|"$H"/.vscode*/extensions/*) return 0 ;;
  esac
  if [ "${old_cov:-1}" -ge 2 ] 2>/dev/null; then
    case "$1" in
      "$H/.claude.json"|"$HQ"/ops/scripts/hook-*.sh) return 0 ;;
      "$H"/.claude/plugins/marketplaces/*) ;;
      "$H"/.claude/plugins/*/hooks/*|*/.mcp.json|*/plugin.json|*/known_marketplaces.json|*/installed_plugins.json \
        |*.sh|*.py|*.js|*.mjs|*.cjs|*.ts)
        case "$1" in "$H"/.claude/plugins/*) return 0 ;; esac ;;
    esac
    case "$1" in "$H"/.claude/plugins/*) [ -x "$1" ] && return 0 ;; esac
  fi
  local r
  while IFS= read -r r; do case "$1" in "$r"/.claude/*) return 0 ;; esac; done < <(repos)
  return 1
}

old_cov="$(awk -F'\t' '$1 == "#coverage" { print $2; exit }' "$REF")"
adopt=0; [ "${old_cov:-1}" -lt "$COVERAGE" ] 2>/dev/null && adopt=1
cov2_set=""
[ "$adopt" = 1 ] && [ "${old_cov:-1}" -ge 2 ] 2>/dev/null && cov2_set="$(settings_files | cov2_targets 2>/dev/null | LC_ALL=C sort -u)"

# bad pages urgent; synced (the weekly org plugin sync rewrites
# ~/.claude/plugins/synced on its own) goes out at default (hq-8cry.10)
bad=(); synced=()
[ "$tamper" = 1 ] && bad+=("the tripwire baseline (baseline was deleted or edited in $STATE)")
# one pass over both lists: new, changed, gone
while IFS=$'\t' read -r kind p; do
  state=present; [ "$kind" = gone ] && state=gone
  # with the helper down, its targets are missing from this scan, not gone
  if [ -s "$helperf" ] && [ "$kind" = gone ]; then echo "$now skipped gone (helper failed) $p" >> "$LOG"
  elif [ "$adopt" = 1 ] && [ "$kind" = new ] && ! old_class "$p"; then echo "$now adopted (coverage $COVERAGE) $p" >> "$LOG"
  elif committed "$p" "$state"; then echo "$now ok-commit $kind $p" >> "$LOG"
  else
    case "$p" in "$SYNCED"/*) synced+=("$p") ;; *) bad+=("$p") ;; esac
    echo "$now ALERT $kind $p" >> "$LOG"
  fi
done < <(awk -F'\t' '/^#/ { next }
                      FILENAME == ARGV[1] { old[$1] = $2; next }
                      { seen[$1] = 1; if (!($1 in old)) print "new\t" $1; else if (old[$1] != $2) print "changed\t" $1 }
                      END { for (p in old) if (!(p in seen)) print "gone\t" p }' "$REF" "$cur")

n=$(( ${#bad[@]} + ${#synced[@]} ))
if [ "$n" -eq 0 ]; then save_base; echo "tripwire: no unexplained change"; finish 0; fi

paths() {  # the first 8 paths, home shortened, then a count of the rest
  local l; l="$(printf '%s\n' "$@" | sed "s#^$H/#~/#" | head -8 | paste -sd ',' | sed 's/,/, /g')"
  [ "$#" -gt 8 ] && l="$l and $(( $# - 8 )) more"
  printf '%s' "$l"
}
# the baseline advances only once every alert is delivered, so a failed notify
# is retried on the next run instead of being swallowed
sent=1
if [ "${#bad[@]}" -gt 0 ]; then
  "$NOTIFY" urgent "Hook tripwire" "${#bad[@]} hook or editor file(s) changed outside a git commit: $(paths "${bad[@]}"). Log: $LOG" >/dev/null 2>&1 || sent=0
fi
if [ "${#synced[@]}" -gt 0 ]; then
  "$NOTIFY" default "Hook tripwire" "${#synced[@]} file(s) changed under the org plugin sync (~/.claude/plugins/synced), likely the weekly sync: $(paths "${synced[@]}"). Log: $LOG" >/dev/null 2>&1 || sent=0
fi
if [ "$sent" = 1 ]; then save_base; else echo "$now notify failed, baseline kept for retry" >> "$LOG"; fi
echo "tripwire: ALERT $n change(s), see $LOG"
finish 1
