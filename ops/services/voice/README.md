# voice: the owner's writing voice from his sent mail (hq-w32vy.1)

Builds `state/voice/profile.md` and `state/voice/examples.jsonl` for a drafter
(the work inbox watcher, hq-w32vy.2) to load. Source: every message in Sent of
owner@example.com and owner@example.com. studioco mail is out of scope.

```
cd ops/services/voice
python3 -m voice.fetch            # both accounts; or: personal | work
python3 -m voice.build --dry-run  # counts and cost estimate, no model call
python3 -m voice.build            # features, synthesis, 5 blind drafts (cap 15 USD)
python3 -m pytest -q tests
```

## Access
- Personal: Gmail IMAP with the HQ Mail app password (Imported / "HQ Mail",
  through `hq_mail.config.secret`); that login is owner@example.com.
- Work: no credential of ours. `voice/n8n_gmail.py` creates a temporary n8n
  workflow (Header Auth webhook, a Code node that only allows messages.list
  in:sent and messages.get format=full, an HTTP node on the existing Gmail
  OAuth2 credential BA74UOAI766aWIP5, executions not saved) and deletes it and
  its token credential when the fetch ends, also on failure.
- Models: `claude -p` with no tools, no MCP, no settings (the ops/security/news.sh
  boundary), Haiku 5.5 for per-message features and Opus 5.5 for the synthesis
  and blind drafts. Cost is the CLI's `total_cost_usd`; `model.Budget` refuses
  any call that could pass the cap. No Anthropic API key is used.

## Data rules
- `state/voice/` is 0700, every file 0600 and written by rename. No message
  text goes to git, beads, the vault or a log; progress lines carry counts only.
- Machine mail is dropped before the model: personal messages whose Message-ID
  Gmail assigned on SMTP submit (`@mx.google.com`, the hq_mail sender), drafts,
  Auto-Submitted, our automated report subjects (`build.AUTOMATED_SUBJECT`),
  self-only mail, and messages with no own text. Haiku then labels each message
  `authored_by`; only `owner` reaches the synthesis.
- Fail-closed: a failed fetch raises and keeps the previous `sent-*.jsonl`; a
  model failure or the cap stops `build` before any output file is written.
  `profile.md` is written last, so its presence means a complete run.

## Outputs
| File | What |
| --- | --- |
| `profile.md` | the voice profile (Spanish, English, per recipient kind, do and do-not, checklist) |
| `examples.jsonl` | 30 to 60 verbatim excerpts with situation, language, recipient kind |
| `blind.jsonl` | 5 held-out real replies with the drafter's version beside them |
| `features.jsonl` | per-message labels (no body text except the excerpt) |
| `corpus.json` | counts per account and year, holdout keys, cost line |
