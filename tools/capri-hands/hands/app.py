"""Entry points: serve, init, call, get."""
from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys

from . import core

USAGE = """usage: python -m hands serve | init [--rotate] | call <json|-> | get <shot-name> [out.png]"""


def config() -> core.Config:
    home = core.home()
    cfg = core.Config(home=home)
    try:  # %LOCALAPPDATA%\\capri-hands\\hands.json may set {"port": N}
        extra = json.loads((home / "hands.json").read_text(encoding="utf-8"))
        cfg.port = int(extra.get("port", cfg.port))
    except (OSError, ValueError):
        pass
    return cfg


def init(cfg: core.Config, rotate: bool = False) -> int:
    """Write the token once, readable only by the current user (icacls drops inherited ACEs)."""
    cfg.home.mkdir(parents=True, exist_ok=True)
    if core.read_token(cfg.token_file) and not rotate:
        print(f"token exists: {cfg.token_file}")
        return 0
    cfg.token_file.write_text(secrets.token_urlsafe(32), encoding="ascii")
    if os.name == "nt":
        user = os.environ["USERNAME"]
        for target in (cfg.home, cfg.token_file):
            subprocess.run(["icacls", str(target), "/inheritance:r", "/grant:r", f"{user}:(OI)(CI)F"
                            if target == cfg.home else f"{user}:F"], check=True, capture_output=True)
    else:
        os.chmod(cfg.token_file, 0o600)
    print(f"token written: {cfg.token_file}")
    return 0


def bind(make, tries: int = 48, wait: float = 5.0, sleep=None):
    """Windows keeps the port in TIME_WAIT for about 2 minutes after the last calls; a
    restart retries the bind rather than set SO_REUSEADDR, which on Windows lets another
    process take the port over."""
    import time

    sleep = sleep or time.sleep
    for i in range(tries):
        try:
            return make()
        except OSError:
            if i == tries - 1:
                raise
            sleep(wait)


def serve(cfg: core.Config) -> int:
    from .server import HandsServer
    from .win import Backend

    cfg.home.mkdir(parents=True, exist_ok=True)
    srv = bind(lambda: HandsServer(cfg, Backend(cfg)))
    core.log_line(cfg.log_file, action="start", ok=True, port=cfg.port,
                  token=bool(core.read_token(cfg.token_file)))
    srv.serve_forever()
    return 0


def main(argv: list[str] | None = None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    cfg = config()
    cmd = argv[0] if argv else ""
    if cmd == "serve":
        rc = serve(cfg)
    elif cmd == "init":
        rc = init(cfg, rotate="--rotate" in argv)
    elif cmd == "call" and len(argv) == 2:
        from .client import call
        rc = call(cfg, argv[1])
    elif cmd == "get" and len(argv) in (2, 3):
        from .client import get
        rc = get(cfg, argv[1], argv[2] if len(argv) == 3 else None)
    else:
        print(USAGE, file=sys.stderr)
        rc = 2
    sys.exit(rc)
