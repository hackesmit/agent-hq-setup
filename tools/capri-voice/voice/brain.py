"""Ollama chat with tools, streamed, timed. Stdlib only (http.client)."""
from __future__ import annotations

import http.client
import json
import time

from . import core

HOST, PORT = "127.0.0.1", 11434


def parse_stream(lines, t0: float, clock=time.perf_counter) -> dict:
    """Consume Ollama /api/chat NDJSON lines; time the first speakable piece.

    Returns text, calls (normalized), raw_calls, first_ms (first sentence or complete tool call), total_ms.
    """
    text, calls, raw, first_ms = "", [], [], None
    for line in lines:
        if not line.strip():
            continue
        msg = json.loads(line)
        if msg.get("error"):
            raise RuntimeError(msg["error"])
        m = msg.get("message") or {}
        for tc in m.get("tool_calls") or []:
            fn = tc.get("function") or {}
            args = fn.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = {"_raw": args}
            raw.append({"name": fn.get("name"), "arguments": args})
            calls.append(core.normalize(raw[-1]))
            if first_ms is None:
                first_ms = (clock() - t0) * 1000
        text += m.get("content") or ""
        if first_ms is None and not calls and core.first_sentence(text, done=bool(msg.get("done"))):
            first_ms = (clock() - t0) * 1000
        if msg.get("done"):
            break
    total_ms = (clock() - t0) * 1000
    return {"text": text.strip(), "calls": calls, "raw_calls": raw, "first_ms": first_ms if first_ms is not None else total_ms,
            "total_ms": total_ms}


def chat(model: str, user: str, *, tools=core.TOOLS, num_ctx: int = 2048, timeout: float = 60) -> dict:
    body = {
        "model": model,
        "stream": True,
        "keep_alive": -1,
        "options": {"temperature": 0, "num_ctx": num_ctx},
        "messages": [{"role": "system", "content": core.system_prompt()}, {"role": "user", "content": user}],
        "tools": tools,
    }
    conn = http.client.HTTPConnection(HOST, PORT, timeout=timeout)
    t0 = time.perf_counter()
    conn.request("POST", "/api/chat", body=json.dumps(body), headers={"Content-Type": "application/json"})
    resp = conn.getresponse()
    if resp.status != 200:
        raise RuntimeError(f"ollama {resp.status}: {resp.read()[:200]!r}")
    try:
        return parse_stream(_lines(resp), t0)
    finally:
        conn.close()


def _lines(resp):
    buf = b""
    while True:
        chunk = resp.read1(65536) if hasattr(resp, "read1") else resp.read(65536)
        if not chunk:
            break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            yield line.decode("utf-8")
    if buf.strip():
        yield buf.decode("utf-8")
