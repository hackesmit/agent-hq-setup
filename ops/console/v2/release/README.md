# HQ Console v2 release pipeline

Beads: hq-dgnf (this directory), hq-qwj2 (`../provision`).
Design: `docs/superpowers/specs/2026-08-17-console-v2-design.md`, sections 3, 3b, 6, 8, 9.

The console server, the terminal runner and the web bundle are **one release**,
not three. A single directory per mirror commit holds all of them, one symlink
switch publishes them together, and rollback moves the same symlink back. That
is why the frontend and the API it talks to are never from different commits.

Nothing in the pipeline ever reads or executes `~/hq`. The working tree is
worker-writable; a caged worker that could edit what the build user runs would
own the build user, and one that could edit what the activation unit runs would
own root. So the build reads a git mirror, and the two scripts live in a
root-owned `/usr/local/lib/hq-console`.

## The pieces

| Path | Runs as | What it is |
| --- | --- | --- |
| `build.sh` | hqbuild | mirror commit to `/var/lib/hqbuild/out/<sha>` |
| `activate.sh` | root | `out/<sha>` to `/var/lib/hqconsole/releases/<sha>`, health-gated switch, rollback |
| `harness.sh` | owner, laptop | local end-to-end test of both, with stubs |
| `units/` | root | the systemd units, installed by the provisioning script |
| `../provision/hqbox-console-provision.sh` | owner on hqbox | users, dirs, node, sudoers, tmpfiles, units, TLS |

## The flow

```
hub-sync (hqsync)  ->  /var/lib/hqsync/mirrors/agent-hq.git
                          |
console-build.timer (5 min)
   -> console-build.service (hqbuild)  -> build.sh
        clone --no-checkout, sparse ops/console/v2
        npm ci --ignore-scripts            (full: vite is a devDep)
        node_modules/.bin/vite build       (never `npm run`)
        npm ci --ignore-scripts --omit=dev (server + runner only)
        npm rebuild node-pty  + pty smoke test
        assemble, reject symlinks, RELEASE.json, .complete
        -> /var/lib/hqbuild/out/<sha>
   OnSuccess=
   -> hq-console-activate.service (root)  -> activate.sh --latest
        rsync into /var/lib/hqconsole/releases/<sha>, reject symlinks, chown
        server.js --check as hqconsole, 30 s, needs {"ok":true}
        switch releases/current  (ln to a temp name, then mv -T)
        systemctl restart hq-console.service
        wait 30 s for state/health.json {sha, at, port}
        on failure: switch back, restart, exit 1
        runner/ changed since the release the runner runs, and no
        non-persistent session alive: send drain; otherwise defer, return
```

`hq-runner.service` is **never** restarted by activation. It owns live PTYs. It
drains itself (advertise `draining`, exit 0 once no non-persistent session is
alive) and comes back through `hq-runner.socket`, which stays listening so a
spawn arriving mid-restart queues instead of failing. Persistent console
terminals live on in tmux and the new runner re-attaches them under the same
sid, so they never hold a drain up.

What activation does about the runner (step 5b, after a healthy switch, after
a healthy `--rollback`, and on a run that finds the target already current):

1. it asks the runner over `/run/hqconsole/runner.sock` (`hello`, then
   `status`) which release it runs;
2. it hashes `runner/` plus `node_modules/node-pty/package.json` in that
   release and in the new one. Equal hashes, or a runner that already runs the
   target, or a runner already `draining`: nothing more is sent;
3. otherwise it sends `list` and counts the sessions that are alive and not
   `persistent`: workers, adopted `hq:work` panes (kind `tmux`) and the meta
   session. Persistent console terminals do not count; they live on in tmux
   and re-attach under the same sid;
4. only when that count is 0 does it send `drain`. The runner then exits at
   once and socket activation starts the new release. When the count is not 0
   it sends nothing and logs `runner restart deferred: N session(s) would
   block it`.

Why it defers instead of draining and waiting: a draining runner refuses
`spawn` and `meta.capability` until every blocking session has ended, and
adopted worker panes and the meta session live for hours and keep being added
(viewing a worker pane adopts it). A drain sent with any of them alive would
leave the console unable to start a terminal for that whole time. Activation
never waits and never kills a session. A deferred restart is retried by every
later run, including the 5-minute timer finding the release already current,
which compares against the release the runner still runs, so the new runner
code goes live at the first run with no blocking session. Until then the old
runner keeps serving. There is a small window between `list` and `drain` in
which a new session could start; it then holds the drain up like any other
blocking session.

