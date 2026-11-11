#!/usr/bin/env bash
# bootstrap.sh — provision a fresh machine to run the HQ stack. Idempotent; re-runnable.
#
# For a NEW machine such as George's WSL Ubuntu. hqbox itself is provisioned by
# ops/install/hqbox-provision.sh, not this script. Steps:
#   gh auth login                 # or paste a GitHub PAT — needed to clone the private repos
#   git clone https://github.com/your-gh-user/agent-hq ~/hq
#   ~/hq/ops/install/bootstrap.sh   # prompts once for the secrets-bundle passphrase
#   hq
#
# Installs deps, restores secrets from the age bundle, sets up ~/.claude + PATH + launchers,
# clones + wires the rigs, and runs canaries. Prereqs it can't reliably auto-install are
# flagged with [MANUAL]. Env: FORCE=1 re-restores secrets even if ops/.env exists.
set -uo pipefail
HQ="$(cd "$(dirname "$0")/../.." && pwd)"
LB="$HOME/.local/bin"
mkdir -p "$LB" "$HOME/.claude/bin" "$HOME/.claude/hooks" "$HOME/.claude/lib/cdp-interact" "$HQ/state"
export PATH="$LB:$PATH"
for nb in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$nb" ] && export PATH="$nb:$PATH"; done
log(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; }
warn(){ printf '\033[1;33m[!] %s\033[0m\n' "$1"; }
have(){ command -v "$1" >/dev/null 2>&1; }

# ── 1. system deps (apt; needs sudo) ─────────────────────────────────────────
log "1/7 system packages"
need_apt=""
for c in age jq tmux gh flock curl; do have "$c" || need_apt="$need_apt $c"; done
if [ -n "$need_apt" ]; then
  if sudo -n true 2>/dev/null || sudo true; then
    sudo apt-get update -qq && sudo apt-get install -y $need_apt || warn "apt install failed for:$need_apt"
  else warn "no sudo — install manually:$need_apt"; fi
else echo "apt deps present"; fi
# age via binary if apt didn't provide it (no sudo path)
if ! have age; then
  v="$(curl -fsSL https://api.github.com/repos/FiloSottile/age/releases/latest | python3 -c 'import json,sys;print(json.load(sys.stdin)["tag_name"])' 2>/dev/null)"
  curl -fsSL "https://github.com/FiloSottile/age/releases/download/$v/age-$v-linux-amd64.tar.gz" -o /tmp/age.tgz \
    && tar -xzf /tmp/age.tgz -C /tmp && install -m755 /tmp/age/age /tmp/age/age-keygen "$LB/" && rm -rf /tmp/age /tmp/age.tgz && echo "age installed"
fi

# ── 2. restore secrets from the age bundle ───────────────────────────────────
log "2/7 secrets"
if [ -f "$HQ/ops/.env" ] && [ "${FORCE:-}" != 1 ]; then
  echo "ops/.env already present (FORCE=1 to overwrite from the bundle)"
elif [ -f "$HQ/ops/install/secrets.age" ]; then
  have age || { warn "age missing — cannot decrypt secrets"; }
  echo "Enter the secrets-bundle passphrase:"
  if age -d "$HQ/ops/install/secrets.age" > /tmp/hq-sec.$$ 2>/dev/null; then
    HQ="$HQ" python3 - /tmp/hq-sec.$$ <<'PY'
import os,sys,re
hq=os.environ["HQ"]; txt=open(sys.argv[1]).read()
parts=re.split(r'(?m)^### (.+)$', txt)
# parts: ['', path1, body1, path2, body2, ...]
for i in range(1,len(parts),2):
    rel=parts[i].strip(); body=parts[i+1].lstrip('\n')
    dst=os.path.join(hq, rel); os.makedirs(os.path.dirname(dst) or '.',exist_ok=True)
    open(dst,'w').write(body); os.chmod(dst,0o600); print("restored", rel)
PY
    shred -u /tmp/hq-sec.$$ 2>/dev/null || rm -f /tmp/hq-sec.$$
  else warn "decrypt failed (wrong passphrase?) — rerun bootstrap"; rm -f /tmp/hq-sec.$$; fi
else warn "no secrets.age bundle — run pack-secrets.sh on the source machine first"; fi
# git identity — without it every commit aborts with "Author identity unknown",
# and the failure only shows up at the first commit, long after setup.
git config --global user.name  >/dev/null 2>&1 || git config --global user.name  "your-gh-user"
git config --global user.email >/dev/null 2>&1 || git config --global user.email "owner@example.com"
echo "git identity: $(git config --global user.name) <$(git config --global user.email)>"

