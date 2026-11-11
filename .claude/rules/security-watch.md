---
paths:
  - "ops/security/**"
  - "ops/config/security-tiers.json"
  - "state/security/**"
---

# Security watch

`ops/security/match.sh` writes the day's findings (one per advisory, package and rig). `ops/security/route.sh` turns them into beads. Each vulnerable package version in a rig gets one bead with a DoD. The bead goes in the rig's own ledger when the rig has one, otherwise in hq with the rig label. Its external ref is `secwatch:<rig>/<ecosystem>/<package>@<installed>`. A finding that is already routed (`state/security/routed.json`, or any ledger that already holds that ref, open or closed) is never filed twice. When it gains an advisory, a higher fixed version or a higher tier, its bead's title, description, priority and labels are rewritten and it gets a comment; an escalation to C pages once. Every such side effect is queued in the routing state and retried on later runs until it succeeds, a bead found only in a ledger is adopted with its tier and dispatch state read back from the bead, and one run holds an exclusive lock. The policy data is `ops/config/security-tiers.json`. These are the tiers:
- **Tier A, autonomous:** a patch bump, KEV known to be false, not malicious, on a rig with no money, auth, data or public class. route.sh dispatches a Sonnet worker, at most two each run. The worker bumps, runs the tests, commits, gets a fresh-context Opus 5.5 review, re-checks that the bead is still tier A with the same target, and on approve runs finish.sh itself. This is the one case where a worker merges its own branch. A red test or a non-approve makes it tier B.
- **Tier B, the normal flow:** any minor, major or unknown bump, or any money, auth, data, public or unknown rig. Also KEV unknown (`kev: null`, catalog unavailable: unknown never means not exploited), and a fix version with no known publish date. The bead is `redteam`. The coordinator dispatches it, and it gets a red-team pass and `lucy` before merge.
- **Tier C, P0:** KEV or malicious on a live rig, or an own-code finding (`own_code: true`). It gets a P0 bead and `notify.sh urgent` once. Every rig counts as live unless the policy sets `live: false`.
- **Cooldown:** no fix installs a version published less than `cooldown_days` (7) ago. A tier A bead waits until the date, and route.sh dispatches it on a later run. Only a KEV fix may bypass the cooldown (`--min-release-age=0` on that one install). A malicious-package fix may not.