Every runner problem in this step (no socket, a query that fails or times out
after 10 s, a release with no `runner/src/runner.js`) is a warning; the console
release is already live and healthy, so activation still exits 0. If the
runner cannot say which release it runs, the release being switched away from
is the comparison base. `RELEASE_RUNNER_DRAIN=0` skips the step;
`RELEASE_RUNNER_SOCKET` moves the socket (the harness points it at a fake
runner in its temp tree, so `harness.sh` never touches the live socket).
`activate.sh` itself is a root-owned copy installed by provisioning (see
below), so this step reaches hqbox only once provisioning is re-run.

## Health, and why there is no health URL

The server refuses connections from its own node (`tailscale whois` self-peer
refusal, design section 3). A `curl` from hqbox would therefore be rejected by
design and would prove nothing about the release. The contract instead is a
file: on a successful listen the server writes

```json
{"sha": "<release sha>", "at": "<iso timestamp>", "port": 8787}
```

to `/var/lib/hqconsole/state/health.json`. `activate.sh` accepts the release
only when the stamp names the new sha **and** its mtime is after the switch, so
neither a stale stamp from the previous release nor an old stamp from an
earlier run of the same sha can pass.

## First boot, in order

1. `bash ~/hq/ops/console/v2/provision/hqbox-console-provision.sh --check`
   and read what it intends to do.
2. `bash ~/hq/ops/console/v2/provision/hqbox-console-provision.sh`
3. Run the hub-sync rollout (`ops/console/v2/sync/rollout-hqbox.sh`, bead
   hq-4m5u) so `/var/lib/hqsync/mirrors/agent-hq.git` exists. Provisioning
   creates the `hqsync` user, `/var/lib/hqsync` and the `hqmirror` group that
   rollout expects, and nothing else about the mirrors.
4. `sudo systemctl start console-build.service` and watch
   `journalctl -u console-build.service -f`. This is deliberately manual: the
   provisioning script enables `console-build.timer` but does not start it, so
   the first build and the first activation happen while someone is looking.
5. The build's `OnSuccess=` starts `hq-console-activate.service`, which
   performs the first switch and starts `hq-console.service`.
6. `sudo systemctl start console-build.timer` to hand over to the 5 minute
   poll.
7. Open `https://hqbox.example.ts.net:8787` from another tailnet device.
   Not from hqbox itself: self-peer connections are refused.

## Rollback

```
sudo /usr/local/lib/hq-console/activate.sh --rollback
```

Moves `current` to the sha recorded in `releases/.previous`, restarts the
console, and waits for the health stamp. A rollback is itself reversible: it
rewrites `.previous` with the sha it just left.

Automatic rollback happens inside a failed activation and needs no operator: if
the candidate check fails, `current` never moves at all; if the new release
fails to come up after the switch, `current` goes back and the old release is
restarted before `activate.sh` exits 1.

Retention keeps three releases (`current`, the previous, and one more) plus
anything listed one sha per line in `releases/.pinned`, which is how phase 1
will keep a release alive while a runner is still executing it.

## Store compatibility, so rollback stays possible

`uploads.sqlite`, the money ledger and the runner's session records follow
expand-then-contract: release N may add columns, tables or fields with defaults
that N-1 ignores, and may never rename, drop, or change the meaning of
anything. A destructive contraction ships only once N is the rollback floor.
`--check` compares the store schema version against what the candidate
understands.

## Test hooks

Both scripts read a handful of environment variables so `harness.sh` can run
them on a laptop with no root, no compiler and no registry. They are documented
in each script's header and **must never be set in production**:

- `build.sh`: `RELEASE_NPM`, `RELEASE_VITE`, `RELEASE_REGISTRY`, `SKIP_NATIVE`,
  `SMOKE_PTY`
- `build.sh` origin wait (safe in production, defaults 120 and 5): `HUB_ORIGIN_WAIT`,
  `HUB_ORIGIN_POLL`. A head not yet on origin waits that long, then exits 0 with a
  `deferred:` line and the next timer poll retries (hq-oq30g.3);
  `release/build-origin.test.sh` covers it.
