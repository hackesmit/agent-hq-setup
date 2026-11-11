# Capri hands (hq-63nvj.1)

One Windows process in the owner's session on George that does desktop actions on request.
Design: docs/designs/2026-11-04-capri-hands.md. Python 3.14 stdlib only (ctypes): no
pywinauto, no AutoHotkey, no venv.

## Contract
- HTTP on `127.0.0.1:47615` only (`hands.json` in the home dir may set `{"port": N}`). Any other bind address is refused at start.
- Every call carries `X-Hands-Token: <token>`; the token is read from `%LOCALAPPDATA%\capri-hands\token` on each call and compared in constant time. Missing file, empty file, wrong token: 401. Any query string: 400. An `Origin` header (a browser page): 403. Body over 64 KB: 413. No Content-Length or chunked: 411. Not a JSON object: 400. Unknown action: 404. Unknown field or wrong type: 400.
- `POST /action` with one JSON object; reply `{"ok": true, ...}`. Each connection has its own thread with a 10 s read timeout, so an idle socket never blocks other calls; actions still run one at a time.
- `GET /shot/<name>` returns a PNG a screenshot wrote (names `shot-YYYYmmdd-HHMMSS-mmm.png` only; the last 50 are kept).

| action | fields | reply |
| --- | --- | --- |
| `open_url` | `url` (http or https only), optional `monitor` (from 1), `new_window`, `maximize` (default true with `monitor`) | plain: none; with `monitor` or `new_window`: `browser`, `hwnd`, `monitor`, `fallback`, `front`; 504 if no new window appeared |
| `open_app` | `name` (Start menu name: exact name in any case first, then fuzzy: prefix, word, close spelling) | `app` |
| `list_windows` | | `windows` (hwnd, title, pid, exe, foreground), `idle_s` (seconds since the owner's last input) |
| `focus_window` | `title` (substring) or `hwnd` | `hwnd`, `title`; 409 if Windows kept the focus elsewhere |
| `type_text` | `text`, optional `hwnd` | `chars` |
| `key` | `combo` like `ctrl+l`, `alt+f4`, `enter`, optional `hwnd` | |
| `click` | `x`, `y` (physical pixels), `button` left/right/middle, `double` | |
| `screenshot` | optional `hwnd` (one window, even when covered) | `name`, `path`, `width`, `height` |
| `media` | `command`: pause, play, play_pause, next, prev, volume_up, volume_down, mute | `player`, `hwnd` for pause and play; 404 when Spotify is not running |
| `media_status` | | `current` (the app the media keys reach), `sessions` (app, status) |
| `audio_devices` | | `outputs`, `inputs` (name, id, default: the console role); `defaults`: the endpoint id per role (`console`, `multimedia`, `communications`) for `output` and `input`; active devices only |
| `audio_output`, `audio_input` | `name` (device name, id, or a fuzzy word: speakers, hyperx), optional `fuzzy` (default true), optional `role` 0 console, 1 multimedia, 2 communications (absent: all three; any other value 400) | `device`, `id`, `previous` (the device that held the first role set), `roles`, `matches` (every name that matched; the shortest wins a tie); 404 lists the devices |
| `volume` | none (read), or `level` 0-100, or `command` up, down, mute, unmute, optional `step` (up/down, default 10) | `level`, `muted`, `device`, `previous`, `was_muted`; a level or up unmutes |
| `monitors` | | `monitors` (index, device, bounds, work as [left, top, right, bottom] physical pixels, primary) |
| `move_window` | `title` (substring) or `hwnd`, `monitor`, optional `maximize` | `hwnd`, `title`, `monitor`, `fallback`, `front` |
| `settings` | `page`: a short name (bluetooth, sound, display, night light, wifi, update, sonido, pantalla ...) or an `ms-settings:` uri | `uri`; 404 for an unknown name |
| `powershell` | `script`, optional `timeout_s` 1-60 (default 30) | `exit_code` (null when killed), `timed_out`, `stdout`, `stderr` (last 64 KB each, kept while the script runs, so the daemon never holds more), `truncated` |
| `spotify_play` | `query` (a song, as spoken; max 200 chars) | `track`, `artists`, `uri`, `cold` (Spotify was started), `playing`, `ms`; 404 no song, 502 search or play failed, 503 Spotify not started or logged out, 504 not confirmed |

With `hwnd`, `type_text` and `key` focus that window and refuse (409) unless it is in front at the moment of sending; `type_text` checks again before every character, `key` before the key-down, and a 409 says how many characters went out. The guard is best effort: SendInput goes to whatever window is in front and cannot be aimed at one, so a window the owner switches to in the instant between the check and the send can get about one character (or the key). After a 409, send only the rest of the text (the reply names the count), never the whole text again. Windows often refuses to give focus away while the owner is typing: check `idle_s` before acting on his desktop, and prefer `screenshot` with `hwnd` to taking the focus. Media keys go to the current Windows media session, often Brave or WhatsApp rather than Spotify; `media_status` says which. `pause` and `play` are explicit and go to Spotify only: WM_APPCOMMAND (47, 46) to its main window, no keystroke and no focus change, so pause while paused stays paused (measured on George 2026-11-04: send about 0.1 ms, a repeat is a no-op). `play_pause` is the toggle key for callers that want it. `type_text` sends one character per SendInput (about 6 ms each), because Windows 11 Notepad dropped characters from a single burst.

Monitors are numbered with the primary as 1, then left to right; a `monitor` past the last falls back to the primary and says `fallback: true`. `open_url` with `monitor` starts the default browser (resolved with AssocQueryStringW, because Windows 11 keeps the live choice under `UserChoiceLatest` and the old `UserChoice` key can still name Edge) with `--new-window` (Firefox `-new-window`), waits up to 10 s for the new window, moves it to that monitor's work area and brings it to the front. Audio uses Core Audio COM through ctypes (`hands/audio.py`, about 40 ms, no PowerShell module): the default device is set for all three roles, as the Sound panel does. `powershell` runs Windows PowerShell 5.1 as the owner in his session (no profile, a UTF-8 BOM temp file under `%LOCALAPPDATA%\capri-hands\ps`, deleted after); the run sits in a Win32 job object, so a run past `timeout_s` is killed with every descendant, even one that outlived powershell and kept the output pipes, and the reply comes back within `timeout_s` plus 2 s; it holds the action lock that long at most. A job object that cannot be made refuses with 500 and runs nothing. A non-zero exit is still `ok: true`: read `exit_code`. Only the script length is logged.

`spotify_play` drives `spotify_cli.exe`, the command line that ships inside the Spotify Store package (`%LOCALAPPDATA%\Microsoft\WindowsApps`): status, `open` when closed, search the top track, play its uri, then poll now-playing until that uri plays. No Web API app, no OAuth, no clicks. The CLI reaches the desktop client only from the owner's session (from ssh it fails after 19 s). Measured 2026-11-04: warm about 1.2 s, cold about 3 s (wall from hqbox 1.5 s and 3.4 s); account is Premium (`spotify_cli me`). Live check: `tools/capri-hands/spotify_probe.sh OUTDIR` (five tries plus cold extras, screenshots).

Log: `%LOCALAPPDATA%\capri-hands\hands.jsonl`, one line per call: action, target (url, app, combo, x,y, hwnd), ok, ms. Typed text is never logged, only its length. Crash tracebacks: `stderr.log` beside it.

## Use from hqbox
```
echo '{"action":"open_url","url":"https://example.com"}' | ssh george 'cd C:\Users\owner\capri-hands && python -m hands call -'
ssh george 'cd C:\Users\owner\capri-hands && python -m hands get shot-20261104-120000-001.png' > shot.png
```
The client runs in the ssh session, reads the same token file and calls 127.0.0.1; only the server, started by the logon task, can reach the desktop.

## Install (from hqbox)
- `mkdir -p /mnt/george/Users/owner/capri-hands/hands && cp tools/capri-hands/hands/*.py tools/capri-hands/hands/*.ps1 $_ && cp tools/capri-hands/run_hands.pyw /mnt/george/Users/owner/capri-hands/` (the `.ps1` is the `media_status` helper; without it that action answers 500, never an empty list)
- Token, once: `ssh george 'cd C:\Users\owner\capri-hands && python -m hands init'` (icacls removes inherited access: only owner can read it; `init --rotate` makes a new one).
- Task (UTF-16 for schtasks): `iconv -f UTF-8 -t UTF-16 tools/capri-hands/hands-task.xml > /mnt/george/Users/owner/capri-hands/hands-task.xml`, then `ssh george 'schtasks /Create /TN capri-hands /XML C:\Users\owner\capri-hands\hands-task.xml /F & schtasks /Run /TN capri-hands'`. Interactive token, least privilege, starts 15 s after logon, restarts every minute on failure.
- Update: copy the files, `schtasks /End /TN capri-hands & schtasks /Run /TN capri-hands`. After recent calls the port sits in TIME_WAIT for up to 2 minutes; the server retries the bind (no SO_REUSEADDR, which on Windows lets another process take the port).
- Revert: `schtasks /End /TN capri-hands & schtasks /Delete /TN capri-hands /F`, delete `C:\Users\owner\capri-hands` and `%LOCALAPPDATA%\capri-hands`.

## Checks
- `python3 -m pytest -q tools/capri-hands/tests` (server, refusals, schema, key combos, app match, PNG; no Windows needed).
- `tools/capri-hands/system_probe.sh OUTDIR [IDLE] [MAXWAIT]`: live probe of the hq-63nvj.13 actions (switch output and back, volume 30 and back, monitors, example.com on monitor 2, Bluetooth settings, powershell Get-Date); snapshots each role default, level and mute, restores all of them on any exit and reads them back; exits nonzero on any failed step or restore, 2 with fewer than two outputs (env PROBE_GEORGE, PROBE_SLEEP for tests).
- `tools/capri-hands/probe.sh OUTDIR [IDLE] [MAXWAIT]`: live probe. It waits until the owner is idle, then runs Notepad type and screenshot, example.com, and a media toggle (muted, toggled twice so playback ends where it started, `media_status` read after each).
