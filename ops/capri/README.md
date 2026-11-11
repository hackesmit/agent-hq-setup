# Capri on a Windows PC

Capri is the voice and desktop side of HQ. It runs on a Windows PC (the owner's is George) and talks to the hqbox console.
This file is the setup guide. Each part's own README has its contract and edge cases.

| Part | Source | On the PC | Runs as | Talks to |
| --- | --- | --- | --- | --- |
| hands | `tools/capri-hands/` ([README](../../tools/capri-hands/README.md)) | `C:\Users\owner\capri-hands` | logon task `capri-hands`, system Python 3.14 `pythonw`, stdlib only | listens on `127.0.0.1:47615`, token in `%LOCALAPPDATA%\capri-hands\token` |
| listener | `tools/capri/` ([README](../../tools/capri/README.md)) | `C:\Users\owner\capri` | logon task `capri`, `venv` (Python 3.14) `pythonw` | hears "Capri", drives Wispr Flow, POSTs `https://<hqbox>:8790/api/capri`; calls hands for tier 0 commands |
| voice | `tools/capri-voice/` (design: `docs/designs/2026-11-04-capri-voice-loop.md`) | `C:\Users\owner\capri-voice` | by hand (`live.bat`, `bench-en.bat`); no task yet | local STT (faster-whisper), Ollama on `127.0.0.1:11434`, Kokoro TTS, hands for tools |

hqbox reaches the PC two ways: ssh (host alias `george`, Windows OpenSSH, key auth) and an sshfs mount of `C:` at
`/mnt/george` (`/etc/fstab`, systemd automount). `ops/scripts/george.sh` drives hands over ssh: one JSON action on stdin
to `python -m hands call -`, so typed text never appears on a command line. Audio stays on the PC; only dictated text
goes to hqbox.

## Deploy from hqbox

```
ops/capri/deploy-george.sh --check     # list drift between the repo and George; exit 1 on drift
ops/capri/deploy-george.sh             # copy changed files, restart what changed, verify
ops/capri/deploy-george.sh --part hands --part listener
ops/capri/deploy-george.sh --scan      # secret scan only
ops/capri/deploy-george.sh --bootstrap # new PC: copy files only (see Install)
```

The deploy copies only git-tracked files, and only the ones that changed. An ignored or untracked local file (a
`capri.json`, `venv`, models, logs) never leaves hqbox, and nothing on the PC is ever deleted (venvs, models, logs,
`.bak-*` stay). `capri.json` belongs to the PC: the deploy installs `capri.json.example` as `capri.json` only when the
PC has none, and never overwrites it. The deploy writes a task XML as UTF-16 (schtasks needs that; the repo keeps
UTF-8) and registers the task again only when the XML changed. It restarts a task only when its part changed. It
always verifies: hands answers `george.sh windows`, the `capri` task is Running, and a final `--check` shows no drift.

Retry: before it copies a part, the deploy writes `.deploy-pending` in that part's folder on the PC, and it deletes the
file only after register, restart and verify pass. When a run stops halfway, the next run registers, restarts and
verifies that part again, even when every file already matches. `--check` reports a pending part as drift.

Secret scan: before any copy, the deploy sweeps every tracked file of the three trees (scripts, tests and READMEs
included) with a regex, the live hands token, and gitleaks. Without gitleaks it refuses (exit 7); `--allow-no-gitleaks`
runs the regex sweep alone. A known non-secret hit is pinned in `SCAN_ALLOW` in the script by file and the sha256 of
the match.

Exit codes: 0 ok, 1 drift or a failed copy, register, restart or verify, 2 usage or source not a git checkout, 3 PC
unreachable, 4 hands token missing, 5 secret-shaped string in a tracked file (file and line printed, never the value),
6 the `.deploy-pending` marker cannot be read, written or deleted, 7 gitleaks not installed. Not deployed: READMEs,
`tests/`, `spike/`, `*.sh` probes (these run from hqbox), `capri.json.example`. Tests: `ops/tests/capri-deploy.test.sh`.

## Install on a new Windows PC

The paths assume the Windows user `owner`. For another user, edit `C:\Users\owner` in the two task XMLs (also
`<UserId>`), the `.bat` files and `tune/*.py`, and set `CAPRI_WIN_HOME` and `CAPRI_GEORGE_ROOT` for the deploy.

1. **Access from hqbox.** Install the Windows OpenSSH server, add hqbox's key, add a `george` host alias in
   `~/.ssh/config`, and add the sshfs line to `/etc/fstab` (see the `/mnt/george` entry on hqbox).
2. **Python.** Python 3.14 from python.org for the current user (`%LOCALAPPDATA%\Programs\Python\Python314`). Voice
   only: `winget install --id astral-sh.uv --version 0.13.7 --exact` and `winget install --id Ollama.Ollama --version 0.40.14 --exact`
   (`tools/capri-voice/install1.ps1`).
3. **Copy the files.** `ops/capri/deploy-george.sh --bootstrap` copies the three folders to the PC. It needs only the
   `/mnt/george` mount: no ssh, no token, and it registers no task. It also installs `capri.json` from the example, and
   it leaves each part pending, so `--check` shows drift until step 7.
4. **Hands.** No packages. Token, once: `ssh george "cd C:\Users\owner\capri-hands && python -m hands init"`. It writes
   `%LOCALAPPDATA%\capri-hands\token`, readable only by the user. `init --rotate` makes a new one. The token is never in
   the repo or on a command line. Until the token exists, the deploy (but not `--bootstrap`) stops with exit 4.
5. **Listener.** In `C:\Users\owner\capri`: `setup.bat` makes `venv` (Python 3.14) and installs the packages. The pinned
   set is `tools/capri/requirements.txt` (`venv\Scripts\pip install -r requirements.txt`). Keyword model: download
   <https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2>
   and extract it in that folder (you get `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01\`). In `capri.json`,
   set `device` (a mic name substring) and `threshold`. Use `tune\mics.bat` and `python -m capri count` to choose them.
   Install Wispr Flow and keep its hands-free hotkey on Ctrl+Win+Space.
6. **Voice** (optional, needs an NVIDIA GPU). In `C:\Users\owner\capri-voice`: `venv.bat` (uv makes a Python 3.12 venv;
   the tested set is `requirements.lock`). `ortgpu.bat` switches onnxruntime to the GPU build, and `check.py` prints the
   providers. Models go in `capri-voice\models\`:
   - `silero_vad.onnx`: <https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx>
   - `kokoro-v1.0.onnx` and `voices-v1.0.bin`: <https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0>
   - `faster-whisper-small` and `faster-whisper-large-v3-turbo` (optional): Hugging Face `Systran/faster-whisper-small`
     and `mobiuslabsgmbh/faster-whisper-large-v3-turbo`. When the folders are missing, faster-whisper downloads them.
   - LLM: `ollama pull qwen2.5:3b-instruct-q4_K_M` (`pull2.bat`). Start Ollama with `start-ollama.ps1`
     (`ollama-serve.bat` sets the flash-attention and keep-alive variables).
7. **Tasks.** `ops/capri/deploy-george.sh` (no flag) writes and registers both tasks (`capri-hands`, then `capri`),
   starts them, verifies, and clears the pending markers. Both start at logon in the user's interactive session, which
   is necessary because input sent from an ssh session does not reach the desktop. Hands restarts every minute if it
   fails.
8. **Check.** `ops/scripts/george.sh windows` and `ops/scripts/george.sh shot` succeed, and
   `ssh george "schtasks /Query /TN capri /FO LIST"` shows `Running`. Say "Capri": a wake line appears in
   `%LOCALAPPDATA%\capri\capri.jsonl`.

The hqbox side (console `/api/capri`, the meta terminal, CapriCorner) is in `ops/console/v2/`. The listener needs no
stored secret: the PC must be on the tailnet so the console's whois gate admits it.

## Revert

- One part: `ssh george "schtasks /End /TN <task> & schtasks /Delete /TN <task> /F"`, then delete its folder on the PC.
  For hands, also delete `%LOCALAPPDATA%\capri-hands`.
- One deploy: `git checkout <previous-commit> -- tools/capri tools/capri-hands tools/capri-voice`, then run
  `ops/capri/deploy-george.sh` again (a `.bak-*` copy on the PC also works).
