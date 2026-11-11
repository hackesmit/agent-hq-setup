#!/usr/bin/env bash
# PostToolUse hook (Bash + WebFetch): the egress ledger.
# A LOG, not a network control: it records and auto-grants, it never blocks a request.
# Extracts domains the session actually contacted: a WebFetch url, or a Bash command
# segment containing a verb that performs egress (curl, wget, ssh, scp, sftp, rsync,
# gh, npx/uvx, a network git subcommand, a package-manager install), including the
# scheme-less ssh/scp/rsync destination forms. Any domain not already
# known (seed allowlist, prior grants, or previously seen) is:
#   logged to ops/egress.log and ops/metrics/egress-domains.jsonl, auto-appended to
#   .claude/settings.local.json (implicit grant = audit trail), pinged low. No bead.
# Pure regex + local file ops — no model calls. Must stay fast: exits
# immediately when no new domain appears (the overwhelmingly common case).
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HQ="${CLAUDE_PROJECT_DIR:-$(cd "$DIR/../.." && pwd)}"
# A rig worker loads this hook through ops/config/worker-hooks.json, so its project dir is
# the rig, not hq. spawn.sh exports HQ_HOOK_DIR (the main hq checkout's ops/scripts) for
# exactly those workers, so state lands in hq by an explicit root, never by a filename guess.
if [ -n "${HQ_HOOK_DIR:-}" ] && [ -d "$HQ_HOOK_DIR" ]; then HQ="$(cd "$HQ_HOOK_DIR/../.." && pwd)"
elif [ ! -f "$HQ/ops/scripts/$(basename "$0")" ]; then HQ="$(cd "$(dirname "$0")/../.." && pwd)"; fi
export PATH="$HOME/.local/bin:$PATH"

HOOK_PAYLOAD="$(cat)" export HOOK_PAYLOAD
python3 - "$HQ" <<'PY'
import json, os, re, subprocess, sys, datetime

hq = sys.argv[1]
try:
    payload = json.loads(os.environ.get("HOOK_PAYLOAD", ""))
except Exception:
    sys.exit(0)

tool = payload.get("tool_name", "")
ti = payload.get("tool_input") or {}
text = ""
if tool == "WebFetch":
    text = str(ti.get("url", ""))
elif tool == "Bash":
    text = str(ti.get("command", ""))
else:
    sys.exit(0)

# WHERE to harvest from. A WebFetch url IS the egress, so it is used whole. A Bash
# command, by contrast, is only evidence of egress when a verb in it actually fetches:
# on 2026-08-19 the old whole-text scan granted five fictional domains that were
# nothing but string literals inside a python heredoc, each one polluting the local
# allowlist and filing an acquisition bead. So: drop heredoc bodies (data handed to a
# program, never a command line), split the rest into command segments, and harvest
# only from segments that contain a network verb.
#
# The verb is matched ANYWHERE in the segment, not just at its start, because real
# fetches are routinely wrapped: `if curl URL; then`, `timeout 5 curl URL`,
# `TOKEN=$(curl URL)`. Accepted residual: a segment that merely mentions a fetch verb
# in prose alongside a URL still grants. That is the pre-existing behaviour and it is
# kept deliberately; closing it needs a real shell parser, and the ledger's failure
# mode is a spurious log line plus an acquisition bead, not a broken command.
NET_VERBS = {"curl", "wget", "ssh", "scp", "sftp", "rsync", "gh", "http", "https"}
FETCH_ALWAYS = {"npx", "uvx", "pipx"}          # these fetch to run, no subcommand needed
SSH_LIKE = {"ssh", "scp", "sftp", "rsync"}     # destinations are user@host / host:path
GIT_NET = {"clone", "fetch", "pull", "push", "remote", "ls-remote", "submodule"}
PKG_MGRS = {"npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "cargo", "go"}
PKG_NET = {"install", "i", "add", "ci", "sync", "update", "upgrade", "get",
           "fetch", "download", "publish"}

# Heredoc delimiters are word characters plus dots and hyphens (END-MARK is legal),
# quoted or bare, and the redirect may be followed by more of the command line.
HEREDOC = re.compile(r"<<-?[ \t]*(['\"]?)([A-Za-z_][A-Za-z0-9_.-]*)\1[^\n]*\n"
                     r".*?\n[ \t]*\2(?![A-Za-z0-9_.-])", re.S)
WORD_SPLIT = re.compile(r"[^A-Za-z0-9_.@:/-]+")
URL_HOST = re.compile(r"https?://([A-Za-z0-9.-]+)")
GIT_SSH = re.compile(r"git@([A-Za-z0-9.-]+):")
AT_HOST = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)")
COLON_HOST = re.compile(r"(?:^|[\s'\"=])([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+):")

