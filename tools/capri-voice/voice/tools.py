"""Run a tool call: hands goes to the capri-hands daemon on 127.0.0.1; the other two are stubs (spike)."""
from __future__ import annotations

import http.client
import json
import os
import time
from pathlib import Path

from . import core

HANDS_PORT = 47615
TOKEN_HEADER = "X-Hands-Token"


def _token_file() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".local" / "share")
    return Path(base) / "capri-hands" / "token"


def hands(body: dict, timeout: float = 10) -> dict:
    token = _token_file().read_text(encoding="utf-8").strip()
    conn = http.client.HTTPConnection("127.0.0.1", HANDS_PORT, timeout=timeout)
    raw = json.dumps(body).encode("utf-8")
    try:
        conn.request("POST", "/action", body=raw, headers={TOKEN_HEADER: token, "Content-Type": "application/json"})
        resp = conn.getresponse()
        data = json.loads(resp.read() or b"{}")
        data.setdefault("ok", resp.status == 200)
        return data
    finally:
        conn.close()


def run(call: dict, *, dry: bool = True, hands_fn=hands) -> tuple[dict, float]:
    """Execute one normalized call; returns (result, ms). dry=True never touches the desktop."""
    t0 = time.perf_counter()
    name, args = call.get("name"), call.get("arguments") or {}
    if name in core.HANDS_TOOLS:
        body = core.hands_body(call)
        if body is None:
            result = {"ok": False, "error": f"cannot run {name} {args}"}
        else:
            result = {"ok": True, "dry": True, "body": body} if dry else hands_fn(body)
    elif name == "ask_orchestrator":
        result = {"ok": True, "reply": "on it"}
    elif name == "status":
        result = {"ok": True, "workers": 3, "asks": 1}
    else:
        result = {"ok": False, "error": f"unknown tool {name}"}
    return result, (time.perf_counter() - t0) * 1000
