"""Fetch every sent message of both accounts into state/voice/sent-<account>.jsonl.

One record per message: headers we need, the owner's own text, and the quoted
part (capped) for blind tests. The file is written once, at the end, by
rename: a failed fetch raises and leaves the previous file as it was.
"""

import email
import email.policy
import imaplib
import re
import sys
from email.header import decode_header, make_header
from email.utils import parseaddr, parsedate_to_datetime
from pathlib import Path

from . import paths, text

QUOTE_CAP = 4000
# Text parts come before attachments, so the first 256 KB of a message hold
# everything we keep (own text is capped far below that) at a fraction of
# the transfer; a cut attachment part is simply ignored by the parser.
IMAP_PARTIAL = 262144
OWN_CAP = 12000


def _hdr(get, name):
    v = get(name)
    if not v:
        return ""
    try:  # RFC 2047 words (=?UTF-8?Q?...?=) from IMAP; Gmail API values come decoded
        return str(make_header(decode_header(str(v)))).strip()
    except (ValueError, LookupError, UnicodeError):
        return str(v).strip()


def record(account, msg_id, get, plain, html, labels=()):
    """Normalize one message. get(name) returns a header value or None."""
    own, quoted = text.own_text(plain, html)
    date = _hdr(get, "Date")
    try:
        dt = parsedate_to_datetime(date)
        iso, year = dt.isoformat(), dt.year
    except (TypeError, ValueError, IndexError):
        iso, year = "", 0
    mid = _hdr(get, "Message-ID")
    m = re.search(r"@([^>\s]+)>?\s*$", mid)
    return {
        "account": account, "id": msg_id, "message_id": mid,
        "mid_domain": re.sub(r"^[^.]*\d[^.]*\.", "", m.group(1).lower()) if m else "",
        "mailer": (_hdr(get, "X-Mailer") or _hdr(get, "User-Agent"))[:60],
        "date": iso, "year": year,
        "from": parseaddr(_hdr(get, "From"))[1].lower(),
        "to": text.addresses(_hdr(get, "To")), "cc": text.addresses(_hdr(get, "Cc")),
        "subject": _hdr(get, "Subject")[:300],
        "in_reply_to": bool(_hdr(get, "In-Reply-To")),
        "auto": _hdr(get, "Auto-Submitted") not in ("", "no") or bool(_hdr(get, "X-Autoreply")),
        "draft": "DRAFT" in labels,
        "own": own[:OWN_CAP], "quoted": quoted[:QUOTE_CAP],
    }


def fetch_personal(log=print):
    sys.path.insert(0, str(paths.HQ / "ops" / "mail"))
    from hq_mail import config  # the HQ Mail login is owner@example.com's app password

    M = imaplib.IMAP4_SSL(config.IMAP_HOST)
    M.login(config.GMAIL_ADDR, config.secret(config.PP_ITEM_MAIL))
    try:
        typ, _ = M.select('"[Gmail]/Sent Mail"', readonly=True)
        if typ != "OK":
            raise RuntimeError("cannot open [Gmail]/Sent Mail")
        typ, d = M.uid("SEARCH", None, "ALL")
        uids = d[0].split()
        out = []
        for i in range(0, len(uids), 100):
            chunk = uids[i:i + 100]
            typ, data = M.uid("FETCH", b",".join(chunk), "(BODY.PEEK[]<0.%d>)" % IMAP_PARTIAL)
            if typ != "OK":
                raise RuntimeError("IMAP fetch failed at %d" % i)
            got = [p for p in data if isinstance(p, tuple)]
            if len(got) != len(chunk):
                raise RuntimeError("IMAP returned %d of %d messages" % (len(got), len(chunk)))
            for meta, raw in got:
                uid = re.search(rb"UID (\d+)", meta).group(1).decode()
                msg = email.message_from_bytes(raw, policy=email.policy.compat32)
                plain, html = text.bodies_from_email(msg)
                out.append(record(paths.PERSONAL, "imap:" + uid, msg.get, plain, html))
            log("personal: %d/%d" % (len(out), len(uids)))
    finally:
        try:
            M.logout()
        except Exception:
            pass
    return out


def fetch_work(log=print, proxy_cls=None):
    from .n8n_gmail import GET_BATCH, WorkProxy

    out = []
    with (proxy_cls or WorkProxy)() as px:
        ids = px.list_sent_ids()
        log("work: %d sent ids" % len(ids))
        for i in range(0, len(ids), GET_BATCH):
            for m in px.get(ids[i:i + GET_BATCH]):
                hdrs = {}
                for h in (m.get("payload") or {}).get("headers") or []:
                    hdrs.setdefault(h["name"].lower(), h["value"])
                plain, html = text.bodies_from_gmail(m["payload"])
                out.append(record(paths.WORK, "gmail:" + m["id"], lambda n: hdrs.get(n.lower()),
                                  plain, html, labels=m.get("labelIds") or ()))
            if (i // GET_BATCH) % 10 == 0:
                log("work: %d/%d" % (len(out), len(ids)))
    if len(out) != len(ids):
        raise RuntimeError("work: fetched %d of %d" % (len(out), len(ids)))
    return out


def sent_path(account):
    return paths.state_dir() / ("sent-%s.jsonl" % account)


def main(argv):
    which = argv or [paths.PERSONAL, paths.WORK]
    for acct in which:
        rows = (fetch_personal if acct == paths.PERSONAL else fetch_work)()
        paths.write_jsonl(sent_path(acct), rows)
        print("%s: wrote %d records" % (acct, len(rows)))


if __name__ == "__main__":
    main(sys.argv[1:])
