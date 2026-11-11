// Rig sigils. The mark is a FORMAT, not an implementation: it is drawn beside a project
// name everywhere in the console, so a change here silently reassigns every project's
// identity. These tests pin the properties that make it usable, and the golden values
// that make a change to the algorithm impossible to land by accident.
import { describe, expect, it } from "vitest";
import { hashId, sigilDistance, sigilFor, SIGIL_HUES } from "./sigil";

// Every project the workspace actually carries today: the registry, the rig checkouts
// and the bunkers. The point of the feature is that this list keeps growing and nothing
// has to be registered, so the test grows with it.
const REAL_IDS = [
  "hq",
  "acme-dashboard",
  "gym-tracker",
  "chesski",
  "fintrack-portfolio",
  "studioco-digital",
  "lodgeco",
  "acme-financial",
  "hq-mail",
  "minecraft",
  "acme-avance",
  "nonprofit-a",
  "cliente-ads",
  "agencyco-site",
  "clientd-site",
  "client-e-marketing",
  "agencyco-accounts",
];

describe("sigilFor", () => {
  it("is deterministic and case and space insensitive", () => {
    const a = sigilFor("acme-dashboard");
    const b = sigilFor("acme-dashboard");
    const c = sigilFor("  acme-Dashboard ");
    expect(a).toEqual(b);
    expect(c.hue).toBe(a.hue);
    expect(c.cells).toEqual(a.cells);
  });

  it("gives a new project a mark with no registration step", () => {
    // the whole point: an id nobody has seen before still resolves
    const fresh = sigilFor("a-project-invented-in-this-test");
    expect(fresh.hue).toBeGreaterThanOrEqual(1);
    expect(fresh.hue).toBeLessThanOrEqual(SIGIL_HUES);
    expect(fresh.cells).toHaveLength(25);
  });

  it("never returns an empty or solid glyph, which would be unreadable", () => {
    for (const id of [...REAL_IDS, "a", "zzzz", "1", "x".repeat(80), "new-rig-2027"]) {
      const filled = sigilFor(id).cells.filter(Boolean).length;
      expect(filled, `${id} filled ${filled}`).toBeGreaterThanOrEqual(7);
      expect(filled, `${id} filled ${filled}`).toBeLessThanOrEqual(17);
    }
  });

  it("is left-right symmetric, so the mark reads as an emblem", () => {
    for (const id of REAL_IDS) {
      const { cells } = sigilFor(id);
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 2; col++) {
          expect(cells[row * 5 + col]).toBe(cells[row * 5 + (4 - col)]);
        }
      }
    }
  });

  it("gives every real project a distinguishable mark", () => {
    const marks = REAL_IDS.map((id) => ({ id, sigil: sigilFor(id) }));
    for (let i = 0; i < marks.length; i++) {
      for (let j = i + 1; j < marks.length; j++) {
        const distance = sigilDistance(marks[i].sigil, marks[j].sigil);
        // 0 would mean two projects share both hue and shape: the same mark twice
        expect(distance, `${marks[i].id} vs ${marks[j].id}`).toBeGreaterThan(0);
      }
    }
  });

  it("spreads across the ramp rather than piling onto one hue", () => {
    const used = new Set(REAL_IDS.map((id) => sigilFor(id).hue));
    // not a uniformity claim, just that the ramp is genuinely in use
    expect(used.size).toBeGreaterThanOrEqual(6);
  });

  it("keeps the marks it has already assigned (golden values)", () => {
    // If this test fails, the algorithm changed and every project in the console just
    // got a different color and glyph. That may be intended, but it is never incidental.
    expect(hashId("hq")).toBe(hashId("hq"));
    const golden: Record<string, number> = {
      hq: 11,
      "acme-dashboard": 6,
      "gym-tracker": 2,
      chesski: 12,
      "fintrack-portfolio": 6,
      "studioco-digital": 8,
      minecraft: 5,
      "acme-avance": 12,
    };
    for (const [id, hue] of Object.entries(golden)) {
      expect(sigilFor(id).hue, `${id} changed hue`).toBe(hue);
    }
    expect(sigilFor("chesski").cells.map((c) => (c ? 1 : 0)).join("")).toBe(
      "0111000100101010000001010",
    );
  });

  it("treats an empty id as unknown rather than throwing", () => {
    expect(() => sigilFor("")).not.toThrow();
    expect(sigilFor("").cells.filter(Boolean).length).toBeGreaterThan(0);
  });
});
