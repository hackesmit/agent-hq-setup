// Model routing for dispatch (bead hq-uyes), which is CLAUDE.md's rule expressed as code:
// the bead's own Model: field wins, risky or large work goes to the top model, Sonnet is
// only ever the default for a seriously simple bead, and anything unclear sizes up.

import { describe, expect, it } from "vitest";
import type { ReadyBead } from "@shared/api";
import {
  batchable,
  batchModelFor,
  defaultModelFor,
  MODELS,
  modelId,
  HAIKU_55,
  OPUS_47,
  OPUS_48,
  OPUS_55,
  SONNET_5,
  SONNET_55,
} from "../now/models";

function bead(over: Partial<ReadyBead> = {}): ReadyBead {
  return {
    rig: "acme-dashboard",
    id: "xd-211",
    title: "a bead",
    priority: 2,
    labels: [],
    kind: "task",
    due: null,
    estimateMin: 15,
    model: null,
    ...over,
  };
}

describe("modelId", () => {
  it("accepts ids, labels and loose spellings", () => {
    expect(modelId("claude-opus-5-5")).toBe(OPUS_55);
    expect(modelId("Opus 5.5")).toBe(OPUS_55);
    expect(modelId("sonnet 5.5")).toBe(SONNET_55);
    expect(modelId("Haiku 5.5")).toBe(HAIKU_55);
    // previous-generation ids on an old Model: field still resolve
    expect(modelId("claude-opus-4-8")).toBe(OPUS_48);
    expect(modelId("Opus 4.8")).toBe(OPUS_48);
    expect(modelId("opus 4.7")).toBe(OPUS_47);
    expect(modelId("Sonnet 5")).toBe(SONNET_5);
    expect(modelId("claude-fable-5")).toBe("claude-fable-5");
    expect(modelId("claude-fable-5-1")).toBe("claude-fable-5-1");
  });

  it("returns null when there is nothing to map, so the rule can decide", () => {
    expect(modelId(null)).toBeNull();
    expect(modelId("")).toBeNull();
    expect(modelId("gpt-5.6")).toBeNull();
  });

  it("only ever returns an id the picker offers", () => {
    const ids = MODELS.map((model) => model.id);
    for (const label of ["Opus 5.5", "sonnet-5-5", "haiku 5.5", "Opus 4.8", "opus-4-7", "sonnet 5", "Fable 5"]) {
      expect(ids).toContain(modelId(label));
    }
  });
});

describe("defaultModelFor", () => {
  it("honours the bead's own Model: field above everything else", () => {
    expect(defaultModelFor(bead({ model: "Sonnet 5.5", labels: ["redteam"], priority: 0 }))).toBe(SONNET_55);
  });

  it("sends redteam and money-shaped work to the top model", () => {
    for (const label of ["redteam", "auth", "money", "checkout", "cfdi", "data"]) {
      expect(defaultModelFor(bead({ labels: [label] })), label).toBe(OPUS_55);
    }
  });

  it("sends P0 work to the top model", () => {
    expect(defaultModelFor(bead({ priority: 0 }))).toBe(OPUS_55);
  });

  it("sizes up on a long estimate", () => {
    expect(defaultModelFor(bead({ estimateMin: 45 }))).toBe(OPUS_55);
    expect(defaultModelFor(bead({ estimateMin: 90 }))).toBe(OPUS_55);
  });

  it("allows Sonnet only for a small, mechanical bead, and never defaults to Haiku", () => {
    expect(defaultModelFor(bead({ labels: ["typo"], estimateMin: 5 }))).toBe(SONNET_55);
    expect(defaultModelFor(bead({ labels: ["chore"], estimateMin: 10 }))).toBe(SONNET_55);
    // Simple label, but half an hour of work: not seriously simple any more.
    expect(defaultModelFor(bead({ labels: ["chore"], estimateMin: 30 }))).toBe(OPUS_55);
    for (const b of [bead(), bead({ labels: ["typo"], estimateMin: 5 }), bead({ priority: 0 })]) {
      expect(defaultModelFor(b)).not.toBe(HAIKU_55);
    }
  });

  it("defaults to Opus when nothing says otherwise: unsure sizes up, never down", () => {
    expect(defaultModelFor(bead())).toBe(OPUS_55);
    expect(defaultModelFor(bead({ estimateMin: null }))).toBe(OPUS_55);
    expect(defaultModelFor(bead({ labels: ["ui", "bug"] }))).toBe(OPUS_55);
  });
});

