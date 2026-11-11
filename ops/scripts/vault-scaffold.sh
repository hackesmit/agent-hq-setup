#!/usr/bin/env bash
# vault-scaffold.sh <name> --type rig|bunker [--tags "a,b"] [--purpose "..."]
# Stamps a workspace hub from template into outbox/vault/<tree>/<name>/_index.md.
set -uo pipefail
HQ="$(cd "$(dirname "$0")/../.." && pwd)"
VAULT="$("$HQ/ops/scripts/vault-path.sh")"
TPL="$HQ/ops/templates/vault-workspace"
OUT="$HQ/outbox/vault"

NAME=""; TYPE=""; TAGS=""; PURPOSE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --type) TYPE="$2"; shift 2 ;;
    --tags) TAGS="$2"; shift 2 ;;
    --purpose) PURPOSE="$2"; shift 2 ;;
    -*) echo "unknown flag $1" >&2; exit 2 ;;
    *) NAME="$1"; shift ;;
  esac
done
[ -n "$NAME" ] && [ -n "$TYPE" ] || { echo "usage: vault-scaffold.sh <name> --type rig|bunker [--tags ..] [--purpose ..]" >&2; exit 2; }
case "$TYPE" in
  rig)    TREE="01 Projects"; TPLF="$TPL/_index.rig.md" ;;
  bunker) TREE="02 Bunkers";  TPLF="$TPL/_index.bunker.md" ;;
  *) echo "type must be rig or bunker" >&2; exit 2 ;;
esac
[ -f "$TPLF" ] || { echo "template missing: $TPLF" >&2; exit 2; }

DEST="$OUT/$TREE/$NAME/_index.md"
if [ -f "$VAULT/$TREE/$NAME/_index.md" ] || [ -f "$DEST" ]; then
  echo "refusing: hub already exists for $TREE/$NAME (vault or outbox)" >&2; exit 3
fi
[ -n "$TAGS" ] || TAGS="$TYPE"
[ -n "$PURPOSE" ] || PURPOSE="TODO: one-paragraph purpose."
DATE="$(date +%F)"

mkdir -p "$(dirname "$DEST")"
NAME="$NAME" DATE="$DATE" TAGS="$TAGS" PURPOSE="$PURPOSE" \
  python3 -c 'import os,sys
t=open(sys.argv[1],encoding="utf-8").read()
for k in ("NAME","DATE","TAGS","PURPOSE"):
    t=t.replace("{{"+k+"}}",os.environ[k])
open(sys.argv[2],"w",encoding="utf-8").write(t)' "$TPLF" "$DEST"

echo "scaffolded -> $DEST"
echo "next: review it, add the Map/Decisions, then the owner runs ops/scripts/vault-sync.sh"
