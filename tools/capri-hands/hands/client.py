"""Client for ssh use: `python -m hands call -` reads one JSON action on stdin and prints the reply."""
from __future__ import annotations

import http.client
import sys

from . import core


def request(cfg: core.Config, method: str, path: str, body: bytes | None = None, timeout: float = 600):
    token = core.read_token(cfg.token_file)
    if not token:
        raise SystemExit(f"no token in {cfg.token_file}: run python -m hands init")
    conn = http.client.HTTPConnection(core.LOOPBACK, cfg.port, timeout=timeout)
    headers = {core.TOKEN_HEADER: token}
    if body is not None:
        headers["Content-Type"] = "application/json"
    try:
        conn.request(method, path, body=body, headers=headers)
        resp = conn.getresponse()
        return resp.status, resp.read()
    except ConnectionRefusedError:
        raise SystemExit(f"hands is not running on {core.LOOPBACK}:{cfg.port}") from None
    finally:
        conn.close()


def call(cfg: core.Config, arg: str) -> int:
    raw = sys.stdin.buffer.read() if arg == "-" else arg.encode("utf-8")
    status, data = request(cfg, "POST", "/action", raw)
    sys.stdout.write(data.decode("utf-8", "replace") + "\n")
    return 0 if status == 200 else 1


def get(cfg: core.Config, name: str, out: str | None) -> int:
    status, data = request(cfg, "GET", "/shot/" + name)
    if status != 200:
        sys.stderr.write(data.decode("utf-8", "replace") + "\n")
        return 1
    if out:
        with open(out, "wb") as f:
            f.write(data)
    else:
        sys.stdout.buffer.write(data)
    return 0
