# Weekly retro — headless run

Read the last 7 days of beads across all rigs (`bd list` in each rig under ~/hq/rigs/, including closed beads). Also skim the last 7 daily notes in the vault (04 Daily/).

Report, in this order:
1. Reworked beads (reopened, or review verdict REQUEST-CHANGES) and why.
2. Escalations and their root causes.
3. Review comments that repeat across beads.
4. Friction notes workers left on beads (P2 notes).
5. Session-eval verdicts: read the week's `session-eval` beads (FLAG/ESCALATE) and the FLAG rate. Recurring FLAG themes are lesson candidates.
6. Unenforced corrections: the week's P1 "unenforced correction" beads from the memory-promise hook — each is a rule that was promised but never given a mechanism. Resolve keep (build the mechanism) or drop (the rule was noise).
7. Verification-ledger health: skim `state/verify/*.jsonl` would-block log lines (audit-mode classes) and the gate's block rate. A high false-positive rate on code/deploy blocks gates any expansion of blocking scope; a high would-block rate on an audit-only class is evidence for or against ever promoting it.

Acquisitions review (mandatory section): list the week's `acquisition` beads, the week's entries in `~/hq/ops/egress.log` (every domain sessions actually contacted), the git diff of each rig's `.mcp.json`, and the current contents of `~/hq/.claude/settings.local.json`. Recommend keep or revert for each. For any the owner marks revert, execute the bead's recorded revert command (for reverted domains, also remove them from ops/.egress-seen so recontact gets re-flagged).

Standing tool reviews:
- Stage 2 delegation gate (bead hq-q7x, deferred ~2026-07-27): if bulk-shaped beads are recurring weekly or more, raise the Gemini/Antigravity delegation-subagent decision with the break-even facts recorded on the bead. Otherwise leave deferred.

Then act on the constitution (invariants 7 and 9, full trust since proposal 58):
- Changes to ~/hq/CLAUDE.md, skills, hooks and settings: additions AND deletions. Pruning is mandatory; a stale rule is a tax on every future session. If nothing should be deleted, say why. Apply a change yourself when it is plainly right (a rule that no longer matches the running system, a dead reference, a mechanical fix): commit it with a clear message and run `ops/scripts/notify.sh low "Constitution changed" "<what>"`. A change that alters what a rule means, or that is a judgment call that is genuinely the owner's, goes into "Decisions needed" as a diff instead.
- Skill candidates for skill-creator: name, one-paragraph spec, and a 3-case eval for each.
- Beads for recurring toil worth automating.

Assemble ONE condensed digest — this is the single artifact the owner reads on his phone, so no hunting across notes. Decisions first, everything actionable inline. Exact structure:

~~~~
# HQ Weekly — <YYYY-Www>   (<today's date>)

```keypoints
[good|warn|bad|info] <one finding per line, 5 to 8 lines: beads closed, reworks, escalations, session-eval FLAG rate, decisions needed, watch items>
```

```chart
{"type":"hbar","title":"Beads closed by rig","labels":["<rig>", "..."],"series":[{"name":"Closed","values":[<count per rig>]}]}
```

## ⚡ Decisions needed (<N>)
1. <one line> — <the ask: keep / revert / approve> — <the diff or revert command inline>
2. ...
(if none this week, write "None — nothing needs your call this week.")

## 📊 Changed this week
- <beads merged per rig, escalations, session-eval FLAG rate, notable acquisitions> (tight bullets)

## 👀 Watch
- <rising rework, open unenforced-correction beads, ledger false-positive signal>

---
## Details
<the full report from the sections above: reworked beads, escalations, repeated review
comments, friction, session-eval, unenforced corrections, ledger health, acquisitions
review, standing tool reviews, and every proposed diff in full>
~~~~

The console Reports reader turns the `keypoints` fence into a summary card and draws the `chart` fence, so open WEEKLY.md with both, then the Decisions section straight after. Keypoints: one point per line, an optional leading tag `[good]` `[warn]` `[bad]` or `[info]` colors it, at most 8. Chart: valid JSON on one line, labels from the real `bd list` counts of beads closed in the window grouped by rig; leave out any rig or value you cannot count, never write NaN or a guess, and drop the chart if no rig has a count. A table cell that starts with a tag is colored the same way.

Keep the top three sections skim-short; push all depth below the `---`. `<N>` is the count of items in "Decisions needed".

Output and delivery:
- Write the digest to `~/hq/WEEKLY.md` (overwrite — the current week's digest; git history holds prior weeks).
- Commit it: `git add WEEKLY.md && git commit -m "retro: weekly digest <YYYY-Www>"`. The git-sync daemon pushes it to GitHub within ~45s. Commit ONLY WEEKLY.md (`git add WEEKLY.md`, nothing else).
- Archive the same digest to the vault for the durable record: append it under `## Retro` to `~/hq/outbox/vault/04 Daily/YYYY-MM-DD.md` (today's date). the owner's vault-sync.sh moves it. Do NOT create separate inbox proposal notes anymore — proposals live inline in the digest.
- Ping the phone with a tap-through link (fill in the real decision count): `ops/scripts/notify.sh low "HQ Weekly — <N> decisions" "https://github.com/your-gh-user/agent-hq/blob/main/WEEKLY.md"`.
- Constitution changes you applied (see above) are listed under "Changed this week" with their commit hash, so the owner can revert any of them from the digest. Commit them separately from WEEKLY.md.
