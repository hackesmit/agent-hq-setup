# The meta terminal, "Capri" (console v2, phase 0)

> **Full trust, 2026-10-11 (the owner).** Capri now runs like every other console terminal:
> `--dangerously-skip-permissions`, `bypassPermissions` in `meta-settings.json`, no deny
> list, no passkey on hqbox (`CONSOLE_META_REQUIRE_PASSKEY=0`). The settings-integrity
> hook is unwired; the audit hook stays. The text below describes the earlier prompting
> design and is kept for history.

Display name: **Capri** (the owner, 2026-08-20). The session kind, scope names
(`hq-meta-<sid>`), env names and file names stay `meta`; only what the owner sees says Capri.

One the owner-only interactive session per box, opened from the console, that runs
outside the project cage so the stack itself can be changed: hooks, settings,
`ops/scripts`, templates, CLAUDE.md, the vault. It is not an uncaged agent. Every
mutating tool call stops and asks the owner in the terminal before it runs, which is the
property invariants 7 and 9 actually protect: agents do not change the cage, the owner
does.

Design source: `docs/superpowers/specs/2026-08-17-console-v2-design.md` section 3b.
Constitution change: `ops/proposals/19-meta-terminal.md`. Until the owner applies that
proposal, the runner's `meta` session kind stays behind its feature flag and this
directory is inert.

## What is in here

| File | Installed to | Owner |
| --- | --- | --- |
| `meta-settings.json` | `/var/lib/hqconsole/meta/meta-settings.json` | `hqconsole`, 0644, read-only to `owner` |
| `hook-meta-audit.sh` | `/var/lib/hqconsole/meta/hook-meta-audit.sh` | `hqconsole`, 0755, read-only to `owner` |
| `hook-meta-settings-integrity.sh` | `/var/lib/hqconsole/meta/hook-meta-settings-integrity.sh` | `hqconsole`, 0755, read-only to `owner` |

This repo directory is the source of truth; provisioning copies these three files to
`/var/lib/hqconsole/meta/`. They deliberately do NOT live under `~/hq`: the meta
session runs as `owner` and could otherwise edit the very hook that checks it.

The one path the session's own hooks write is the per-session state dir the runner
creates with `owner` write access:
`/var/lib/hqconsole/meta/sessions/<session-id>/` (override with `HQ_META_STATE`).

## How the runner launches it

Inside a transient systemd scope with a deterministic name, so every descendant is in
one cgroup and dies with the session:

    systemd-run --user --scope --unit hq-meta-<session-id> \
      --setenv HQ_META_STATE=/var/lib/hqconsole/meta/sessions \
      --setenv HQ_META_SETTINGS=/var/lib/hqconsole/meta/meta-settings.json \
      --setenv HQ_META_AUDIT=/var/lib/hqconsole/meta/audit.jsonl \
      --setenv HQ_META_PROJECT=/home/owner/hq \
      claude --setting-sources user \
             --add-dir /home/owner/hq \
             --settings /var/lib/hqconsole/meta/meta-settings.json \
             --permission-mode default

Notes on each part:

- `--setting-sources user` means the hq project cage is not loaded. That is the point:
  the session can edit cage files. `--add-dir` grants directory access only, it never
  loads `~/hq/.claude/settings.json`.
- `--settings` layers the meta settings on top: prompting permission mode, an empty
  allow list, the read-deny list, and the two hooks below.
- `--permission-mode default` is stated on the command line as well as in the settings
  file, so a settings file that lost the key cannot silently promote the session.
- The PTY is never written to disk. A terminal stream carries echoed keystrokes, so a
  pasted token would land in the file; replay is the runner's in-memory ring buffer
  only, and the audit trail is the hook lines described below.
- Never headless, never spawned by a bead, mail, cron, or another agent, never
  reachable by `ctl dispatch`. Start and attach require a fresh WebAuthn assertion from
  a passkey registered on the owner's devices; the server mints a one-use capability bound
  to that browser connection. Self-peer connections are refused at the socket layer, so
  a worker on hqbox cannot reach the endpoint at all.
- Caps: idle 30 minutes, hard 2 hours, and browser detach all stop the scope
  (`systemctl --user stop hq-meta-<id>`, SIGTERM then SIGKILL to the whole cgroup).

## Start refusal rules

The runner refuses to open a meta session, with the reason on a card, when any of:

1. `~/.claude/settings.json` contains a `permissions.allow` entry for a mutating tool
   (`Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`). A user-level allow rule would
   silently pre-approve exactly what the prompt exists to catch.
2. `/var/lib/hqconsole/meta/meta-settings.json` contains any such allow entry, or its
   `permissions.defaultMode` is not `default`.
3. Either settings file, or either hook script, is writable by `owner`, or a hook
   script named in the meta settings is missing or not executable.
4. The per-session state dir cannot be created with `owner` write access.
5. The request carries no fresh passkey assertion, or the peer is the box itself.
6. A previous meta session record has no close event (crash): the runner runs the close
   checks for that record first and pins the result before serving a new one.

