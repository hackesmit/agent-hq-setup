---
paths:
  - "ops/scripts/spawn.sh"
  - "ops/scripts/stall-watch*"
  - "ops/scripts/snooze.sh"
  - "ops/console/ctl.sh"
  - "state/objectives/**"
  - "rigs/**/graphify-out/**"
---

# Dispatch internals

- spawn.sh's pane goes in the `hq:work` window (watch it live). It is on the hqterm tmux server when hq started from a console terminal, and the console's own terminals are `hqt-*` sessions under hq-runner; stall-watch watches both.
- Why batching matters: every spawn re-reads CLAUDE.md and the seed before doing any work, so a session per one-line bead pays that cost repeatedly; on 2026-08-12 that was 20 sessions and 3.1M output tokens in a day. dispatch-batch caps a session at 8 beads, so a larger epic dispatches over successive sessions.
- n8n workflow JSON will not graph meaningfully in graphify; prose docs and PDFs will.
- After a rig merge, `graphify update .` in the rig keeps main's graph authoritative; the post-checkout hook only covers worktrees.
