import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../theme/tokens.css", import.meta.url), "utf8");
const tsx = readFileSync(new URL("./CapriCorner.tsx", import.meta.url), "utf8");

describe("capri square neon frame (hq-ymxzt.6)", () => {
  it("carries the owner's palette in tokens", () => {
    for (const hex of ["#100d18", "#ff1744", "#b6ff00", "#00d9ff", "#ff2d95", "#f5f5f5", "#21152f", "#8c164f", "#ffb4d9", "#777482"]) {
      expect(tokens.toLowerCase()).toContain(hex);
    }
    expect(tokens).not.toMatch(/#ff2bd6/i);
  });
  it("is a square capri.exe window with a turning conic ring and a glow by state", () => {
    expect(tsx).toContain("capri.exe");
    expect(css).toContain("conic-gradient(from var(--hq-capri-a)");
    expect(css).toContain("@keyframes hq-capri-turn");
    expect(css).not.toContain("polygon(50% 0, 100% 25%");
    expect(css).toMatch(/\.hq-capri-badge\[data-mood="listening"\]/);
    expect(css).toMatch(/\.hq-capri-badge\[data-mood="thinking"\]/);
    expect(css).toMatch(/\.hq-capri-badge\[data-mood="speaking"\]/);
    expect(css).toContain("var(--capri-cyan)");
  });
  it("stills the ring under reduced motion, listening pulse included", () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{[^}]*\}\s*\.hq-capri-badge, \.hq-capri-badge\[data-mood\][^}]*animation: none/);
  });
  it("keeps reduced motion and the input lift", () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.hq-capri-corner, \.hq-capri-badge \{ transition/);
    expect(tsx).toContain("useLift");
  });
  it("never edits the image files", () => {
    expect(tsx).not.toMatch(/canvas|toDataURL/i);
  });
});
