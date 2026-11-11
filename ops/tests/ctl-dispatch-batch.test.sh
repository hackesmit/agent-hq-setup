#!/usr/bin/env bash
# ctl-dispatch-batch.test.sh: dispatch-batch picks the ledger by bead id prefix
# (hq-kptb3.4). hq-* beads live in the hq ledger even when dispatched to a rig
# with no .beads; other prefixes use the rig dir. Hermetic: fake bd records its
# cwd, fake spawn does nothing.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
CTL="$REPO/ops/console/ctl.sh"
pass=0; fail=0
ok(){ pass=$((pass+1)); echo "ok   $1"; }
bad(){ fail=$((fail+1)); echo "FAIL $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$3] got [$2])"; fi; }

TMP="$(mktemp -d /tmp/ctlbatch.XXXXXX)"; trap 'rm -rf "$TMP"' EXIT
export HQ_STATE_DIR="$TMP/state" HQ_ROOT="$TMP/hq" HQ_RIGS_DIR="$TMP/hq/rigs" HQ_NO_SCHEDULE=1 HQ_NOTIFY=/bin/true HQ_NO_BELL=1
mkdir -p "$HQ_STATE_DIR" "$HQ_ROOT/.git" "$HQ_RIGS_DIR/enk/.git" "$HQ_RIGS_DIR/xd/.git" "$HQ_ROOT/ops/scripts"
printf '#!/bin/sh\nexit 0\n' > "$TMP/spawn"; chmod +x "$TMP/spawn"
cat > "$TMP/bd" <<'SH'
#!/bin/bash
echo "$(pwd) $*" >> "$BDLOG"
case "$1" in
  show) printf '[{"id":"%s","status":"open","title":"t %s"}]' "$2" "$2";;
  ready) printf '[{"id":"hq-e.1","issue_type":"task"},{"id":"hq-e.2","issue_type":"task"}]';;
esac
SH
chmod +x "$TMP/bd"
export HQ_BD="$TMP/bd" HQ_SPAWN="$TMP/spawn" BDLOG="$TMP/bd.log"

: > "$BDLOG"
out="$("$CTL" dispatch-batch --rig enk --beads hq-a.1 2>&1)"; rc=$?
check "hq bead on rig without .beads dispatches" "$rc" 0
check "hq bead asks the hq ledger" "$(grep -c "^$HQ_ROOT show hq-a.1" "$BDLOG")" 2

: > "$BDLOG"; rm -rf "$HQ_STATE_DIR"/*
out="$("$CTL" dispatch-batch --rig xd --beads xd-9 2>&1)"; rc=$?
check "xd bead dispatches" "$rc" 0
check "xd bead asks the rig dir" "$(grep -c "^$HQ_RIGS_DIR/xd show xd-9" "$BDLOG")" 2

: > "$BDLOG"; rm -rf "$HQ_STATE_DIR"/*
out="$("$CTL" dispatch-batch --rig enk --epic hq-e 2>&1)"; rc=$?
check "epic dispatches from the hq ledger" "$rc" 0
check "epic ready runs in hq with --limit 0" "$(grep -c "^$HQ_ROOT ready --parent hq-e --limit 0" "$BDLOG")" 1
case "$out" in *"dispatched 2 beads"*) ok "epic plan has both children";; *) bad "epic plan: $out";; esac

printf '#!/bin/sh\necho nope >&2; exit 1\n' > "$TMP/bd"
out="$("$CTL" dispatch-batch --rig enk --beads hq-z 2>&1)"; rc=$?
check "missing bead refuses" "$rc" 2
case "$out" in *"ledger $HQ_ROOT"*) ok "error names the ledger";; *) bad "error: $out";; esac

echo "pass=$pass fail=$fail"; [ "$fail" = 0 ]
