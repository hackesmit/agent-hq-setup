#!/usr/bin/env bash
# decision-record.test.sh (hq-0yagv.3): fixture test for decision-record.py.
# Run: bash decision-record.test.sh   (exit 0 = pass)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DR="${DR_PY:-$HERE/../decision-record.py}"
[ -f "$DR" ] || { echo "FAIL cannot find $DR"; exit 1; }
R="$(mktemp -d)"; trap '[ -n "${KEEP:-}" ] || rm -rf "$R"' EXIT; echo "tmp $R"
export DR_ARCHIVE="$R/archive" DR_CONSOLE="$R/console" DR_REGISTRY="$R/sessions.json" \
       DR_HQ="$R/hq" DR_LEDGER_JSON="$R/ledger.json"
OUT="$R/archive/decisions/decisions.jsonl"
fail=0
ok() { echo "ok   $1"; }
no() { echo "FAIL $1"; fail=1; }
run() { python3 "$DR" --out "$OUT" "$@" >"$R/out" 2>"$R/err"; echo $?; }
rec() { jq -c --arg i "$1" 'select(.id==$i)' "$OUT"; }

mkdir -p "$R/hq/rigs/lodgeco-system" "$R/hq/rigs/peel-1a2b" "$DR_CONSOLE/answers"
echo '{"s-0001":{"rig":"peel"}}' > "$DR_REGISTRY"
cat > "$DR_LEDGER_JSON" <<'EOF'
[{"id":"hq-abc12","status":"closed","closed_at":"2026-10-02T10:00:00Z","close_reason":"done","title":"Fix the bill","labels":["lodgeco-system","P1"]},
 {"id":"hq-zz9q","status":"open","title":"Other","labels":["hq"]}]
EOF

# console: answered, cancelled-but-answered (unlinked file), open, resolved without text
A1="$DR_CONSOLE/answers/r-aaaa-11111111.txt"
printf 'Go with option one. token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123\n' > "$A1"
printf 'Later answer to a cancelled ask\n' > "$DR_CONSOLE/answers/r-bbbb-22222222.txt"
jq -n --arg a1 "$A1" '[
 {id:"r-aaaa",question:"Pick a fix for hq-abc12. Cost 45 USD, see ops/reference/x.md and https://ex.com/p?key=SECRETQ\n- Option one (recommended)\n- Option two",
  bead:"hq-abc12",session:"s-0001",status:"delivered",ts:"2026-10-01T09:00:00Z",answered_ts:"2026-10-01T09:05:00Z",answer_file:$a1,kind:"decision",sev:"P1"},
 {id:"r-bbbb",question:"Old question?",bead:"",session:"",status:"cancelled",ts:"2026-09-01T09:00:00Z",answer_file:""},
 {id:"r-cccc",question:"Still open?",bead:"",session:"",status:"open",ts:"2026-11-01T09:00:00Z",answer_file:""},
 {id:"r-dddd",question:"Dismissed?",bead:"",session:"",status:"resolved",ts:"2026-08-20T09:00:00Z"}]' \
 > "$DR_CONSOLE/requests.json"

# transcript fixture
P="$DR_ARCHIVE/claude/projects/-home-owner-hq-rigs-lodgeco-system-4740"
mkdir -p "$P/sess1/subagents" "$DR_ARCHIVE/george-wsl/projects/-home-owner-hq"
python3 - "$P/s1.jsonl" <<'PY'
import json, sys
C = "/home/owner/hq/rigs/lodgeco-system-4740"
def a(uuid, mid, blocks, ts, side=False):
    return {"type": "assistant", "uuid": uuid, "isSidechain": side, "cwd": C, "sessionId": "S1",
            "timestamp": ts, "message": {"id": mid, "role": "assistant", "content": blocks}}
def u(uuid, content, ts, **kw):
    o = {"type": "user", "uuid": uuid, "isSidechain": False, "userType": "external", "cwd": C,
         "sessionId": "S1", "timestamp": ts, "message": {"role": "user", "content": content}}
    o.update(kw); return o
auq = {"type": "tool_use", "id": "toolu_A", "name": "AskUserQuestion", "input": {"questions": [
    {"question": "How should hq-abc12 proceed?", "header": "Bill", "multiSelect": False,
     "options": [{"label": "Drop split (Recommended)", "description": "Removes 4 bugs in api/bill.ts"},
                 {"label": "Another round", "description": "One more author round"}]},
    {"question": "Which font?", "header": "Font", "multiSelect": False,
     "options": [{"label": "Inter", "description": "x"}, {"label": "Mono", "description": "y"}]}]}}
