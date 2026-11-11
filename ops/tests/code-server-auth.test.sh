#!/usr/bin/env bash
# code-server auth (hq-an7jw.20): the shipped config never serves an
# unauthenticated owner workbench, and the unit fails closed without a
# password. Starts real code-server on a free loopback port with throwaway
# user-data and extensions dirs; the systemd checks run as transient user units
# built from the shipped drop-in. The upgrade cases (hq-an7jw.25) run the
# whole install.sh with fake systemctl, sudo, tailscale, loginctl and tmux on
# PATH, a throwaway HOME and HQ_CS_PORT on a free port, and a real auth none
# code-server standing in for the old code-server@USER unit. Nothing live is
# touched. The failure cases (hq-an7jw.27) probe the port themselves after
# install.sh exits, before any cleanup here: a failed run must leave nothing
# answering and no code-server process from the run. CS_INSTALL overrides the
# installer under test (to prove a case fails against an older install.sh).
# Round 4 (hq-an7jw.28): "dead" means the kernel lists no listening socket on
# the port (ss), and the cases add HUP and TERM mid-run, a 302 to a folder in
# place of the login page, and a hung listener that never answers.
# Round 5 (hq-an7jw.30): the fake tailscale keeps serve mappings in
# $FAKE_SYSD/serve ("<https port> <target>" lines, seeded with the old 443
# mapping to the code-server port and an unrelated one), and the cases add an
# existing mapping during the restart, no fuser, no ss, a closed output on
# the last line, and a closed output mid-run (SIGPIPE).
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
D="$REPO/ops/services/hqbox-terminals"
CFG="$D/code-server-config.yaml"; DROP="$D/code-server-auth.conf"
T="$(mktemp -d)"; CLEAN=":"
trap 'kill "${CS:-}" 2>/dev/null; for c in $CLEAN; do "$c" 2>/dev/null; done; rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "ok   $1"; }
bad() { fail=$((fail + 1)); echo "FAIL $1"; }

# 1. static: password auth, no password or auth none in git
grep -qx 'auth: password' "$CFG" && ok "config sets auth: password" || bad "config sets auth: password"
grep -Eq '^(auth: none|password:|hashed-password:)' "$CFG" && bad "config holds no auth none or password" \
  || ok "config holds no auth none or password"
grep -Eq '^EnvironmentFile=%h/\.config/code-server/auth\.env$' "$DROP" \
  && ok "drop-in EnvironmentFile is required (no leading -)" || bad "drop-in EnvironmentFile is required"
# systemd expands a single-dollar $PASSWORD into argv (visible in ps); $$ defers it to the shell
pre_line="$(grep '^ExecStartPre=' "$DROP")"
case "$pre_line" in *'"$$PASSWORD"'*) ! printf '%s' "$pre_line" | grep -Eq '(^|[^$])\$PASSWORD' \
  && ok "ExecStartPre reads \$\$PASSWORD, never \$PASSWORD" || bad "ExecStartPre has a single-dollar \$PASSWORD";;
  *) bad "ExecStartPre reads \$\$PASSWORD";; esac

port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
start_cs() { # start_cs <port>; env decides the password
  code-server --config "$CFG" --bind-addr "127.0.0.1:$1" --user-data-dir "$T/u" \
    --extensions-dir "$T/e" --disable-telemetry --disable-update-check >"$T/log" 2>&1 &
  CS=$!
}

if ! command -v code-server >/dev/null; then
  bad "code-server not installed (runtime cases not run)"
else
  # 2. shipped config + password: GET / with no credential is a 302 to login
  P="$(port)"; PASSWORD=test-only-pw start_cs "$P"
  for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$P/healthz" && break; sleep 0.25; done
  got="$(curl -s -o "$T/body" -w '%{http_code} %{redirect_url}' "http://127.0.0.1:$P/")"
  case "$got" in 302\ */login) ok "GET / without credential: $got";; *) bad "GET / without credential: $got";; esac
  grep -qi 'workbench' "$T/body" && bad "no workbench in the unauthenticated body" || ok "no workbench in the unauthenticated body"
  kill "$CS" 2>/dev/null; wait "$CS" 2>/dev/null

  # 3. shipped config, no password: code-server refuses, never serves
  #    (bounded: a config that serves anyway would never exit; timeout is rc 124)
  P="$(port)"; env -u PASSWORD -u HASHED_PASSWORD timeout 30 code-server --config "$CFG" \
    --bind-addr "127.0.0.1:$P" --user-data-dir "$T/u" --extensions-dir "$T/e" \
    --disable-telemetry --disable-update-check >"$T/log" 2>&1; rc=$?
  [ "$rc" -ne 0 ] && [ "$rc" -ne 124 ] && grep -q 'Please pass in a password' "$T/log" \
    && ok "no password: code-server exits $rc and refuses" || bad "no password: code-server refuses (rc $rc)"
fi

# 4. drop-in, as systemd runs it: missing auth.env and empty PASSWORD both fail
if systemctl --user is-system-running >/dev/null 2>&1 || [ "$(systemctl --user is-system-running 2>/dev/null)" = degraded ]; then
  pre="$(sed -n 's/^ExecStartPre=//p' "$DROP")"
  run() { # run <envfile>: the drop-in's two directives around /bin/true
    systemd-run --user --quiet --wait --collect -p "EnvironmentFile=$1" \
      -p "ExecStartPre=$pre" /bin/true >/dev/null 2>&1
  }
  run "$T/missing.env"; rc=$?; [ "$rc" -ne 0 ] && ok "unit refuses with auth.env missing (rc $rc)" || bad "unit refuses with auth.env missing"
  printf 'PASSWORD=\n' >"$T/empty.env"
  run "$T/empty.env"; rc=$?; [ "$rc" -ne 0 ] && ok "unit refuses with empty PASSWORD (rc $rc)" || bad "unit refuses with empty PASSWORD"
  printf 'PASSWORD=x\n' >"$T/set.env"
  run "$T/set.env"; rc=$?; [ "$rc" -eq 0 ] && ok "unit starts with PASSWORD set" || bad "unit starts with PASSWORD set (rc $rc)"
