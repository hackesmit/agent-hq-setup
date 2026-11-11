---
name: vault-writing
description: Use when writing anything vault-bound - daily notes, knowledge or decision notes, hub updates, inbox proposals, new workspaces, or any content headed for the owner's Obsidian vault or ~/hq/outbox/vault/. Also use when asked to record, file, or "put in the vault" any finding, report, or note.
---

# Vault writing

The normal path is `~/hq/outbox/vault/<same relative path>`; the sync daemon merges it into the real vault (`~/vault`) within about 45 seconds. Write the vault directly only when a fix needs it (a replace, move or delete). The vault's own `CLAUDE.md` is the rulebook; this skill is the mechanics that keep the graph connected to the central [[Home]] index.

## Sync semantics decide what you write

The merge APPENDS your outbox file to an existing vault file, or creates it if new. So:

- Target exists (hub, Knowledge.md, daily note): outbox file contains ONLY the new lines. Never the full file - past sessions re-wrote whole Knowledge.md templates and the vault accumulated five duplicate headers.
- Target is new: write the complete note.
- The outbox only appends. To replace, move or delete a vault file, write the vault directly (`ops/scripts/vault-path.sh` prints its path) and keep the graph rules below.

## Graph rules (every note reaches Home)

1. Path-qualify hub and Knowledge links, always: `[[01 Projects/<ws>/_index|<ws> hub]]`, `[[01 Projects/<ws>/Knowledge|Knowledge]]`. Bare `[[_index]]` or `[[Knowledge]]` is ambiguous (12 and 7 files share those basenames) and wires the graph to an arbitrary workspace. The 2026-07-28 audit found 59 such wrong edges.
2. Every new note links its hub (an `Up:` line or inline), and gets listed in that hub's Map via a small append to the hub file.
3. Every hub carries `Up: [[Home|HQ Vault]]`. A new workspace hub is appended to `Home.md`'s matching section so it stays reachable from the center.
4. Inbox notes name their target: `Target: [[01 Projects/<ws>/_index|<ws> hub]]` plus provenance.

## Quick reference

| What | Where (under outbox/vault/) |
| --- | --- |
| Daily log entry | `04 Daily/YYYY-MM-DD.md`, append under a heading |
| Proposal / finding | `00 Inbox/YYYY-MM-DD <short-title>.md`, one idea per note |
| KB one-liner | run `vault <rig> "<line>" --tag <tag>` instead of writing files |
| New workspace | `ops/scripts/vault-scaffold.sh <name> --type rig|bunker`, then append hub link to `Home.md` |
| Work product | numbered category folder in its workspace, dated filename |
| Verify | `ops/scripts/vault-lint.sh` (orphans, bare links, loose files); receipt: `Verification: docs-only - lint plus readback` |

## Style

ASCII punctuation only (no em dashes, arrows, box glyphs). Terse prose, dated work products, no transcripts. Spanish domain terms stay Spanish in Orbit Acme material.

## Common mistakes (all observed in the 2026-07-28 audit)

| Mistake | Fix |
| --- | --- |
| Bare `[[_index]]` / `[[Knowledge]]` link | Path-qualify with the full folder path |
| Note with no links in or out | Add `Up:` hub link and a Map line in the hub |
| Full-file rewrite of an existing note | Outbox file = only the appended lines |
| Loose note at a workspace root | File into a numbered category; only `_index.md` and `Knowledge.md` sit at the root |
| New workspace missing from `Home.md` | Append its hub under Projects or Bunkers in Home |
