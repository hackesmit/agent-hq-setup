# MCP spawn-time profiles

## Capabilities (the registry: check this before refining any request)

| Profile | Gives the session | Reach for it when | Attach |
| --- | --- | --- | --- |
| `gworkspace` | Gmail, Drive, Calendar, Docs, Sheets as owner@example.com (read and write, tokens already stored) | the task reads or sends mail, reads or writes a Sheet or Doc, files something in Drive, checks or books calendar time | bead field `MCP: gworkspace`; `spawn.sh ... --mcp gworkspace` (once the spawn patch lands); or `claude --mcp-config ops/mcp/gworkspace.json --strict-mcp-config` |
| `browser` | Playwright: a real Chromium the agent drives, screenshots, form filling | anything that needs a logged-in web UI, a visual check, or a site with no API | `MCP: browser` / `--mcp browser` / `claude --mcp-config ops/mcp/browser.json --strict-mcp-config` |

Rules of thumb: a session cannot hot-plug a server, so decide at refinement time and put the
`MCP:` field on the bead; do not hand-roll an API script for something a profile already does;
profiles can be combined (`--mcp gworkspace,browser`). New capability = acquisition protocol below.

One profile per occasional capability. A bead declaring `MCP: <name>` is dispatched with
`claude --mcp-config ops/mcp/<name>.json --strict-mcp-config` so the worker sees only that
profile's servers and nothing else. Beads without an MCP field spawn plain (zero servers).

## No sandbox wrapping (since proposal 58)

The OS sandbox and `srt` were removed on 2026-07-13 and full trust (proposal 58) retired the
cage, so every profile runs its server directly. The `docs` (Context7) profile was removed on
2026-10-19 (hq-fgg3.10): it could only start through `srt`, which is gone, and no spawn ever
used it. Re-add it through the acquisition protocol, without a wrapper, if a bead needs it.

## Profiles

### browser.json — Playwright — UNWRAPPED EXCEPTION (the owner's call, 2026-07-11)
Chromium spawns its own sandbox/child processes and does not survive `srt` wrapping. the owner
chose the scoped-unwrapped-exception route (over the dedicated-distro route). Playwright runs
UNCAGED: it has full filesystem + network. Bound only by: it's dispatched solely on beads
explicitly tagged `MCP: browser`, no credentials are readable that a normal process couldn't
already reach on this laptop, and it's recorded on acquisition bead `hq-k7g`. Revisit on the
desktop (run browser beads in the key-free Ubuntu-hq distro instead).

### gworkspace.json - Google Workspace (workspace-mcp) - UNWRAPPED (credential wired 2026-08-17)
Upstream `taylorwilsdon/google_workspace_mcp` (MIT, ~3k stars), PyPI `workspace-mcp` pinned to
1.24.1, launched by `gworkspace-launch.sh` via `uvx` on stdio. Gmail, Drive, Calendar, Docs,
Sheets at the `core` tier, single-user mode. Not srt-wrapped: `srt` and `bwrap` are gone from
this box since the OS sandbox was removed (2026-07-13), so it runs uncaged like Playwright.
Credentials: the launcher reads the OAuth client id/secret from Proton Pass API-credential
item "Google mcp oauth" (vault "Imported on 2026-07-13 at 14.56.53", fields API Key / Secret) at spawn and passes them only as env vars; the
server keeps refresh tokens under `~/.google_workspace_mcp/credentials`. First use opens a
browser consent flow on localhost:8000. Two gates before first dispatch, both the owner's:
create the GCP OAuth client (personal owner@example.com identity, per the account-separation
memory) and store it in Proton Pass; approve the unwrapped exception on the acquisition bead.
Scope knobs: `GWORKSPACE_TIER`, `GWORKSPACE_TOOLS`, `GWORKSPACE_READ_ONLY=1`.
Revert: `rm ops/mcp/gworkspace.json ops/mcp/gworkspace-launch.sh; uv cache clean workspace-mcp`.

## Adding profiles
Only through the acquisition protocol (ops/templates/acquisition.md): provenance checked,
version pinned, an acquisition bead with the revert command.
