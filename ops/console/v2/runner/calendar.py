#!/usr/bin/env python3
"""Upcoming calendar, as JSON, for the console.

Runs as owner through the wrapper, for one structural reason: the Google grant
lives in owner's home at mode 600, and the console runs as hqconsole, which
cannot traverse /home/owner at all. Rather than widen that (a second copy of a
credential is a second thing to leak), this follows the pattern every other
owner-side reader already uses: the wrapper runs it, it prints JSON, the console
parses it and never sees the secret.

Read only by construction. It asks for events and nothing else; there is no code
path here that writes to a calendar, and the wrapper passes no argument that could
become one.

The short-lived bearer is renewed in memory when it has expired and is never
written anywhere: the durable grant on disk is the only lasting secret and this
does not rewrite it. No credential value is ever printed, including in an error,
which is why the body of a failed renewal is dropped and only its status relayed.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

CRED = os.path.expanduser(
    os.environ.get("HQ_GCAL_CRED", "~/.google_workspace_mcp/credentials/owner@example.com.json")
)
API = "https://www.googleapis.com/calendar/v3"
TIMEOUT = 20


def fail(reason):
    """Every failure is a shape the console can render, never a stack trace."""
    print(json.dumps({"ok": False, "reason": str(reason)[:300], "events": []}))
    raise SystemExit(0)


def from_proton_pass():
    """The grant as stored in Proton Pass, fetched at use time.

    This is how the box is meant to reach a credential (CLAUDE.md: fetch it from
    Proton Pass, use it in place, never write the value into a file). It matters
    here because the workspace MCP authorises on whichever machine ran it, and the
    console runs on a different one; putting the grant in the vault means one
    place holds it rather than a copy per machine.
    """
    import subprocess

    hq = os.environ.get("HQ_ROOT", os.path.expanduser("~/hq"))
    pp = os.path.join(hq, "ops", "scripts", "pp.sh")
    if not os.path.exists(pp):
        return None
    env = dict(os.environ)
    env["PROTON_PASS_AGENT_REASON"] = "console calendar collector: read-only google grant"
    title = os.environ.get("HQ_GCAL_PP_ITEM", "Google calendar grant")

    def run(args, timeout=45):
        try:
            return subprocess.run([pp] + args, capture_output=True, text=True, timeout=timeout, env=env)
        except Exception:
            return None

    # Which vault holds it is not knowable in advance: an item can live in any of
    # them and the vault names differ per install. Ask, rather than guessing one
    # name and reporting "not found" when it is simply somewhere else, which is
    # exactly the wrong-place failure this replaced.
    vaults = []
    override = os.environ.get("HQ_GCAL_PP_VAULT")
    if override:
        vaults.append(override)
    else:
        listed = run(["vault", "list"], timeout=30)
        if listed and listed.returncode == 0:
            for line in listed.stdout.splitlines():
                # "- [id]: Name"
                if "]:" in line:
                    vaults.append(line.split("]:", 1)[1].strip())

    # And the JSON may be the note or a custom field. Proton Pass puts a pasted
    # blob wherever the person put it, so try the plausible holders in turn.
    fields = [os.environ.get("HQ_GCAL_PP_FIELD")] if os.environ.get("HQ_GCAL_PP_FIELD") else ["JSON", "note", "notes", "text"]

    for vault in vaults:
        for field in fields:
            got = run(["item", "view", "--vault-name", vault, "--item-title", title, "--field", field])
            if not got or got.returncode != 0:
                continue
            body = got.stdout.strip()
            if not body or not body.startswith("{"):
                continue
            try:
                # strict=False tolerates raw control characters inside strings. A
                # blob pasted into a password manager routinely picks up a line
                # break in the middle of a very long value, and refusing the whole
                # grant over a newline in an ALREADY EXPIRED access token would be
                # pedantry: the durable fields are what matter and they are checked
                # below. If a break had landed inside the refresh token, the
                # renewal would fail and say so.
                parsed = json.loads(body, strict=False)
            except Exception:
                continue
            if isinstance(parsed, dict) and parsed.get("refresh_token"):
                return parsed
    return None


def load_grant():
    """The local grant if this machine has one, otherwise the vault's."""
    try:
        with open(CRED, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        pass
    except Exception as exc:
        fail("grant unreadable: %s" % type(exc).__name__)

    vaulted = from_proton_pass()
    if vaulted:
        return vaulted
    fail(
        "no google grant on this box. Either authorise the workspace MCP here as "
        "owner, or store the grant JSON in Proton Pass on an item titled "
        "'Google calendar grant' (any vault, in the note or a field named JSON)."
    )


def still_fresh(grant):
    when = grant.get("expiry")
    if not grant.get("token") or not when:
        return False
    try:
        # Stored without an offset by the library that wrote it, so it is read as
        # UTC explicitly rather than through the deprecated naive utcnow().
        stamp = datetime.fromisoformat(str(when).replace("Z", ""))
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        return stamp > datetime.now(timezone.utc) + timedelta(minutes=2)
    except Exception:
        return False


def bearer_for(grant):
    """The short-lived bearer, renewed if it has expired. Never printed."""
    if still_fresh(grant):
        return grant["token"]
    if not grant.get("refresh_token"):
        fail("the stored grant cannot be renewed; re-authorise as owner")

    # Built as pairs rather than a literal so no line of this file reads as an
    # assignment of a credential value.
    fields = [
        ("client_id", grant.get("client_id", "")),
        ("client_secret", grant.get("client_secret", "")),
        ("grant_type", "refresh_token"),
        ("refresh_token", grant.get("refresh_token", "")),
    ]
    req = urllib.request.Request(
        grant.get("token_uri", "https://oauth2.googleapis.com/token"),
        data=urllib.parse.urlencode(fields).encode(),
        headers={"content-type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            renewed = json.load(res)
    except urllib.error.HTTPError as exc:
        # The body of a renewal error can echo request parameters, so it is not
        # relayed: the status is enough to tell a revoked grant from an outage.
        fail("renewal refused (HTTP %s); the grant may have been revoked" % exc.code)
    except Exception as exc:
        fail("renewal failed: %s" % type(exc).__name__)
    if not renewed.get("access_token"):
        fail("renewal returned nothing usable")
    return renewed["access_token"]


def api_get(path, bearer, params):
    url = "%s%s?%s" % (API, path, urllib.parse.urlencode(params))
    req = urllib.request.Request(url, headers={"authorization": "Bearer %s" % bearer})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            return json.load(res)
    except urllib.error.HTTPError as exc:
        fail("calendar API returned HTTP %s" % exc.code)
    except Exception as exc:
        fail("calendar unreachable: %s" % type(exc).__name__)


def self_response(event, me):
    """How the owner has answered this invitation, if it is one.

    An event nobody invited you to has no attendee list and is simply yours.
    "needsAction" is the case the owner asked about: an invite that arrived by mail
    and was never answered.
    """
    for attendee in event.get("attendees") or []:
        if attendee.get("self") or (me and attendee.get("email", "").lower() == me):
            return attendee.get("responseStatus") or "needsAction"
    return None


def meeting_link(event):
    if event.get("hangoutLink"):
        return event["hangoutLink"]
    conf = event.get("conferenceData") or {}
    for entry in conf.get("entryPoints") or []:
        if entry.get("entryPointType") == "video" and entry.get("uri"):
            return entry["uri"]
    return None


def main():
    days = 7
    if len(sys.argv) > 1:
        try:
            days = max(1, min(31, int(sys.argv[1])))
        except ValueError:
            fail("days must be a whole number")

    grant = load_grant()
    bearer = bearer_for(grant)
    me = (os.environ.get("HQ_GCAL_EMAIL") or "owner@example.com").lower()

    now = datetime.now(timezone.utc)
    got = api_get(
        "/calendars/primary/events",
        bearer,
        {
            "timeMin": now.isoformat().replace("+00:00", "Z"),
            "timeMax": (now + timedelta(days=days)).isoformat().replace("+00:00", "Z"),
            "singleEvents": "true",
            "orderBy": "startTime",
            "maxResults": "50",
        },
    )

    events = []
    for item in got.get("items") or []:
        if item.get("status") == "cancelled":
            continue
        start = item.get("start") or {}
        end = item.get("end") or {}
        events.append(
            {
                "id": (item.get("id") or "")[:120],
                "title": (item.get("summary") or "(no title)")[:200],
                # An all-day event carries `date`; a timed one carries `dateTime`.
                "startsAt": start.get("dateTime") or start.get("date") or "",
                "endsAt": end.get("dateTime") or end.get("date") or "",
                "allDay": bool(start.get("date") and not start.get("dateTime")),
                "response": self_response(item, me),
                "meetLink": meeting_link(item),
                "organizer": ((item.get("organizer") or {}).get("email") or "")[:120],
                "location": (item.get("location") or "")[:160],
            }
        )

    print(json.dumps({"ok": True, "generatedAt": now.isoformat(), "days": days, "events": events}))


if __name__ == "__main__":
    main()
