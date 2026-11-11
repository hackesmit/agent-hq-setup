import sys, json, http.client
sys.path.insert(0, r"C:\Users\owner\capri-voice")
from voice import core
for stream in (False, True):
    body = {"model": "qwen2.5:7b-instruct-q4_K_M", "stream": stream, "options": {"temperature": 0, "num_ctx": 2048},
            "messages": [{"role": "system", "content": core.system_prompt()}, {"role": "user", "content": "Abre Spotify."}], "tools": core.TOOLS}
    c = http.client.HTTPConnection("127.0.0.1", 11434, timeout=60)
    c.request("POST", "/api/chat", body=json.dumps(body)); r = c.getresponse().read().decode()
    print("STREAM" if stream else "NOSTREAM", r[:1500])
