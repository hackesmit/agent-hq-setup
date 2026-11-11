import base64
import json
import os
import stat
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

FAKE_CLAUDE = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
model = args[args.index("--model") + 1]
prompt = sys.stdin.read()
with open(os.environ["FAKE_CLAUDE_LOG"], "a") as f:
    f.write(json.dumps({"model": model, "system": args[args.index("--system-prompt") + 1], "prompt": prompt}) + "\n")
outs = json.load(open(os.environ["FAKE_CLAUDE_OUT"]))
o = outs.get(model)
if isinstance(o, list):
    n = sum(1 for ln in open(os.environ["FAKE_CLAUDE_LOG"]) if json.loads(ln)["model"] == model)
    o = o[min(n - 1, len(o) - 1)]
if o == "error":
    print(json.dumps({"is_error": True, "subtype": "error_during_execution", "total_cost_usd": 0.001}))
    sys.exit(1)
print(json.dumps({"is_error": False, "structured_output": o, "total_cost_usd": 0.01,
                  "usage": {"input_tokens": 100, "output_tokens": 50}}))
'''

NOTIFY = r'''#!/bin/sh
printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$FAKE_NOTIFY_LOG"
exit "${FAKE_NOTIFY_RC:-0}"
'''

CTL = r'''#!/usr/bin/env python3
import json, os, sys
with open(os.environ["FAKE_CTL_LOG"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\n")
sys.exit(int(os.environ.get("FAKE_CTL_RC", "0")))
'''


def _exe(path, body):
    path.write_text(body)
    path.chmod(0o755)
    return str(path)


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Isolated state, voice profile, fake claude, notify and ctl."""
    state, voice = tmp_path / "state", tmp_path / "voice"
    voice.mkdir()
    (voice / "profile.md").write_text("# Voice profile\nShort. Greets with 'Hola'. Signs 'Saludos, the owner'.\n")
    ex = [{"account": "work", "language": "es", "recipient_kind": "team", "text": "Sí, claro. ¿A qué hora le funciona hoy?"},
          {"account": "work", "language": "es", "recipient_kind": "team", "text": "Va, lo reviso y te aviso."},
          {"account": "work", "language": "es", "recipient_kind": "team", "text": "Listo, ya quedó cargado en la carpeta."},
          {"account": "personal", "language": "en", "recipient_kind": "client",
           "text": "Thanks for the update, I will send the revised file tomorrow morning before the call."}]
    (voice / "examples.jsonl").write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in ex))
    facts = tmp_path / "facts.md"
    facts.write_text("# facts\n")
    logs = {k: tmp_path / ("%s.log" % k) for k in ("claude", "notify", "ctl")}
    for p in logs.values():
        p.write_text("")
    out = tmp_path / "claude-out.json"
    monkeypatch.setenv("FAKE_CLAUDE_LOG", str(logs["claude"]))
    monkeypatch.setenv("FAKE_CLAUDE_OUT", str(out))
    monkeypatch.setenv("FAKE_NOTIFY_LOG", str(logs["notify"]))
    monkeypatch.setenv("FAKE_CTL_LOG", str(logs["ctl"]))
    from mail_watch import config
    from voice import model
    monkeypatch.setattr(config, "STATE", state)
    monkeypatch.setattr(config, "VOICE_STATE", voice)
    monkeypatch.setattr(config, "FACTS", facts)
    monkeypatch.setattr(config, "NOTIFY", _exe(tmp_path / "notify.sh", NOTIFY))
    monkeypatch.setattr(config, "CTL", _exe(tmp_path / "ctl.sh", CTL))
    monkeypatch.setattr(model, "CLAUDE", _exe(tmp_path / "claude", FAKE_CLAUDE))

    class E:
        tmp = tmp_path

        def outputs(self, d):
            out.write_text(json.dumps(d))

        def lines(self, k):
            return [ln for ln in logs[k].read_text().splitlines() if ln]

        def claude_calls(self):
            return [json.loads(ln) for ln in self.lines("claude")]

    e = E()
    e.state = state
    return e


def b64(s):
    return base64.urlsafe_b64encode(s.encode()).decode().rstrip("=")


def gmail_msg(mid="m1", thread="t1", sender="Person B <personb@example.com>", subject="Reporte de inventario",
              body="Hola the owner, ¿me puedes mandar el reporte hoy?\n\nGracias",
              quoted="El lun, 3 nov 2026 a las 10:02, Owner Name (<owner@example.com>) escribió:\n> Te mando el avance\n",
              extra_headers=(), labels=("INBOX", "UNREAD"), attachments=("inventario.xlsx",)):
    headers = [{"name": "From", "value": sender}, {"name": "To", "value": "owner@example.com"},
               {"name": "Subject", "value": subject}, {"name": "Date", "value": "Tue, 4 Nov 2026 09:00:00 -0800"},
               {"name": "Message-ID", "value": "<abc-%s@mail.gmail.com>" % mid},
               {"name": "References", "value": "<root@mail.gmail.com>"}] + [
        {"name": k, "value": v} for k, v in extra_headers]
    parts = [{"mimeType": "text/plain", "filename": "", "body": {"data": b64(body + "\n\n" + quoted)}}]
    parts += [{"mimeType": "application/vnd.ms-excel", "filename": a, "body": {"attachmentId": "x", "size": 10}}
              for a in attachments]
    return {"id": mid, "threadId": thread, "labelIds": list(labels), "internalDate": "1793811600000",
            "payload": {"mimeType": "multipart/mixed", "headers": headers, "parts": parts}}


def mode(p):
    return stat.S_IMODE(os.stat(p).st_mode)
