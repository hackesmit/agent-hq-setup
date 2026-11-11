#!/usr/bin/env bash
# Fixture harness for hqbox-provision.sh. Stubs sudo/ufw/tailscale/apt/ip so the
# firewall-and-tailnet ordering can be exercised without touching a real host.
#
#   bash ops/install/hqbox-provision.fixture.sh
#
# Run it after ANY edit to hqbox-provision.sh. That script cannot be tested by
# running it, since running it on a real box is the thing being de-risked, and
# its failure mode is locking the owner out of a headless machine. Three real bugs
# came out of this harness rather than out of a live box:
#   1. LAN_IF=$(lan_iface) ran in a subshell, so SSH_CLIENT_IP never propagated
#      and the temporary ssh rule was silently never created.
#   2. `yes | ufw delete` returned 141 on SIGPIPE under pipefail, so cleanup
#      reported failure after succeeding.
#   3. `ufw status | grep -q` and `apt-config dump | grep -q` had the same
#      SIGPIPE-under-pipefail defect, firing their own die handlers on success.
#
# Expected: A, C, D, E, G exit 0 and leave no temp rule. B exits 1 at ufw enable
# without ever reaching tailscale. F exits 1 refusing to claim tailnet-only.
SRC=/home/owner/hq/ops/install/hqbox-provision.sh
BIN=$(mktemp -d)
export PATH="$BIN:$PATH"
export TRACE="$BIN/trace" RULES="$BIN/rules"

cat > "$BIN/sudo" <<'EOF'
#!/usr/bin/env bash
while [[ "$1" == -* || "$1" == *=* ]]; do [ "$1" = "-v" ] && exit 0; shift; done
exec "$@"
EOF

# Two interfaces, so interface selection is actually exercised: the ssh session
# arrives on eth1, but eth0 sorts first and is what a naive picker would choose.
cat > "$BIN/ip" <<'EOF'
#!/usr/bin/env bash
fam=-4; [ "$1" = "-6" ] && fam=-6
[ "$fam" = "-6" ] && { echo "1: eth1    inet6 fd00::20/64 scope global"; exit 0; }
cat <<'ROWS'
1: eth0    inet 192.168.1.10/24 scope global eth0
2: eth1    inet 192.168.1.77/24 scope global eth1
3: tailscale0    inet 100.64.0.9/32 scope global tailscale0
ROWS
EOF

# Models ufw well enough to exercise add, tagged lookup by number, delete-by-number
# with renumbering, and the display format that `ufw status` actually emits.
cat > "$BIN/ufw" <<'EOF'
#!/usr/bin/env bash
echo "ufw $*" >> "$TRACE"
touch "$RULES"
render() {
  while IFS= read -r r; do
    case "$r" in
      *"on tailscale0"*) echo "Anywhere on tailscale0     ALLOW IN    Anywhere";;
      *"port 22"*)
        ifc=$(sed -n 's/.* on \([^ ]*\) .*/\1/p' <<<"$r")
        src=$(sed -n 's/.* from \([^ ]*\) .*/\1/p' <<<"$r"); src=${src:-Anywhere}
        cmt=$(sed -n 's/.*comment \(.*\)/\1/p' <<<"$r")
        echo "22/tcp on ${ifc}            ALLOW IN    ${src} ${cmt}";;
      "PREEXISTING22") echo "22/tcp                     ALLOW IN    Anywhere";;
      *41641*)          echo "41641/udp                  ALLOW IN    Anywhere";;
    esac
  done < "$RULES"
}
[ "$1" = "--force" ] && shift
case "$1 $2" in
  "status numbered")
    render | nl -ba -w2 -s'] ' | sed 's/^/[/'; exit 0;;
esac
case "$1" in
  enable) [ "$UFW_ENABLE_FAILS" = 1 ] && exit 1; exit 0;;
  status) echo "Status: active"; render; exit 0;;
  allow)  echo "$*" >> "$RULES"; exit 0;;
  delete) sed -i "${2}d" "$RULES"; exit 0;;
esac
exit 0
EOF

