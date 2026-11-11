# Capri hands: control George by voice and from the orchestrator (2026-11-04)

the owner's request: Capri (and the orchestrator) opens websites and apps on George, uses them
(Spotify: open, search, play a song; type into an app), and answers simple commands fast.
Look at how OpenClaw and Grok split simple from complex work.

## Goal
A spoken or typed command becomes an action on George's desktop. Common commands finish in
under one second after Wispr Flow writes the transcript; anything else reaches the
orchestrator, which can also drive George, slower but general.

## Hard constraints (read or measured, 2026-11-04)
- Input arrives on George: the listener reads the transcript from Wispr Flow's flow.sqlite
  (hq-ymxzt.3, in review). George is the right place to act: no network hop for tier 0.
- Desktop actions must run in the owner's interactive session. A process started over ssh runs
  in a non-interactive session: SendInput from ssh never reached the desktop (spike,
  tools/capri/spike/RESULTS.md). The listener already runs in his session as a logon task.
- Measured latency: ssh hqbox to George 0.27 s. `claude -p` Haiku 5.5 with the full HQ
  setup 5.8 s; stripped (no MCP, no settings, no tools, empty dir) 2.5 s. No personal
  Anthropic API key exists (the only one is acme's Botvi key; not ours to use), so every
  model call is a Claude Code CLI call on the Max plan.
- Spotify: the owner's account receives "get Premium" offers (Gmail, 2026-10-25), so it is on
  the free tier. The Web API play endpoint needs Premium (403 PREMIUM_REQUIRED), so song
  playback goes through the desktop app (URI scheme plus UI automation), not the API.
  Corrected 2026-11-04 (hq-63nvj.3): the account is Premium (`spotify_cli me`: product
  premium), and the Store app ships `spotify_cli.exe`, which searches and plays through the
  running desktop client. Song playback uses that CLI: no Web API, no UI automation.
- George has Spotify, Brave, Edge, Discord, WhatsApp, VS Code, Office (Get-StartApps),
  Python 3.14, Node, AutoHotkey.

## What the others do (sources in the bead)
- OpenClaw: one long-lived gateway process owns the channels and dispatches tools; skills
  are listed as compact metadata and loaded on demand; the "hands" run locally. No
  documented complexity router: model choice is per agent config.
- Grok voice: one speech-to-speech model that reasons in the background while it speaks,
  so no pipeline hops. Not available to us; the lesson is to remove hops on the fast path.

## Design (derived, not inherited)
Three tiers, cheapest first. A tier passes the command up when it is not sure.
1. Tier 0, rules on George (target under 0.3 s): a small grammar (Spanish and English) for
   open app, open website, media keys (play, pause, next, volume), "play <song> on
   Spotify", "type <text>". No model. Executed in-process by hands.
2. Tier 1, Haiku parse (about 2.5 s): a short imperative the rules miss goes to the console
   server, which runs stripped Haiku with the action schema and returns one action or
   "complex". Built only after tier 0 shows which misses matter (measure first).
3. Tier 2, the orchestrator (Fable): everything else, as today's say route. It drives George
   with the `george` CLI: the same actions plus screenshot, click and key for general
   computer use (it reads the screenshot, decides, acts).

Hands is one Windows process in the owner's session (logon task), separate from the listener so
either restarts alone: an HTTP server on 127.0.0.1 only, every call carrying a token from a
file only the owner's user can read. hqbox reaches it over ssh (curl.exe on George), so no new
port is exposed. Every action is logged on George (action name and target, never typed text).

Removed parts: no AutoHotkey in the new path (Python ctypes and pywinauto cover it), no
second listener, no Spotify Web API, no new network listener.

## Beads
1. hands daemon (tools/capri-hands): actions, token, logon task, live probe.
2. george CLI on hqbox plus the orchestrator seed section.
3. Spotify: play a named song through the desktop app (free tier), live probe.
4. Tier 0 router in the listener (after hq-ymxzt.3 merges).
5. Tier 1 Haiku parse (after 4, only if tier 0 misses justify it).
