---
paths:
  - "ops/console/**"
  - "ops/scripts/console.sh"
  - "state/console/**"
---

# Console internals

- State lives in `state/console/`. The dashboard is at https://hqbox.example.ts.net:8790 from the owner's own tailnet devices; its whois gate resets every other peer, hqbox itself included.
- spawn seeds the phase list; finish/snooze log changes automatically.
- `console.sh ask` marks the session's console card as waiting, with the question and an answer box on it, and pings. An answer the owner sends from the card arrives typed into the terminal. A question with no live terminal is listed at the foot of the Sessions card. There is no Needs-you panel (the owner, 2026-10-20) and no Commands card (proposal 58).
- `console.sh ask` refuses a question that has a sentence longer than 25 words.
