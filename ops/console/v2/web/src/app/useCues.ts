// The React seam between the cue engine (pure policy) and CuePlayer (WebAudio).
//
// Kept deliberately thin: everything worth testing lives in cues.ts, and everything that
// needs a browser lives in cuePlayer.ts. This file only owns the lifecycle.
//
// Bead: hq-4lxc.

import { useEffect, useMemo, useRef } from "react";
import type { ConsoleState } from "@shared/api";
import { CueEngine, URGENT_REPEAT_MS, type CueName } from "./cues";
import { CuePlayer } from "./cuePlayer";
import { cueSettings, type Settings } from "./settings";

export interface CueHandle {
  /** Play a cue directly. The Capri ear and the Settings preview use this. */
  fire: (cue: CueName) => void;
}

/**
 * Watches console state and rings.
 *
 * Audio is unlocked on the first real user gesture, because browsers refuse to start an
 * AudioContext before one. Until that gesture every ring is a silent no-op, which is the
 * correct behaviour rather than a bug: a console nobody has touched has nobody listening.
 */
export function useCues(state: ConsoleState | null, settings: Settings): CueHandle {
  const playerRef = useRef<CuePlayer | null>(null);
  if (playerRef.current === null) playerRef.current = new CuePlayer();
  const player = playerRef.current;

  const engine = useMemo(
    () => new CueEngine({ play: (cue) => player.play(cue), now: () => Date.now() }),
    [player],
  );

  // Settings are read fresh on every decision, so a mute takes effect on the next event
  // rather than on the next mount.
  engine.settings = cueSettings(settings);

  useEffect(() => {
    const unlock = () => player.unlock();
    const opts = { once: true, passive: true } as const;
    window.addEventListener("pointerdown", unlock, opts);
    window.addEventListener("keydown", unlock, opts);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [player]);

  useEffect(() => {
    engine.observe(state);
  }, [engine, state]);

  // The P0 second ring must land on time even when no other state changed, so it needs a
  // clock of its own rather than the next snapshot push.
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    const timer = setInterval(() => engine.tick(stateRef.current), Math.floor(URGENT_REPEAT_MS / 6));
    return () => clearInterval(timer);
  }, [engine]);

  return useMemo(
    () => ({
      fire: (cue: CueName) => {
        player.unlock();
        engine.fire(cue);
      },
    }),
    [engine, player],
  );
}
