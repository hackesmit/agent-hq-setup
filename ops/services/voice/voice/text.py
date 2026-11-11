"""Keep only the owner's own words from a sent message.

Two body sources feed one cleaner: a parsed RFC 822 message (IMAP) and a
Gmail API payload (format=full, the work account). The cleaner cuts at the
first quote header (English or Spanish, Gmail, Apple Mail or Outlook),
drops '>' lines, phone footers and the '-- ' signature, and returns the
quoted part separately so a blind test can show what he answered.
"""

import base64
import re
from email.utils import getaddresses
from html.parser import HTMLParser

# A quote header can wrap over up to three lines in Gmail, so the "On ...
# wrote:" pattern is matched on the text, not per line.
_QUOTE_HEADERS = [
    re.compile(r"^[ \t]*(On|El|Le|Am)\b[^\n]{0,300}(\n[^\n]{0,200}){0,2}?(wrote|escribi[oó]|a [ée]crit|schrieb)\s*:[ \t]*$",
               re.M | re.I),
    re.compile(r"^[ \t]*-{2,}[ \t]*(Original Message|Mensaje original|Forwarded message|Mensaje reenviado"
               r"|Begin forwarded message|Inicio del mensaje reenviado)[ \t]*-*[ \t]*$", re.M | re.I),
    re.compile(r"^[ \t]*(Begin forwarded message|Inicio del mensaje reenviado)[ \t]*:", re.M | re.I),
    re.compile(r"^[ \t]*_{20,}[ \t]*$", re.M),
    # Outlook block: From/De line followed within two lines by Sent/Enviado/Date/Fecha
    re.compile(r"^[ \t]*\**(From|De)\**[ \t]*:[^\n]*\n([^\n]*\n){0,2}?[ \t]*\**(Sent|Enviado|Date|Fecha)\**[ \t]*:",
               re.M | re.I),
]
_FOOTERS = re.compile(
    r"^[ \t]*(Sent from my|Enviado desde mi|Get Outlook for|Obtener Outlook para|Sent from Mail for"
    r"|Enviado desde Correo para|Sent with Proton Mail|Enviado con)\b.*$", re.M | re.I)
_SIG_DELIM = re.compile(r"^-- ?$", re.M)


def split_quote(text):
    """(own, quoted): own text above the first quote header, and the rest."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    cut = len(text)
    for rx in _QUOTE_HEADERS:
        m = rx.search(text)
        if m and m.start() < cut:
            cut = m.start()
    own, quoted = text[:cut], text[cut:]
    lines = own.split("\n")
    # A '>' line also starts the quote when no header matched (some clients).
    for i, ln in enumerate(lines):
        if ln.lstrip().startswith(">"):
            rest = lines[i:]
            if all(not r.strip() or r.lstrip().startswith(">") for r in rest[:3]):
                quoted = "\n".join(rest) + quoted
                lines = lines[:i]
                break
    return "\n".join(lines), quoted


def strip_signature(own):
    m = _SIG_DELIM.search(own)
    if m:
        own = own[:m.start()]
    own = _FOOTERS.sub("", own)
    return tidy(own)


def tidy(text):
    text = re.sub(r"[ \t ]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def strip_common_tails(texts, min_count=5, min_share=0.03):
    """Drop trailing lines that repeat across many messages (a signature).

    A line counts when it is among the last six non-empty lines of a
    message; any such line seen in at least max(min_count, share * n)
    messages is a signature line and is peeled off the end, repeatedly.
    """
    n = len(texts)
    floor = max(min_count, int(min_share * n))
    counts = {}
    for t in texts:
        tail = [ln.strip().lower() for ln in t.split("\n") if ln.strip()][-6:]
        for ln in set(tail):
            counts[ln] = counts.get(ln, 0) + 1
    common = {ln for ln, c in counts.items() if c >= floor}
    out = []
    for t in texts:
        lines = t.split("\n")
        while lines and (not lines[-1].strip() or lines[-1].strip().lower() in common):
            lines.pop()
        out.append(tidy("\n".join(lines)))
    return out, sorted(common)


class _HtmlText(HTMLParser):
    """HTML to text, skipping quoted history and Gmail signatures."""

    SKIP_CLASSES = ("gmail_quote", "gmail_signature", "gmail_attr", "moz-cite-prefix", "yahoo_quoted")
    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "table", "blockquote"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.depth, self.stack = [], 0, []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        skip = tag in ("blockquote", "style", "script", "head") or \
            any(c in (a.get("class") or "") for c in self.SKIP_CLASSES) or \
            (a.get("id") or "").startswith(("divRplyFwdMsg", "appendonsend"))
        if tag in ("br", "img", "hr", "meta", "link", "input"):
            if tag == "br" and not self.depth:
                self.out.append("\n")
            return
        self.stack.append(skip)
        if skip:
            self.depth += 1
        if tag in self.BLOCK and not self.depth:
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in ("br", "img", "hr", "meta", "link", "input"):
            return
        if self.stack:
            if self.stack.pop():
                self.depth -= 1
        if tag in self.BLOCK and not self.depth:
            self.out.append("\n")

    def handle_data(self, data):
        if not self.depth:
            self.out.append(data)


def html_to_text(html):
    p = _HtmlText()
    p.feed(html)
    p.close()
    return tidy("".join(p.out))


def bodies_from_email(msg):
    """(plain, html) from an email.message.Message, attachments skipped."""
    plain = html = ""
    for part in msg.walk():
        if part.is_multipart() or part.get_content_disposition() == "attachment":
            continue
        ctype = part.get_content_type()
        if ctype not in ("text/plain", "text/html"):
            continue
        payload = part.get_payload(decode=True) or b""
        charset = part.get_content_charset() or "utf-8"
        try:
            s = payload.decode(charset, "replace")
        except LookupError:
            s = payload.decode("utf-8", "replace")
        if ctype == "text/plain" and not plain:
            plain = s
        elif ctype == "text/html" and not html:
            html = s
    return plain, html


def bodies_from_gmail(payload):
    """(plain, html) from a Gmail API message payload (format=full)."""
    found = {"text/plain": "", "text/html": ""}

    def walk(p):
        mime = p.get("mimeType", "")
        if mime in found and not found[mime] and not p.get("filename"):
            data = (p.get("body") or {}).get("data")
            if data:
                found[mime] = base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", "replace")
        for c in p.get("parts") or []:
            walk(c)

    walk(payload or {})
    return found["text/plain"], found["text/html"]


def own_text(plain, html):
    """(own, quoted) for one message, preferring the plain part."""
    if plain.strip():
        own, quoted = split_quote(plain)
    else:
        own, quoted = html_to_text(html or ""), ""
        own, q2 = split_quote(own)
        quoted = q2
    return strip_signature(own), tidy(quoted)


def addresses(*header_values):
    return [a.lower() for _, a in getaddresses([h for h in header_values if h]) if a]
