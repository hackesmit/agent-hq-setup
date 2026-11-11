#!/usr/bin/env bash
# hqbox provisioning: Ubuntu Server phases 2, 3 and the pre-bootstrap half of 4.
#
# Runbook: docs/superpowers/plans/2026-07-28-mini-pc-setup-runbook.md
# Run this ON hqbox, as user owner, after the Ubuntu Server install has
# finished and you can ssh in over the LAN. It does the mechanical parts:
# updates, unattended-upgrades, the default-deny firewall, Tailscale, and the
# base tools bootstrap.sh expects. It stops before anything interactive that
# only you can answer (GitHub auth, Claude OAuth) and prints those as next
# steps.
#
#   scp this file to the box, or once ~/hq exists just run it from there:
#     bash ~/hq/ops/install/hqbox-provision.sh
#
# Idempotent: safe to re-run after fixing whatever failed. It never reboots on
# its own; it tells you when a reboot is owed. Every state-changing command is
# checked, so it stops at the first real failure rather than reporting success
# over a broken step.
#
# ORDER MATTERS, and it is not the order the prose runbook lists. The firewall
# goes up BEFORE Tailscale, not after, so tailscaled never runs a single second
# on an unfiltered LAN. To keep that from locking you out of the very ssh
# session you are running this in, the firewall is raised with a TEMPORARY rule
# allowing ssh on the LAN interface, and that rule is torn down only once the
# tailnet is confirmed up. Your live session survives the teardown: ufw permits
# established connections, so only NEW LAN connections are refused. Do not
# reorder any of this.
set -uo pipefail
# Every ufw and ip invocation below is machine-parsed, and ufw localizes its
# status output. A German locale would make "Status: active" unmatchable.
export LC_ALL=C

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m %s\n' "$*"; }
warn() { printf '    \033[33mWARN\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mFAILED\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(id -un)" = "owner" ] || die "run as owner, not $(id -un). HQ paths are absolute."
grep -qi ubuntu /etc/os-release || die "this expects Ubuntu Server"
sudo -v || die "this needs sudo"
REBOOT_OWED=0

# 1. updates ------------------------------------------------------------------
log "1/6 system updates"
sudo apt-get update -qq || die "apt update failed. Check the network first: ip -4 addr"
sudo DEBIAN_FRONTEND=noninteractive apt-get full-upgrade -y -qq || die "apt full-upgrade failed"
ok "packages current"
[ -f /var/run/reboot-required ] && { REBOOT_OWED=1; warn "a reboot is owed (kernel or libc updated)"; }

# 2. unattended security patches ----------------------------------------------
# An unattended 24/7 host must self-patch. Automatic REBOOTS are switched off
# EXPLICITLY rather than left to the package default: scheduled jobs must not
# die mid-run at 3am, so kernel reboots are applied by hand at retro time. The
# 99- prefix loads last, so it wins over anything the package ships.
log "2/6 unattended-upgrades"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades \
  || die "unattended-upgrades install failed"
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' \
  | sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null \
  || die "could not write /etc/apt/apt.conf.d/20auto-upgrades"
printf 'Unattended-Upgrade::Automatic-Reboot "false";\nUnattended-Upgrade::Automatic-Reboot-WithUsers "false";\n' \
  | sudo tee /etc/apt/apt.conf.d/99-hqbox-no-auto-reboot >/dev/null \
  || die "could not write the no-auto-reboot config"
# Captured before matching, never piped straight into `grep -q`: under pipefail
# an early-exiting grep SIGPIPEs the producer, so the pipeline returns 141 even
# when the pattern matched. Every parsed command below follows the same shape.
APT_CFG=$(apt-config dump 2>/dev/null)
grep -q 'Unattended-Upgrade::Automatic-Reboot "false"' <<<"$APT_CFG" \
  || die "automatic reboot is still enabled after writing 99-hqbox-no-auto-reboot"
ok "security patches automatic, reboots manual and verified off"

# 3. base tools ----------------------------------------------------------------
# bootstrap.sh expects these. Installed before any daemon so a failure here
# costs nothing.
log "3/6 base tools"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git gh tmux curl ca-certificates ufw \
  || die "base tool install failed"
ok "git $(git --version | awk '{print $3}'), gh, tmux, ufw"

# 4. firewall, BEFORE any service --------------------------------------------
# With zero router port-forwards there is no internet path to this box at all,
# so the only remaining exposure is other devices on the LAN: guest phones, IoT
# junk. Default-deny closes that. Everything HQ ever runs binds to tailscale0
# or is covered by the allow-in-on-tailscale0 rule.
#
# The tailscale0 rule is written before the interface exists, which ufw accepts
# happily: it is just an interface match in the generated rules, and it starts
# matching the moment Tailscale creates the device.
log "4/6 firewall (default deny on the LAN, tailnet only)"

# Readiness is BackendState plus a real address, never the exit status of
# `tailscale status`: a logged-out daemon answers successfully while being
# useless to ssh through. Note the JSON is pretty-printed, so the parse has to
# tolerate whitespace around the colon.
ts_state() {
  have tailscale || return 0
  tailscale status --json 2>/dev/null \
    | sed -n 's/.*"BackendState"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}
ts_ip()    { have tailscale && tailscale ip -4 2>/dev/null | head -1; }
ts_ready() { [ "$(ts_state)" = "Running" ] && [ -n "$(ts_ip)" ]; }

# The interface the operator actually arrived on. On a box with both ethernet
# and wifi, picking the first global interface can open the temporary rule on
# the wrong one and lock the session out anyway. When there IS an ssh session,
# this fails closed rather than guessing: a wrong guess is the lockout it is
# meant to prevent. The address family is taken from the session, so an IPv6
# login is not silently matched against the IPv4 table.
# Sets LAN_IF and SSH_CLIENT_IP as globals rather than echoing, because a
# command substitution would run this in a subshell and silently drop
# SSH_CLIENT_IP, leaving the temporary rule uncreated.
LAN_IF=""; SSH_CLIENT_IP=""
resolve_lan_iface() {
  local caddr saddr fam
  if [ -n "${SSH_CONNECTION:-}" ]; then
    caddr=$(awk '{print $1}' <<<"$SSH_CONNECTION")
    saddr=$(awk '{print $3}' <<<"$SSH_CONNECTION")
    case "$saddr" in *:*) fam=-6;; *) fam=-4;; esac
    LAN_IF=$(ip $fam -o addr show scope global | awk -v a="$saddr" '$4 ~ "^"a"/" {print $2}' | head -1)
    [ -n "$LAN_IF" ] || die "running over ssh from $caddr but could not map the local address $saddr to an interface. Refusing to guess, because guessing wrong is the lockout this rule exists to prevent."
    SSH_CLIENT_IP="$caddr"
    return 0
  fi
  # Console run. Nothing to preserve, so this is only used for reporting.
  LAN_IF=$(ip -4 -o addr show scope global | grep -v tailscale | awk '{print $2}' | head -1)
}

