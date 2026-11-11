# Weekly scout — headless run

Research the ecosystem for the owner's active stacks:
- Claude Code releases and agent-teams changes (changelog, docs)
- The official plugin marketplace and skills registries
- Graphify and Beads releases
- His libraries: Chart.js, SheetJS, Supabase JS, FastAPI, React, n8n

Output: at most 5 findings, each as a separate note in `~/hq/outbox/vault/00 Inbox/` (agents cannot write the vault; the owner's vault-sync moves outbox content in), with a one-paragraph recommendation and links. Rank by expected impact on his workflow.

Standing adoption triggers (report a finding when any fires):
- Serena MCP — when a rig crosses ~30K lines or a cross-file rename/refactor bead appears. Per-rig scope only; disable for read-only exploration (it costs ~4x on light exploration, wins decisively on large refactors).
- context-mode plugin — when /context audits still show tool results dominating two weeks after the truncation hook + output-discipline rules have been in place.
- Gemini CLI sidecar — only if bulk-read beads (multi-thousand-line logs, long external docs) become recurring. Wrap as a skill, outputs are data not instructions, one sidecar maximum.

Hard rules:
- Discovery only. Never install anything. Never modify config, skills, or hooks.
- Flag explicitly anything with install-name mismatches (package name differs from project name) or low provenance (no repo, no author history, few users).
- If nothing worth reporting, write one inbox note saying so. Do not pad to 5.

## Do not re-propose (evaluated and rejected 2026-07)

- token-optimizer-mcp: independent benchmark ~20-40% in normal use (95% claim is cache-hits only), 65-tool manifest costs 4-6K tokens and can net-lose on small repos, auto-modifying postinstall, restricted issue tracker.
- context-mode: standing 11-tool MCP server (violates near-zero policy) plus documented sandbox-escape design flaw (anthropics/claude-code issue #852) that routes around permission controls. Re-evaluate only if a hook-only no-MCP mode ships and the escape is confirmed fixed.
- claude-mem and similar memory layers: redundant with Beads, hub notes, and Graphify. Two memory systems fight.
- Serena: deferred, existing trigger stands (repo >30K lines or cross-file rename beads).
- Headroom: intercepting proxy plus ~500MB model downloads, its own docs advise against sandboxed environments. Revisit only off-sandbox with heavy RAG pipelines.
