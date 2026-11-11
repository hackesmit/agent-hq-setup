# Vault workspace shell

Canonical structure for every vault workspace (rig or bunker). Stamped by
`ops/scripts/vault-scaffold.sh`. See the design spec at
`docs/superpowers/specs/2026-07-17-vault-knowledge-system-design.md`.

- `_index.rig.md` / `_index.bunker.md`: the hub template. Tokens `{{NAME}}`,
  `{{DATE}}`, `{{TAGS}}`, `{{PURPOSE}}` are substituted at scaffold time.
- Required hub sections: `## Map` (wikilinked spine) and `## Decisions`
  (dated, newest first, `YYYY-MM-DD - decision - why`, ASCII only).
- Filing rule: no loose notes at a workspace root except `_index.md` and
  (rigs) `Knowledge.md`; everything else files into a numbered category.
- Linking rule: every note links its hub and its antecedents; no orphans.
