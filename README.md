# agent-hq-setup

A working setup for running many Claude Code agents on one always-on Linux box, with a
process that keeps them honest. This is the machinery of one person's private HQ,
exported with the client work, personal data, secrets and runtime state removed.

It is a reference you adapt, not a product you install and forget. Read this file to
the end before you start: the last sections say what is missing and what you must
replace.

## What HQ is

- **One box.** An always-on Ubuntu machine holds everything: the repos, the ledger,
  the agents, the console. Nothing depends on a laptop being awake.
- **tmux terminals.** Every agent is a Claude Code session in a tmux pane or window.
  Two terminals on the same repo get separate git worktrees, so they never collide.
- **A beads ledger.** Work lives in [beads](https://github.com/steveyegge/beads)
  (`bd`): an epic per idea, beads of 5 to 15 minutes each, every bead with a
  Definition of Done before anyone starts it. State lives in files, never in a
  context window, so any session can be killed with no loss.
- **Hooks that enforce the process.** Claude Code hooks in `.claude/settings.json`
  call scripts in `ops/scripts/` that refuse what the process forbids: closing a bead
  without a verification receipt, writing outside the allowed paths, decorative
  glyphs in written content, and more. A rule with no hook is treated as a wish.
- **A console.** A web dashboard (`ops/console/v2/`) shows what waits on you, what
  runs, and what changed, and lets you answer a worker's question from a phone.
- **Workers spawned per bead.** `ops/scripts/spawn.sh` makes a worktree, a branch, a
  tmux window and a seed file for one bead; the worker commits, never merges.
- **Adversarial review.** A fresh-context reviewer on a model at least as strong as
  the worker tries to break each risky change and blocks only with a runnable failing
  check. Money, auth, data and security diffs also get a second pass from a different
  AI vendor. `ops/scripts/finish.sh` merges one branch at a time, only with a
  matching receipt.
- **An orchestrator.** Events (worker done, review verdict, worker question) go to a
  queue that a systemd path unit drains with one fresh headless Claude run per event
  (`docs/designs/2026-11-04-orchestrator.md`).
- **Capri on a Windows PC.** A voice and desktop side: a wake-word listener, a small
  "hands" service that drives the Windows desktop, and a local voice loop. The box
  deploys it over ssh (`ops/capri/README.md`).

`CLAUDE.md` is the constitution every session reads first. It is the best single
description of how the system behaves.

## Layout

| Path | What it holds |
| --- | --- |
| `CLAUDE.md`, `AGENTS.md` | The constitution and the agent entry point |
| `.claude/` | Claude Code settings (hooks, permissions), rules loaded per path, skills |
| `ops/scripts/` | Spawn, finish, review, notify, the hooks, the exporter |
| `ops/console/` | The console: server, terminal runner, web app, release pipeline |
| `ops/services/` | systemd units and their scripts (orchestrator, backups, monitors) |
| `ops/templates/` | Bead, reviewer, red-team and worker seed templates |
| `ops/config/` | Runtime config; `site.example.env` names the install |
| `ops/install/` | `bootstrap.sh` and `hqbox-provision.sh` for a fresh box |
| `ops/capri/`, `tools/capri*/` | Capri: deploy script and the Windows-side code |
| `ops/tests/`, `tests/` | Shell and Python tests for the scripts |
| `docs/STACK-MAP.md` | The map of the whole stack; read it before you change it |
| `docs/designs/` | Design notes for the larger parts |

Not here: `rigs/` (the project repos HQ works on), `state/` (runtime state), the
ledger database, the notes vault, and every secret.

## Install on a fresh box

Target: Ubuntu 24.04 on a machine that stays on. These steps are the outline;
`ops/install/hqbox-provision.sh` and `ops/install/bootstrap.sh` hold the detail and
are safe to re-run.

1. **Base system.** Ubuntu 24.04, a user for yourself, ssh. Read
   `ops/install/hqbox-provision.sh` before you run it: it raises a default-deny
   firewall, installs Tailscale and the base tools, and stops before anything
   interactive.
2. **Tools.** git, tmux, Node 22, Python 3, `jq`, the GitHub CLI (`gh auth login`),
   [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (log in once), and
   `bd` from the beads releases.
3. **Clone and name the install.**
   ```
   git clone <your fork> ~/hq
   cp ~/hq/ops/config/site.example.env ~/hq/ops/config/site.env   # then edit it
   ```
   `site.env` holds who this install belongs to: user, home, box name, tailnet host,
   git org, vault path. It is gitignored.
4. **Bootstrap.** `~/hq/ops/install/bootstrap.sh` installs dependencies, links
   `~/.claude` and the launchers, and runs canary checks. Its secrets step restores
   an age bundle that is not in this repo: skip it, and put your own keys in
   `ops/.env` (start from `ops/.env.example`).
5. **Ledger.** `cd ~/hq && bd init`, then `bd prime` for the full reference.
6. **Console (optional but useful).** `ops/console/v2/release/README.md` explains
   the build and release pipeline and `ops/console/v2/provision/` the users, units
   and TLS. The console authenticates by Tailscale identity (`tailscale whois`); without
   a tailnet you must replace that layer before you expose it.
7. **Tailscale (optional).** Needed for the console and for phone access; the rest
   runs without it.
8. **Capri (optional).** Needs a Windows PC reachable over ssh. Follow
   `ops/capri/README.md`, then `ops/capri/deploy-george.sh --bootstrap`.

Then open a terminal in `~/hq`, run `claude`, and ask it for `status`.

## Adapt it to you

- **Your rigs.** The rig table in `CLAUDE.md` is an example. Replace it with your
  own repos (path, default branch, deploy notes) and add a file per rig under
  `.claude/rules/rigs/` if a rig needs more than one line.
- **Your facts file.** Create `ops/reference/owner-facts.md` (rename it and the
  references to it if you like) with your standing answers: the decisions an agent
  would otherwise ask you about again. Agents read it before they ask.
- **Your names.** Scripts still use a few fixed names: the box (`hqbox`), the Windows
  PC (`george`), and `/home/...` paths in some units. `docs/SHARING.md` counts what
  is still tied to the original machine. Search for them before you run a service.
- **Your models and budget.** `ops/config/orchestrator.json` sets the model per role.
  The second-vendor review (`lucy`) needs an OpenAI key and has a daily cap.
- **Your notifications.** `ops/scripts/notify.sh` posts to ntfy; set your topic.

## Deliberately absent

- **Client data.** Every client and person name is replaced by a neutral placeholder
  (ClientA, Person A, example.com) before export, and the export is refused if any
  survives.
- **Secrets.** No keys, tokens, passwords or secret bundles. A leak gate refuses API
  key shapes, private keys, secret assignments, tailnet names, emails, phone numbers
  and public IPs.
- **State.** No ledger database, no runtime state, no logs, no notes vault, no git
  history of the private repo.
- **Binary files.** Fonts, audio cues and images are skipped by the exporter, so the
  console falls back to system fonts and plays no sounds until you add your own.

## How this repo is made

`ops/scripts/hq-public-export.sh --push <checkout>` selects the files the allowlist
names, scrubs them, gates the result, adds this README, `LICENSE` and
`CONTRIBUTING.md`, gates the checkout again, and commits with the source commit in
the message (`export from hq <sha>`). It commits nothing when nothing changed. See
`CONTRIBUTING.md` before you open a pull request.

## License

MIT; see `LICENSE`.