describe("batchModelFor", () => {
  it("takes the strongest default in the batch", () => {
    expect(
      batchModelFor([bead({ labels: ["typo"], estimateMin: 5 }), bead({ id: "xd-2", estimateMin: 60 })]),
    ).toBe(OPUS_55);
    expect(
      batchModelFor([bead({ labels: ["typo"], estimateMin: 5 }), bead({ id: "xd-2", labels: ["chore"], estimateMin: 5 })]),
    ).toBe(SONNET_55);
  });

  it("falls back to Opus for an empty batch: unsure sizes up", () => {
    expect(batchModelFor([])).toBe(OPUS_55);
  });

  it("never overrides a batch whose members all asked for something below the old floor", () => {
    // lucy round 1 (2026-10-08): a floor above the members' explicit choices
    // silently replaced a Haiku-only batch and a legacy Sonnet 5 batch.
    expect(batchModelFor([bead({ model: "Haiku 5.5" }), bead({ id: "xd-2", model: "Haiku 5.5" })])).toBe(HAIKU_55);
    expect(batchModelFor([bead({ model: "Sonnet 5" }), bead({ id: "xd-2", model: "claude-sonnet-5" })])).toBe(SONNET_5);
    expect(batchModelFor([bead({ model: "Haiku 5.5" }), bead({ id: "xd-2", model: "Sonnet 5" })])).toBe(SONNET_5);
  });
});

describe("batchable", () => {
  it("keeps redteam and P0 beads out of a batch", () => {
    expect(batchable(bead({ labels: ["redteam"] }))).toBe(false);
    expect(batchable(bead({ priority: 0 }))).toBe(false);
    expect(batchable(bead({ labels: ["ui"], priority: 2 }))).toBe(true);
  });
});

describe("the 5.5 generation is dispatchable and the previous one still resolves", () => {
  it("offers the current generation first and keeps the old ids selectable", () => {
    expect(MODELS[0]!.label).toBe("Opus 5.5");
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1", "claude-opus-5"]) {
      expect(MODELS.map((m) => m.id)).toContain(id);
    }
  });

  it("is resolvable from the ways a bead might spell it", () => {
    expect(modelId("Opus 5")).toBe("claude-opus-5");
    expect(modelId("claude-opus-5")).toBe("claude-opus-5");
    expect(modelId("opus-5")).toBe("claude-opus-5");
  });

  it("a batch takes the strongest member and never sizes a newer Opus down", () => {
    const bead = (model: string | null) => ({ labels: [], priority: 2, estimateMin: 20, model });
    expect(batchModelFor([bead("Opus 5"), bead("Opus 4.7")])).toBe("claude-opus-5");
    expect(batchModelFor([bead("Opus 5.5"), bead("Opus 5")])).toBe("claude-opus-5-5");
    expect(batchModelFor([bead("Haiku 5.5"), bead("Sonnet 5.5")])).toBe("claude-sonnet-5-5");
    expect(batchModelFor([bead("Sonnet 5"), bead("Fable 5.1")])).toBe("claude-fable-5-1");
  });

  it("routes risk and P0 to the current Opus (stack refresh 2026-10-08, proposal 57)", () => {
    expect(defaultModelFor({ labels: ["redteam"], priority: 2, estimateMin: 20, model: null })).toBe("claude-opus-5-5");
    expect(defaultModelFor({ labels: [], priority: 0, estimateMin: 20, model: null })).toBe("claude-opus-5-5");
  });
});

describe("hq beads cannot be dispatched at all", () => {
  it("is not batchable, because ctl refuses to spawn a worker for one", () => {
    // the owner hit this: dispatching hq-7e9n failed with "hq beads are worked in a
    // terminal, not a spawned worker". Queueing one in a batch would be the same
    // failure, later and less obviously.
    expect(batchable({ rig: "hq", labels: [], priority: 2 })).toBe(false);
    expect(batchable({ rig: "hq", labels: [], priority: 3 })).toBe(false);
    // every other rig is unchanged
    expect(batchable({ rig: "chesski", labels: [], priority: 2 })).toBe(true);
    expect(batchable({ rig: "chesski", labels: ["redteam"], priority: 2 })).toBe(false);
    expect(batchable({ rig: "chesski", labels: [], priority: 0 })).toBe(false);
  });
});