rows = [
  u("u0", "Start the work", "2026-10-03T08:00:00Z"),
  a("a1", "m1", [{"type": "text", "text": "The review found 3 rounds of failures in state/x.json."}], "2026-10-03T08:01:00Z"),
  a("a2", "m1", [auq], "2026-10-03T08:01:01Z"),
  u("u1", [{"type": "tool_result", "tool_use_id": "toolu_A", "content": "Your questions have been answered"}],
    "2026-10-03T08:02:00Z", toolUseResult={"questions": [], "answers": {
        "How should hq-abc12 proceed?": "Drop split (Recommended)",
        "Which font?": "Neither, use the house font"}, "annotations": {}}),
  a("a3", "m2", [{"type": "tool_use", "id": "toolu_B", "name": "Bash", "input": {"command": "cat .env"}}], "2026-10-03T08:03:00Z"),
  u("u2", [{"type": "tool_result", "tool_use_id": "toolu_B", "content": "TOOL_OUTPUT_LEAK PASSWORD=hunter2hunter2"}], "2026-10-03T08:03:01Z"),
  a("a4", "m3", [{"type": "text", "text": "Done.\n\n- Ship now\n- Wait a day\n\nShould I ship it now?"}], "2026-10-03T08:04:00Z"),
  u("u3", "<system-reminder>injected</system-reminder>", "2026-10-03T08:04:30Z", isMeta=True),
  u("u4", "Wait a day, then ship", "2026-10-03T08:05:00Z"),
  a("a5", "m4", [{"type": "text", "text": "Shall I look?"}, {"type": "tool_use", "id": "toolu_C", "name": "Read", "input": {}}], "2026-10-03T08:06:00Z"),
  u("u5", [{"type": "tool_result", "tool_use_id": "toolu_C", "content": "file body"}], "2026-10-03T08:06:01Z"),
  a("a6", "m5", [{"type": "tool_use", "id": "toolu_D", "name": "AskUserQuestion", "input": {"questions": [
     {"question": "Deploy where?", "header": "Deploy", "multiSelect": False,
      "options": [{"label": "Prod", "description": ""}, {"label": "Staging", "description": ""}]}]}}], "2026-10-03T08:07:00Z"),
  u("u6", [{"type": "tool_result", "tool_use_id": "toolu_D", "is_error": True,
            "content": "The user doesn't want to proceed with this tool use."}], "2026-10-03T08:08:00Z"),
  u("u7", "Neither, I need to think", "2026-10-03T08:09:00Z"),
  a("a7", "m6", [{"type": "text", "text": "Sidechain question?"}], "2026-10-03T08:10:00Z", side=True),
  a("a8", "m7", [{"type": "tool_use", "id": "toolu_E", "name": "AskUserQuestion", "input": {"questions": [
     {"question": "Never answered?", "header": "X", "multiSelect": False, "options": []}]}}], "2026-10-03T08:11:00Z"),
]
with open(sys.argv[1], "w") as fh:
    for r in rows: fh.write(json.dumps(r) + "\n")
PY
zstd -q --rm "$P/s1.jsonl"
cp "$P/s1.jsonl.zst" "$P/s1.jsonl@1790000000.zst"            # kept-both copy: must not duplicate
cp "$P/s1.jsonl.zst" "$P/sess1/subagents/agent-1.jsonl.zst"   # subagent transcripts are skipped

[ "$(run)" = 0 ] && ok "first run exits 0" || no "first run: $(cat "$R/err")"
[ "$(wc -l < "$OUT")" = 6 ] && ok "6 records (2 console, 2+1 AUQ, 1 turn)" || no "record count $(wc -l < "$OUT"): $(jq -c '.id' "$OUT" | tr '\n' ' ')"
sha1="$(sha256sum < "$OUT")"
[ "$(run)" = 0 ] && [ "$(sha256sum < "$OUT")" = "$sha1" ] && grep -q unchanged "$R/out" \
  && ok "rerun yields the same file" || no "rerun differs"
[ "$(stat -c %a "$OUT")" = 600 ] && [ "$(stat -c %a "$(dirname "$OUT")")" = 700 ] && ok "modes 0600/0700" || no "modes"

