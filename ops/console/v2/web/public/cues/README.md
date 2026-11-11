# Console sound cues

Drop audio files in this directory and name them in `cues.json` under `files`.

    {
      "gain": 1,
      "files": {
        "NEEDS_YOU": "needs-you.wav",
        "DONE": "done.wav"
      }
    }

Anything not listed plays a synthesized tone instead (`src/app/cuePlayer.ts`, `TONES`),
so the vocabulary works before a single file exists and a missing or corrupt file
degrades to the tone rather than to silence.

Guidance for the files themselves:

- Short. Under 700 ms. These interrupt work.
- No leading silence. The cue must land the moment the event does.
- Normalised, and levelled against each other. `gain` scales all of them together if the
  set as a whole is too hot or too quiet.
- Keep the SHAPES distinct, not just the timbres. Rising means attention, falling means
  finished, a flat click means routine, a low thud means failure. That is what makes the
  vocabulary learnable from the next room.
- Any format the browser can decode. WAV and OGG are safe; MP3 has a decoder-dependent
  leading gap that undermines the point.

Quiet hours and the mute live in console Settings. Only `URGENT` pierces quiet hours; the
mute silences everything.
