import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ActivityEvent, Alert, ConsoleState } from "@shared/api";
import {
  COALESCE_MS,
  CUES,
  CUE_NAMES,
  CueEngine,
  URGENT_REPEAT_MS,
  cueForActivity,
  cueForAlert,
  inQuietHours,
  type CueName,
} from "./cues";
import { TONES, parseManifest, resolveAsset } from "./cuePlayer";

// --- fixtures ---------------------------------------------------------------

function act(id: string, type: ActivityEvent["type"], sev: Alert["severity"] | null = null): ActivityEvent {
  return { id, ts: "2026-08-24T10:00:00Z", type, rig: null, session: null, bead: null, title: id, detail: null, sev };
}

function alert(id: string, severity: Alert["severity"]): Alert {
  return { id, severity, title: id, detail: null, createdAt: "2026-08-24T10:00:00Z", source: "test", ackable: true };
}

function state(activity: ActivityEvent[] = [], alerts: Alert[] = []): ConsoleState {
  return { activity, alerts } as unknown as ConsoleState;
}

/** An engine with a controllable clock and a recording player. */
function harness(opts: { at?: number; settings?: Partial<ConstructorParameters<typeof CueEngine>[0]["settings"]> } = {}) {
  const played: CueName[] = [];
  let now = opts.at ?? Date.parse("2026-08-24T14:00:00");
  const engine = new CueEngine({
    play: (cue) => played.push(cue),
    now: () => now,
    settings: { sound: true, quietFrom: 22, quietTo: 8, ...(opts.settings ?? {}) },
  });
  return {
    engine,
    played,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
  };
}

// --- the table ---------------------------------------------------------------

describe("the cue table", () => {
  it("gives every cue a distinct salience, so 'most salient' is never a tie", () => {
    const saliences = CUE_NAMES.map((c) => CUES[c].salience);
    expect(new Set(saliences).size).toBe(saliences.length);
  });

  it("keeps routine events quieter than the ones that need the owner", () => {
    expect(CUES.DISPATCHED.salience).toBeLessThan(CUES.NEEDS_YOU.salience);
    expect(CUES.ANSWERED.salience).toBeLessThan(CUES.NEEDS_YOU.salience);
    expect(CUES.URGENT.salience).toBeGreaterThan(CUES.NEEDS_YOU.salience);
  });

  it("gives every cue a synthesized fallback voice", () => {
    for (const cue of CUE_NAMES) {
      expect(TONES[cue], cue).toBeTruthy();
      expect(TONES[cue].steps.length).toBeGreaterThan(0);
    }
  });

  it("lets only the P0 cue pierce quiet hours", () => {
    const piercing = CUE_NAMES.filter((c) => CUES[c].piercesQuietHours);
    expect(piercing).toEqual(["URGENT"]);
  });
});

// --- mapping -----------------------------------------------------------------

describe("mapping events onto cues", () => {
  it("maps the six state-driven events", () => {
    expect(cueForActivity(act("1", "ask"))).toBe("NEEDS_YOU");
    expect(cueForActivity(act("2", "answer"))).toBe("ANSWERED");
    expect(cueForActivity(act("3", "finish"))).toBe("DONE");
    expect(cueForActivity(act("4", "dispatch"))).toBe("DISPATCHED");
    expect(cueForActivity(act("5", "error"))).toBe("FAILED");
  });

  it("stays silent for events that are worth reading but not interrupting for", () => {
    expect(cueForActivity(act("6", "commit"))).toBeNull();
    expect(cueForActivity(act("7", "merge"))).toBeNull();
    expect(cueForActivity(act("8", "snooze"))).toBeNull();
    expect(cueForActivity(act("9", "capture"))).toBeNull();
  });

  it("sounds an op only when it failed", () => {
    expect(cueForActivity(act("10", "op"))).toBeNull();
    expect(cueForActivity(act("11", "op", "P1"))).toBe("FAILED");
  });

  it("sounds P0 and P1 alerts, and leaves P2 for the retro", () => {
    expect(cueForAlert(alert("a", "P0"))).toBe("URGENT");
    expect(cueForAlert(alert("b", "P1"))).toBe("NEEDS_YOU");
    expect(cueForAlert(alert("c", "P2"))).toBeNull();
  });
});

// --- priming -----------------------------------------------------------------