# After the policy is in place, prove the claim rather than asserting it. A
# pre-existing "ufw allow 22/tcp" survives `ufw default deny`, so without this
# the script would announce "tailnet is the only way in" over an open LAN port.
lan_ssh_rules() {
  sudo ufw status 2>/dev/null \
    | awk '/ALLOW IN/ && $1 ~ /(^|[^0-9])22(\/(tcp|udp))?$/ && $0 !~ /tailscale0/'
}

TEMP_TAG="hqbox-temp-lan-ssh"
# Deletes the tagged rule whoever created it, so a run that died between adding
# and removing it does not leave LAN ssh open forever. Rule numbers shift after
# each delete, so the list is re-read every pass.
drop_temp_rule() {
  local n
  while :; do
    n=$(sudo ufw status numbered 2>/dev/null | grep -F "$TEMP_TAG" | head -1 \
        | sed -n 's/^\[[[:space:]]*\([0-9]\{1,\}\)\].*/\1/p')
    [ -n "$n" ] || return 0
    # --force rather than piping `yes`: under pipefail a SIGPIPE'd `yes` makes
    # the pipeline return 141 even when the delete itself succeeded.
    sudo ufw --force delete "$n" >/dev/null 2>&1 || return 1
  done
}

resolve_lan_iface
[ -n "$LAN_IF" ] || die "could not identify the LAN interface"
LAN_IP=$(ip -4 -o addr show scope global dev "$LAN_IF" | awk '{print $4}' | cut -d/ -f1 | head -1)

sudo ufw default deny incoming  >/dev/null || die "ufw default deny incoming failed"
sudo ufw default allow outgoing >/dev/null || die "ufw default allow outgoing failed"
sudo ufw allow in on tailscale0 >/dev/null || die "ufw allow in on tailscale0 failed"
sudo ufw allow 41641/udp        >/dev/null || die "ufw allow 41641/udp failed"  # Tailscale's own port, for direct connections

# The temporary bridge. Without it, enabling the firewall here would refuse the
# LAN ssh you are almost certainly sitting in, on a box with no tailnet yet.
# Only for an ssh run, and only for the one host that is actually connected. A
# console run has no session to protect, so opening port 22 to the whole LAN
# there would be pure exposure for no benefit.
if [ -n "$SSH_CLIENT_IP" ] && ! ts_ready; then
  sudo ufw allow in on "$LAN_IF" from "$SSH_CLIENT_IP" to any port 22 proto tcp comment "$TEMP_TAG" >/dev/null \
    || die "could not add the temporary LAN ssh rule"
  warn "temporary ssh rule added for $SSH_CLIENT_IP on $LAN_IF, removed once the tailnet is up"
fi

sudo ufw --force enable >/dev/null || die "ufw enable failed"
UFW_STATUS=$(sudo ufw status)
grep -q '^Status: active' <<<"$UFW_STATUS" || die "ufw reports inactive after enable"
ok "ufw active, default deny incoming"

