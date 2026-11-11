#!/usr/bin/env bash
# Install the hqbox terminal-access layer. Idempotent; run ON hqbox as owner:
#
#   bash ~/hq/ops/services/hqbox-terminals/install.sh
#
# What it sets up:
#   - code-server serving on 127.0.0.1:8080 as a user service, password
#     protected: the password lives in ~/.config/code-server/auth.env
#     (mode 600, generated on first run, never in git); read it with
#     `cat ~/.config/code-server/auth.env` and enter it once per browser
#   - a persistent tmux session "hq" as a user service
#   - user lingering, so both start at boot without a login
#   - tailscale serve exposing code-server tailnet-only over HTTPS
#
# Access afterwards, from any device logged into the tailnet:
#   browser:  https://hqbox.example.ts.net   (iPhone-friendly)
#   ssh:      ssh owner@hqbox -t tmux attach -t hq
#
# REQUIRED: restrict the box in your tailnet ACL to your own login.
# tailscale serve forwards every peer the ACL lets through and does no user
# check of its own. The code-server password is the second wall, not the
# only one. Example ACL grant (tailscale admin console, Access controls):
#   {"src": ["you@example.com"], "dst": ["tag:hqbox"], "ip": ["*"]}
# with no other rule that reaches the box. The default allow-all ACL lets
# every tailnet member reach it.
#
# RUN IT over ssh or a plain tmux pane, never from the code-server terminal:
# it stops code-server.service, which kills a shell running inside it.
#
# UPGRADE: older installers could run code-server as the packaged template
# unit code-server@USER.service (system or user scope) with auth none. This
# installer FIRST turns off every tailscale serve mapping that forwards to the
# code-server port, whatever host the target names (and stops if one stays), so nothing it starts or probes is
# reachable from the tailnet. Then it stops, then disables, that unit, and
# stops unless nothing answers the code-server port afterwards. It applies
# tailscale serve again only after GET / without a credential redirects to
# the login page (302, Location ./login); any other answer, a 302 to a folder
# included, stops it. "Nothing on the port" always means the kernel lists no
# listening socket on it (ss), never an HTTP result: a hung listener that does
# not answer still counts as live. Without ss the port always counts as live.
# FAIL CLOSED: if it exits non-zero at any point, HUP, INT, TERM and PIPE (an
# ssh session that drops) included, it stops code-server and the old units,
# kills whatever still listens on the port (pids from ss, TERM then KILL; no
# fuser needed), and only if a listener is still there turns off the
# tailscale serve mapping. It disables code-server.service and the old units
# first, so a reboot after a failed run starts none of them. A failed run
# leaves the workbench down, never open; rerun to bring it back. The serve
# status is parsed with jq; an unreadable or unrecognised status stops the run.
# A box with only the old template unit gets a complete code-server.service
# in ~/.config/systemd/user (the hq-auth.conf drop-in alone creates nothing).
# HQ_CS_PORT overrides the port (tests only; the shipped config binds 8080).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CS_PORT="${HQ_CS_PORT:-8080}"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
die() { echo "install.sh: $*; stop" >&2; exit 1; }
LEGACY="code-server@$USER.service"
port_listening() { # 0 while the kernel lists a listening TCP socket on the port; no ss counts as listening
  command -v ss >/dev/null 2>&1 || return 0
  local out; out="$(ss -H -ltn "sport = :$CS_PORT" 2>/dev/null)" || return 0
  [ -n "$out" ]
}
port_dead() { # port_dead <tries>: 0 once no socket listens on the port
  local i; for i in $(seq 1 "$1"); do port_listening || return 0; sleep 0.5; done; return 1
}
kill_port() { # kill_port <signal>: signal every process that listens on the port (pids from ss -p)
  local out p
  out="$(sudo -n ss -H -ltnp "sport = :$CS_PORT" 2>/dev/null || ss -H -ltnp "sport = :$CS_PORT" 2>/dev/null)"
  for p in $(printf '%s\n' "$out" | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
    kill -s "$1" "$p" 2>/dev/null || sudo -n kill -s "$1" "$p" 2>/dev/null
  done
  return 0
}
served_ports() { # the tailscale serve ports whose handler forwards to the code-server port
  # Parsed as JSON (jq), never by line layout. A handler matches on the PORT of
  # its target after URL parsing, whatever the host text: 127.0.0.1, localhost,
  # [::1], [::ffff:127.0.0.1], a hostname, any alias. Fails (non-zero) when the
  # status is unreadable or empty, is not a JSON object, holds a handler target
  # with no explicit port (a scheme URL with no :PORT included), holds a
  # matching handler under no Web or TCP port key, or names :PORT in any other
  # string value: an unrecognised layout must stop the run, never read as clean.
  local raw ports
  raw="$(sudo tailscale serve status --json)" && [ -n "${raw//[[:space:]]/}" ] || return 1   # empty is unreadable
  ports="$(jq -r --arg want "$CS_PORT" '
    def port_of: # the port of a handler target: scheme://[user@]host[:port][/path] or host:port or a bare port
      if test("^unix:") then null else   # a unix socket is never the TCP port
      (if test("^[A-Za-z][A-Za-z0-9+.-]*://") then capture("^(?<s>[^:]+)://(?<a>[^/?#]*)")
       else {s: "", a: capture("^(?<a>[^/?#]*)").a} end) as $u
      | ($u.a | sub("^.*@"; "")) as $h
      # an explicit port only: a scheme default (80, 443) is never assumed, and a
      # bare number is a port only with no scheme ("http://8080" names a host)
      | if ($h | test(":[0-9]+$")) then $h | capture(":(?<p>[0-9]+)$").p | tonumber
        elif $u.s == "" and ($h | test("^[0-9]+$")) then $h | tonumber
        else error("handler target with no port: \(.)") end end;
    def handler: .[-1] == "Proxy" or .[-1] == "TCPForward";
    if type != "object" then error("status is not a JSON object") else . end
    | ($want | tonumber) as $w
    | [paths(type == "string") as $p | {p: $p, v: getpath($p)}] as $leaves
    | ($leaves[] | select((.p | handler | not) and (.v | test(":0*\($w)([^0-9]|$)")))
       | error("port \($w) named outside a handler: \(.p)")),
      ($leaves[] | select((.p | handler) and (.v | port_of) == $w) | .p as $p
       | [range(1; $p | length) as $i | select($p[$i - 1] == "Web" or $p[$i - 1] == "TCP") | $p[$i]] | last
       | if type == "string" and test("(^|:)[0-9]+$") then sub("^.*:"; "") else error("no port key for a mapping") end)
  ' <<<"$raw")" || return 1
  printf '%s\n' "$ports" | sort -u | sed '/^$/d'
}
unpublish() { # turn off every tailscale serve mapping to the code-server port; 0 once none is left
  local ports p
  ports="$(served_ports)" || return 1
  for p in $ports; do
    sudo tailscale serve --https="$p" off >/dev/null 2>&1 || sudo tailscale serve --tcp="$p" off >/dev/null 2>&1
  done
  ports="$(served_ports)" || return 1
  [ -z "$ports" ]
}
fail_closed() { # on a non-zero exit: leave nothing listening on the code-server port
  set +e; trap '' HUP INT TERM PIPE   # a second signal or a closed output must not cut the cleanup short
  echo "install.sh: failed; stopping code-server so nothing serves 127.0.0.1:$CS_PORT" >&2
  systemctl --user stop code-server.service 2>/dev/null
  systemctl --user stop "$LEGACY" 2>/dev/null
  sudo systemctl stop "$LEGACY" 2>/dev/null
  # disabled before any early return: a unit left enabled comes back at boot
  # (the old one with auth none) behind a mapping this run could not turn off
  systemctl --user disable code-server.service 2>/dev/null
  systemctl --user disable "$LEGACY" 2>/dev/null
  sudo systemctl disable "$LEGACY" 2>/dev/null
  port_dead 4 && return
  kill_port TERM; port_dead 10 && return
  kill_port KILL; port_dead 4 && return
  echo "install.sh: a socket still listens on port $CS_PORT; turning off its tailscale serve mapping" >&2
  unpublish || echo "install.sh: could not confirm the tailscale serve mapping is off; check: sudo tailscale serve status" >&2
}
# armed before anything else, and never disarmed: a zero exit skips the cleanup
trap 'rc=$?; [ "$rc" -eq 0 ] || fail_closed; exit "$rc"' EXIT
# a signal reaches the EXIT trap with $? of the last finished command (often 0):
# exit with the signal's code so fail_closed runs
trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 141' PIPE
command -v ss >/dev/null 2>&1 || die "ss (iproute2) is missing; it decides whether the port is free"
command -v jq >/dev/null 2>&1 || die "jq is missing; it parses tailscale serve status"

echo "== unpublish code-server from the tailnet until it is verified =="
unpublish || die "a tailscale serve mapping to port $CS_PORT is still on (or its status is unreadable)"

echo "== retire old code-server units (auth none) =="
for scope in system user; do
  if [ "$scope" = system ]; then q=(systemctl); w=(sudo systemctl); else q=(systemctl --user); w=(systemctl --user); fi
  if "${q[@]}" is-active --quiet "$LEGACY" || "${q[@]}" is-enabled --quiet "$LEGACY" 2>/dev/null; then
    echo "stopping, then disabling, $LEGACY ($scope)"
    "${w[@]}" stop "$LEGACY" || die "could not stop $LEGACY ($scope)"
    ! "${q[@]}" is-active --quiet "$LEGACY" || die "$LEGACY ($scope) is still active"
    "${w[@]}" disable "$LEGACY" || die "could not disable $LEGACY ($scope)"
    ! "${q[@]}" is-enabled --quiet "$LEGACY" 2>/dev/null || die "$LEGACY ($scope) is still enabled"
  fi
done
systemctl --user stop code-server.service 2>/dev/null || true
port_dead 4 || die "a socket still listens on port $CS_PORT after the code-server units stopped"

echo "== deploy config files =="
install -D -m 600 "$HERE/code-server-config.yaml" "$HOME/.config/code-server/config.yaml"
install -D -m 644 "$HERE/tmux-hq.service" "$HOME/.config/systemd/user/tmux-hq.service"
install -D -m 644 "$HERE/code-server-auth.conf" \
  "$HOME/.config/systemd/user/code-server.service.d/hq-auth.conf"

echo "== code-server password (outside git, kept if present) =="
# Kept only in the exact form this installer writes (one line, PASSWORD= and
# letters and digits, no quotes): systemd reads PASSWORD="" or a last
# duplicate PASSWORD= as empty, and the unit would then refuse every start.
# Anything else is regenerated.
AUTH_ENV="$HOME/.config/code-server/auth.env"
if ! awk '{ if (NR > 1 || $0 !~ /^PASSWORD=[A-Za-z0-9]+$/) bad = 1 } END { exit (bad || NR != 1) }' \
    "$AUTH_ENV" 2>/dev/null; then
  ( umask 077; printf 'PASSWORD=%s\n' "$(head -c 24 /dev/urandom | base64 | tr -d '/+=')" > "$AUTH_ENV" )
  echo "generated $AUTH_ENV (read it with: cat $AUTH_ENV)"
fi
chmod 600 "$AUTH_ENV"

echo "== linger (user services run without a login session) =="
sudo loginctl enable-linger "$USER"

echo "== user services =="
systemctl --user daemon-reload
# Template-only installs (old packages shipped only code-server@.service) have
# no base code-server.service, and a drop-in does not create its parent: write
# a complete unit to ~/.config/systemd/user, then confirm systemd loads it.
if [ -z "$(systemctl --user show -P FragmentPath code-server.service)" ]; then
  cs_bin="$(command -v code-server)" || die "code-server is not on PATH; no unit can run it"
  case "$cs_bin" in /*[[:space:]]*|[!/]*) die "code-server path $cs_bin is not an absolute path without spaces";; esac
  echo "no packaged code-server.service: writing $HOME/.config/systemd/user/code-server.service"
  printf '%s\n' '[Unit]' 'Description=code-server (written by hq install.sh: no packaged user unit)' \
    'After=network.target' '' '[Service]' 'Type=exec' \
    "ExecStart=$cs_bin --config %h/.config/code-server/config.yaml" 'Restart=always' '' \
    '[Install]' 'WantedBy=default.target' >"$HOME/.config/systemd/user/code-server.service"
  chmod 644 "$HOME/.config/systemd/user/code-server.service"
  systemctl --user daemon-reload
  [ -n "$(systemctl --user show -P FragmentPath code-server.service)" ] \
    || die "systemd does not load the written code-server.service"
fi
systemctl --user enable code-server.service
systemctl --user restart code-server.service
systemctl --user enable --now tmux-hq.service

echo "== verify (before anything is published) =="
systemctl --user is-active code-server.service
systemctl --user is-active tmux-hq.service
tmux has-session -t hq && echo "tmux session hq: present"
for _ in $(seq 1 60); do curl -s -o /dev/null -m 5 "http://127.0.0.1:$CS_PORT/healthz" && break; sleep 0.5; done
got="$(curl -s -o /dev/null -m 5 -w '%{http_code} %{redirect_url}' "http://127.0.0.1:$CS_PORT/" || true)"
echo "code-server local, no credential: HTTP $got (302 to http://127.0.0.1:$CS_PORT/login expected)"
[ "$got" = "302 http://127.0.0.1:$CS_PORT/login" ] || die "code-server does not redirect to its login page"

echo "== tailscale serve (tailnet-only HTTPS, NOT funnel) =="
sudo tailscale serve --bg "$CS_PORT"
sudo tailscale serve status
echo "done. Browser URL: https://hqbox.example.ts.net"