# Tailscale emits PRETTY-PRINTED json. That is the point of this stub: a parser
# matching only compact json fails on every real machine.
cat > "$BIN/tailscale" <<'EOF'
#!/usr/bin/env bash
echo "tailscale $*" >> "$TRACE"
joined() { [ "$TS_JOINED" = 1 ] || [ -f "$BIN/.joined" ]; }
case "$1" in
  status)
    joined || { [ "$TS_DAEMON_ANSWERS" = 1 ] || exit 1; }
    if [ "$2" = "--json" ]; then
      state=NeedsLogin; joined && state="$TS_BACKEND"
      printf '{\n  "Version": "1.80.0",\n  "BackendState": "%s",\n  "Self": {}\n}\n' "$state"
    fi;;
  ip)  joined && echo "100.64.0.9";;
  up)  touch "$BIN/.joined"; exit 0;;
  set) exit 0;;
esac
exit 0
EOF

cat > "$BIN/tee" <<'EOF'
#!/usr/bin/env bash
out="$1"; shift 2>/dev/null
cat > "${TMPDIR:-/tmp}/fixture-etc-$(basename "$out")"
EOF

for c in apt-get apt-config unattended-upgrades; do
  printf '#!/usr/bin/env bash\necho "%s $*" >> "$TRACE"\n[ "$1" = dump ] && echo '"'"'Unattended-Upgrade::Automatic-Reboot "false";'"'"'\nexit 0\n' "$c" > "$BIN/$c"
done
chmod +x "$BIN"/*
export BIN
SSH="SSH_CONNECTION=192.168.1.5 51000 192.168.1.77 22"

run_case() {
  : > "$TRACE"; : > "$RULES"; rm -f "$BIN/.joined"
  local name="$1" seed="$2"; shift 2
  [ -n "$seed" ] && echo "$seed" > "$RULES"
  echo "=== $name ==="
  ( env "$@" bash "$SRC" ) >/tmp/out.txt 2>&1
  echo "  exit=$?  |  $(grep -a 'FAILED\|only way in' /tmp/out.txt | tail -1 | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-95)"
  grep -n "ufw allow in on\|ufw --force enable\|ufw delete\|tailscale up\|tailscale set" "$TRACE" | sed 's/^/    /'
  echo "  temp rule left: $(grep -cF hqbox-temp-lan-ssh "$RULES")"
}

# A: fresh box over ssh. Firewall precedes tailscale; the temp rule is scoped to
# the connecting host, on the interface that session arrived on (eth1, NOT eth0),
# and is gone by the end.
run_case "A: fresh box over ssh, joins tailnet" "" "$SSH" TS_JOINED=0 TS_BACKEND=Running

# B: ufw enable fails. Must die and must NEVER reach tailscale.
run_case "B: ufw enable fails" "" "$SSH" TS_JOINED=0 TS_BACKEND=Running UFW_ENABLE_FAILS=1

# C: already on the tailnet. No temp rule, but --ssh=true still enforced.
run_case "C: already joined" "" "$SSH" TS_JOINED=1 TS_BACKEND=Running

# D: THE LEAK CASE. An earlier run died after adding the temp rule. This run finds
# the box joined so never adds one, but must still clean the stranded rule.
run_case "D: stranded temp rule from an earlier run" \
  "allow in on eth1 from 192.168.1.5 to any port 22 proto tcp comment hqbox-temp-lan-ssh" \
  "$SSH" TS_JOINED=1 TS_BACKEND=Running

# E: daemon answers but is logged out. Using the exit status of `tailscale status`
# would skip the temp rule here and risk a lockout.
run_case "E: daemon up but NeedsLogin" "" "$SSH" TS_JOINED=0 TS_DAEMON_ANSWERS=1 TS_BACKEND=Running

# F: a pre-existing untagged `ufw allow 22/tcp`. default-deny does not remove it,
# so the script must REFUSE to claim tailnet-only.
run_case "F: pre-existing open LAN ssh rule" "PREEXISTING22" "$SSH" TS_JOINED=1 TS_BACKEND=Running

# G: console run, no ssh session. There is nothing to preserve, so no LAN port 22
# must ever be opened.
run_case "G: console run, no ssh session" "" TS_JOINED=0 TS_BACKEND=Running

rm -rf "$BIN"