else
  bad "no systemd user manager (unit cases not run)"
fi

# 5. upgrade from the old template unit (hq-an7jw.25): install.sh retires a
#    running auth none code-server@USER before anything else, and refuses to
#    publish when it cannot.
INSTALL="${CS_INSTALL:-$D/install.sh}"
B="$T/bin"; mkdir -p "$B"
cat >"$B/systemctl" <<'FAKE'
#!/usr/bin/env bash
# fake systemctl: code-server@*.service is the old auth none instance
# (pid in $FAKE_SYSD/legacy.pid); code-server.service (user) runs real
# code-server with the deployed config and auth.env. Knobs: FAKE_DISABLE_FAIL
# (disable fails), FAKE_STOP_LIES (exit 0, unit keeps running),
# FAKE_STAYS_ENABLED (stops, stays enabled), FAKE_NEW_NOAUTH (the new unit
# serves with auth none), FAKE_NEW_FOLDER (auth none with a folder, so GET /
# is a 302 to ./?folder=...), FAKE_NO_BASE_UNIT (template-only install: no
# packaged code-server.service; it loads only once ~/.config/systemd/user holds
# one, and then runs that file's ExecStart). Every call is logged.
S="$FAKE_SYSD"; echo "systemctl $*" >>"$S/calls"
scope=system; [ "${1:-}" = --user ] && { scope=user; shift; }
verb="$1"; shift; [ "${1:-}" = --quiet ] && shift; [ "${1:-}" = --now ] && { now=1; shift; }
unit="${*: -1}"
alive() { [ -s "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
reap() { alive "$1" && { kill "$(cat "$1")"; while alive "$1"; do sleep 0.1; done; }; rm -f "$1"; }
case "$unit" in
  code-server@*)
    [ "$scope" = "$FAKE_LEGACY_SCOPE" ] || { [ "$verb" = is-active ] && exit 3; exit 1; }
    case "$verb" in
      is-active) alive "$S/legacy.pid";;
      is-enabled) [ -e "$S/legacy.enabled" ];;
      stop) [ -z "${FAKE_STOP_LIES:-}" ] && reap "$S/legacy.pid"; exit 0;;
      disable) [ -n "${FAKE_DISABLE_FAIL:-}" ] && exit 1
               [ -n "${FAKE_STAYS_ENABLED:-}" ] || rm -f "$S/legacy.enabled"
               [ -z "${FAKE_STOP_LIES:-}" ] && [ -n "${now:-}" ] && reap "$S/legacy.pid"; exit 0;;
      *) exit 0;;
    esac;;
  code-server.service)
    uf="$HOME/.config/systemd/user/code-server.service"
    frag=/usr/lib/systemd/user/code-server.service
    [ -n "${FAKE_NO_BASE_UNIT:-}" ] && { frag=""; [ -f "$uf" ] && frag="$uf"; }
    case "$verb" in
      show) echo "$frag";;
      enable) [ -n "$frag" ] || { echo "Unit file code-server.service does not exist." >&2; exit 1; };;
      stop) reap "$S/user.pid";;
      restart) reap "$S/user.pid"
        [ -n "$frag" ] || { echo "Unit code-server.service not found." >&2; exit 5; }
        grep -Eq ":$HQ_CS_PORT(/|\$)" "$S/serve" 2>/dev/null && echo "EXPOSED at restart" >>"$S/calls"
        cmd=code-server   # the packaged unit runs code-server; a written one runs its own ExecStart
        [ "$frag" = "$uf" ] && cmd="$(sed -n 's/^ExecStart=//p' "$uf" | sed "s|%h|$HOME|g")"
        ( set -a; . "$HOME/.config/code-server/auth.env"; set +a
          set --; [ -n "${FAKE_NEW_FOLDER:-}" ] && { mkdir -p "$S/ws"; set -- --auth none "$S/ws"; }
          [ "$cmd" = code-server ] && set -- "$@" --config "$HOME/.config/code-server/config.yaml"
          exec $cmd ${FAKE_NEW_NOAUTH:+--auth none} "$@" --bind-addr "127.0.0.1:$HQ_CS_PORT" \
            --user-data-dir "$S/u" --extensions-dir "$S/e" --disable-telemetry --disable-update-check ) >"$S/user.log" 2>&1 &
        echo $! >"$S/user.pid";;
      is-active) alive "$S/user.pid";;
      *) exit 0;;
    esac;;
  *) exit 0;;
