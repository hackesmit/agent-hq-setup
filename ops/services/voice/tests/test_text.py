import base64
import email
import os
import stat
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from voice import paths, text  # noqa: E402


def test_gmail_english_quote_wrapped_header():
    body = ("Sounds good, send it over.\n\nthe owner\n\n"
            "On Mon, Mar 4, 2024 at 10:02 AM Ana Perez <\nana@example.com> wrote:\n\n> Here is the file\n")
    own, quoted = text.own_text(body, "")
    assert own == "Sounds good, send it over.\n\nthe owner"
    assert "Here is the file" in quoted


def test_gmail_spanish_quote():
    body = ("Va, lo reviso mañana.\n\n"
            "El lun, 4 mar 2024 a las 10:02, Person B (<personb@example.com>) escribió:\n> Te mando el reporte\n")
    own, quoted = text.own_text(body, "")
    assert own == "Va, lo reviso mañana."
    assert "Te mando el reporte" in quoted


def test_outlook_block_and_forward():
    body = "Ok\n\n________________________________\nDe: Person C\nEnviado: lunes\nPara: the owner\n\nhola"
    assert text.own_text(body, "")[0] == "Ok"
    fwd = "FYI\n\n---------- Forwarded message ---------\nFrom: x\nDate: y\n\nbody"
    assert text.own_text(fwd, "")[0] == "FYI"
    es = "Mira esto\n\n---------- Mensaje reenviado ---------\nDe: x\n"
    assert text.own_text(es, "")[0] == "Mira esto"


def test_outlook_from_sent_without_rule():
    body = "Gracias!\n\nFrom: Ana Perez <ana@x.com>\nSent: Monday, March 4, 2024\nTo: the owner\n\nold text"
    assert text.own_text(body, "")[0] == "Gracias!"


def test_angle_quotes_without_header_and_signature_and_footer():
    body = "Yes.\n\n-- \nOwner Name\nOrbit Acme\n"
    assert text.own_text(body, "")[0] == "Yes."
    body = "Claro\n\nEnviado desde mi iPhone\n\n> algo\n> mas\n"
    assert text.own_text(body, "")[0] == "Claro"


def test_inline_greater_than_in_prose_is_kept():
    body = "Price went from 5 to 7\n>that is a jump, keep it\nthanks"
    assert ">that is a jump" in text.own_text(body, "")[0]


def test_html_fallback_skips_gmail_quote_and_signature():
    html = ('<div dir="ltr">Hola equipo,<br>listo.<br></div>'
            '<div class="gmail_signature">Owner Name | Director</div>'
            '<div class="gmail_quote"><div class="gmail_attr">El lun escribió:</div>'
            '<blockquote>texto viejo</blockquote></div>')
    own, _ = text.own_text("", html)
    assert own == "Hola equipo,\nlisto."


def test_common_tails_peel_repeated_signature():
    sig = "\n\nOwner Name\nDirector de Operaciones\n+52 000 000 0000"
    texts = ["mensaje %d" % i + sig for i in range(10)] + ["sin firma"]
    out, common = text.strip_common_tails(texts)
    assert out[0] == "mensaje 0"
    assert out[-1] == "sin firma"
    assert "director de operaciones" in common


def test_common_tails_keep_rare_lines():
    texts = ["a\nthanks", "b\nthanks", "c\nsaludos"]
    out, common = text.strip_common_tails(texts)
    assert out == texts and common == []


def test_bodies_from_email_multipart_skips_attachment():
    raw = (b"From: d@x\r\nTo: a@y\r\nSubject: s\r\nMIME-Version: 1.0\r\n"
           b"Content-Type: multipart/mixed; boundary=B\r\n\r\n"
           b"--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhola se\xc3\xb1or\r\n"
           b"--B\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=a.txt\r\n\r\nNOPE\r\n--B--\r\n")
    plain, html = text.bodies_from_email(email.message_from_bytes(raw))
    assert plain.strip() == "hola señor" and html == ""


def test_bodies_from_gmail_payload():
    enc = lambda s: base64.urlsafe_b64encode(s.encode()).decode().rstrip("=")
    payload = {"mimeType": "multipart/mixed", "parts": [
        {"mimeType": "multipart/alternative", "parts": [
            {"mimeType": "text/plain", "body": {"data": enc("listo ñ")}},
            {"mimeType": "text/html", "body": {"data": enc("<b>listo</b>")}}]},
        {"mimeType": "text/plain", "filename": "x.txt", "body": {"attachmentId": "A"}}]}
    assert text.bodies_from_gmail(payload) == ("listo ñ", "<b>listo</b>")


def test_write_private_is_0600_and_dir_0700(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "STATE", tmp_path / "voice")
    d = paths.state_dir("raw")
    p = paths.write_private(d / "x.json", "secret body")
    assert stat.S_IMODE(os.stat(p).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(tmp_path / "voice").st_mode) == 0o700
    assert stat.S_IMODE(os.stat(d).st_mode) == 0o700
    assert not [f for f in os.listdir(d) if f.startswith(".")]