describe("the first snapshot", () => {
  it("primes silently, so a page refresh does not replay the whole day", () => {
    const h = harness();
    h.engine.observe(state([act("1", "ask"), act("2", "finish"), act("3", "error")], [alert("a", "P0")]));
    expect(h.played).toEqual([]);
  });

  it("still fires for what arrives after priming", () => {
    const h = harness();
    h.engine.observe(state([act("1", "ask")]));
    h.advance(COALESCE_MS + 1);
    h.engine.observe(state([act("1", "ask"), act("2", "finish")]));
    expect(h.played).toEqual(["DONE"]);
  });

  it("treats a null state as 'no news', not as an empty world", () => {
    const h = harness();
    h.engine.observe(state([act("1", "ask")]));
    h.advance(COALESCE_MS + 1);
    h.engine.observe(null); // socket dropped
    h.advance(COALESCE_MS + 1);
    h.engine.observe(state([act("1", "ask")])); // same event comes back on reconnect
    expect(h.played).toEqual([]);
  });
});

// --- one cue per tick --------------------------------------------------------

describe("one cue per snapshot", () => {
  it("plays the most salient candidate and swallows the rest", () => {
    const h = harness();
    h.engine.observe(state());
    h.engine.observe(state([act("1", "dispatch"), act("2", "ask"), act("3", "answer")]));
    expect(h.played).toEqual(["NEEDS_YOU"]);
  });

  it("lets a P0 alert beat a question in the same tick", () => {
    const h = harness();
    h.engine.observe(state());
    h.engine.observe(state([act("1", "ask")], [alert("a", "P0")]));
    expect(h.played).toEqual(["URGENT"]);
  });

  it("fires each event exactly once, however often it is re-sent", () => {
    const h = harness();
    h.engine.observe(state());
    h.engine.observe(state([act("1", "finish")]));
    h.advance(COALESCE_MS + 1);
    h.engine.observe(state([act("1", "finish")]));
    h.advance(COALESCE_MS + 1);
    h.engine.observe(state([act("1", "finish")]));
    expect(h.played).toEqual(["DONE"]);
  });
});

// --- coalescing --------------------------------------------------------------

describe("coalescing", () => {
  it("rings once for a burst inside the window", () => {
    const h = harness();
    h.engine.observe(state());
    h.engine.observe(state([act("1", "dispatch")]));
    h.advance(500);
    h.engine.observe(state([act("1", "dispatch"), act("2", "dispatch")]));
    h.advance(500);
    h.engine.observe(state([act("1", "dispatch"), act("2", "dispatch"), act("3", "dispatch")]));
    expect(h.played).toEqual(["DISPATCHED"]);
  });

  it("rings again once the window has passed", () => {
    const h = harness();
    h.engine.observe(state());
    h.engine.observe(state([act("1", "dispatch")]));
    h.advance(COALESCE_MS + 1);
    h.engine.observe(state([act("1", "dispatch"), act("2", "dispatch")]));
    expect(h.played).toEqual(["DISPATCHED", "DISPATCHED"]);
  });

  it("coalesces per cue type, so a question is not swallowed by a dispatch", () => {
    const h = harness();
    h.engine.observe(state());
    h.engine.observe(state([act("1", "dispatch")]));
    h.advance(200);
    h.engine.observe(state([act("1", "dispatch"), act("2", "ask")]));
    expect(h.played).toEqual(["DISPATCHED", "NEEDS_YOU"]);
  });
});

// --- mute and quiet hours ----------------------------------------------------

describe("mute", () => {
  it("silences everything, including P0", () => {
    const h = harness({ settings: { sound: false } });
    h.engine.observe(state());
    h.engine.observe(state([act("1", "ask")], [alert("a", "P0")]));
    expect(h.played).toEqual([]);
  });
});

describe("quiet hours", () => {
  it("wraps past midnight", () => {
    expect(inQuietHours(23, 22, 8)).toBe(true);
    expect(inQuietHours(3, 22, 8)).toBe(true);
    expect(inQuietHours(8, 22, 8)).toBe(false);
    expect(inQuietHours(14, 22, 8)).toBe(false);
  });

  it("handles a same-day window", () => {
    expect(inQuietHours(10, 9, 17)).toBe(true);
    expect(inQuietHours(18, 9, 17)).toBe(false);
  });

  it("treats from == to as 'no quiet hours'", () => {
    for (let h = 0; h < 24; h++) expect(inQuietHours(h, 0, 0)).toBe(false);
  });

  it("swallows a question at 3am", () => {
    const h = harness({ at: Date.parse("2026-08-24T03:00:00") });
    h.engine.observe(state());
    h.engine.observe(state([act("1", "ask")]));
    expect(h.played).toEqual([]);
  });

  it("still rings for a P0 at 3am", () => {
    const h = harness({ at: Date.parse("2026-08-24T03:00:00") });
    h.engine.observe(state());
    h.engine.observe(state([], [alert("a", "P0")]));
    expect(h.played).toEqual(["URGENT"]);
  });
});

