---
paths:
  - "ops/mcp/**"
  - "ops/scripts/mcp-attach.sh"
---

# MCP profiles

- Standing MCP servers: zero at HQ, minimal per rig. Occasional capability attaches at spawn via ops/mcp/ profiles declared on the bead's MCP: field. A bead with `MCP: <profile>` runs in a directly spawned worker: `claude --mcp-config ops/mcp/<profile>.json --strict-mcp-config` (headless or its own window). Beads without the field spawn plain.
- A server not in ops/mcp/ yet is an acquisition: provenance check, acquisition bead, profile file, then respawn.
