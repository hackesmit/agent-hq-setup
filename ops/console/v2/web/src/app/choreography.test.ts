import { describe, expect, it } from "vitest";
import {
  COMPRESS_AFTER, MOVE_MS, STAGGER_MS, decayFor, departureTotalMs, planBatch,
  type DecayMemory,
} from "./choreography";

describe("rule 1: a batch is one event with n bodies", () => {
  const mk = (n: number, sev: "P0" | "P2" | null = "P2") =>
    Array.from({ length: n }, (_, i) => ({ id: `i${i}`, severity: sev, type: "ask" }));

  it("staggers in reading order, 45 ms apart", () => {
    const p = planBatch(mk(4));
    expect(p.items.map((i) => i.delayMs)).toEqual([0, STAGGER_MS, STAGGER_MS * 2, STAGGER_MS * 3]);
  });

  it("gives the whole batch ONE call, not n", () => {
    const p = planBatch(mk(8));
    expect(p.items.filter((i) => i.call)).toHaveLength(1);
  });

  it("compresses past nine so the batch still lands inside one move", () => {
    const p = planBatch(mk(16));
    const last = Math.max(...p.items.map((i) => i.delayMs));
    expect(p.items.length).toBeGreaterThan(COMPRESS_AFTER);
    expect(last).toBeLessThan(MOVE_MS);
  });

  it("lets a P0 preempt: it lands alone on the beat and takes the call", () => {
    const p = planBatch([
      { id: "a", severity: "P2", type: "ask" },
      { id: "urgent", severity: "P0", type: "ask" },
      { id: "b", severity: "P2", type: "ask" },
    ]);
    const p0 = p.items.find((i) => i.id === "urgent")!;
    expect(p0.delayMs).toBe(0);
    expect(p0.call).toBe(true);
    expect(p.items.filter((i) => i.call)).toHaveLength(1);
  });

  it("does not make the P2s vanish when a P0 preempts: they follow, quietly", () => {
    const p = planBatch([
      { id: "urgent", severity: "P0", type: "ask" },
      { id: "a", severity: "P2", type: "ask" },
    ]);
    const other = p.items.find((i) => i.id === "a")!;
    expect(other.delayMs).toBeGreaterThan(0);   // holds one shift, then follows
    expect(other.decay).toBe("quiet");          // present, but not competing
  });

  it("stops itemising past twenty and presents a digest instead", () => {
    const p = planBatch(mk(40));
    expect(p.digest).not.toBeNull();
    expect(p.digest!.count).toBe(40);
    expect(p.items.length).toBeLessThan(40);
    expect(p.announce).toContain("40");
  });

  it("says the batch once for a screen reader, rather than n times", () => {
    expect(planBatch(mk(5)).announce).toBe("5 items");
    expect(planBatch(mk(1)).announce).toBe("1 item");
  });

  it("an empty batch does nothing at all", () => {
    const p = planBatch([]);
    expect(p.items).toEqual([]);
    expect(p.announce).toBe("");
  });
});

describe("rule 2: the four-hundredth arrival moves less than the first", () => {
  it("decays full, then quiet, then a mark", () => {
    const m: DecayMemory = new Map();
    const win = 300_000;
    expect(decayFor("finish", 0, m, win)).toBe("full");
    expect(decayFor("finish", 0 + 20_000, m, win)).toBe("mark");     // hard on its heels
    expect(decayFor("finish", 20_000 + 120_000, m, win)).toBe("quiet");
    expect(decayFor("finish", 140_000 + 400_000, m, win)).toBe("full"); // long gap resets
  });

  it("decays per type, so a rare event is not muted by a common one", () => {
    const m: DecayMemory = new Map();
    decayFor("commit", 0, m);
    expect(decayFor("merge", 1000, m)).toBe("full");
  });
});

describe("rule 3: nothing vanishes", () => {
  it("resolves, holds long enough to read, then leaves", () => {
    expect(departureTotalMs()).toBe(180 + 720 + 360);
  });
});
