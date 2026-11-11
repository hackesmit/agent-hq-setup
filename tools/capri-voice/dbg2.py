import sys, json, http.client, copy
sys.path.insert(0, r"C:\Users\owner\capri-voice")
from voice import core
tools = copy.deepcopy(core.TOOLS); del tools[0]["function"]["parameters"]["properties"]["action"]["enum"]
for name, t in (("noenum", tools),):
    for m in ("qwen2.5:7b-instruct-q4_K_M", "llama3.2:3b-instruct-q4_K_M"):
      for txt in ("Abre Spotify.", "Pausa la música.", "Sube el volumen."):
        body = {"model": m, "stream": False, "options": {"temperature": 0, "num_ctx": 2048},
            "messages": [{"role": "system", "content": core.system_prompt()}, {"role": "user", "content": txt}], "tools": t}
        c = http.client.HTTPConnection("127.0.0.1", 11434, timeout=60)
        c.request("POST", "/api/chat", body=json.dumps(body)); r = json.loads(c.getresponse().read())
        print(name, m[:5], txt, json.dumps(r["message"], ensure_ascii=False)[:300], r["eval_count"])
# raw view of what qwen produces with enum
body = {"model": "qwen2.5:7b-instruct-q4_K_M", "stream": False, "raw": True, "options": {"temperature": 0},
        "prompt": "<|im_start|>system\n" + core.system_prompt() + "\n\n# Tools\n\n<tools>\n" + "\n".join(json.dumps(x["function"]) for x in core.TOOLS) + "\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags.<|im_end|>\n<|im_start|>user\nAbre Spotify.<|im_end|>\n<|im_start|>assistant\n"}
c = http.client.HTTPConnection("127.0.0.1", 11434, timeout=60)
c.request("POST", "/api/generate", body=json.dumps(body)); print("RAW", json.loads(c.getresponse().read())["response"])
