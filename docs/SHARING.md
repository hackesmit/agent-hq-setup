# Running your own HQ

This is an honest account of what it takes for someone who is not the owner to run this
workshop, what already works, and what is still welded to one machine. It is written for
the person deciding whether to try, so it leads with the parts that would waste their
evening.

## What this is

An agent workshop, not a tmux tool. Work is broken into small units (beads) in a local
ledger, dispatched to Claude sessions that run in git worktrees, reviewed adversarially,
and merged one branch at a time. A web console on an always-on box shows what is waiting
on you, what is running, and what changed. tmux is how panes are held, not what the
system is about, so a setup built around tmux does not map onto this: the pieces that
matter are the ledger, the dispatch and review loop, the guards, and the console.

## What you need

- A Linux box that stays on (this install is WSL Ubuntu on a desktop, and a plain
  Linux box is simpler). It hosts the console and runs the workers.
- Node 22, git, tmux, and the Claude Code CLI.
- A Tailscale tailnet. The console binds one tailnet address and gates every connection
  on a `tailscale whois` owner check; that check IS the authentication. Without a
  tailnet you would need to replace the auth layer, which is not a config change.
- `bd` (beads) for the ledger.
- Optional: an Obsidian vault, an ntfy topic for phone pushes, Uptime Kuma.

## The short version

```
git clone https://<your git host>/<your org>/agent-hq ~/hq
cp ~/hq/ops/config/site.example.env ~/hq/ops/config/site.env   # then edit it
~/hq/ops/install/bootstrap.sh
```

`ops/config/site.env` is where an install says whose it is: the account, the box, the
tailnet name, the owner login, the git org, the vault path. It is gitignored, so a fork
keeps its own identity and never commits it.

## What is genuinely portable today

- The console: server, runner, and web. Every identity value it uses already comes from
  its unit environment (`CONSOLE_HOST`, `CONSOLE_OWNER`, `HQ_ROOT`, the meta terminal's
  WebAuthn identity, the cloud tokens). The defaults in `config.js` are this install's
  values, and they are defaults, not assumptions.
- The beads flow, the review discipline, and the verification receipts. Those are
  conventions in `CLAUDE.md` plus a few scripts; they carry over as written.
- The guards, in shape. They enforce a containment policy read from
  `.claude/settings.json`, which lists paths rather than hardcoding one person's.
- `ops/install/bootstrap.sh` and `hqbox-provision.sh`, which is more than most personal
  setups ever get: users, directories, systemd units, sudoers, TLS from the tailnet.

## What is still welded to this machine

Counted, not guessed, at the time of writing:

- **`/home/owner` in about 54 files.** Mostly shell scripts and systemd units. The
  units read `HQ_ROOT`; the scripts largely do not yet.
- **The tailnet name in about 12 files**, including the TLS certificate name and the
  WebAuthn relying party. This one cannot have a working default for anyone else.
- **The owner email in about 21 files**, which is a real control in the console and a
  string everywhere else.
- **The git org in about 20 files.**
- **The Windows vault path in about 17 files.** On a non-WSL box the vault is just a
  directory, and the outbox already isolates writes, so this degrades cleanly, but the
  paths are still spelled out.
- **The rig table lives in `CLAUDE.md`**, which is the constitution: it names the owner's
  four rigs, their branches and their deploy behavior. A fork has to replace that
  section wholesale.

None of these are hard problems. They are a day of careful work, and the reason they are
not done yet is that a workshop with one user never had to pay for it.

## The order that work should happen in

1. `ops/config/site.env` exists and the console reads it. **Done.**
2. A `LICENSE`. **Done: MIT.**
3. The shell scripts stop hardcoding `/home/owner` and read `HQ_ROOT`, and the units
   take an `EnvironmentFile`. Most of these live under `ops/scripts`, which agents do
   not edit; this is a proposal to the owner rather than a change any session can make.
4. `CLAUDE.md` gains an example rig table and moves the real one into a file a fork
   replaces. Constitution, so again a proposal.
5. A worked example: one throwaway rig, so a new operator can dispatch and merge a bead
   on day one without inventing a project first.

## Before this repo is shared

The code being clean is not the same as the repository being shareable. Even after
every path above is parameterized, the git history contains client project names, vault
notes, bead titles describing real work, and the shape of the owner's infrastructure. A
public fork should start from a fresh history, not from this one. That is a decision for
the owner, and this document does not make it.
