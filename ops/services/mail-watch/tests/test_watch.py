import base64
import email
import json

import pytest
from conftest import gmail_msg, mode

from mail_watch import draft, triage, watch

REPLY = {"label": "reply_needed", "language": "es", "recipient_kind": "team", "summary": "Pide el reporte de inventario hoy"}
FYI = dict(REPLY, label="fyi", summary="Avisa que llego el pedido")
DRAFT = {"body": "Hola Person B, te lo mando hoy.\n\nSaludos", "blanks": []}
ENV = {"MW_TABLE": "tbl", "MW_PATH": "p", "MW_TOKEN": "t", "MW_TRIGGER_WF": "wf1"}


class FakeApi:
    def __init__(self, rows, active=True):
        self.table, self.active, self.deleted = list(rows), active, []

    def rows(self, table_id):
        return [dict(r) for r in self.table]

    def delete_rows(self, table_id, msg_id):
        self.deleted.append(msg_id)
        self.table = [r for r in self.table if r["msg_id"] != msg_id]

    def workflow_active(self, wf):
        return self.active


class FakeProxy:
    def __init__(self, msgs, draft_error=None, get_error=None):
        self.msgs, self.drafts, self.gets = {m["id"]: m for m in msgs}, [], 0
        self.draft_error, self.get_error = draft_error, get_error

    def get(self, ids):
        self.gets += 1
        if self.get_error:
            raise RuntimeError(self.get_error)
        return [self.msgs[i] for i in ids]

    def draft(self, thread_id, raw):
        if self.draft_error:
            raise RuntimeError(self.draft_error)
        self.drafts.append((thread_id, raw))
        return "r-draft-%d" % len(self.drafts)


def run(env, api, proxy):
    st = watch.State()
    return st, watch.cycle(st, watch.Alerts(st), api, proxy, ENV)


def rows(*ids):
    return [{"msg_id": i, "thread_id": "t1"} for i in ids]


def test_reply_needed_makes_context_draft_and_one_card(env):
    env.outputs({triage.HAIKU: REPLY, draft.SONNET: DRAFT})
    api, proxy = FakeApi(rows("m1")), FakeProxy([gmail_msg()])
    st, c = run(env, api, proxy)
    assert c["done"] == 1 and c["drafts"] == 1
    ctx = (env.state / "threads" / "t1.md").read_text()
    assert "¿me puedes mandar el reporte hoy?" in ctx and "Te mando el avance" not in ctx
    assert "inventario.xlsx" in ctx
    (thread, raw), = proxy.drafts
    m = email.message_from_bytes(base64.urlsafe_b64decode(raw))
    assert thread == "t1" and m["In-Reply-To"] == "<abc-m1@mail.gmail.com>"
    (card,) = [json.loads(x) for x in env.lines("ctl")]
    assert card[0] == "ask" and "Mail to reply from Person B" in card[1] and "--kind" in card
    assert "#inbox/t1" in card[card.index("--link") + 1]
    assert [ln.split("\t")[1] for ln in env.lines("notify")] == ["Mail to reply"]
    assert api.deleted == ["m1"] and api.table == []
    index = (env.state / "index.md").read_text()
    assert "reply_needed" in index and "threads/t1.md" in index
    for f in ("seen.json", "index.md", "threads/t1.md"):
        assert mode(env.state / f) == 0o600
    assert mode(env.state) == 0o700
    # A second cycle (trigger re-queued the same id) does nothing new.
    api.table = rows("m1")
    st, c = run(env, api, proxy)
    assert len(proxy.drafts) == 1 and len(env.lines("ctl")) == 1 and proxy.gets == 1
    assert ctx == (env.state / "threads" / "t1.md").read_text()


def test_fyi_and_noise_get_context_but_no_draft(env):
    env.outputs({triage.HAIKU: FYI, draft.SONNET: DRAFT})
    msgs = [gmail_msg("m1"), gmail_msg("m2", thread="t2", extra_headers=[("List-Id", "x")])]
    api, proxy = FakeApi(rows("m1") + [{"msg_id": "m2", "thread_id": "t2"}]), FakeProxy(msgs)
    st, c = run(env, api, proxy)
    assert c["done"] == 2 and proxy.drafts == [] and env.lines("ctl") == []
    assert st.seen["m1"]["label"] == "fyi" and st.seen["m2"]["label"] == "noise"
    assert (env.state / "threads" / "t2.md").exists()
    assert [c["model"] for c in env.claude_calls()] == ["claude-haiku-5-5"]


def test_model_error_leaves_no_draft_and_alerts_once(env):
    env.outputs({triage.HAIKU: REPLY, draft.SONNET: "error"})
    api, proxy = FakeApi(rows("m1")), FakeProxy([gmail_msg()])
    for _ in range(4):
        st, c = run(env, api, proxy)
    assert proxy.drafts == [] and env.lines("ctl") == []
    alerts = [ln for ln in env.lines("notify") if "Mail watch problem" in ln]
    assert len(alerts) == 1
    assert st.seen["m1"]["status"] == "failed" and api.table == []
    # triage ran once; the label survives the draft retries
    assert [c["model"] for c in env.claude_calls()].count("claude-haiku-5-5") == 1


def test_draft_post_failure_is_never_retried(env):
    env.outputs({triage.HAIKU: REPLY, draft.SONNET: DRAFT})
    api, proxy = FakeApi(rows("m1")), FakeProxy([gmail_msg()], draft_error="HTTP 403")
    run(env, api, proxy)
    st, c = run(env, api, proxy)
    assert st.seen["m1"]["status"] == "failed" and env.lines("ctl") == []
    assert len([ln for ln in env.lines("notify") if "Mail watch problem" in ln]) == 1
    assert [c["model"] for c in env.claude_calls()].count("claude-sonnet-5-5") == 1


