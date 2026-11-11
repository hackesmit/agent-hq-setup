"""POST /api/capri to the HQ console, with no stored secret.

The console accepts a POST only with the per-boot X-Console-Key, which it puts
in the page it serves. George is the owner's own tailnet device, so the console's
tailscale whois gate already admits it; the listener reads the key from the page
the same way a browser tab does, keeps it in memory only, and fetches it again
after a console restart (403 with reload).
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Callable, Optional

from .core import boot_key

Opener = Callable[[urllib.request.Request, float], tuple]


def _open(req: urllib.request.Request, timeout: float) -> tuple:
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


LOST = {"ok": False, "status": "lost"}  # a post went out and no answer came back


class Console:
    def __init__(self, base_url: str, opener: Opener = _open, timeout: float = 5.0):
        self.base = base_url.rstrip("/")
        self.opener = opener
        self.timeout = timeout
        self.key: Optional[str] = None

    def refresh_key(self) -> Optional[str]:
        status, body = self.opener(urllib.request.Request(self.base + "/"), self.timeout)
        self.key = boot_key(body) if status == 200 else None
        return self.key

    def post(self, event: str, **fields) -> Optional[dict]:
        """The JSON reply; {"ok": False, "status": N} for a non-200; None when the
        console was never reached (nothing typed); {"ok": False, "status": "lost"}
        when the post went out and no answer came back (it may have been typed).
        fields ride along (say: text, transcriptId)."""
        for attempt in range(2):
            try:
                if not self.key and not self.refresh_key():
                    return None
                req = urllib.request.Request(
                    self.base + "/api/capri",
                    data=json.dumps({"event": event, **fields}).encode(),
                    headers={"content-type": "application/json", "x-console-key": self.key},
                    method="POST",
                )
            except (OSError, ValueError):
                return None
            try:
                status, body = self.opener(req, self.timeout)
            except urllib.error.URLError:
                return None  # urlopen wraps every failure before the request was sent
            except OSError:
                return dict(LOST)  # unwrapped: the request went out, the answer did not come back
            if status == 403 and attempt == 0:
                self.key = None  # the console restarted: new boot key
                continue
            if status != 200:
                return {"ok": False, "status": status}
            try:
                return json.loads(body)
            except ValueError:
                return dict(LOST)
        return None
