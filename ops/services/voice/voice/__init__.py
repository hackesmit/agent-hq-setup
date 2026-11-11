"""the owner's writing voice, built from his sent mail (hq-w32vy.1).

fetch (personal IMAP, work through a temporary n8n Gmail proxy), keep only
his own text, extract per-message features with Haiku, synthesize one
profile with Opus. Everything generated lives in state/voice (0700, files
0600); no message body goes to git, beads, the vault or a log.
"""