Rules 1 and 2 are checked again at every attach, not only at start.

## While the session runs

`hook-meta-settings-integrity.sh` (PreToolUse on Bash, Write, Edit, MultiEdit,
NotebookEdit) records the sha256 of the user settings, the project
`settings.local.json`, the project `settings.json` and the meta settings file on its
first call for a session id, and recomputes them on every later call. If any hash
differs, or a file appeared or disappeared, it prints the reason, exits 2 (the tool call
does not run), and writes `<session-dir>/INTEGRITY_FAILED` with the reason. The runner
watches for that marker: it stops the scope, reverts the rule, and pins a card.

Why it is synchronous and not a watcher: an "always allow" answer persists an allow rule
into a settings file and the running process applies it immediately, so an asynchronous
watcher would see it only after the next tool call had already run unprompted. Because
the check is inside the call path, a second mutation cannot slip through between the
persisted rule and the revert. An inotify watcher stays as a belt for the non-tool case.

The hook fails CLOSED: an unusable state dir, an unreadable settings file, or a missing
meta settings file blocks and says why. Measured cost is about 16 ms per call on the
laptop (one `sha256sum` call, no python, no background work), budget 50 ms.

`hook-meta-audit.sh` (PostToolUse, matcher `*`) appends one JSON line per tool call to
the audit trail and never blocks anything, ever, for any reason.

## Audit trail

`/var/lib/hqconsole/meta/audit.jsonl` (override with `HQ_META_AUDIT`), one object per
line:

    {"ts":"2026-08-18T14:03:11Z","session_id":"...","tool":"Bash","target":"git status"}

`target` is the `file_path` for Write, Edit, MultiEdit and NotebookEdit, the first 120
characters of the command for Bash, the `url` for WebFetch, and empty for everything
else. Nothing else is recorded: no arguments beyond that prefix, no file contents, no
output, no keystrokes.

This is a trail, not a tamper-proof log. The session runs as the same Unix user and can
delete the file mid-run; what it cannot do is unsee what the runner already forwarded.
The real control is the close check below.

## Close: reconciliation and sweep

A transient scope handles descendants, including anything that forks, `nohup`s, or
ignores SIGHUP. The one escape is the owner's own systemd user manager, so the runner
snapshots at start and diffs at close. Reconciliation is not a blind restore, because
the owner may legitimately change things from another terminal during a two-hour session:

- Items that did NOT exist at session start are stopped, disabled or removed
  automatically, and listed with a one-click restore in case one was legitimate.
- Items that existed at start and CHANGED are not touched automatically; they are shown
  as a diff card in Now with Revert / Keep per item, and the session stays marked
  "unreconciled" until the owner answers.

Swept surfaces, all with the same rule:

1. User systemd manager: unit file hashes under `~/.config/systemd/user`, plus the
   enabled and active state of every unit, timer and scope.
2. User crontab.
3. `at` jobs.
4. Login-shell files and autostart dirs: `~/.profile`, `~/.bashrc`,
   `~/.config/autostart`.
5. Lingering `hq-meta-*` scopes: the runner's first act at start is to stop any that
   survived a SIGKILLed runner, and run the user-manager diff for them.

Then the cage checks, whose result is pinned to Now until the owner acknowledges it:

6. `ops/scripts/canaries.sh`.
7. The hq.sh cage-integrity diff: `git diff` of `.claude`, `ops/githooks`, `ops/scripts`,
   `ops/templates` and `CLAUDE.md` against HEAD.

If the runner or the host dies with a session open, the session record has no close
event, and the next runner or console start runs 5 to 7 for it and pins the result, so a
crash cannot skip the check.

The honest limit: a session could write a persistence mechanism this sweep does not know
about. That is exactly why every action needed the owner's keypress in the first place.

## Credentials

The meta session gets none, and not by Claude rules alone. A `permissions.deny` entry
stops the tool layer, but an approved script running as `owner` can still `open()` a
file, so the boundary is the OS: the git credential store and the ops env file move out
of `owner`'s reach and become readable only by the daemon users that need them
(`hqsync` owns the PAT; the mail loop and console collectors read their tokens from
Proton Pass at start). The deny list in `meta-settings.json` stays as a courtesy layer.
That credential move is part of proposal 19, because credential scope is the owner's.

Proton Pass is unchanged and stated plainly: agents already fetch API tokens through
`pp` by accepted policy, with the exfil and secret-in-file guards as the control.

Pushes keep flowing through git-sync: the meta session commits, `hqsync` pushes.

## Tests

`bash ops/console/v2/tests/guards/run.sh` covers both hooks (audit logging and its
fail-open behaviour, the integrity baseline, unchanged pass, changed user settings
block plus marker, appearing `settings.local.json`, missing meta settings, unusable
state dir, cost budget) and the meta settings file (valid JSON, prompting mode, no
mutating allow rule), alongside the proposal 21 guard fixtures.