esac
FAKE
cat >"$B/sudo" <<'FAKE'
#!/usr/bin/env bash
[ "${1:-}" = -n ] && shift
case "$1" in systemctl|tailscale|loginctl|ss|kill) exec "$@";; *) echo "fake sudo: refused $1" >&2; exit 99;; esac
FAKE
cat >"$B/tailscale" <<'FAKE'
#!/usr/bin/env bash
# fake tailscale serve: mappings live in $FAKE_SYSD/serve. Knobs: FAKE_SERVE_STICKY
# (off exits 0, the mapping stays), FAKE_CLOSE_AT_STATUS (plain status kills the
# output reader in $FAKE_SYSD/reader.pid, as a dropped ssh session would),
# FAKE_STATUS_FAIL (status --json exits 1, as with tailscaled down),
# FAKE_STATUS_FMT (status --json layout: compact, tab, junk, empty, or unknown,
# a mapping to the port under a key the installer does not know)
S="$FAKE_SYSD"; echo "tailscale $*" >>"$S/calls"; touch "$S/serve"
[ "${1:-}" = serve ] || exit 0; shift
fmt() { case "${FAKE_STATUS_FMT:-}" in
  compact) jq -c .;; tab) sed -E ':a; s/^(\t*)  /\1\t/; ta';; junk) cat >/dev/null; echo 'no JSON here';;
  empty) cat >/dev/null;; unknown) cat >/dev/null; printf '{"Later":{"x":{"Upstream":"http://127.0.0.1:%s"}}}\n' "$HQ_CS_PORT";;
  *) cat;; esac; }
case "$*" in
  "status --json") [ -n "${FAKE_STATUS_FAIL:-}" ] && { echo "tailscaled not running" >&2; exit 1; }
    { echo '{'; echo '  "Web": {'; n=0
    while read -r port target; do [ "$n" -gt 0 ] && echo '    },'; n=1
      printf '    "box.example.ts.net:%s": {\n      "Handlers": {\n        "/": {\n          "Proxy": "%s"\n        }\n      }\n' "$port" "$target"
    done <"$S/serve"; [ "$n" -gt 0 ] && echo '    }'; echo '  }'; echo '}'; } | fmt;;
  status) if [ -n "${FAKE_CLOSE_AT_STATUS:-}" ]; then kill "$(cat "$S/reader.pid")"; sleep 0.5; else cat "$S/serve"; fi;;
  "--bg "*) { grep -v '^443 ' "$S/serve"; echo "443 http://127.0.0.1:$2"; } >"$S/serve.new"; mv "$S/serve.new" "$S/serve";;
  --https=*" off") p="${1#--https=}"; grep -q "^$p " "$S/serve" || exit 1   # like tailscale: no handler is an error
    [ -n "${FAKE_SERVE_STICKY:-}" ] && exit 0
    grep -v "^$p " "$S/serve" >"$S/serve.new"; mv "$S/serve.new" "$S/serve";;
  *) exit 1;;
esac
FAKE
printf '#!/bin/sh\nexit 0\n' >"$B/loginctl"; printf '#!/bin/sh\nexit 0\n' >"$B/tmux"
chmod +x "$B"/*

legacy_start() { # legacy_start <dir> <port>: auth none code-server as the old unit
  # (hq-an7jw.32) a throwaway HOME, XDG dirs and --config: the operator's own
  # code-server config is never read or written, and a failed start is killed
  local h="$1/legacy-home"; mkdir -p "$h"
  printf 'bind-addr: 127.0.0.1:%s\nauth: none\ncert: false\n' "$2" >"$1/legacy-config.yaml"
  env HOME="$h" XDG_CONFIG_HOME="$h/.config" XDG_DATA_HOME="$h/.local/share" XDG_CACHE_HOME="$h/.cache" \
    code-server --config "$1/legacy-config.yaml" --auth none --bind-addr "127.0.0.1:$2" \
    --user-data-dir "$1/lu" --extensions-dir "$1/le" \
    --disable-telemetry --disable-update-check >"$1/legacy.log" 2>&1 &
  echo $! >"$1/legacy.pid"; touch "$1/legacy.enabled"
  serve_seed "$1" "$2"
  for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$2/healthz" && return 0; sleep 0.25; done
  kill "$(cat "$1/legacy.pid")" 2>/dev/null; return 1
}
serve_seed() { # serve_seed <dir> <port>: the old tailnet mapping to code-server, plus one that is not ours
  # SEED_TARGET (printf format, %s is the port) names the old mapping's target
  printf "443 ${SEED_TARGET:-http://127.0.0.1:%s}\n10000 http://127.0.0.1:8787\n" "$2" >"$1/serve"
}
get() { curl -s -o "$1" -m 5 -w '%{http_code}' "http://127.0.0.1:$2/" || true; }
listening() { [ -n "$(ss -H -ltn "sport = :$1" 2>/dev/null)" ]; }   # kernel state, not HTTP
upgrade() { # upgrade <name> <scope> [env...]: start the old unit, run install.sh; sets $u $up
  # auth.env starts as $PRE_AUTH (printf format), default an invalid leftover PASSWORD=
  u="$T/up-$1"; mkdir -p "$u/home/.config/code-server"; up="$(port)"
  printf "${PRE_AUTH:-PASSWORD=\\n}" >"$u/home/.config/code-server/auth.env"
  legacy_start "$u" "$up" || { bad "$1: stand-in auth none instance did not start"; return 1; }
  [ "$(get "$u/pre" "$up")" = 200 ] && grep -qi workbench "$u/pre" \
    || { bad "$1: stand-in serves the workbench before the upgrade"; return 1; }
  env -i PATH="${UPATH:-$B:$PATH}" HOME="$u/home" USER=hqtest FAKE_SYSD="$u" FAKE_LEGACY_SCOPE="$2" HQ_CS_PORT="$up" \
    "${@:3}" bash "$INSTALL" >"$u/install.log" 2>&1; irc=$?
}
dead_after() { # dead_after <label>: no listening socket on the port, no process from this run is left
  local lis=no got left; listening "$up" && lis=yes
  got="$(get "$u/post" "$up")"; left="$(pgrep -f -- "$u/" | tr '\n' ' ')"
  [ "$lis" = no ] && [ "$got" = 000 ] && [ -z "$left" ] && ok "$1: after exit $irc no listener on the port, nothing left" \
    || bad "$1: after exit $irc listener: $lis, GET /: $got, processes left: ${left:-none}"
}
cleanup_up() {
  for f in "$u/legacy.pid" "$u/user.pid" "$u/hung.pid"; do
    [ -s "$f" ] && { kill -CONT "$(cat "$f")"; kill "$(cat "$f")"; } 2>/dev/null
  done
}
prep() { # prep <name>: fresh dir and port, a good auth.env, nothing on the port; sets $u $up
  u="$T/up-$1"; mkdir -p "$u/home/.config/code-server"; up="$(port)"
  printf 'PASSWORD=Good123xyz\n' >"$u/home/.config/code-server/auth.env"; serve_seed "$u" "$up"
}
nopath() { # nopath <dir> <tool...>: a PATH dir with every tool on $PATH except the named ones
  mkdir -p "$1"; local d f n; local IFS=:
  for d in $PATH; do for f in "$d"/*; do n="${f##*/}"
    [ -x "$f" ] && [ ! -e "$1/$n" ] && case " ${*:2} " in *" $n "*) ;; *) ln -s "$f" "$1/$n";; esac
  done; done
}
CLEAN+=" cleanup_up"

