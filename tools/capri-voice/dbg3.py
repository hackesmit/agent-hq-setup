import sys, json, http.client
sys.path.insert(0, r"C:\Users\owner\capri-voice")
from voice import core
def fn(name, desc, props, req):
    return {"type": "function", "function": {"name": name, "description": desc, "parameters": {"type": "object", "properties": props, "required": req}}}
flat = [
 fn("open_app", "Open a program on the owner's PC by name.", {"name": {"type": "string", "description": "program name, e.g. Spotify"}}, ["name"]),
 fn("open_url", "Open a web page.", {"url": {"type": "string", "description": "full https URL"}}, ["url"]),
 fn("media", "Control music and volume.", {"command": {"type": "string", "enum": core.MEDIA_COMMANDS}}, ["command"]),
] + core.TOOLS[1:]
for m in ("qwen2.5:7b-instruct-q4_K_M", "llama3.2:3b-instruct-q4_K_M"):
    for p in core.PHRASES:
        body = {"model": m, "stream": False, "options": {"temperature": 0, "num_ctx": 2048},
            "messages": [{"role": "system", "content": core.system_prompt()}, {"role": "user", "content": p["text"]}], "tools": flat}
        c = http.client.HTTPConnection("127.0.0.1", 11434, timeout=60)
        c.request("POST", "/api/chat", body=json.dumps(body)); r = json.loads(c.getresponse().read())
        msg = r["message"]
        calls = [(t["function"]["name"], t["function"]["arguments"]) for t in msg.get("tool_calls") or []]
        print(m[:5], p["id"], calls, repr(msg.get("content",""))[:80], r["eval_count"], round(r["total_duration"]/1e6))
