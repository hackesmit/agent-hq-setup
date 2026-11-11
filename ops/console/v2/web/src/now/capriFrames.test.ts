import { describe, expect, it } from "vitest";
import { CAPRI_FRAMES_URL, capriFileProblem, capriClip, capriFrameAt, parseCapriFrames, type CapriFrames } from "./capriFrames";

const manifest = {
  version: 1,
  states: {
    idle: { ms: 700, frames: ["idle/001.png"] },
    speaking: { ms: 110, frames: ["speaking/1.webp", "speaking/2.webp", "speaking/3.webp"] },
  },
};

describe("capri frames manifest", () => {
  it("turns the server's list into frame urls", () => {
    const f = parseCapriFrames(manifest) as CapriFrames;
    expect(f.idle).toEqual({ ms: 700, frames: [`${CAPRI_FRAMES_URL}/idle/001.png`] });
    expect(f.speaking?.frames).toHaveLength(3);
    expect(f.listening).toBeUndefined();
  });
  it("no manifest, a wrong version or no frames at all means no frames", () => {
    for (const bad of [null, "x", {}, { ...manifest, version: 2 }, { version: 1, states: {} },
      { version: 1, states: { idle: { ms: 100, frames: [] } } }]) {
      expect(parseCapriFrames(bad)).toBeNull();
    }
  });
  it("keeps only frames inside their own state folder and clamps the frame time", () => {
    const f = parseCapriFrames({
      version: 1,
      states: {
        idle: { ms: 1, frames: ["idle/../../secret.png", "speaking/1.png", "https://x/idle/1.png", "idle/a.svg", "idle/1.png"] },
        thinking: { ms: 1e9, frames: ["thinking/1.png"] },
        glitch: { ms: 100, frames: ["glitch/1.png"] },
      },
    }) as CapriFrames;
    expect(f.idle).toEqual({ ms: 40, frames: [`${CAPRI_FRAMES_URL}/idle/1.png`] });
    expect(f.thinking?.ms).toBe(5000);
    expect(Object.keys(f)).toEqual(["idle", "thinking"]);
  });
});

describe("capri frame player", () => {
  const f = parseCapriFrames(manifest) as CapriFrames;
  it("a mood with no frames of its own falls back to idle", () => {
    expect(capriClip(f, "listening")).toBe(f.idle);
    expect(capriClip(f, "speaking")).toBe(f.speaking);
  });
  it("with no idle, any supplied state stands in", () => {
    const only = parseCapriFrames({ version: 1, states: { thinking: { ms: 300, frames: ["thinking/1.png"] } } }) as CapriFrames;
    expect(capriClip(only, "idle")).toBe(only.thinking);
  });
  it("loops the clip at its frame time", () => {
    const c = f.speaking!;
    expect([0, 109, 110, 230, 330, 440].map((t) => capriFrameAt(c, t, false).slice(-6, -5))).toEqual(["1", "1", "2", "3", "1", "2"]);
  });
  it("reduced motion holds the first frame", () => {
    expect(capriFrameAt(f.speaking!, 250, true)).toBe(f.speaking!.frames[0]);
  });
});

describe("Load images file check", () => {
  const ok = { name: "a.png", type: "image/png", size: 1000 };
  it("accepts png, jpg, webp and gif up to 5 MB", () => {
    for (const n of ["a.png", "a.JPG", "a.jpeg", "a.webp", "a.gif"]) expect(capriFileProblem({ ...ok, name: n, type: "" })).toBeNull();
    expect(capriFileProblem({ ...ok, size: 5 * 1024 * 1024 })).toBeNull();
  });
  it("refuses other types, an empty file and anything over 5 MB", () => {
    expect(capriFileProblem({ name: "a.svg", type: "image/svg+xml", size: 10 })).toMatch(/png/);
    expect(capriFileProblem({ ...ok, size: 5 * 1024 * 1024 + 1 })).toMatch(/5 MB/);
    expect(capriFileProblem({ ...ok, size: 0 })).toMatch(/Empty/);
  });
});
