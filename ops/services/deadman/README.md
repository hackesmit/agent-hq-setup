# Timer dead-man's switch

`hq-deadman.sh <user|system>` runs every ten minutes (`hq-deadman.timer`, `hq-deadman-system.timer`).
It reads `ops/config/timer-cadence.json`: each timer has a `grace` in seconds. A timer whose service has
not exited with `Result=success` within its grace raises one alert (ntfy through `notify.sh`),
repeated at most daily, then one "recovered" ping. OnFailure alerts cover a unit that fails; this covers
silence. A missing or malformed cadence file, or a timer on the box with no cadence and no `ignore` entry,
is itself an alert.

`ignore_patterns` holds shell globs (snooze timers `hq-wake-s-*.timer` never alert). `checked_by` (default: the entry's `scope`) makes the other scope's run watch the entry; the deadman timers watch each other that way. Alerts use `notify.sh default`.

Add a new timer: put it in `timers` (with a grace of roughly three times its period) or `ignore`.
State is in `state/deadman/<scope>/`. Test: `bash ops/services/deadman/tests/hq-deadman.test.sh`.
Install (from main, after merge): `ops/services/deadman/install.sh`.