def test_read_failure_alerts_once_then_recovers(env):
    env.outputs({triage.HAIKU: FYI})
    api, proxy = FakeApi(rows("m1")), FakeProxy([gmail_msg()], get_error="HTTP 401")
    run(env, api, proxy)
    run(env, api, proxy)
    assert len(env.lines("notify")) == 1
    proxy.get_error = None
    st, c = run(env, api, proxy)
    assert st.seen["m1"]["status"] == "done" and st.alerts == {}


def test_daily_cap_stops_model_calls_and_keeps_mail_queued(env, monkeypatch):
    from mail_watch import config
    monkeypatch.setattr(config, "DAILY_CAP_USD", 0.0)
    env.outputs({triage.HAIKU: REPLY, draft.SONNET: DRAFT})
    api, proxy = FakeApi(rows("m1")), FakeProxy([gmail_msg()])
    run(env, api, proxy)
    st, c = run(env, api, proxy)
    assert env.claude_calls() == [] and proxy.drafts == []
    assert st.seen["m1"]["status"] == "pending" and api.table == rows("m1")
    assert len(env.lines("notify")) == 1


def test_card_failure_retries_card_not_draft(env, monkeypatch):
    env.outputs({triage.HAIKU: REPLY, draft.SONNET: DRAFT})
    monkeypatch.setenv("FAKE_CTL_RC", "1")
    api, proxy = FakeApi(rows("m1")), FakeProxy([gmail_msg()])
    st, _ = run(env, api, proxy)
    assert st.seen["m1"]["status"] == "pending" and len(proxy.drafts) == 1
    monkeypatch.setenv("FAKE_CTL_RC", "0")
    st, _ = run(env, api, proxy)
    assert st.seen["m1"]["status"] == "done" and len(proxy.drafts) == 1 and len(env.lines("ctl")) == 2


def test_interrupted_draft_call_is_not_repeated(env):
    env.outputs({triage.HAIKU: REPLY, draft.SONNET: DRAFT})
    api, proxy = FakeApi(rows("m1")), FakeProxy([gmail_msg()])
    st = watch.State()
    st.seen["m1"] = {"status": "pending", "tries": 0, "thread": "t1", "context": True, "label": "reply_needed",
                     "drafting": True}
    st.save()
    st, c = run(env, api, proxy)
    assert proxy.drafts == [] and st.seen["m1"]["status"] == "failed"


def test_inactive_trigger_alerts(env):
    env.outputs({})
    run(env, FakeApi([], active=False), FakeProxy([]))
    run(env, FakeApi([], active=False), FakeProxy([]))
    assert len(env.lines("notify")) == 1 and "trigger is not active" in env.lines("notify")[0]


def test_logs_carry_no_mail_text(env, capsys):
    env.outputs({triage.HAIKU: REPLY, draft.SONNET: DRAFT})
    run(env, FakeApi(rows("m1")), FakeProxy([gmail_msg()]))
    out = capsys.readouterr()
    assert "reporte" not in (out.out + out.err).lower() and "Person B" not in out.out + out.err


def test_never_sends(env):
    from mail_watch import n8n
    assert "/send" not in n8n.PLAN_JS and "messages/send" not in n8n.PLAN_JS
    assert "modify" not in n8n.PLAN_JS
    ops = [ln for ln in n8n.PLAN_JS.splitlines() if "b.op ===" in ln]
    assert len(ops) == 2 and "'get'" in ops[0] and "'draft'" in ops[1]
    assert n8n.trigger_workflow("x")["settings"]["saveDataSuccessExecution"] == "none"
    assert n8n.proxy_workflow("p", {"id": "c", "name": "n"})["settings"]["saveDataErrorExecution"] == "none"


@pytest.mark.parametrize("flag", ["state", "hq"])
def test_kill_switch(env, monkeypatch, tmp_path, flag):
    from mail_watch import config
    monkeypatch.setattr(config, "HQ", tmp_path / "hq")
    p = (env.state / "DISABLED") if flag == "state" else (tmp_path / "hq" / "ops" / "mail" / "DISABLED")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.touch()
    assert watch.main([]) == 0
    assert env.lines("notify") == []


def test_card_never_binds_to_a_terminal(env, tmp_path, monkeypatch):
    # hq-an7jw.19: ctl whoami must find no identity, or the card can bind to a
    # worker pane and reach the orchestrator as a worker ask.
    for k, v in {"TMUX": "/tmp/s,1,0", "TMUX_PANE": "%0", "HQ_PANE": "%0", "HQ_CONSOLE_SID": "s-con"}.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("HQ_NO_TMUX", raising=False)
    dump = tmp_path / "ctl-env.json"
    ctl = tmp_path / "env-ctl.sh"
    ctl.write_text("#!/usr/bin/env python3\nimport json, os\n"
                   "json.dump(dict(os.environ), open(%r, 'w'))\n" % str(dump))
    ctl.chmod(0o755)
    rec = {"from_name": "Person B", "from_addr": "b@x", "subject": "s", "thread": "t1", "id": "m1"}
    watch.raise_card(rec, REPLY, {"blanks": []}, "r-draft-1", ctl=str(ctl))
    seen = json.loads(dump.read_text())
    assert seen.get("HQ_NO_TMUX") == "1"
    assert not {"TMUX", "TMUX_PANE", "HQ_PANE", "HQ_CONSOLE_SID"} & set(seen)
