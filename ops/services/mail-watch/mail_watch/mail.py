"""One Gmail API message (format=full) to a compact record, and the reply MIME.

The record keeps sender, date, subject, the owner-facing plain text with the
quoted history cut off (voice.text), and attachment names only.
"""

import base64
import re
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formataddr, getaddresses, parseaddr, parsedate_to_datetime

from . import config  # noqa: F401  (puts the voice package on sys.path)
from voice import text  # noqa: E402

KEEP_HEADERS = ("from", "to", "cc", "reply-to", "subject", "date", "message-id", "references",
                "in-reply-to", "list-unsubscribe", "list-id", "precedence", "auto-submitted")


def headers_of(payload):
    out = {}
    for h in (payload or {}).get("headers") or []:
        k = (h.get("name") or "").lower()
        if k in KEEP_HEADERS and k not in out:
            out[k] = h.get("value") or ""
    return out


def attachment_names(payload):
    names = []

    def walk(p):
        fn = p.get("filename")
        if fn:
            names.append(fn)
        for c in p.get("parts") or []:
            walk(c)

    walk(payload or {})
    return names


def when(msg, hdr):
    ms = msg.get("internalDate")
    if ms:
        return datetime.fromtimestamp(int(ms) / 1000, timezone.utc)
    try:
        return parsedate_to_datetime(hdr.get("date", ""))
    except (TypeError, ValueError):
        return datetime.now(timezone.utc)


def parse(msg):
    payload = msg.get("payload") or {}
    hdr = headers_of(payload)
    plain, html = text.bodies_from_gmail(payload)
    own, quoted = text.own_text(plain, html)
    name, addr = parseaddr(hdr.get("from", ""))
    truncated = len(own) > config.TEXT_CAP
    return {
        "id": msg["id"],
        "thread": msg.get("threadId") or msg["id"],
        "labels": msg.get("labelIds") or [],
        "date": when(msg, hdr).isoformat(timespec="minutes"),
        "from_name": name or addr,
        "from_addr": addr.lower(),
        "to": [a.lower() for _, a in getaddresses([hdr.get("to", "")]) if a],
        "cc": [a.lower() for _, a in getaddresses([hdr.get("cc", "")]) if a],
        "reply_to": parseaddr(hdr.get("reply-to", ""))[1].lower(),
        "subject": hdr.get("subject", "").strip(),
        "message_id": hdr.get("message-id", "").strip(),
        "references": hdr.get("references", "").strip(),
        "headers": {k: hdr[k] for k in ("list-unsubscribe", "list-id", "precedence", "auto-submitted") if k in hdr},
        "text": own[:config.TEXT_CAP] + ("\n[truncated]" if truncated else ""),
        "quoted": quoted[:config.QUOTE_CAP],
        "attachments": attachment_names(payload),
    }


def context_block(rec, label="", draft=""):
    """The Markdown section one message adds to its thread's context file."""
    lines = ["## %s  %s <%s>" % (rec["date"], rec["from_name"], rec["from_addr"]),
             "subject: %s" % rec["subject"]]
    if label:
        lines.append("triage: %s%s" % (label, ("  draft: " + draft) if draft else ""))
    if rec["attachments"]:
        lines.append("attachments: " + ", ".join(rec["attachments"]))
    lines += ["", rec["text"] or "(no text)", ""]
    return "\n".join(lines) + "\n"


def reply_subject(subject):
    s = subject or ""
    return s if re.match(r"^\s*(re|rv|r)\s*:", s, re.I) else ("Re: " + s if s else "Re:")


def quote_header(rec, language):
    d = rec["date"].replace("T", " ")
    who = "%s <%s>" % (rec["from_name"], rec["from_addr"])
    return ("On %s, %s wrote:" if language == "en" else "El %s, %s escribió:") % (d, who)


def build_reply(rec, body, language="es"):
    """RFC 822 reply on the same thread, as base64url for the Gmail drafts API."""
    m = EmailMessage()
    m["From"] = formataddr((config.OWN_NAME, config.ACCOUNT))
    m["To"] = rec["reply_to"] or rec["from_addr"]
    m["Subject"] = reply_subject(rec["subject"])
    if rec["message_id"]:
        m["In-Reply-To"] = rec["message_id"]
        m["References"] = (rec["references"] + " " + rec["message_id"]).strip()
    quoted = "\n".join("> " + ln if ln else ">" for ln in (rec["text"] or "").split("\n"))
    m.set_content("%s\n\n%s\n%s\n" % (body.strip(), quote_header(rec, language), quoted))
    return base64.urlsafe_b64encode(m.as_bytes()).decode("ascii")


def gmail_link(thread_id):
    return "https://mail.google.com/mail/u/?authuser=%s#inbox/%s" % (config.ACCOUNT, thread_id)
