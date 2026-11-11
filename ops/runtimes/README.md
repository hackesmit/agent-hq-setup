# Runtime presets

One JSON record per agent CLI that can run an HQ worker: command, headless mode,
model list, process names, resume style, instructions file, and whether the
logical cage (the hook guards) can run there. The shape is Gas Town's production
AgentPresetInfo, which drives five vendors in the field; values for gemini and
codex are lifted from their source rather than guessed.

Inert today. `ops/proposals/24-runtime-presets.md` (cage, the owner applies) teaches
spawn.sh, wake.sh and ctl.sh to read these, keyed by a vendor prefix on the
bead's Model: field (`Model: codex:gpt-5.6-codex`); no prefix means claude,
byte-for-byte today's behavior.

The one rule that is policy, not plumbing: a preset with `supports_hooks: false`
never takes redteam-tagged beads or anything touching money, auth, data or a
public surface, and dispatch refuses the combination. The cage does not exist on
those runtimes, so the review gate and the bead's risk class are the whole
control. Full audit: docs/superpowers/specs/2026-08-25-sovereignty-audit.md.
