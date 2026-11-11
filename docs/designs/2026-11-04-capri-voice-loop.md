# Capri voice loop on George: spike results (hq-nda4h.1)

Status: spike done, 2026-11-05. Code: `tools/capri-voice/` (deploy copy `C:\Users\owner\capri-voice`).
Evidence: `state/review/hq-nda4h.1/live/` (timing logs per run, three recorded mic sessions, acoustic gaps).

## Goal, constraints, facts

- Goal: the owner speaks, Capri answers out loud in under a second, using a small local model for desktop
  actions and handing real work to the orchestrator.
- Constraints: no audio leaves George; the current listener task stays; installs are reversible
  (hq-nda4h.2 to .5 hold the revert commands).
- Facts measured on George: RTX 4060 8 GB (8188 MiB), 1392 MiB used by the desktop before the loop loads.
  Ollama 0.40.14, faster-whisper on CUDA int8_float16, Kokoro-82M onnx on CUDA, Silero VAD v5 on CPU.

## The loop

Hand loop, no framework: mic (sounddevice, 32 ms frames) to Silero VAD with a 300 ms end-of-speech silence,
then faster-whisper (one encoder pass shared by language ID and decoding), then Ollama `/api/chat` streamed
with five flat tools (open_app, open_url, media, ask_orchestrator, status), then the tool result becomes
speech from a template with no second model turn, then Kokoro to the speakers.

## How it was measured

- Bench: synthesized phrases (Kokoro voices am_adam / em_alex) fed through the same stages from files.
  e2e = VAD tail + STT + LLM to first tool call or first sentence + tool + TTS. It does not include the
  speaker output buffer.
- Live: `voice live --play-inputs` plays each phrase through George's Realtek speakers, the Anker mic hears it,
  the loop answers out loud. `e2e_acoustic` uses the player clock; the acoustic gap is the silence the mic
  recorded between the end of the phrase and the start of Capri's reply (VAD on `session-mic.wav`, 32 ms
  resolution). The acoustic gap is the true voice-to-voice number.
- Tools ran dry (no capri-hands calls); the dry tool step costs under 0.1 ms. A real capri-hands call adds
  0.1 ms (media) to about 200 ms (PowerShell paths), see 2026-11-04-capri-hands.md.

## Results: English phrases (the owner 2026-11-05)

Phrases e01 to e10: open Spotify, pause the music, what time is it, open YouTube, how many workers are
running, tell the orchestrator to check my email, turn the volume up, skip this song, ask the orchestrator
to review the acme branch, hey Capri how are you.

Live, in the room (qwen2.5:3b, 300 ms silence), medians over 10 phrases, in ms:

| STT | VAD tail | STT | LLM first | TTS | end detected to play | voice to voice p50 | worst | tools ok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| small | 290 | 78 | 199 | 140 | 445 | 976 | 1184 | 9/10 |
| large-v3-turbo | 291 | 267 | 258 | 159 | 716 | 1280 | 1568 | 9/10 |

Bench, English, auto language (file fed, no speaker buffer):

| model | STT | STT ms | LLM first ms | TTS ms | e2e p50 | e2e worst | tools ok (strict) | GPU MB used |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| qwen2.5:7b | small | 80 | 362 | 126 | 886 | 1086 | 9/10 (8) | 6857 |
| qwen2.5:3b | small | 82 | 204 | 137 | 682 | 854 | 9/10 (9) | 4961 |
| llama3.2:3b | small | 82 | 136 | 128 | 617 | 754 | 9/10 (7) | 5111 |
| qwen2.5:7b | large-v3-turbo | 200 | 364 | 122 | 990 | 1203 | 9/10 (8) | 7633 |
| qwen2.5:3b | large-v3-turbo | 199 | 194 | 132 | 794 | 962 | 9/10 (9) | 5139 |
| llama3.2:3b | large-v3-turbo | 200 | 138 | 126 | 754 | 892 | 9/10 (7) | 5289 |

Text-only tool accuracy on the English set (exact phrase text, no STT): qwen2.5:7b 9/10 (skip this song
becomes prev), qwen2.5:3b 9/10 (skip this song gets no tool call), llama3.2:3b 8/10 (calls status for the
time and for small talk). Strict = before the synonym normalizer in `core.normalize`.

Fixing the STT language to English (`--stt-lang en`) saves 4 to 6 ms: language ID on the shared encoder
output is almost free, so auto language costs nothing for English.

## Results: mixed Spanish and English (previous worker, s-1b64)

Bench, 300 ms silence: qwen2.5:3b with large-v3-turbo 900 ms p50, 10/10 tools; with small 768 ms but 8/10,
because small mishears short Spanish commands ('Sube el volumen' as English 'Subel Volumen').
qwen2.5:7b with large-v3-turbo is 2066 ms p50: 7.5 GB of 8 GB used, the GPU is full and the LLM slows.
Live mixed session (qwen2.5:3b, large-v3-turbo): voice to voice p50 1296 ms, the first phrase 2784 ms
(cold path), the rest 1056 to 1408 ms.

## Where the time goes (English, small, live)

290 ms waiting for silence, 78 ms STT, about 200 ms to the first tool call, about 140 ms TTS, about 20 ms of glue, about 180 ms
speaker output buffer (`out_latency_s` 0.182), plus Kokoro's lead-in silence and the mic buffer. The silence
wait and the output buffer are a third of the total and cost no compute.

## Recommendation

- Loop: keep the hand loop. It is under 1000 lines, every stage is timed, and the glue between stages costs
  about 20 ms. Pipecat was not installed; it would add a framework to tune for the same stages (UNVERIFIED on
  Windows with these local services, and not needed).
- Model: qwen2.5:3b-instruct-q4_K_M. Best strict tool accuracy on both sets, 200 ms to the first call,
  under 5.2 GB total GPU with either STT. llama3.2:3b is 60 ms faster but calls status for small talk and
  the time. qwen2.5:7b is 150 to 200 ms slower and fills the GPU with large-v3-turbo.
- STT: large-v3-turbo while the owner mixes Spanish and English (small mishears short Spanish commands);
  small when the session is English only, which saves about 190 ms in STT and about 300 ms voice to voice.
- Not under a second yet for mixed speech. Next steps, in order of value: drop the output buffer
  (sounddevice latency 'low', about 100 ms back), cut the end-of-speech silence to 200 to 250 ms with a
  semantic end check, play the tool template the moment the call is parsed instead of after the whole
  stream, and trim Kokoro's lead-in silence.
- Fix e08: map 'skip' phrases to media next in the tier 0 router (hq-63nvj) before the model sees them.

## Stop conditions checked

CUDA runs (faster-whisper and Kokoro on CUDAExecutionProvider). End to end is under 2 s for every
qwen2.5:3b and llama3.2:3b option, so the spike does not stop on latency.
