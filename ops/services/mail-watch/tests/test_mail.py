import base64
import email

from conftest import b64, gmail_msg

from mail_watch import mail


def test_parse_strips_quoted_history_and_keeps_attachment_names():
    rec = mail.parse(gmail_msg())
    assert rec["text"] == "Hola the owner, ¿me puedes mandar el reporte hoy?\n\nGracias"
    assert "Te mando el avance" in rec["quoted"]
    assert "Te mando el avance" not in rec["text"]
    assert rec["attachments"] == ["inventario.xlsx"]
    assert rec["from_addr"] == "personb@example.com" and rec["from_name"] == "Person B"
    assert rec["thread"] == "t1" and rec["message_id"] == "<abc-m1@mail.gmail.com>"


def test_parse_english_wrapped_quote_and_gt_lines():
    m = gmail_msg(body="Can you confirm Thursday?", quoted="On Mon, Nov 3, 2026 at 10:02 AM Ana <\nana@x.com> wrote:\n> old\n")
    assert mail.parse(m)["text"] == "Can you confirm Thursday?"
    m2 = gmail_msg(body="Ok, gracias", quoted="> linea vieja\n> otra\n> mas\n")
    assert mail.parse(m2)["text"] == "Ok, gracias"


def test_parse_outlook_block():
    m = gmail_msg(body="Te confirmo mañana", quoted="________________________________\nDe: Person C\nEnviado: lunes\n\nviejo")
    assert mail.parse(m)["text"] == "Te confirmo mañana"


def test_parse_html_only_drops_gmail_quote():
    m = gmail_msg()
    m["payload"]["parts"][0] = {"mimeType": "text/html", "filename": "", "body": {"data": b64(
        "<div>Nuevo texto</div><div class=\"gmail_quote\">El lun escribió:<blockquote>viejo</blockquote></div>")}}
    assert mail.parse(m)["text"] == "Nuevo texto"


def test_context_block_has_no_body_of_attachments():
    rec = mail.parse(gmail_msg())
    block = mail.context_block(rec)
    assert "attachments: inventario.xlsx" in block and "Person B <personb@example.com>" in block
    assert "Te mando el avance" not in block


def test_build_reply_threads_on_the_message():
    rec = mail.parse(gmail_msg(extra_headers=[("Reply-To", "Equipo <equipo@example.com>")]))
    raw = mail.build_reply(rec, "Hola Person B, te lo mando hoy.\n\nSaludos", "es")
    m = email.message_from_bytes(base64.urlsafe_b64decode(raw))
    assert m["To"] == "equipo@example.com"
    assert m["Subject"] == "Re: Reporte de inventario"
    assert m["In-Reply-To"] == "<abc-m1@mail.gmail.com>"
    assert m["References"] == "<root@mail.gmail.com> <abc-m1@mail.gmail.com>"
    assert "owner@example.com" in m["From"]
    body = m.get_payload(decode=True).decode()
    assert body.startswith("Hola Person B, te lo mando hoy.")
    assert "escribió:" in body and "> Hola the owner" in body


def test_reply_subject_keeps_existing_prefix():
    assert mail.reply_subject("RE: x") == "RE: x"
    assert mail.reply_subject("Rv: x") == "Rv: x"
    assert mail.reply_subject("Junta") == "Re: Junta"
