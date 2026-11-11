---
paths:
  - "ops/scripts/hook-*"
  - ".claude/settings.json"
  - ".claude/settings.local.json"
  - "state/verify/**"
---

# Hook internals

- Verification: a `PostToolUse` recorder logs every change and every verification command to `state/verify/$SESSION.jsonl` (audit trail; the weekly retro's ledger-health check reads it; session-eval rebuilds from the transcript, not this file). A `PreToolUse` gate on `bd close` checks the bead for a matching receipt: for code/deploy changes with no receipt and no `not run` reason it BLOCKS and prints the receipt line to add; for every other class it logs the gap and passes. `HQ_VERIFY_BLOCK=0` turns the gate to audit-only.
- The memory-promise hook (`ops/scripts/hook-memory-promise.sh`, a Stop hook) watches for rule-shaped memory writes or first-person promises made without an accompanying enforcing artifact, and files them as P1 "unenforced correction" beads so the promise becomes real acquisition-style work reviewed keep-or-revert at the retro.
- The session eval (`ops/scripts/hook-session-eval.sh`, a Stop hook) is fire-and-forget: it catches scope drift, guardrail-fighting, wrong-target action, credential exposure, and the claim-vs-evidence gap. Its verdict lands as a P2 `session-eval` bead (ESCALATE raises a P1 and can spawn a fresh-context verification agent). The weekly retro mines these alongside rework and escalations.
- Four workflow hooks (added 2026-07-17, adapted from the CC-toolkit peer set) are canary-gated and fail-open: `hook-url-verification-gate.sh` (Stop) blocks ending a turn that calls a controlled url live/ready/deployed when nothing in the turn actually fetched it (curl/WebFetch/200 evidence required; third-party urls are never gated). `hook-commit-branch-check.sh` (PreToolUse Bash) refuses a direct `git commit` on a rig's canonical default branch (worktrees, the hq repo, and non-default branches all pass). `hook-no-em-dash.sh` (PreToolUse Write/Edit/MultiEdit and commit messages) blocks em dashes and AI-decoration glyphs (arrows, check/cross marks, box-drawing, bullets) in written content. `hook-compact-suggest.sh` (PreToolUse, non-blocking) nudges `/compact` on long sessions.
- The egress ledger (a hook) auto-logs every new domain any session contacts, grants it in .claude/settings.local.json, files the acquisition bead, and pings the owner.