if ! command -v code-server >/dev/null; then
  bad "code-server not installed (upgrade cases not run)"
else
  for sc in system user; do
    if upgrade "upgrade-$sc" "$sc"; then
      got="$(get "$u/after" "$up")"
      [ "$irc" -eq 0 ] && ok "upgrade ($sc template): install.sh exits 0" || bad "upgrade ($sc template): install.sh exits $irc ($(tail -1 "$u/install.log"))"
      { [ ! -s "$u/legacy.pid" ] || ! kill -0 "$(cat "$u/legacy.pid")" 2>/dev/null; } && [ ! -e "$u/legacy.enabled" ] \
        && ok "upgrade ($sc template): old auth none unit stopped and disabled" || bad "upgrade ($sc template): old auth none unit still running or enabled"
      case "$got" in 302|403|000) ! grep -qi workbench "$u/after" 2>/dev/null \
        && ok "upgrade ($sc template): GET / without credential is $got, no workbench" || bad "upgrade ($sc template): workbench body after upgrade";;
        *) bad "upgrade ($sc template): GET / without credential is $got";; esac
      grep -q '^tailscale serve --bg' "$u/calls" \
        && [ "$(curl -s -o /dev/null -m 5 -w '%{http_code} %{redirect_url}' "http://127.0.0.1:$up/")" = "302 http://127.0.0.1:$up/login" ] \
        && ok "upgrade ($sc template): the real login redirect passes, serve applied" \
        || bad "upgrade ($sc template): login redirect refused or serve not applied"
      grep -qx "443 http://127.0.0.1:$up" "$u/serve" && grep -q '^10000 ' "$u/serve" && ! grep -q 'EXPOSED' "$u/calls" \
        && ok "upgrade ($sc template): unpublished during the restart, 443 republished, other mappings kept" \
        || bad "upgrade ($sc template): serve mappings: $(tr '\n' ';' <"$u/serve"), calls: $(grep -c EXPOSED "$u/calls") EXPOSED"
      grep -Eq '^PASSWORD=.+' "$u/home/.config/code-server/auth.env" \
        && ok "upgrade ($sc template): empty PASSWORD in auth.env regenerated" || bad "upgrade ($sc template): auth.env still has no password"
      cleanup_up
    fi
  done

  # fail closed: disable fails, disable lies, or a stray process holds the port
  for knob in FAKE_DISABLE_FAIL=1 FAKE_STOP_LIES=1 FAKE_STAYS_ENABLED=1 STRAY; do
    if [ "$knob" = STRAY ]; then
      upgrade "stray" none || continue   # auth none process no unit owns: a stray
    else
      upgrade "refuse-${knob%%=*}" system "$knob" || continue
    fi
    [ "$irc" -ne 0 ] && ! grep -q '^tailscale serve --bg' "$u/calls" 2>/dev/null \
      && ! grep -q '^systemctl --user restart' "$u/calls" 2>/dev/null \
      && ok "refusal (${knob%%=*}): install.sh exits $irc before tailscale serve or the new unit" \
      || bad "refusal (${knob%%=*}): install.sh exit $irc, calls: $(tr '\n' ';' <"$u/calls" 2>/dev/null)"
    dead_after "refusal (${knob%%=*})"
    cleanup_up
  done
  # the new unit itself serves without a password: refused before tailscale serve
  if upgrade "refuse-new-noauth" system FAKE_NEW_NOAUTH=1; then
    [ "$irc" -ne 0 ] && ! grep -q '^tailscale serve --bg' "$u/calls" \
      && ok "refusal (new unit auth none): install.sh exits $irc before tailscale serve" \
      || bad "refusal (new unit auth none): install.sh exit $irc, calls: $(tr '\n' ';' <"$u/calls")"
    dead_after "refusal (new unit auth none)"
    cleanup_up
  fi

  # (b) hq-an7jw.28: auth none answering / with a 302 to a folder is not a login page
  prep folder
  env -i PATH="$B:$PATH" HOME="$u/home" USER=hqtest FAKE_SYSD="$u" FAKE_LEGACY_SCOPE=system HQ_CS_PORT="$up" \
    FAKE_NEW_FOLDER=1 timeout 120 bash "$INSTALL" >"$u/install.log" 2>&1; irc=$?
  [ "$irc" -eq 1 ] && grep -q '^systemctl --user restart' "$u/calls" && ! grep -q '^tailscale serve --bg' "$u/calls" \
    && ok "refusal (302 to ./?folder=): install.sh exits 1, no tailscale serve" \
    || bad "refusal (302 to ./?folder=): exit $irc, calls: $(tr '\n' ';' <"$u/calls" 2>/dev/null)"
  dead_after "refusal (302 to ./?folder=)"
  cleanup_up

  # (c) hq-an7jw.28: a stopped listener holds the port and never answers; its
  #     curl result is a timeout (000), yet a socket still listens
  prep hung
  ( python3 - "$up" "$u/hung" <<'PY' &
import socket, sys, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(16); time.sleep(10**6)
PY
    echo $! >"$u/hung.pid" )
  for _ in $(seq 1 40); do listening "$up" && break; sleep 0.1; done
  kill -STOP "$(cat "$u/hung.pid")"
  env -i PATH="$B:$PATH" HOME="$u/home" USER=hqtest FAKE_SYSD="$u" FAKE_LEGACY_SCOPE=none HQ_CS_PORT="$up" \
    timeout 120 bash "$INSTALL" >"$u/install.log" 2>&1; irc=$?
  [ "$irc" -eq 1 ] && ! grep -q '^tailscale serve --bg' "$u/calls" \
    && ok "refusal (hung listener): install.sh exits 1, no tailscale serve" \
    || bad "refusal (hung listener): exit $irc, calls: $(tr '\n' ';' <"$u/calls" 2>/dev/null)"
  sleep 0.5; dead_after "refusal (hung listener)"
  cleanup_up

  # (a) hq-an7jw.28: HUP or TERM after the restart, the new unit forced to auth
  #     none: install.sh exits 129 or 143 and leaves no listener. A slow
  #     /healthz keeps the run inside the verify step when the signal lands.
  SB="$T/sigbin"; mkdir -p "$SB"
  printf '#!/bin/sh\ncase "$*" in *healthz*) sleep 3;; esac\nexec %s "$@"\n' "$(command -v curl)" >"$SB/curl"
  chmod +x "$SB/curl"
  for sig in HUP:129 TERM:143; do
    prep "sig-${sig%%:*}"
    env -i PATH="$SB:$B:$PATH" HOME="$u/home" USER=hqtest FAKE_SYSD="$u" FAKE_LEGACY_SCOPE=system HQ_CS_PORT="$up" \
      FAKE_NEW_NOAUTH=1 timeout 120 bash "$INSTALL" >"$u/install.log" 2>&1 & ip=$!
    for _ in $(seq 1 200); do grep -q 'restart code-server.service' "$u/calls" 2>/dev/null && break; sleep 0.1; done
    sleep 1; pkill -"${sig%%:*}" -P "$ip" -f -- "$INSTALL"; wait "$ip"; irc=$?
    [ "$irc" -eq "${sig#*:}" ] && grep -q 'failed; stopping code-server' "$u/install.log" && ! grep -q '^tailscale serve --bg' "$u/calls" \
      && ok "signal (${sig%%:*}): install.sh exits $irc, fail_closed ran, no tailscale serve" \
      || bad "signal (${sig%%:*}): exit $irc (want ${sig#*:}), log: $(tail -1 "$u/install.log")"
    dead_after "signal (${sig%%:*})"
    cleanup_up
  done

  # Round 5 (hq-an7jw.30)
  stopped_after() { # stopped_after <calls line>: a code-server.service stop follows that line
    awk -v l="$1" 'index($0, l) { r = 1 } r && /--user stop code-server.service/ { f = 1 } END { exit !f }' "$u/calls"
  }
  # (r5-1, lucy 1) an existing tailscale serve mapping to the port is off before
  #     the replacement starts, so an auth none start is never reachable from the
  #     tailnet; a mapping that will not turn off stops the run before the restart
  if upgrade "r5-serve-off" system FAKE_NEW_NOAUTH=1; then
    first_off="$(grep -n '^tailscale serve --https=443 off' "$u/calls" | head -1 | cut -d: -f1)"
    restart="$(grep -n '^systemctl --user restart code-server' "$u/calls" | head -1 | cut -d: -f1)"
    [ "$irc" -eq 1 ] && [ -n "$first_off" ] && [ -n "$restart" ] && [ "$first_off" -lt "$restart" ] \
      && ! grep -q 'EXPOSED' "$u/calls" && ! grep -q "127.0.0.1:$up" "$u/serve" && grep -q '^10000 ' "$u/serve" \
      && ok "r5 existing serve mapping: off before the restart, never exposed, other mappings kept, exit $irc" \
      || bad "r5 existing serve mapping: exit $irc, serve: $(tr '\n' ';' <"$u/serve"), calls: $(tr '\n' ';' <"$u/calls")"
    dead_after "r5 existing serve mapping"
    cleanup_up
  fi
  if upgrade "r5-serve-sticky" system FAKE_SERVE_STICKY=1; then
    [ "$irc" -eq 1 ] && ! grep -q '^systemctl --user restart' "$u/calls" && ! grep -q '^tailscale serve --bg' "$u/calls" \
      && grep -q 'tailscale serve mapping to port' "$u/install.log" \
      && ok "r5 serve mapping that stays on: exit 1 before the restart" \
      || bad "r5 serve mapping that stays on: exit $irc, calls: $(tr '\n' ';' <"$u/calls")"
    dead_after "r5 serve mapping that stays on"
    cleanup_up
  fi

  # (r5-2, lucy 2) no fuser on PATH: the hung listener is still killed (pids from ss)
  NF="$T/nofuser"; nopath "$NF" fuser
  prep r5-nofuser
  ( python3 - "$up" <<'PY2' &
import socket, sys, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(16); time.sleep(10**6)
PY2
    echo $! >"$u/hung.pid" )
  for _ in $(seq 1 40); do listening "$up" && break; sleep 0.1; done
  kill -STOP "$(cat "$u/hung.pid")"
  env -i PATH="$B:$NF" HOME="$u/home" USER=hqtest FAKE_SYSD="$u" FAKE_LEGACY_SCOPE=none HQ_CS_PORT="$up" \
    timeout 120 bash "$INSTALL" >"$u/install.log" 2>&1; irc=$?
  [ "$irc" -eq 1 ] && ! grep -q '^tailscale serve --bg' "$u/calls" \
    && [ ! -e "$NF/fuser" ] && ok "r5 no fuser: hung listener run exits 1, no tailscale serve" \
    || bad "r5 no fuser: exit $irc, calls: $(tr '\n' ';' <"$u/calls" 2>/dev/null)"
  sleep 0.5; dead_after "r5 no fuser (hung listener)"
  cleanup_up

  # (r5-3, lucy 3) no ss: the check runs with the trap armed, so the old auth
  #     none unit is stopped and its serve mapping turned off anyway
  NS="$T/noss"; nopath "$NS" ss
  if UPATH="$B:$NS" upgrade "r5-noss" system; then
    [ "$irc" -eq 1 ] && grep -q 'ss (iproute2) is missing' "$u/install.log" && ! grep -q '^systemctl --user restart' "$u/calls" \
      && ! grep -q "127.0.0.1:$up" "$u/serve" && grep -q '^10000 ' "$u/serve" \
      && ok "r5 no ss: exit 1, old unit stopped, its serve mapping off, other mappings kept" \
      || bad "r5 no ss: exit $irc, serve: $(tr '\n' ';' <"$u/serve"), log: $(tail -1 "$u/install.log")"
    dead_after "r5 no ss"
    cleanup_up
  fi

  # (r5-4, lucy 4) the output closes after tailscale serve, before the last line:
  #     the EXIT trap is still armed, so the run fails closed (exit 141)
  prep r5-lastline; mkfifo "$u/out"
  ( cat "$u/out" >"$u/install.log" & echo $! >"$u/reader.pid" )
  env -i PATH="$B:$PATH" HOME="$u/home" USER=hqtest FAKE_SYSD="$u" FAKE_LEGACY_SCOPE=none HQ_CS_PORT="$up" \
    FAKE_CLOSE_AT_STATUS=1 timeout 120 bash "$INSTALL" >"$u/out" 2>&1; irc=$?
  [ "$irc" -eq 141 ] && grep -q '^tailscale serve --bg' "$u/calls" && stopped_after 'tailscale serve --bg' \
    && ok "r5 output closed before the last line: exit 141, code-server stopped after serve" \
    || bad "r5 output closed before the last line: exit $irc, calls: $(tr '\n' ';' <"$u/calls")"
  dead_after "r5 output closed before the last line"
  cleanup_up

  # (r5-5, review s-2948) ssh without a tty drops mid-run: SIGPIPE, not SIGHUP;
  #     the new unit is forced to auth none and must not stay up
  prep r5-pipe; mkfifo "$u/out"
  ( cat "$u/out" >"$u/install.log" & echo $! >"$u/reader.pid" )
  env -i PATH="$SB:$B:$PATH" HOME="$u/home" USER=hqtest FAKE_SYSD="$u" FAKE_LEGACY_SCOPE=system HQ_CS_PORT="$up" \
    FAKE_NEW_NOAUTH=1 setsid timeout 120 bash "$INSTALL" >"$u/out" 2>&1 & ip=$!
  for _ in $(seq 1 200); do grep -q 'restart code-server.service' "$u/calls" 2>/dev/null && break; sleep 0.1; done
  sleep 1; kill "$(cat "$u/reader.pid")"; wait "$ip"; irc=$?
  [ "$irc" -eq 141 ] && stopped_after 'restart code-server.service' && ! grep -q '^tailscale serve --bg' "$u/calls" \
    && ok "r5 SIGPIPE mid-run: exit 141, fail_closed stopped code-server, no tailscale serve" \
    || bad "r5 SIGPIPE mid-run: exit $irc (want 141), calls: $(tr '\n' ';' <"$u/calls")"
  dead_after "r5 SIGPIPE mid-run"
  cleanup_up

  # Round 6 (hq-an7jw.32)
  # (r6-1, lucy 1) the serve status is parsed as JSON, not by line layout:
  #     compact and tab-indented status still find the mapping, and it is off
  #     before the replacement (forced to auth none) starts
  for f in compact tab; do
    if upgrade "r6-fmt-$f" system FAKE_NEW_NOAUTH=1 FAKE_STATUS_FMT="$f"; then
      first_off="$(grep -n '^tailscale serve --https=443 off' "$u/calls" | head -1 | cut -d: -f1)"
      restart="$(grep -n '^systemctl --user restart code-server' "$u/calls" | head -1 | cut -d: -f1)"
      [ "$irc" -eq 1 ] && [ -n "$first_off" ] && [ -n "$restart" ] && [ "$first_off" -lt "$restart" ] \
        && ! grep -q 'EXPOSED' "$u/calls" && ! grep -q "127.0.0.1:$up" "$u/serve" && grep -q '^10000 ' "$u/serve" \
        && ok "r6 $f status JSON: mapping off before the restart, never exposed, other mappings kept" \
        || bad "r6 $f status JSON: exit $irc, serve: $(tr '\n' ';' <"$u/serve"), calls: $(tr '\n' ';' <"$u/calls")"
      dead_after "r6 $f status JSON"
      cleanup_up
    fi
  done
  # (r6-1) an unreadable or unrecognised status stops the run before anything
  #     restarts: junk, empty, the code-server port under an unknown key
  for f in junk empty unknown; do
    if upgrade "r6-status-$f" system FAKE_STATUS_FMT="$f"; then
      [ "$irc" -eq 1 ] && grep -q 'status is unreadable' "$u/install.log" \
        && ! grep -q '^systemctl --user restart' "$u/calls" && ! grep -q '^tailscale serve --bg' "$u/calls" \
        && ok "r6 $f status: exit 1 before the restart, no tailscale serve" \
        || bad "r6 $f status: exit $irc, log: $(tail -1 "$u/install.log"), calls: $(tr '\n' ';' <"$u/calls")"
      dead_after "r6 $f status"
      cleanup_up
    fi
  done
  # (r6-2, lucy 2) status unavailable (tailscaled down) at the first check: the
  #     run fails before retiring the old unit, and fail_closed still disables
  #     it in both scopes, so a reboot cannot bring the auth none unit back
  for sc in system user; do
    if upgrade "r6-nostatus-$sc" "$sc" FAKE_STATUS_FAIL=1; then
      [ "$irc" -eq 1 ] && [ ! -e "$u/legacy.enabled" ] \
        && { [ ! -s "$u/legacy.pid" ] || ! kill -0 "$(cat "$u/legacy.pid")" 2>/dev/null; } \
        && grep -q 'disable code-server.service' "$u/calls" && ! grep -q '^tailscale serve --bg' "$u/calls" \
        && ok "r6 status unavailable ($sc legacy): exit 1, old unit stopped and disabled, new unit disabled" \
        || bad "r6 status unavailable ($sc legacy): exit $irc, enabled: $([ -e "$u/legacy.enabled" ] && echo yes || echo no), calls: $(tr '\n' ';' <"$u/calls")"
      dead_after "r6 status unavailable ($sc legacy)"
      cleanup_up
    fi
  done
  # (r6-3, lucy 3) the legacy fixture never runs with the operator's HOME or config
  u="$T/up-r6-isolated"; mkdir -p "$u"; up="$(port)"
  if legacy_start "$u" "$up"; then
    lp="$(cat "$u/legacy.pid")"
    henv="$(tr '\0' '\n' <"/proc/$lp/environ" | sed -n 's/^HOME=//p')"
    cfg="$(tr '\0' '\n' <"/proc/$lp/cmdline" | grep -A1 -x -- --config | tail -1)"
    [ "$henv" = "$u/legacy-home" ] && [ "$cfg" = "$u/legacy-config.yaml" ] \
      && ok "r6 legacy fixture: HOME and --config are throwaway paths under the test dir" \
      || bad "r6 legacy fixture: HOME=$henv --config=$cfg"
  else
    bad "r6 legacy fixture: did not start"
  fi
  cleanup_up

  # Round 7 (hq-an7jw.33)
  # (r7-1, lucy 1) a mapping matches on the port of its target, whatever the
  #     host text: every alias is off before the replacement (forced to auth
  #     none) starts, never exposed, and the unrelated mapping stays
  for a in 'localhost|http://localhost:%s' 'ipv6-loopback|http://[::1]:%s' \
           'ipv4-mapped|http://[::ffff:127.0.0.1]:%s' 'ipv4-mapped-hex|http://[::ffff:7f00:1]:%s/' \
           'hostname|https+insecure://box.example.ts.net:%s/x'; do
    name="${a%%|*}"
    if SEED_TARGET="${a#*|}" upgrade "r7-alias-$name" system FAKE_NEW_NOAUTH=1; then
      first_off="$(grep -n '^tailscale serve --https=443 off' "$u/calls" | head -1 | cut -d: -f1)"
      restart="$(grep -n '^systemctl --user restart code-server' "$u/calls" | head -1 | cut -d: -f1)"
      [ "$irc" -eq 1 ] && [ -n "$first_off" ] && [ -n "$restart" ] && [ "$first_off" -lt "$restart" ] \
        && ! grep -q 'EXPOSED' "$u/calls" && ! grep -q '^443 ' "$u/serve" && grep -q '^10000 ' "$u/serve" \
        && ok "r7 alias $name ($(printf "${a#*|}" "$up")): off before the restart, never exposed, other mappings kept" \
        || bad "r7 alias $name: exit $irc, serve: $(tr '\n' ';' <"$u/serve"), calls: $(tr '\n' ';' <"$u/calls")"
      dead_after "r7 alias $name"
      cleanup_up
    fi
  done
  # (r7-1) a target on a near port (code-server port with a digit added) is not ours: kept
  if SEED_TARGET='http://127.0.0.1:1%s' upgrade "r7-near-port" system; then
    [ "$irc" -eq 0 ] && grep -qx "443 http://127.0.0.1:$up" "$u/serve" && grep -q '^10000 ' "$u/serve" \
      && ! grep -q '^tailscale serve --https=443 off' "$u/calls" \
      && ok "r7 near port (:1$up): not unpublished, run exits 0" \
      || bad "r7 near port: exit $irc, serve: $(tr '\n' ';' <"$u/serve"), calls: $(tr '\n' ';' <"$u/calls")"
    cleanup_up
  fi
  # Round 8 (hq-an7jw.39, lucy round 1 on hq-an7jw.33)
  # (r8-1) a scheme URL with no explicit port is an unexpected shape: no default
  #     port is assumed, the run stops before the restart and before any serve
  #     change. "http://PORT" names a host, so it stops too and its mapping is
  #     never turned off as if it were ours
  for a in 'http-no-port|http://localhost' 'https-no-port|https://host' 'http-numeric-host|http://%s'; do
    name="${a%%|*}"
    if SEED_TARGET="${a#*|}" upgrade "r8-$name" system; then
      [ "$irc" -eq 1 ] && grep -q 'status is unreadable' "$u/install.log" \
        && ! grep -q '^systemctl --user restart' "$u/calls" && ! grep -q '^tailscale serve --bg' "$u/calls" \
        && ! grep -q '^tailscale serve --https=.* off' "$u/calls" && grep -q '^443 ' "$u/serve" && grep -q '^10000 ' "$u/serve" \
        && ok "r8 $name ($(printf "${a#*|}" "$up")): exit 1 before the restart, no mapping turned off or added" \
        || bad "r8 $name: exit $irc, log: $(tail -1 "$u/install.log"), serve: $(tr '\n' ';' <"$u/serve"), calls: $(tr '\n' ';' <"$u/calls")"
      dead_after "r8 $name"
      cleanup_up
    fi
  done
  # (r8-2) a bare number with no scheme is still a port: off before the restart
  if SEED_TARGET='%s' upgrade "r8-bare-port" system FAKE_NEW_NOAUTH=1; then
    first_off="$(grep -n '^tailscale serve --https=443 off' "$u/calls" | head -1 | cut -d: -f1)"
    restart="$(grep -n '^systemctl --user restart code-server' "$u/calls" | head -1 | cut -d: -f1)"
    [ "$irc" -eq 1 ] && [ -n "$first_off" ] && [ -n "$restart" ] && [ "$first_off" -lt "$restart" ] \
      && ! grep -q 'EXPOSED' "$u/calls" && ! grep -q '^443 ' "$u/serve" && grep -q '^10000 ' "$u/serve" \
      && ok "r8 bare port ($up): off before the restart, never exposed, other mappings kept" \
      || bad "r8 bare port: exit $irc, serve: $(tr '\n' ';' <"$u/serve"), calls: $(tr '\n' ';' <"$u/calls")"
    dead_after "r8 bare port"
    cleanup_up
  fi
  # (r7-2, lucy 2) template-only install: no packaged code-server.service. The
  #     upgrade writes a complete unit, systemd loads it, its ExecStart serves
  #     the login page, serve is applied; a packaged unit is never shadowed
  for sc in system user; do
    if upgrade "r7-template-only-$sc" "$sc" FAKE_NO_BASE_UNIT=1; then
      uf="$u/home/.config/systemd/user/code-server.service"
      [ "$irc" -eq 0 ] && [ -f "$uf" ] && grep -q '^ExecStart=/.*code-server --config %h/.config/code-server/config.yaml$' "$uf" \
        && grep -q '^tailscale serve --bg' "$u/calls" && grep -qx "443 http://127.0.0.1:$up" "$u/serve" \
        && [ "$(curl -s -o /dev/null -m 5 -w '%{http_code} %{redirect_url}' "http://127.0.0.1:$up/")" = "302 http://127.0.0.1:$up/login" ] \
        && [ ! -e "$u/legacy.enabled" ] \
        && ok "r7 template-only ($sc legacy): unit written, loads, login redirect, serve applied, old unit disabled" \
        || bad "r7 template-only ($sc legacy): exit $irc ($(tail -1 "$u/install.log")), unit: $([ -f "$uf" ] && echo yes || echo no)"
      if [ "$sc" = user ] && command -v systemd-analyze >/dev/null; then
        mkdir -p "$u/verify"; cp "$uf" "$u/verify/code-server.service"
        out="$(systemd-analyze --user verify "$u/verify/code-server.service" 2>&1)"; rc=$?
        [ "$rc" -eq 0 ] && ok "r7 written unit passes systemd-analyze verify" || bad "r7 written unit: systemd-analyze verify rc $rc: $out"
      fi
      cleanup_up
    fi
  done
  if upgrade "r7-packaged-unit" user; then
    [ "$irc" -eq 0 ] && [ ! -e "$u/home/.config/systemd/user/code-server.service" ] \
      && ok "r7 packaged unit present: no unit written in ~/.config/systemd/user" \
      || bad "r7 packaged unit present: exit $irc, unit written: $(ls "$u/home/.config/systemd/user")"
    cleanup_up
  fi

  # auth.env (hq-an7jw.27): kept only in the form systemd reads as non-empty
  for c in 'quoted|PASSWORD=""\n' 'dup|PASSWORD=Abc123\nPASSWORD=\n' 'good|PASSWORD=Good123xyz\n'; do
    name="${c%%|*}"; pre="${c#*|}"
    if PRE_AUTH="$pre" upgrade "auth-$name" user; then
      f="$u/home/.config/code-server/auth.env"; printf "$pre" >"$u/want"
      if [ "$name" = good ]; then
        [ "$irc" -eq 0 ] && cmp -s "$f" "$u/want" && ok "auth.env ($name): kept byte for byte" \
          || bad "auth.env ($name): exit $irc, file changed or run failed"
      else
        [ "$irc" -eq 0 ] && ! cmp -s "$f" "$u/want" && grep -qxE 'PASSWORD=[A-Za-z0-9]+' "$f" && [ "$(wc -l <"$f")" -eq 1 ] \
          && ok "auth.env ($name): regenerated" || bad "auth.env ($name): exit $irc, not regenerated"
      fi
      cleanup_up
    fi
  done
fi

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