# ── 3. toolchain (best-effort; skip if present) ──────────────────────────────
log "3/7 toolchain"
have uv   || curl -LsSf https://astral.sh/uv/install.sh | sh || warn "uv install failed"
have node || warn "[MANUAL] node missing — install nvm + node 24: https://github.com/nvm-sh/nvm"
have claude || warn "[MANUAL] Claude Code CLI (claude) not found — install it: https://claude.com/claude-code"
# pass-cli (pinned + checksum)
if ! have pass-cli; then
  m="$(curl -fsSL https://proton.me/download/pass-cli/versions.json)"
  u="$(printf '%s' "$m" | python3 -c 'import json,sys;print(json.load(sys.stdin)["passCliVersions"]["urls"]["linux"]["x86_64"]["url"])')"
  h="$(printf '%s' "$m" | python3 -c 'import json,sys;print(json.load(sys.stdin)["passCliVersions"]["urls"]["linux"]["x86_64"]["hash"])')"
  curl -fsSL "$u" -o /tmp/pc && [ "$(sha256sum /tmp/pc|cut -d' ' -f1)" = "$h" ] && install -m755 /tmp/pc "$LB/pass-cli" && echo "pass-cli installed" || warn "pass-cli checksum/install failed"
  rm -f /tmp/pc
fi
have npm && { have ccstatusline || npm i -g ccstatusline >/dev/null 2>&1; }
have uv  && { have graphify || uv tool install graphifyy==0.9.12 >/dev/null 2>&1 || warn "graphify install failed"; }
have bd  || warn "[MANUAL] beads (bd) not found — install per its docs"
have rtk || warn "[MANUAL] rtk not found — pinned musl binary (global ~/.claude hook, optional)"

# ── 5. launchers + PATH ──────────────────────────────────────────────────────
log "5/7 launchers"
for t in term term-kill vault pp lucy review; do
  printf '#!/usr/bin/env bash\nexec "%s/ops/scripts/%s.sh" "$@"\n' "$HQ" "$t" > "$LB/$t"; chmod +x "$LB/$t"
done
printf '#!/usr/bin/env bash\nexec "%s/ops/scripts/hq.sh" "$@"\n' "$HQ" > "$LB/hq"; chmod +x "$LB/hq"
grep -q '.local/bin' "$HOME/.bashrc" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
echo "installed: hq term term-kill vault pp lucy review"

# ── 6. rigs (clone + wire) ───────────────────────────────────────────────────
log "6/7 rigs"
CRED="store --file $HQ/.git-credentials"
# Attach a repo to its existing beads ledger. A repo that ships .beads/ already
# HAS a ledger: `bd init` there would fork a second one with no clean merge back,
# so only a repo without one gets init. bd bootstrap needs the canonical machine
# to have run `bd dolt push` first, since plain git push skips refs/dolt.
# .beads/embeddeddolt is the local database, so its absence means "not attached
# yet" — that keeps this safe to re-run on an already-hydrated machine.
wire_beads(){ # <dir> <label> [init-prefix]
  local dir="$1" label="$2" pfx="${3:-}"
  git -C "$dir" config beads.role maintainer
  [ -d "$dir/.beads" ] && chmod 700 "$dir/.beads"   # bd warns on every call otherwise
  [ -d "$dir/.beads/embeddeddolt" ] && { echo "  $label ledger present"; return; }
  (
    cd "$dir" || exit 0
    if [ -f .beads/metadata.json ]; then
      bd bootstrap >/dev/null 2>&1 && echo "  $label ledger attached" \
        || warn "  $label: bd bootstrap failed — has the canonical machine run 'bd dolt push'?"
    elif [ -n "$pfx" ]; then
      bd init --skip-agents --non-interactive -p "$pfx" >/dev/null 2>&1 || true
    fi
  )
}

wire_rig(){ # <dir> <giturl> <prefix>
  local dir="$HQ/rigs/$1" url="$2" pfx="$3"
  if [ -d "$dir/.git" ]; then echo "  $1 present"
  elif git clone "$url" "$dir" 2>/dev/null; then
    git -C "$dir" config core.hooksPath "$HQ/ops/githooks"
    git -C "$dir" config credential.helper "$CRED"
    have graphify && ( cd "$dir" && graphify update . >/dev/null 2>&1 ) || true
    echo "  cloned + wired $1"
  else warn "  clone failed: $1 ($url) — check GitHub auth/PAT scope"; return; fi
  # Runs for present clones too, so re-running bootstrap repairs a machine set
  # up before this step existed.
  wire_beads "$dir" "$1" "$pfx"
}
# hq's own ledger. Nothing in bootstrap used to touch it, so every new machine
# landed with the hq beads missing until someone noticed by hand.
wire_beads "$HQ" hq

wire_rig chesski          https://github.com/your-gh-user/chesski.git                ck
wire_rig gym-tracker      https://github.com/your-gh-user/gym-tracker.git            gt
wire_rig acme-dashboard  https://github.com/your-gh-user/orbit-acme-dashboard.git  xd
wire_rig fintrack-portfolio https://github.com/your-gh-user/fintrack-portfolio.git       dp
# The hq checkout itself gets the pre-push secret scan too (hq-an7jw.21): wire_rig
# sets hooksPath only on the rigs it clones, and a fresh hq clone has none.
"$HQ/ops/scripts/githooks-install.sh" || warn "githooks-install failed: hq has no pre-push secret scan"

# ── 7. verify ────────────────────────────────────────────────────────────────
log "7/7 canaries"
"$HQ/ops/scripts/canaries.sh" 2>&1 | tail -3 || warn "canaries failed — review guard/config integrity"

log "done"
echo "Restart your shell (or: source ~/.bashrc), then run:  hq"