r="$(rec console:r-aaaa)"
[ "$(jq -r .rig <<<"$r")" = peel ] && ok "console rig from session registry" || no "console rig: $r"
jq -e '.answer | startswith("Go with option one") and contains("[REDACTED]") and (contains("sk-ant") | not)' <<<"$r" >/dev/null \
  && ok "console answer verbatim, secret redacted" || no "console answer: $(jq .answer <<<"$r")"
jq -e '.recommended == "Option one (recommended)" and (.options|length)==2' <<<"$r" >/dev/null \
  && ok "console options and recommendation parsed" || no "console options: $(jq -c '.options,.recommended' <<<"$r")"
jq -e '.evidence.links == ["https://ex.com/p"] and (.evidence.files|index("ops/reference/x.md")) != null and .evidence.numbers == ["45 USD"]' <<<"$r" >/dev/null \
  && ok "evidence: link without query, file, number" || no "evidence: $(jq -c .evidence <<<"$r")"
jq -e '.outcome["hq-abc12"].status == "closed" and .outcome["hq-abc12"].close_reason == "done"' <<<"$r" >/dev/null \
  && ok "outcome from ledger" || no "outcome: $(jq -c .outcome <<<"$r")"
jq -e '.answer == "Later answer to a cancelled ask" and .request_status == "cancelled"' <<<"$(rec console:r-bbbb)" >/dev/null \
  && ok "unlinked answer file of a cancelled ask kept" || no "cancelled ask"
[ -z "$(rec console:r-cccc)$(rec console:r-dddd)" ] && ok "asks without answer text skipped" || no "unanswered ask recorded"
grep -q 'console: 4 asks, 3 closed, 2 with an answer' "$R/out" && ok "console counts printed" || no "counts: $(cat "$R/out")"
grep -q 'by month: 2026-09=1, 2026-10=5' "$R/out" && ok "counts by month printed" || no "by month: $(grep month "$R/out")"

r="$(rec auq:toolu_A:0)"
jq -e '.answer_kind=="option" and .recommended=="Drop split (Recommended)" and .rig=="lodgeco-system"
       and .bead_ids==["hq-abc12"] and .header=="Bill" and .host=="claude"
       and (.evidence.files|index("api/bill.ts"))!=null and (.evidence.files|index("state/x.json"))!=null
       and (.evidence.numbers|index("3 rounds"))!=null' <<<"$r" >/dev/null \
  && ok "AUQ option answer with evidence and bead" || no "AUQ 0: $r"
jq -e '.answer=="Neither, use the house font" and .answer_kind=="other"' <<<"$(rec auq:toolu_A:1)" >/dev/null \
  && ok "AUQ free-text answer" || no "AUQ 1: $(rec auq:toolu_A:1)"
jq -e '.answer_kind=="declined" and .followup=="Neither, I need to think"' <<<"$(rec auq:toolu_D:0)" >/dev/null \
  && ok "declined AUQ keeps the owner's next message" || no "declined: $(rec auq:toolu_D:0)"
[ -z "$(rec auq:toolu_E:0)" ] && grep -q '1 unanswered calls' "$R/out" && ok "unanswered AUQ counted, not recorded" || no "unanswered AUQ"
r="$(jq -c 'select(.source=="turn_question")' "$OUT")"
jq -e '.answer=="Wait a day, then ship" and (.question|startswith("- Ship now")) and (.options|length)==2' <<<"$r" >/dev/null \
  && ok "turn question with its option list" || no "turn question: $r"
[ "$(jq -c 'select(.source=="turn_question")' "$OUT" | wc -l)" = 1 ] \
  && ok "no turn record for a question followed by a tool call, meta or sidechain" || no "extra turn records"
! grep -qE 'TOOL_OUTPUT_LEAK|hunter2|cat \.env|SECRETQ' "$OUT" && ok "no tool output or query secrets in the record" || no "leak"

# stop condition: fewer than half of the closed asks have an answer
jq '. + [range(5) | {id:("r-e00"+tostring),question:"q",status:"cancelled",ts:"2026-09-02T00:00:00Z"}]' \
  "$DR_CONSOLE/requests.json" > "$R/rq" && mv "$R/rq" "$DR_CONSOLE/requests.json"
[ "$(run)" = 4 ] && grep -q STOP "$R/err" && ok "exit 4 when under half of closed asks link" || no "stop condition: $(cat "$R/err")"

[ "$fail" = 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$fail"
