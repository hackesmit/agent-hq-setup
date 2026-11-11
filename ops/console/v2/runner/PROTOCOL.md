# hq-runner protocol (v1)

The runner is a separate daemon (user hqconsole, systemd socket activation on
/run/hqconsole/runner.sock, 0660 hqconsole:hqconsole) that owns terminal
sessions so the console server can restart or be redeployed without touching a
running PTY. The console connects over the unix socket; the browser never does.
Design: docs/superpowers/specs/2026-08-17-console-v2-design.md, "Terminal
runner" and 3b (meta terminal).

Transport: newline-delimited JSON, one object per line, both directions.
Every request carries `id` (client-chosen, echoed on the reply). Events (data,
exit) carry `sid` and no `id`.

## Handshake
- C: `{"id":1,"op":"hello","protocol":1,"release":"<sha>"}`
- S: `{"id":1,"ok":true,"protocol":1,"release":"<sha>","state":"serving|draining","sessions":[...]}`
A protocol mismatch answers `ok:false, error:"protocol"` and the console shows
"runner update pending" (the runner is never restarted by activation).

## Session kinds
- `worker`: headless job (`claude -p ...` or any argv), keyboard never accepted,
  output streamed and appended to `/var/lib/hqconsole/term/<sid>.log`.
- `interactive`: real PTY, keyboard accepted, no disk log (ring buffer only).
- `meta` (shown to the owner as "Capri"): interactive plus the meta rules (transient scope, WebAuthn capability
  checked by the console before it asks the runner, start refusal on allow
  rules, close reconciliation and sweep, lingering-scope kill at runner start).
- `tmux`: attach to an existing tmux pane (capture-pane seed, owned pipe-pane
  stream, send-keys only when `writable`), for sessions spawned by spawn.sh
  today. `sid` is the tmux pane id, resolved through the owner wrapper.

## Requests
- `spawn {kind, argv, cwd, env?, cols, rows, rig?, bead?, label?, log?:bool}`
  -> `{ok, sid}`; refused with `error:"draining"` while draining.
  An `interactive` spawn with `persist:true` (and optionally `resumeArgv`) is a
  persistent console terminal (2026-10-09): the argv runs in a session `hqt-<sid>`
  on the hqterm tmux server (wrapper verbs term-new/term-attach/term-has/term-kill,
  own user scope `hq-term-tmux.scope`), and the PTY holds only a tmux client. The
  record is kept in the state file under `terms`. On start, before serving, the
  runner re-attaches every record whose tmux session is alive (same sid), and
  runs `resumeArgv` in a fresh tmux session for every one that is not (reboot),
  at most RUNNER_TERM_RESUME_MAX (3) times per RUNNER_TERM_RESUME_WINDOW_MS
  (10 min). A client exit with the tmux session still alive is not an `exit`
  event; `kill` ends the tmux session too. Persistent terms never block a drain.
- `attach {sid, cols, rows}` -> `{ok, replay:"<last N KB>", writable, cols, rows}`;
  then events `data {sid, data}` until `detach` or exit.
- `detach {sid}` -> `{ok}`
- `input {sid, data}` -> `{ok}` or `error:"read-only"` for worker/tmux-readonly.
- `resize {sid, cols, rows}` -> `{ok}`
- `kill {sid, signal?}` -> `{ok}`
- `term.snooze {sid, wakeAt}` -> `{ok, sid, wakeAt}` (2026-10-20): a persistent
  console terminal only (it needs `resumeArgv`). Ends the tmux session, keeps the
  record with `snoozedUntil`, and at that time (polled every 30 s) runs
  `resumeArgv` under the same sid. A snoozed record is skipped by the start-up
  restore and listed as `{alive:false, attachable:false, snoozedUntil}`.
- `term.wake {sid}` -> `{ok, woke:[sid]}`: wake a snoozed terminal now.
- `term.redraw {sid}` -> `{ok, redrawn}` (2026-10-20): a persistent console
  terminal only; anything else is refused with `error:"not a console terminal"`
  (an adopted hq:work pane shares its tmux window with the tiled panes). Resizes
  the PTY one row smaller and back after 60 ms, so tmux and the program inside
  repaint the whole screen. `redrawn:false` means nothing was done: the session
  is dead, too short, or a wiggle is already under way.
- `term.fg {sid}` -> `{ok, command}` (hq-ymxzt.3): a persistent console terminal
  only (else `error:"not a console terminal"`). `command` is the foreground
  program of its tmux pane (`pane_current_command`, for example `claude` or
  `bash`), or null when tmux cannot tell. Read-only; Capri say types only when it
  is `claude`.
