"""spotify_play (hq-63nvj.3): query parser and the CLI sequence, with a scripted spotify_cli."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hands import core, spotify  # noqa: E402

URI = "spotify:track:2JiDi0qAXsPwhPqA2qaKGt"
SEARCH = json.dumps({"tracks": [{"uri": URI, "name": "Bohemian Rhapsody", "artists": ["Queen"]}], "artists": []})
PLAYING = json.dumps({"currently_playing": {"description": "Bohemian Rhapsody - Queen", "uri": URI, "is_playing": True}})
PAUSED = json.dumps({"currently_playing": {"description": "x", "uri": URI, "is_playing": False}})
OTHER = json.dumps({"currently_playing": {"description": "x", "uri": "spotify:episode:e1", "is_playing": True}})
UP = (0, '{"running":true,"logged_in":true}', "")
STARTING = (0, '{"running":true,"logged_in":false}', "")
DOWN = (1, "", "Spotify desktop client is not running")


class Cli:
    """Scripted spotify_cli: each command name maps to a list of replies, the last one repeats."""

    def __init__(self, **script):
        self.script = {k: list(v) for k, v in script.items()}
        self.calls = []
        self.now = 0.0

    def __call__(self, args, timeout):
        self.calls.append(list(args))
        self.now += 0.2
        replies = self.script[args[0]]
        out = replies.pop(0) if len(replies) > 1 else replies[0]
        if isinstance(out, Exception):
            raise out
        return out

    def clock(self):
        return self.now

    def sleep(self, s):
        self.now += s

    def play(self, query="Bohemian Rhapsody Queen", **kw):
        return spotify.play(query, self, sleep=self.sleep, clock=self.clock, **kw)

    def names(self):
        return [c[0] for c in self.calls]


# ---- action parser ---------------------------------------------------------

def parse(body):
    return core.parse_action(json.dumps(body).encode())


def test_parser_accepts_query():
    assert parse({"action": "spotify_play", "query": "Bohemian Rhapsody Queen"}) == {
        "action": "spotify_play", "query": "Bohemian Rhapsody Queen"}


@pytest.mark.parametrize("body,status", [
    ({"action": "spotify_play"}, 400),
    ({"action": "spotify_play", "query": 5}, 400),
    ({"action": "spotify_play", "query": "   "}, 400),
    ({"action": "spotify_play", "query": "\x1b\x07"}, 400),
    ({"action": "spotify_play", "query": "x" * 201}, 400),
    ({"action": "spotify_play", "query": "- --"}, 400),
    ({"action": "spotify_play", "query": "song", "device": "Kitchen"}, 400),
])
def test_parser_refuses(body, status):
    with pytest.raises(core.Refused) as e:
        parse(body)
    assert e.value.status == status


def test_parser_cleans_query():
    got = parse({"action": "spotify_play", "query": "  Bohemian\tRhapsody\n\x1b[201~ Queen "})["query"]
    assert got == "Bohemian Rhapsody [201~ Queen"


def test_dash_inside_query_kept_leading_dash_dropped():
    assert parse({"action": "spotify_play", "query": "-- AC-DC Thunderstruck"})["query"] == "AC-DC Thunderstruck"
    assert parse({"action": "spotify_play", "query": "--help"})["query"] == "help"


def test_log_keeps_the_query():
    assert core.log_target({"action": "spotify_play", "query": "Bohemian Rhapsody"}) == "Bohemian Rhapsody"


# ---- play sequence ---------------------------------------------------------

def test_warm_play_searches_plays_and_confirms():
    cli = Cli(status=[UP], search=[(0, SEARCH, "")], play=[(0, "", "")], **{"now-playing": [(0, PLAYING, "")]})
    got = cli.play()
    assert cli.names() == ["status", "search", "play", "now-playing"]
    assert cli.calls[1] == ["search", "Bohemian Rhapsody Queen", "--type", "track", "--limit", "1", "--format", "json"]
    assert cli.calls[2] == ["play", URI]
    assert got["uri"] == URI and got["track"] == "Bohemian Rhapsody" and got["artists"] == ["Queen"]
    assert got["cold"] is False and got["playing"] is True and got["ms"] >= 0


def test_cold_start_opens_and_waits_for_login():
    cli = Cli(status=[DOWN, (1, "", "client connection failed"), STARTING, UP], open=[(0, "", "")],
              search=[(0, SEARCH, "")], play=[(0, "", "")], **{"now-playing": [(0, PLAYING, "")]})
    got = cli.play()
    assert cli.names() == ["status", "open", "status", "status", "status", "search", "play", "now-playing"]
    assert got["cold"] is True


def test_confirm_waits_until_our_track_plays():
    cli = Cli(status=[UP], search=[(0, SEARCH, "")], play=[(0, "", "")],
              **{"now-playing": [(0, OTHER, ""), (0, PAUSED, ""), (0, PLAYING, "")]})
    assert cli.play()["playing"] is True
    assert cli.names().count("now-playing") == 3


def test_never_starts_is_503():
    cli = Cli(status=[DOWN], open=[(0, "", "")])
    with pytest.raises(core.Refused) as e:
        cli.play(start_timeout=3)
    assert e.value.status == 503
    assert cli.names().count("open") == 1


def test_running_but_logged_out_is_503():
    cli = Cli(status=[STARTING])
    with pytest.raises(core.Refused) as e:
        cli.play(start_timeout=3)
    assert e.value.status == 503 and "log" in e.value.reason
    assert "open" not in cli.names()


def test_status_timeout_counts_as_not_ready():
    import subprocess
    cli = Cli(status=[subprocess.TimeoutExpired("spotify_cli", 5), UP], open=[(0, "", "")],
              search=[(0, SEARCH, "")], play=[(0, "", "")], **{"now-playing": [(0, PLAYING, "")]})
    assert cli.play()["playing"] is True


def test_no_track_found_is_404():
    cli = Cli(status=[UP], search=[(0, json.dumps({"tracks": []}), "")])
    with pytest.raises(core.Refused) as e:
        cli.play()
    assert e.value.status == 404
    assert "play" not in cli.names()


@pytest.mark.parametrize("reply", [(1, "", "boom"), (0, "not json", ""), (0, "[]", "")])
def test_search_failure_is_502(reply):
    cli = Cli(status=[UP], search=[reply])
    with pytest.raises(core.Refused) as e:
        cli.play()
    assert e.value.status == 502


def test_play_failure_is_502():
    cli = Cli(status=[UP], search=[(0, SEARCH, "")], play=[(1, "", "Premium required")])
    with pytest.raises(core.Refused) as e:
        cli.play()
    assert e.value.status == 502 and "Premium required" in e.value.reason


def test_unconfirmed_play_is_504():
    cli = Cli(status=[UP], search=[(0, SEARCH, "")], play=[(0, "", "")], **{"now-playing": [(0, OTHER, "")]})
    with pytest.raises(core.Refused) as e:
        cli.play(confirm_timeout=2)
    assert e.value.status == 504


def test_top_track_skips_entries_without_uri():
    data = json.dumps({"tracks": [{"name": "x"}, {"uri": URI, "name": "y", "artists": ["A"]}]})
    assert spotify.top_track(data)["uri"] == URI


def test_top_track_refuses_non_track_uri():
    data = json.dumps({"tracks": [{"uri": "https://evil", "name": "x"}]})
    assert spotify.top_track(data) is None
