---
paths:
  - "ops/scripts/finish.sh"
  - "ops/scripts/drift-check.sh"
  - "ops/scripts/drift_check.py"
  - "ops/scripts/eval-gate.sh"
  - "ops/scripts/vercel-deploy.sh"
  - "ops/config/runtime.json"
  - "ops/config/vercel-deploy.json"
  - "state/evals/**"
---

# Merge gates inside finish.sh

- finish.sh commits pending work, refreshes codemaps, conflict-checks then merges the branch into the rig's local default, closes the bead only with a matching `Verification:` receipt, removes the worktree, and kills the pane. Without `--confirm` it prints a dry finish-plan and changes nothing; on a conflict or a missing receipt it stops and leaves the branch, worktree and pane for the owner (status `finishable`).
- Drift gate: it runs `ops/scripts/drift-check.sh` (declared in `ops/config/runtime.json` versus what runs) BEFORE merging, at the default tip and at the would-be merge result in a throwaway worktree, when the merge touches a path drift-check reads. It refuses the merge (nothing merged, the default branch is never reset) only when the result ADDS a drift item; pre-existing drift never blocks, and `HQ_DRIFT_BLOCK=0` overrides.
- Eval gate (hq-43e6.3): `ops/scripts/eval-gate.sh` refuses a merge that changes a chatbot's behavior files (the rig's `evals/prompt-files.txt`: prompt, tools, model, call parameters) unless that bot's eval passed on exactly the merged content (receipt `state/evals/<rig>/<hash>.json`, written only by a fully green eval). `HQ_EVAL_BLOCK=0` overrides and the reason goes on the bead.
- For rigs in `ops/config/vercel-deploy.json` (acme-avance today) a push does NOT deploy (Vercel Hobby blocks your-gh-user's commits): finish.sh publishes by API after the merge.
