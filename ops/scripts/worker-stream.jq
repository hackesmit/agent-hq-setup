# Render `claude -p --output-format stream-json` events as human-readable lines.
# Used by spawn.sh worker launch scripts so the tmux pane shows live activity
# instead of sitting blank until the run ends. Input is raw lines (jq -R):
# non-JSON lines (e.g. claude stderr merged in) pass through verbatim.
def clip($n): tostring | gsub("\\s+"; " ") | if length > $n then .[0:$n] + " ..." else . end;
(fromjson? // {type: "raw", raw: .}) |
if .type == "raw" then .raw
elif .type == "system" and .subtype == "init" then
  "[start] model " + (.model // "?") + "  session " + (.session_id // "?")
elif .type == "assistant" then
  ((.message.content // [])[]
   | if .type == "tool_use" then "[" + .name + "] " + (.input | clip(160))
     elif .type == "text" then .text
     elif .type == "thinking" then "[think] " + (.thinking | clip(120))
     else empty
     end)
elif .type == "result" then
  "",
  "[" + (.subtype // "result") + "] " + (((.duration_ms // 0) / 1000) | round | tostring) + "s  cost $" + ((.total_cost_usd // 0) | tostring | .[0:6]),
  ((.result // "") | tostring)
else empty
end
