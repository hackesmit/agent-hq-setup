import pytest
from conftest import gmail_msg

from mail_watch import config, draft, mail
from voice import model

TRI = {"label": "reply_needed", "language": "es", "recipient_kind": "team", "summary": "x"}


def test_target_is_median_for_kind_and_language(env):
    ex = draft.load_examples()
    assert draft.target_words(ex, "team", "es") == 7
    # too few English client examples: falls back to the whole set
    assert draft.target_words(ex, "client", "en") == draft.target_words(ex, "nobody", "xx")


def test_work_examples_come_first(env):
    ex = draft.ordered_examples(draft.load_examples(), "client", "en")
    assert ex[0]["account"] == "work"


def test_draft_uses_sonnet_profile_and_lists_blanks(env):
    env.outputs({draft.SONNET: {"body": "Hola Person B, te lo mando el [fecha].\n\nSaludos", "blanks": []}})
    d = draft.write(mail.parse(gmail_msg()), TRI, model.Budget(2))
    assert d["blanks"] == ["[fecha]"]
    (call,) = env.claude_calls()
    assert call["model"] == "claude-sonnet-5-5"
    assert "Greets with 'Hola'" in call["system"] and "about 7 words" in call["system"]
    assert "Never invent a fact" in call["system"]
    assert "Te mando el avance" in call["prompt"]  # thread history goes in as context


def test_long_draft_gets_one_shorter_retry(env):
    long_body = " ".join(["palabra"] * 60)
    env.outputs({draft.SONNET: [{"body": long_body, "blanks": []}, {"body": "Va, hoy te lo mando.", "blanks": []}]})
    d = draft.write(mail.parse(gmail_msg()), TRI, model.Budget(2))
    assert d["body"] == "Va, hoy te lo mando."
    calls = env.claude_calls()
    assert len(calls) == 2 and "at most 7 words" in calls[1]["prompt"]


def test_no_profile_no_draft(env):
    (config.VOICE_STATE / "profile.md").unlink()
    env.outputs({draft.SONNET: {"body": "x", "blanks": []}})
    with pytest.raises(model.ModelError):
        draft.write(mail.parse(gmail_msg()), TRI, model.Budget(2))
    assert env.claude_calls() == []


def test_empty_draft_is_an_error(env):
    env.outputs({draft.SONNET: {"body": "  ", "blanks": []}})
    with pytest.raises(model.ModelError):
        draft.write(mail.parse(gmail_msg()), TRI, model.Budget(2))