- `activate.sh`: `RELEASE_SYSTEMCTL`, `RELEASE_SERVER_CMD`, `RELEASE_NODE`,
  `RELEASE_RUN_AS`, `RELEASE_OWNER`, `RELEASE_STATE_DIR`,
  `RELEASE_CHECK_TIMEOUT`, `RELEASE_HEALTH_TIMEOUT`, `RELEASE_SMOKE_PTY`,
  `RELEASE_RUNNER_SOCKET`, `RELEASE_RUNNER_DRAIN`

`bash release/harness.sh` builds a throwaway bare mirror from this repo, commits
a small fake server into it, starts a fake runner on a socket in its temp
tree, and runs twelve cases: build, build-again-skips, activate,
activate-again-no-ops, candidate failure (no switch), post-switch failure
(rollback), clean activation of a second commit, a manual rollback, activation
of a commit that changes `runner/` while an adopted pane is alive (no drain,
restart deferred), a re-run with only persistent terminals alive (the deferred
drain is retried and sent), a rollback across that change (drain sent), and
activation with the runner socket gone (warning only). The cases that do not change `runner/` assert that no
drain was sent. `--keep` leaves the temp tree for inspection.

What the harness does **not** cover, on purpose: the node-pty compile and the
PTY smoke test, because this laptop has no `make` or `g++`. Those are covered
by the first real build on hqbox. If the build unit ever turns out to be unable
to allocate a PTY, set `SMOKE_PTY=0` on `console-build.service` and
`RELEASE_SMOKE_PTY=1` on `hq-console-activate.service`; `activate.sh` then runs
the same test against the published release, as the console user, which also
proves `hqconsole` can load the compiled binding.

## Symlinks

Both the build and the activation reject any symlink in the tree they produce.
The served and executed root is resolved once and every requested path is
checked against it, so a link is either dead weight or a way out. npm creates
two kinds on every install and `build.sh` removes them explicitly rather than
tolerating them: `node_modules/.bin/*` shims (never used at runtime) and
`node_modules/@hq/*` workspace links (re-materialised as a real directory for
`@hq/console-shared`). If a dependency ever ships its own symlink the build
fails loudly with the path, which is the right outcome for a decision nobody
should make silently.

## Phase 0 limits, and what phase 1 owes

- **Builder egress is unrestricted.** `console-build.service` sets no network
  policy. The mitigations are a pinned lockfile, `--ignore-scripts` (so no
  package runs a lifecycle command), an explicit `--registry`, and a mirror the
  builder can only read. A hard restriction (`IPAddressAllow=` over the
  resolved registry set, or a network namespace) is phase 1 hardening.
- **No self-update of the pipeline.** `build.sh` and `activate.sh` are copied
  into `/usr/local/lib/hq-console` by the provisioning script. Changing either
  one means re-running provisioning. Phase 1 should make activation install the
  new pipeline scripts from the release it just published, with the same
  candidate-then-switch discipline, so the pipeline updates itself the way
  everything else does.
- **A runner restart can be deferred indefinitely.** Activation drains only
  when no non-persistent session is alive (see above). While workers or
  adopted panes are always open, every run logs `runner restart deferred` and
  the old runner keeps serving the old runner code. `status` on the runner
  socket shows the release it still runs.
- **The runner's unit sandbox is deliberately weak** and must stay that way.
  A transient scope started with `systemd-run --scope` registers a process the
  runner forked, so the child inherits the runner's namespaces. Setting
  `ProtectSystem=strict`, `ProtectHome=` or `PrivateTmp=yes` on
  `hq-runner.service` would be inherited by every worker and interactive
  session and would make them unable to write `~/hq` or `/tmp`. The runner's
  containment is the Unix user plus the single-command sudo rule, not unit
  hardening.
- **`tailscale whois` access for hqconsole is unresolved.** The tailscaled
  LocalAPI socket is root-owned by default and `tailscale set --operator` names
  one user. The auth bead (P0.2) has to settle whether `hqconsole` is granted
  that socket or the lookup is proxied. Do not widen `hq-console.service` to
  paper over it.
