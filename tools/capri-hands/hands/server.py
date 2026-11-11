"""HTTP front of Capri hands: 127.0.0.1 only, a token on every call, one action at a time.

POST /action  {"action": "...", ...}  -> 200 {"ok": true, ...} or an error status.
GET  /shot/<name>                     -> the PNG a screenshot action wrote.
The backend (win.Backend on George, a fake in tests) does the desktop work.
"""
from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import core


class HandsServer(ThreadingHTTPServer):
    """One thread per connection, so a client that connects and sends nothing (or a
    browser's preopened socket) never holds up other calls; self.lock still runs the
    desktop actions one at a time."""
    allow_reuse_address = False  # a second copy must fail to bind, not share the port
    allow_reuse_port = False
    daemon_threads = True

    def __init__(self, cfg: core.Config, backend, host: str = core.LOOPBACK):
        core.check_bind(host)
        self.cfg = cfg
        self.backend = backend
        self.lock = threading.Lock()
        super().__init__((host, cfg.port), Handler)


class Handler(BaseHTTPRequestHandler):
    server: HandsServer
    server_version = "capri-hands"
    sys_version = ""
    timeout = 10  # seconds a socket may sit idle mid-request before the thread drops it

    def log_message(self, *args):  # the stdlib access log would print paths; we keep our own log
        pass

    def _reply(self, status: int, payload: dict | None = None, *, body: bytes | None = None, ctype="application/json"):
        data = body if body is not None else json.dumps(payload or {}).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def _refuse(self, err: core.Refused, action: str | None = None):
        core.log_line(self.server.cfg.log_file, action=action, ok=False, status=err.status, reason=err.reason)
        self._reply(err.status, {"ok": False, "error": err.reason})

    def _gate(self) -> str | None:
        try:
            return core.check_request(
                path=self.path, headers=self.headers,
                expected_token=core.read_token(self.server.cfg.token_file),
            )
        except core.Refused as err:
            self._refuse(err)
            return None

    def do_POST(self):
        path = self._gate()
        if path is None:
            return
        if path != "/action":
            return self._refuse(core.Refused(404, "unknown path"))
        try:
            n = core.body_length(self.headers)
            action = core.parse_action(self.rfile.read(n))
        except core.Refused as err:
            return self._refuse(err)
        name = action["action"]
        t0 = time.monotonic()
        try:
            with self.server.lock:
                result = self.server.backend.run(action)
        except core.Refused as err:
            return self._refuse(err, name)
        except Exception as err:  # noqa: BLE001 - report, never crash the server
            core.log_line(self.server.cfg.log_file, action=name, target=core.log_target(action), ok=False,
                          error=type(err).__name__)
            return self._reply(500, {"ok": False, "error": f"{type(err).__name__}: {err}"})
        ms = int((time.monotonic() - t0) * 1000)
        core.log_line(self.server.cfg.log_file, action=name, target=core.log_target(action), ok=True, ms=ms)
        self._reply(200, {"ok": True, **(result or {})})

    def do_GET(self):
        path = self._gate()
        if path is None:
            return
        name = path.removeprefix("/shot/")
        if name == path or not core.SHOT_NAME.match(name):
            return self._refuse(core.Refused(404, "unknown path"))
        try:
            data = (self.server.cfg.shots / name).read_bytes()
        except OSError:
            return self._refuse(core.Refused(404, "no such shot"))
        self._reply(200, body=data, ctype="image/png")

    def _no(self):
        if self._gate() is not None:
            self._refuse(core.Refused(405, "method refused"))

    do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = _no
