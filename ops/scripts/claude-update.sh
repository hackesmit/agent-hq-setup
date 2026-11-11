#!/usr/bin/env bash
# claude-update.sh: update Claude Code to the latest release.
# Claude Code is exempt from the npm min-release-age guard (the owner 2026-11-04);
# every other package keeps it. ignore-scripts stays on, so the package's own
# postinstall (which places the native binary) is run explicitly afterwards.
set -euo pipefail
ver="${1:-latest}"
npm install -g "@anthropic-ai/claude-code@${ver}" --min-release-age=0
dir="$(npm root -g)/@anthropic-ai/claude-code"
(cd "$dir" && node install.cjs)
claude --version
