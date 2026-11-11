# One orchestrator, background workers (hq-7llgp.8)

**Verdict first:** the orchestrator costs about 6.7 USD a day against 10.6 USD for today's coordinator terminals (section 5). It is cheaper, so the design proceeds.

## 1. Ask routing

- `ctl.sh ask` from a session registered as a worker writes the request with `to: orchestrator`. The console Now view hides that queue; the owner never sees it.
- The orchestrator answers from, in order: `ops/reference/owner-facts.md`, the files, the ledger, a sensible default. It replies with `ctl.sh answer`, which already revives a parked worker.
- It forwards to the owner only with `ctl.sh forward <rid> --class business|taste|unknowable`. The verb refuses a forward with no class.
- Safety net: an orchestrator ask not touched in 10 minutes forwards itself, so a dead orchestrator never blocks a worker.
- When the owner answers a stable fact, the orchestrator adds a line to the facts file. Session-eval flags a forward that the facts file already answered.

## 2. The orchestrator loop (events, never polling)

Emitters append one JSON line to `state/orchestrator/events.jsonl`. A systemd path unit (`hq-orchestrator.path`) fires `orchestrator-run.sh`, which takes a flock and handles each new event in a fresh `claude -p` call. No timer, no loop.

| Event | Emitted by | Action |
|---|---|---|
| worker done | `notify.sh "Task done"` | check the receipt; size review per invariant 6 (none, Opus reviewer, plus lucy) |
| review verdict | reviewer session end | approve: merge; block: fix bead to a fresh worker; rounds per invariant 6 |
| merge ready | approve with green checks | `finish.sh --confirm`, one at a time; write the project update line |
| merge done | `finish.sh` | `bd ready` on that epic; dispatch the next bead or batch |
| worker ask | `ctl.sh ask` | answer or forward (section 1) |
| the owner message | the chat terminal | the owner talks to the orchestrator terminal directly |

The chat terminal and the event runner share only files (invariant 1).

## 3. Workers headless

- `spawn.sh` puts workers in a detached tmux session `hq-bg`, one window each, instead of tiling `hq:work`. `--pane` restores today's behavior. The current no-tmux fallback (`nohup`) stays.
- The console Terminals card gets an Open button: `tmux join-pane` moves the worker into `hq:work` so the owner can drive it, and Close sends it back.

## 4. What the owner sees

- Console Now: only forwarded questions and P0 items.
- Project pages: the hq-c4pl0 flow charts, plus one update line per project that the orchestrator writes after each merge or block (`state/console/project-updates.json`).
- Digest: P1 items twice a day (09:00 and 18:00 local) through `notify.sh default`. P2 stays silent in the ledger. P0 pages at once, as today.

## 5. Token budget

Measured from `state/usage/claude-api.sqlite`, 2026-11-03 (the full day; the table starts 03:36Z that day, so treat it as one sample):

- Coordinator terminals (no bead, main thread, Opus): 3 sessions, 189 calls, 21.8 M tokens, **10.61 USD**. Average context per call 100k to 145k, 0.056 USD per call.
- All no-bead traffic (hooks, summaries, subagents included): 17.91 USD. Workers: 25 beads, 121.84 USD (4.87 USD per bead). The orchestrator does not change worker spend.

Effective cost per call (same table): Opus 0.056 USD at 135k context, Sonnet 0.031 USD at 91k; cost scales with context.

Estimate at 25 beads a day (about 3.4 events per bead plus 15 the owner messages):

| Part | Model | Events a day | Calls x context | Tokens a day | USD a day |
|---|---|---|---|---|---|
| Triage: asks, done, dispatch | Sonnet | 80 | 4 x 30k | 9.6 M | 3.20 |
| Review sizing and merges | Opus | 25 | 6 x 40k | 6.0 M | 2.50 |
| the owner chat terminal | Opus | 15 | 3 x 50k | 2.3 M | 0.95 |
| **Total** | | | | **17.9 M** | **6.65** |

Models in use (the owner 2026-11-10): Fable 5.2 (`claude-fable-5-2`) decides, Sonnet 5.5 triages, set in ops/config/orchestrator.json; the table above is the original estimate.

Per event: about 120k tokens and 0.04 USD for triage, 240k tokens and 0.10 USD for a merge. Against 10.61 USD today that saves about 4 USD a day, about 120 USD a month. Reviewer and lucy spend is the same in both and left out.

How context stays small: every event is a fresh `claude -p` with a 30k prefix (this file's seed, the facts file, the event, `bd show`); nothing carries over. The chat terminal restarts itself above 60k context, since state lives in files. A daily cap (default 12 USD, read from the same table) stops the event runner and pings the owner at P1.

## 6. Migration beads

1. **Ask routing:** `to: orchestrator`, `forward` verb, 10-minute fallback. Owns `ops/console/ctl.sh` and its tests.
2. **Event runner:** `orchestrator-run.sh`, systemd path unit and service, flock, daily cap. Owns `ops/scripts/orchestrator-run.sh`, `ops/systemd/hq-orchestrator.*`.
3. **Emitters:** done, merge and verdict events. Owns `ops/scripts/notify.sh`, `ops/scripts/finish.sh`.
4. **Headless workers:** `hq-bg` session, `--pane` flag. Owns `ops/scripts/spawn.sh`.
5. **Console:** Open/Close button, project update line, hidden orchestrator queue. Owns `ops/console/v2/`.
6. **Rules and seed:** orchestrator seed template and the CLAUDE.md operating loop change. Owns `ops/templates/orchestrator.md`, `CLAUDE.md`. Depends on 1 to 5.

Beads 1 to 5 are independent; 1, 2 and 6 get an Opus reviewer (they change who answers and who merges).

## 7. Risks and what stays the owner's

- **Wrong answer to a worker:** every orchestrator answer is logged with its source, and the digest lists them, so the owner can correct one and the fix goes into the facts file.
- **Single point of failure:** events persist in the file and asks forward after 10 minutes, so a crash loses nothing.
- **Runaway spend:** the daily cap.
- **Stays the owner's:** business, taste and unknowable questions; merging money, auth or data already in use when lucy cannot run; the never-merge-open rule for money, data-loss and cross-tab findings is unchanged.