def hosts_in(chunk, ssh_forms=False):
    found = set(URL_HOST.findall(chunk)) | set(GIT_SSH.findall(chunk))
    if ssh_forms:
        # ssh/scp/sftp/rsync name their destination without a scheme
        found |= set(AT_HOST.findall(chunk)) | set(COLON_HOST.findall(chunk))
    return found

def egress_hosts(cmd):
    found = set()
    for seg in HEREDOC.sub(" ", cmd).split("\n"):
        for part in re.split(r"[;|&]+", seg):
            words = {os.path.basename(w) for w in WORD_SPLIT.split(part) if w}
            fetches = bool(words & NET_VERBS) or bool(words & FETCH_ALWAYS) \
                or ("git" in words and bool(words & GIT_NET)) \
                or (bool(words & PKG_MGRS) and bool(words & PKG_NET))
            if fetches:
                found |= hosts_in(part, ssh_forms=bool(words & SSH_LIKE))
    return found

# scheme URLs + git ssh form; deliberately NOT bare hostnames (too noisy)
hosts = hosts_in(text) if tool == "WebFetch" else egress_hosts(text)
hosts = {h.lower().rstrip(".").split(":")[0] for h in hosts}
hosts = {h for h in hosts if "." in h and not re.fullmatch(r"[\d.]+", h)
         and h not in ("localhost", "127.0.0.1")}
if not hosts:
    sys.exit(0)

def load(p):
    try:
        return json.load(open(p))
    except Exception:
        return {}

def domains_of(cfg):
    return set(d.lower().lstrip("*.") for d in
               (cfg.get("sandbox", {}).get("network", {}).get("allowedDomains") or []))

settings = os.path.join(hq, ".claude", "settings.json")
local = os.path.join(hq, ".claude", "settings.local.json")
seen_file = os.path.join(hq, "ops", ".egress-seen")

known = domains_of(load(settings)) | domains_of(load(local))
try:
    known |= set(open(seen_file).read().split())
except Exception:
    pass

def covered(h):
    parts = h.split(".")
    return any(".".join(parts[i:]) in known for i in range(len(parts) - 1))

new = sorted(h for h in hosts if not covered(h))
if not new:
    sys.exit(0)

ts = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
with open(os.path.join(hq, "ops", "egress.log"), "a") as f:
    for h in new:
        f.write(f"{ts}\t{h}\t{tool}\t{text[:160]}\n")
with open(seen_file, "a") as f:
    f.write("".join(h + "\n" for h in new))

cfg = load(local)
doms = cfg.setdefault("sandbox", {}).setdefault("network", {}).setdefault("allowedDomains", [])
for h in new:
    if h not in doms:
        doms.append(h)
tmp = local + ".tmp"
json.dump(cfg, open(tmp, "w"), indent=2)
os.replace(tmp, local)

# Domains go to a jsonl log, never to beads (hq-7llgp.2): the weekly retro reads its summary.
# Revert: restore the bd create loop from git history (git log -S"Acquisition: domain").
os.makedirs(os.path.join(hq, "ops", "metrics"), exist_ok=True)
with open(os.path.join(hq, "ops", "metrics", "egress-domains.jsonl"), "a") as f:
    for h in new:
        f.write(json.dumps({"ts": ts, "domain": h, "session": payload.get("session_id", ""),
                            "bead": os.environ.get("HQ_BEAD", "")}) + "\n")
subprocess.run([os.path.join(hq, "ops", "scripts", "notify.sh"), "low",
                "Egress: new domain", ", ".join(new)], capture_output=True, timeout=15)
PY
exit 0
