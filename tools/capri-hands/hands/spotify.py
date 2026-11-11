"""spotify_play: play a named song in George's Spotify desktop app (hq-63nvj.3).

Path: spotify_cli.exe, the command line Spotify ships inside its Store package (an app
execution alias in %LOCALAPPDATA%\\Microsoft\\WindowsApps). It talks to the running
desktop client, so no Web API app, no OAuth token and no UI automation. It only reaches
the client from the owner's interactive session (from ssh: "client connection failed"
after 19 s), which is where hands runs.

Measured 2026-11-04 on George: warm search plus play plus confirm 0.96 s; cold (app
closed) open, login, search, play, confirm 3.3 s.

Pure except runner(): the sequence takes an injected run(args, timeout) so tests script it.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time

from . import core

CLI = r"%LOCALAPPDATA%\Microsoft\WindowsApps\spotify_cli.exe"
MAX_QUERY = 200
CREATE_NO_WINDOW = 0x08000000
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def clean_query(query: str) -> str:
    """Spoken text -> one search line: whitespace collapsed, control characters dropped,
    leading dashes dropped so the CLI never reads the query as a flag."""
    q = " ".join(_CONTROL.sub("", " ".join(query.split())).split())
    q = q.lstrip("- ")
    if not q:
        raise core.Refused(400, "empty query")
    if len(q) > MAX_QUERY:
        raise core.Refused(400, f"query over {MAX_QUERY} characters")
    return q


def _json(text: str):
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def top_track(stdout: str) -> dict | None:
    """The first search hit with a spotify:track: uri, or None."""
    data = _json(stdout)
    if not isinstance(data, dict) or not isinstance(data.get("tracks"), list):
        return None
    for t in data["tracks"]:
        if isinstance(t, dict) and isinstance(t.get("uri"), str) and t["uri"].startswith("spotify:track:"):
            return t
    return None


def _ready(reply) -> tuple[bool, bool]:
    """(running, logged_in) from a status reply; any failure counts as not running."""
    if reply is None:
        return False, False
    rc, out, _ = reply
    data = _json(out) if rc == 0 else None
    if not isinstance(data, dict):
        return False, False
    return bool(data.get("running")), bool(data.get("logged_in"))


def _playing(reply, uri: str) -> bool:
    if reply is None or reply[0] != 0:
        return False
    data = _json(reply[1])
    cur = data.get("currently_playing") if isinstance(data, dict) else None
    return isinstance(cur, dict) and cur.get("uri") == uri and cur.get("is_playing") is True


def play(query: str, run, *, sleep=time.sleep, clock=time.monotonic,
         start_timeout: float = 15.0, confirm_timeout: float = 3.0, poll: float = 0.1) -> dict:
    """Start Spotify if needed, search the top track, play it, confirm it plays.
    Refused: 503 app never ready, 404 no track, 502 search or play failed, 504 not confirmed."""

    def call(args, timeout):
        try:
            return run(args, timeout)
        except subprocess.TimeoutExpired:
            return None

    t0 = clock()
    cold = False
    running, logged_in = _ready(call(["status", "--format", "json"], 5))
    if not logged_in:
        if not running:
            call(["open"], 10)
            cold = True
        deadline = clock() + start_timeout
        while not logged_in:
            if clock() >= deadline:
                raise core.Refused(503, "spotify is running but not logged in" if running
                                   else "spotify did not start")
            sleep(poll)
            running, logged_in = _ready(call(["status", "--format", "json"], 3))

    found = call(["search", query, "--type", "track", "--limit", "1", "--format", "json"], 10)
    if found is None or found[0] != 0 or not isinstance(_json(found[1]), dict):
        raise core.Refused(502, "spotify search failed: " + (found[2].strip()[:200] if found else "timeout"))
    track = top_track(found[1])
    if track is None:
        raise core.Refused(404, "no song found")
    uri = track["uri"]

    done = call(["play", uri], 10)
    if done is None or done[0] != 0:
        raise core.Refused(502, "spotify play failed: " + (done[2].strip()[:200] if done else "timeout"))

    deadline = clock() + confirm_timeout
    while not _playing(call(["now-playing", "--format", "json"], 3), uri):
        if clock() >= deadline:
            raise core.Refused(504, "spotify did not start the song")
        sleep(poll)
    artists = track.get("artists")
    return {"track": track.get("name"), "artists": artists if isinstance(artists, list) else [], "uri": uri,
            "cold": cold, "playing": True, "ms": int((clock() - t0) * 1000)}


def runner(cli: str = CLI):
    """The real run(args, timeout) on George: no console window, UTF-8 output."""
    exe = os.path.expandvars(cli)

    def run(args, timeout):
        p = subprocess.run([exe, *args], capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=timeout, creationflags=CREATE_NO_WINDOW)
        return p.returncode, p.stdout, p.stderr

    return run
