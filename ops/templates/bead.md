Title: <verb + object, one line>
Rig: <rig>
Model: <claude-opus-5-5 | claude-sonnet-5-5 | claude-haiku-5-5, default per complexity, see dispatch routing>
MCP: <none | profile name from ops/mcp/, e.g. browser, docs — default none>
Context: <2-3 sentences, links to hub/graph nodes if relevant>
Files owned: <explicit list — no other worker touches these>
Assumptions: <each assumption this bead relies on, marked checked (with the source) or UNVERIFIED; first principles: goal, constraints, facts, then design>
Steps: <only if non-obvious>
Definition of Done:
- Outcome: <the single end state that must be true when done>
- Proof: <the command that proves it, e.g. pnpm test src/x.test.js exits 0. The close gate checks the receipt against this line>
- Constraints: <what must not change or regress>
- Fail-closed (guards, validators, scanners, gates): list the missing, empty, corrupt, unreadable and alternate-encoding inputs; each one has a test that expects a refusal or a non-zero exit, and a revert of the fix makes that test fail.
- Stop-when: <the condition to stop and ask the owner instead of pushing on>
- Verification receipt emitted before close: `Verification: <class> - <command/tool> - <result>` referencing the Proof command (see CLAUDE.md Verification; code/deploy changes block on a missing receipt unless `not run - <blocker>`)
Out of scope: <what NOT to do. With Files owned, this is the boundary>