// --- the P0 repeat -----------------------------------------------------------

describe("the P0 second ring", () => {
  it("rings again when the alert is still there", () => {
    const h = harness();
    h.engine.observe(state());
    h.engine.observe(state([], [alert("a", "P0")]));
    expect(h.played).toEqual(["URGENT"]);
    expect(h.engine.urgentRepeatPending()).toBe(true);

    h.advance(URGENT_REPEAT_MS + 1);
    h.engine.tick(state([], [alert("a", "P0")]));
    expect(h.played).toEqual(["URGENT", "URGENT"]);
    expect(h.engine.urgentRepeatPending()).toBe(false);
  });

  it("does not ring a third time", () => {
    const h = harness();
    h.engine.observe(state());
    h.engine.observe(state([], [alert("a", "P0")]));
    h.advance(URGENT_REPEAT_MS + 1);
    h.engine.tick(state([], [alert("a", "P0")]));
    h.advance(URGENT_REPEAT_MS * 3);
    h.engine.tick(state([], [alert("a", "P0")]));
    expect(h.played).toEqual(["URGENT", "URGENT"]);
  });

  it("disarms when the alert is acknowledged before it is due", () => {
    const h = harness();
    h.engine.observe(state());
    h.engine.observe(state([], [alert("a", "P0")]));
    h.advance(1_000);
    h.engine.tick(state([], [])); // acked, so it is gone from state
    expect(h.engine.urgentRepeatPending()).toBe(false);
    h.advance(URGENT_REPEAT_MS + 1);
    h.engine.tick(state([], []));
    expect(h.played).toEqual(["URGENT"]);
  });

  it("stays silent on a repeat while muted", () => {
    const h = harness();
    h.engine.observe(state());
    h.engine.observe(state([], [alert("a", "P0")]));
    h.engine.settings = { ...h.engine.settings, sound: false };
    h.advance(URGENT_REPEAT_MS + 1);
    h.engine.tick(state([], [alert("a", "P0")]));
    expect(h.played).toEqual(["URGENT"]);
  });
});

// --- direct fire (the Capri ear) --------------------------------------------

describe("fire(), the entry point the Capri ear uses", () => {
  it("plays immediately and reports that it did", () => {
    const h = harness();
    expect(h.engine.fire("LISTENING")).toBe(true);
    expect(h.played).toEqual(["LISTENING"]);
  });

  it("still respects the mute", () => {
    const h = harness({ settings: { sound: false } });
    expect(h.engine.fire("LISTENING")).toBe(false);
    expect(h.played).toEqual([]);
  });

  it("still respects coalescing", () => {
    const h = harness();
    expect(h.engine.fire("CANCEL")).toBe(true);
    expect(h.engine.fire("CANCEL")).toBe(false);
    h.advance(COALESCE_MS + 1);
    expect(h.engine.fire("CANCEL")).toBe(true);
  });
});

// --- the manifest ------------------------------------------------------------

describe("the cue manifest", () => {
  it("survives anything that is not a manifest", () => {
    expect(parseManifest(null)).toEqual({});
    expect(parseManifest("nope")).toEqual({});
    expect(parseManifest([1, 2])).toEqual({});
    expect(parseManifest({ files: "nope" })).toEqual({});
  });

  it("keeps only string paths, so a half-written file still loads what it has", () => {
    const m = parseManifest({ files: { DONE: "done.wav", URGENT: 42, CANCEL: "  " } });
    expect(m.files).toEqual({ DONE: "done.wav" });
  });

  it("clamps a runaway global gain", () => {
    expect(parseManifest({ gain: 100 }).gain).toBe(4);
    expect(parseManifest({ gain: -1 }).gain).toBeUndefined();
    expect(parseManifest({ gain: 1.5 }).gain).toBe(1.5);
  });

  it("resolves relative paths against the manifest, and leaves absolute ones alone", () => {
    expect(resolveAsset("done.wav")).toBe("/cues/done.wav");
    expect(resolveAsset("/other/done.wav")).toBe("/other/done.wav");
    expect(resolveAsset("https://x/done.wav")).toBe("https://x/done.wav");
  });

  it("names only real cues, so a typo in the shipped manifest is caught here", () => {
    const path = fileURLToPath(new URL("../../public/cues/cues.json", import.meta.url));
    const shipped = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    // The shipped file must itself parse cleanly, comment keys and all.
    const parsed = parseManifest(shipped);
    for (const key of Object.keys(parsed.files ?? {})) expect(CUE_NAMES).toContain(key as CueName);
    const files = (shipped.files ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(files)) expect(CUE_NAMES).toContain(key as CueName);
  });
});