- `list` -> `{ok, sessions:[{sid, kind, argv0, cwd, rig, bead, startedAt, alive, exitCode, writable, snoozedUntil?}]}`
- `drain` -> `{ok, state:"draining"}` (no new spawns; the runner exits by itself
  when the session count reaches zero and systemd restarts it into the new release)
- `restart` -> `{ok, state, pending, blocking}` (hq-4npjr.20): what activation
  sends when runner/ changed. With no blocking session (persistent terms and
  adopted tmux panes never block; worker PTYs, the meta session and a meta close
  in flight do) it is `drain`: `state:"draining"`, `pending:false`. Otherwise
  `state:"serving"`, `pending:true`: new spawns still work, and the runner drains
  itself when the last blocking session ends. While pending, a meta session with
  no input for `RUNNER_META_RESTART_IDLE_MS` (default 1 h, 0 = never) is closed
  (endedBy `runner restart`). Idempotent.
- `status` -> `{ok, state, restartPending, sessions:n, release, protocol, uptimeS}`
- `meta.capability` -> `{ok, capability, expiresInS}`: a one-use ticket (60 s) the
  console presents as `spawn {kind:"meta", capability}`; refused with
  `meta disabled` while `RUNNER_META_ENABLED` is off and with `meta session
  already live` while one runs. `spawn kind=meta` takes no argv: the wrapper pins it.
- `meta.status` -> `{ok, enabled, live:{sid,startedAt,lastInputAt,attachers}|null,
  capabilities, lastClose:{sid,closedAt,endedBy,reconcile,integrity}|null,
  unreconciled:[sid], idleMs, capMs}` (also carried in the `hello` reply as `meta`).

## Events
- `data {sid, data}` (UTF-8 text; the runner does not re-encode)
- `exit {sid, code, signal}` followed by session removal after 60 s (attachers get
  the final replay until then)
- `meta.reconcile {sid, endedBy, at, autoReverted:[{kind,name,ok,action}],
  changed:[{kind,name,from,to,revert}], errors:[]}` and
  `meta.integrity {sid, ok, at, report:{canaries,cage}|null, error, integrityFailed}`
  after a meta session closes (detach grace, idle, cap, kill, integrity marker, exit,
  or the start sweep for a record with no close event). Sent to every connection.

## Meta session rules (enforced by the runner, not the console)
0. Everything below is behind `RUNNER_META_ENABLED=1` (unit env, root flips it;
   default off). Off means `meta.capability` and `spawn kind=meta` answer
   `meta disabled`.
1. Refuse `spawn kind=meta` unless the console passes a capability the runner
   minted for exactly one start (`meta.capability` request, 60 s TTL, spent on
   first use whether or not the start succeeds). One live meta session per box.
2. Refuse when the wrapper's `meta-check` says so: `~/.claude/settings.json` with
   a `permissions.allow` entry for Bash, Write, Edit, MultiEdit, NotebookEdit or
   with any user-level hooks; meta settings not `defaultMode: default` or with
   such an allow entry; meta dir, settings or hooks writable by owner, hooks not
   directly inside the meta dir, missing or not executable; audit file not
   appendable; session state dir not creatable. The reasons come back in the
   `spawn` error detail.
3. Launch as owner through the wrapper's `claude-meta` verb inside a transient
   user scope `hq-meta-<sid>` (`systemd-run --user --scope`), with the flags
   `--setting-sources user --add-dir /home/owner/hq --settings /var/lib/hqconsole/meta/meta-settings.json --permission-mode default`.
4. Snapshot before start (user units and timers with file hashes and states,
   crontab, at queue, shell/autostart files); on close (detach, 2 h cap, 30 min
   idle, kill): stop the scope (SIGTERM then SIGKILL of the whole cgroup), diff
   the snapshot, auto-revert new items, emit `meta.reconcile {sid, autoReverted:[], changed:[]}`
   for the console to turn into cards, run canaries and the cage-integrity diff
   through the wrapper and emit `meta.integrity {sid, ok, report}`.
5. At runner start: stop any lingering `hq-meta-*` scope and reconcile sessions
   whose record has no close event (results land in `meta.status.lastClose`).
6. Never write the PTY stream of interactive or meta sessions to disk.
7. Stops: idle 30 min without keyboard input (`RUNNER_META_IDLE_MS`), 2 h cap
   (`RUNNER_META_CAP_MS`), the last attacher detaching for longer than the grace
   (`RUNNER_META_DETACH_GRACE_MS`, 15 s, so a page refresh is not a kill), an
   `INTEGRITY_FAILED` marker from the settings-integrity hook (polled every
   `RUNNER_META_MARKER_POLL_MS`), or `kill`. Every path ends in the same close
   reconciliation.
