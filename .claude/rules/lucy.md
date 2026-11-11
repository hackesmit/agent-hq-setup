---
paths:
  - "ops/scripts/review.sh"
  - "ops/templates/reviewer.md"
  - "ops/templates/redteam.md"
---

# lucy internals

`lucy` is an alias of `review`. It sends the diff to an OpenAI model (gpt-6.1-sol, a constant in ops/scripts/review.sh; `--model` overrides it per call; reasoning effort xhigh when the rig is money, auth, data or unknown in ops/config/security-tiers.json and high otherwise, `--effort` overrides), a hostile second opinion from a different vendor, and returns findings plus `VERDICT: SHIP | REVISE | BLOCK`. With no args it reviews the current branch against the repo default; or `lucy --rig R --branch <worker branch> [--base BRANCH] "<what changed + its DoD>"`.

Flags and limits: `--bead ID` (else `HQ_BEAD`) tags the call in the log, `ops/metrics/lucy-calls.jsonl` (gitignored; one JSON line per call that reaches the API, failed calls too). `LUCY_DAILY_CAP_USD` (default 5) caps the UTC day's logged spend; the cap ignores cost values that are negative or not finite. Raising it costs money only.

Exit codes: 0 = reviewed, with a `VERDICT:` line. 7 = the answer had no VERDICT line, so treat the review as not run. 6 = refused (daily cap reached, unpriced model, call log unreadable or unwritable): lucy did NOT run, which is the "lucy cannot run" case in CLAUDE.md, never a pass. 5 = empty answer twice. 4 = API failure. The prompt BLOCKs money, data loss (including permanent cross-tab or replica divergence) and security.
