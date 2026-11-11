# Capri listener (hq-ymxzt.3)

Runs on George (Windows 11, native Python, not WSL). It hears the word Capri and
hands the mic to Wispr Flow, which types into the HQ orchestrator input.

## One wake (design change 2026-11-04: delivery never depends on focus)
1. sherpa-onnx 2.0.1 keyword spotting (`sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`, int8, one thread) hears CAPRI. Short tick; the chime time is T0.
2. POST `/api/capri {"event":"wake"}`. The reply says `orchestrator: true|false` (a live terminal named orchestrator). No console, a refusal, or no orchestrator is no target: low chime, no Flow key.
3. The Capri window (a small square always-on-top box, bottom right, "listening") takes the focus, so Flow's paste lands in it and never in the owner's windows. If the owner clicks away mid-dictation the paste may land there, but delivery below still works.
4. Ctrl+Win+Space starts Flow hands-free. The listener stops spotting and watches the mic level: speech then 2 s silence ends it; no speech in 6 s, or 60 s total (the hard stop cancels), stops it with nothing sent. Ctrl+Win+Space again stops Flow. A final transcript that is only a cancel phrase, or whose last clause is one (cancel, never mind, forget it, stop listening, scratch that, ignore that, cancela, olvídalo, déjalo, no importa; a leading Capri ignored), shows `cancelled` and sends nothing. Bare `stop` is not one.
5. Read `%APPDATA%\Wispr Flow\flow.sqlite` read-only (`mode=ro`, WAL kept, retried when locked): the first History row after T0, pinned by its transcriptEntityId; only that row is read again. Status `formatted`: editedText if present, else formattedText. Still `raw_transcript` after 10 s: asrText. No row in 12 s: nothing sent.
6. Focus goes back to the owner's previous window (after 1 s for the paste), unless he already moved it.
7. POST `/api/capri {"event":"say","text","transcriptId"}`. The server types the text into the orchestrator terminal as one bracketed paste and presses Enter there; only when the terminal's foreground program is claude, and the text starts with `[voice via Capri] `; one delivery per transcriptId. A 409 (no orchestrator, or not at claude) shows "orchestrator not running" and retries once after 15 s. A 502 means the delivery is uncertain: nothing is resent. Then `done`.

The listener never presses Enter or any key on the desktop except Flow's Ctrl+Win+Space (focus moves use AttachThreadInput, no keystroke). Outcomes are logged one JSON line per wake to `%LOCALAPPDATA%\capri\capri.jsonl` (`sent`, `no-target`, `no-speech`, `no-transcript`, `not-delivered`), with transcript ids and lengths only, never text.

## Tier 0 router (hq-63nvj.4)
Before step 7, `capri/router.py` matches the transcript against a small grammar (Spanish and English, Wispr punctuation): open an app (fixed list of Start menu names), open a site (fixed list, or a bare domain), media keys (pausa, siguiente cancion, sube el volumen), `pon <song> en Spotify` (hands action `spotify_play`, hq-63nvj.3), `escribe <text>` (typed only into the window the focus went back to). The whole utterance must match one rule and every name must be on a list; a question, two commands, an unknown name, or `escribe un correo ...` goes to the orchestrator as before. The action runs through Capri hands on 127.0.0.1 with its token. A refusal before acting (hands down, unknown action, no such app) falls through to the orchestrator; a failure after hands may have acted (409, 500, no answer) never does. Log: `{"ev": "route", "tier": 0|2, "kind", "hands", "ms"}`, no text. Probe: `venv\Scripts\python -m capri route "Abre Spotify." [--run]`. `capri.json` may set `hands_port`.

## Auth without a stored secret
POSTs need the per-boot `X-Console-Key`. George is the owner's own tailnet device, so the console whois gate admits it; the listener GETs `/` like a browser tab, reads the `console-boot-key` meta tag, keeps it in memory, and fetches it again after a 403 (console restart).

## Privacy
Audio stays on George. The dictated text goes only to hqbox (the say POST); neither side logs it (ids and lengths only). Tuning recordings (`capri record`) are written under `C:\Users\owner\capri\tune` and deleted after the count.

## Install (from hqbox)
- Copy `capri/`, `run_capri.pyw` to `/mnt/george/Users/owner/capri/`; venv: `python -m venv venv`, `venv\Scripts\pip install sherpa-onnx==2.0.1 sounddevice numpy pystray pillow sentencepiece`; model tarball from the k2-fsa `kws-models` release, extracted beside it.
- `capri-task.xml` must be UTF-16 for schtasks: `iconv -f UTF-8 -t UTF-16 capri-task.xml > /mnt/george/Users/owner/capri/capri-task.xml`, then on George `schtasks /Create /TN capri /XML C:\Users\owner\capri\capri-task.xml /F`. The task is interactive (the owner's session): SendInput from an ssh session does not reach the desktop.
- `C:\Users\owner\capri\capri.json` overrides `Config` fields: `{"device": "Anker", "threshold": 0.2}`. The Windows default mic (HyperX headset) returns digital silence; the Anker PowerConf C200 caught the most wakes in calibration.
- Tray icon: Mute, Quit. Sleep or a device change stalls the stream; it reopens after 3 s without audio.
- Update: copy the changed files to `C:\Users\owner\capri\`, then `ssh george "schtasks /End /TN capri & schtasks /Run /TN capri"`. The new run waits up to 10 s for the old one to release its lock (hq-ymxzt.12); confirm with a new `start` line in `%LOCALAPPDATA%\capri\capri.jsonl`.
- Revert: `schtasks /End /TN capri & schtasks /Delete /TN capri /F`, delete `C:\Users\owner\capri`.

## Edge cases (hq-ymxzt.10, lucy round 3)
- Hard stop at 60 s: the Capri window keeps the focus until Flow's row is written, so Flow's paste never reaches the owner's window. Nothing is sent.
- Flow already dictating: the wake's hotkey stops that dictation; the listener sees its row (started before the wake, still running at it), skips the second press and sends nothing (`flow-busy`). Flow pastes that text into the Capri window; it stays in Flow's History. A hand recording with no speech may write no row (not checked); then it is not caught.
- A say that reached the console with no answer is `uncertain` (status `lost`) and never resent; only a refused (409) or unreached say is retried.
- Still open, console side: after an uncertain say, the next say can join text left in the orchestrator input (finding 3).

## Checks on George
`python -m capri probe` posts one wake and logs the reply (no key). `python -m capri flowcheck 600` logs the newest Flow History row of the last 10 minutes: id, status, length, never text.

## Tuning
`venv\Scripts\python -m capri record SECONDS tune\PREFIX Anker,TONOR` records each mic; `python -m capri count tune\PREFIX-Anker.wav 0.1,0.2,0.3` counts wakes per threshold.

## Tests
`python3 -m pytest -q tools/capri/tests` (pure logic and the console client; no Windows needed).
