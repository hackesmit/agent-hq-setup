// The handoff card. The Finish button is enabled from readGate and nothing else, so the
// reading has to be conservative: a false block costs a second look, a false pass merges
// unreviewed work into main.
import { describe, expect, it } from "vitest";
import { barWidths, biggestChurn, diffSummary, mayFinish, readGate, reviewCommand, type Diffstat } from "./handoff";

describe("readGate", () => {
  it("treats a refusal as a block, whatever words it used", () => {
    const blocks = [
      "finish: refusing js-4: no Review-Approve marker for 7f59483",
      "blocked: the worktree is dirty",
      "missing verification receipt on the bead",
      "merge conflict against main",
      "checks failed: 2 of 41",
      "not allowed on a canonical branch",
    ];
    for (const text of blocks) {
      const reading = readGate(text);
      expect(reading.verdict, text).toBe("block");
      expect(mayFinish(reading), text).toBe(false);
    }
  });

  it("only calls it a pass on a clear pass", () => {
    for (const text of ["gate passed, nothing to report", "would merge cleanly into main", "ready to finish"]) {
      expect(readGate(text).verdict, text).toBe("pass");
      expect(mayFinish(readGate(text))).toBe(true);
    }
  });

  it("refuses to guess, and a guess is never a pass", () => {
    for (const text of ["", "some output nobody planned for", "usage: finish.sh <id>"]) {
      const reading = readGate(text);
      expect(reading.verdict, text).not.toBe("pass");
      expect(mayFinish(reading), text).toBe(false);
    }
    expect(readGate(null).verdict).toBe("unknown");
    expect(mayFinish(readGate(null))).toBe(false);
    expect(mayFinish(readGate("checking..."))).toBe(false);
  });

  it("reads a mixed message as a block, since it is describing what is wrong", () => {
    const reading = readGate("gate passed for the branch but the receipt is missing");
    expect(reading.verdict).toBe("block");
    expect(mayFinish(reading)).toBe(false);
  });

  it("reads the gate's JSON as a sentence rather than showing a blob", () => {
    const blocked = readGate('{"bead": "", "ok": false, "reason": "no live session"}');
    expect(blocked.verdict).toBe("block");
    expect(blocked.line).toBe("no live session");
    expect(mayFinish(blocked)).toBe(false);

    const passed = readGate('{"bead": "xd-207", "ok": true, "reason": "approval found for 7f59483"}');
    expect(passed.verdict).toBe("pass");
    expect(passed.line).toBe("approval found for 7f59483");

    // ok:false with nothing to say is still a block, and says so
    expect(readGate('{"ok": false}').verdict).toBe("block");
    expect(readGate('{"ok": false}').line).toMatch(/no reason given/);

    // JSON without a verdict is never a pass
    expect(mayFinish(readGate('{"bead": "xd-207"}'))).toBe(false);
    // and malformed JSON falls back to reading it as prose
    expect(readGate('{"ok": tru').verdict).not.toBe("pass");
  });

  it("quotes the gate's own first line rather than inventing a summary", () => {
    const reading = readGate("finish: refusing js-4: no receipt\n  see ops/scripts/finish.sh:212");
    expect(reading.line).toBe("finish: refusing js-4: no receipt");
  });
});

describe("the diffstat", () => {
  const stat: Diffstat = {
    branch: "xd-207-avance-tema",
    base: "main",
    added: 186,
    removed: 23,
    files: [
      { path: "web/mocks/avance-app.html", added: 141, removed: 8 },
      { path: "web/src/theme/tokens.css", added: 22, removed: 4 },
      { path: "assets/logo.png", added: null, removed: null },
    ],
  };

  it("summarises without pretending to know more than it does", () => {
    expect(diffSummary(stat)).toBe("3 files, +186 -23");
    expect(diffSummary({ ...stat, files: [], added: 0, removed: 0 })).toBe("no changes against the base");
    expect(diffSummary({ ...stat, note: "no branch on this session" })).toBe("no branch on this session");
    expect(diffSummary(null)).toBe("");
    expect(diffSummary({ ...stat, truncated: true })).toContain("3 files+");
  });

  it("scales the bars against the biggest file, and shows a binary file as a file", () => {
    expect(biggestChurn(stat.files)).toBe(149);
    const big = barWidths(stat.files[0], 149);
    const small = barWidths(stat.files[1], 149);
    expect(big.add).toBeGreaterThan(small.add);
    expect(big.add).toBeLessThanOrEqual(90);
    // a binary file has no counts, so it gets no bar rather than a zero-width lie
    const binary = barWidths(stat.files[2], 149);
    expect(binary.add).toBe(0);
    expect(binary.del).toBe(0);
  });

  it("gives a tiny change a visible bar rather than nothing", () => {
    const one = barWidths({ path: "x", added: 1, removed: 0 }, 5000);
    expect(one.add).toBeGreaterThanOrEqual(2);
  });
});

describe("reviewCommand", () => {
  it("is the command you would type, with the rig and base filled in", () => {
    expect(reviewCommand("acme-dashboard", "main", "xd-207: avance tema sync")).toBe(
      'lucy --rig acme-dashboard --base main "xd-207: avance tema sync"',
    );
  });

  it("drops the rig for hq itself", () => {
    expect(reviewCommand(null, "main", "hq-6l74: the runner fix")).toBe('lucy --base main "hq-6l74: the runner fix"');
  });

  it("quotes the description so a quote in a bead title cannot break the line", () => {
    expect(reviewCommand("chesski", "main", 'ch-19: the "depth" flag')).toContain('\\"depth\\"');
  });
});