# 5. Tailscale -----------------------------------------------------------------
# --ssh turns on Tailscale SSH: key management handled by the tailnet, so there
# is no password auth exposure on the box at all. The preference is enforced on
# every run, not just the first: a box that is already on the tailnet with SSH
# switched off would otherwise silently skip it.
log "5/6 Tailscale"
if have tailscale; then
  ok "tailscale already installed"
else
  TS_INSTALLER=$(mktemp) || die "mktemp failed"
  curl -fsSL https://tailscale.com/install.sh -o "$TS_INSTALLER" \
    || die "could not fetch the Tailscale installer"
  sudo sh "$TS_INSTALLER" || die "Tailscale install failed"
  rm -f "$TS_INSTALLER"
  ok "tailscale installed"
fi

if ! ts_ready; then
  warn "not on the tailnet yet (state: $(ts_state)). The next command prints a login URL."
  warn "Open it on DESKTOP and authenticate as owner@example.com."
  sudo tailscale up --ssh || die "tailscale up failed or was not completed"
fi
ts_ready || die "tailscale backend is '$(ts_state)' with address '$(ts_ip)', not ready"
# Enforce the SSH preference unconditionally, including on a box that joined
# earlier with it switched off.
sudo tailscale set --ssh=true || die "could not enable Tailscale SSH"
TS_IP=$(ts_ip)
ok "on the tailnet at $TS_IP, Tailscale SSH on"

# Now, and only now, the LAN door closes. This runs unconditionally rather than
# only when this invocation opened the rule, so a rule stranded by an earlier
# failed run is cleaned up too. Established connections survive ufw reloads, so
# the session running this script does not drop.
drop_temp_rule \
  || die "could not remove the temporary LAN ssh rule. Remove it by hand: sudo ufw status numbered"
UFW_STATUS=$(sudo ufw status 2>/dev/null)
if grep -qF "$TEMP_TAG" <<<"$UFW_STATUS"; then
  die "the temporary LAN ssh rule is still present after cleanup. LAN port 22 is open; fix before continuing."
fi
STRAY=$(lan_ssh_rules)
if [ -n "$STRAY" ]; then
  printf '%s\n' "$STRAY" | sed 's/^/    /' >&2
  die "the rules above allow ssh from outside the tailnet, so 'tailnet only' is not true. Remove them (sudo ufw status numbered, sudo ufw delete N) and re-run."
fi
ok "no non-tailnet ssh rule remains, tailnet is the only way in"

# 6. acceptance ----------------------------------------------------------------
log "6/6 acceptance"
ok "LAN address  ${LAN_IP:-unknown} on $LAN_IF"
ok "tailnet addr $TS_IP"
sudo ufw status | sed 's/^/    /'
echo
echo "    Verify from DESKTOP in PowerShell. Both must hold:"
echo "      Tailscale OFF:  Test-NetConnection ${LAN_IP:-<lan-ip>} -Port 22   -> TcpTestSucceeded False"
echo "      Tailscale ON :  ssh owner@hqbox                                 -> works"
echo "    A LAN scan that succeeds means the firewall did not take. Stop and fix it"
echo "    before any service phase. If you are ever locked out entirely, the local"
echo "    console with a monitor and keyboard always works."

cat <<'NEXT'

=========================== NEXT, BY HAND ===========================
These need answers only you can give, so the script stops here.

  1. Router: add a DHCP reservation pinning this box's MAC to its current
     LAN address, and confirm there are NO port-forward rules aimed at it.
     Tailscale needs none, now or ever.

  2. On DAN, before you bootstrap here. Plain git push does not move beads
     data; it lives in refs/dolt/ and needs its own push, per repo:
         cd ~/hq && bd dolt push
         # and the same in rigs/chesski, gym-tracker, acme-dashboard,
         # fintrack-portfolio
     Skip this and hqbox bootstraps with empty ledgers, which is exactly how
     DESKTOP landed empty on 2026-08-07.

  3. GitHub auth, needed to clone the private repos:
         gh auth login          # GitHub.com, HTTPS, paste the PAT

  4. Clone and bootstrap:
         git clone https://github.com/your-gh-user/agent-hq ~/hq
         ~/hq/ops/install/bootstrap.sh
     It prompts once for the secrets-bundle passphrase (Proton Pass). It is
     idempotent, so re-run it if anything fails. It sets the git identity and
     attaches every ledger itself.

  5. Claude Code login, which cannot happen headless silently:
         claude                 # prints a URL, approve on DESKTOP, paste back

  6. Verify the stack:
         cd ~/hq && ops/scripts/canaries.sh      # must be green
         pp vault list                           # proton session works
         ops/scripts/notify.sh low "hqbox online"

Then continue at Phase 5 of the runbook: scheduled jobs.
=====================================================================
NEXT

if [ "$REBOOT_OWED" = 1 ]; then
  printf '\n\033[33mA reboot is owed before you go further: sudo reboot\033[0m\n'
fi
