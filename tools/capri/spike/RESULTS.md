# Wispr Flow hotkey spike (hq-ymxzt.1), 2026-11-04

## Facts
- Flow stores hotkeys in `%APPDATA%\Wispr Flow\config.json` under `shortcuts`: `162+91` ptt (Ctrl+Win), `162+32+91` hands-free (Ctrl+Win+Space), `27` dismiss. Not changed. No rebind was needed, so no revert is needed.
- SendInput from ssh cannot reach the desktop. A scheduled task with `/IT /RU owner` runs AutoHotkey v2.0.31 in the owner's session (`send-hotkey.ahk`).

## 1. Flow starts from a sent hotkey: YES
Sent Ctrl+Win+Space with AutoHotkey. The idle pill (`shots/handsfree-0-before.png`) became the hands-free bar with cancel and confirm buttons and a waveform (`shots/handsfree-1-after.png`). A second send closed it (`shots/handsfree-2-end.png`). Active window at the time was WhatsApp, so focus does not matter for starting Flow.
Not tested: Ctrl+Win (ptt) and a Win-free rebind. Not needed because the Win combo works.

## 2. Text lands in the console input: YES (2026-11-04 08:42 UTC, the owner at George)
Dictate mode (30 s window): Flow started from the sent Ctrl+Win+Space, transcribed the owner, and pasted into whatever field had focus (this time the coordinator terminal in the console Terminals tab). Flow pastes wherever focus is, so the listener must focus the orchestrator input first (hq-ymxzt.2 focus hook). Earlier notes: needs the owner's voice and the console meta tab focused in the browser. My one scripted click on the browser tab did not switch tabs (the owner was using Discord and WhatsApp on George), so I stopped clicking on his live desktop.

## 3. Spoken "press enter" submits: NO (2026-11-04 08:42 UTC)
The words "Press Enter" were typed literally three times; no Enter was pressed. Either the Experimental setting was off or it only acts at the end of a session. Design: the listener sends Enter itself after Flow ends (it stopped Flow with a second hotkey press), so the setting is not needed.

## Revert
`ssh george "schtasks /Delete /TN capri-spike /F & schtasks /Delete /TN capri-focus /F"`; AutoHotkey: `winget uninstall --id AutoHotkey.AutoHotkey`.
