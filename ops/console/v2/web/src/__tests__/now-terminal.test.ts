// Copying text out of a terminal pane. The interesting part is not the clipboard
// call, it is rebuilding lines from the xterm buffer: a soft wrap is a rendering
// detail of the pane's current width, not part of what the shell printed, so a
// copied command has to come back as one line or it will not paste.
import { describe, expect, it } from "vitest";
import { bufferText, isPasteChord } from "../now/Terminal";

interface Row {
  text: string;
  wrapped?: boolean;
}

/** The slice of xterm's API bufferText actually reads. */
function fakeTerm(rows: Row[]) {
  const lines = rows.map((row) => ({
    isWrapped: Boolean(row.wrapped),
    // xterm's own contract: the argument is "trim trailing whitespace".
    translateToString: (trim: boolean) => (trim ? row.text.replace(/\s+$/, "") : row.text),
  }));
  return {
    buffer: {
      active: {
        length: lines.length,
        getLine: (i: number) => lines[i],
      },
    },
  } as unknown as Parameters<typeof bufferText>[0];
}

describe("bufferText", () => {
  it("joins a soft-wrapped line back into the one line the shell printed", () => {
    const text = bufferText(
      fakeTerm([
        { text: "$ npx supabase db push --linked --project-ref abcd" },
        { text: "efghijkl", wrapped: true },
        { text: "done" },
      ]),
    );
    expect(text).toBe("$ npx supabase db push --linked --project-ref abcdefghijkl\ndone");
  });

  it("keeps the padding a wrapped row depends on, and trims the row that ends a line", () => {
    // Right-trimming a row whose continuation follows would eat the space between
    // two words that happened to straddle the wrap.
    const text = bufferText(fakeTerm([{ text: "one two   " }, { text: "three", wrapped: true }]));
    expect(text).toBe("one two   three");
    expect(bufferText(fakeTerm([{ text: "trailing   " }]))).toBe("trailing");
  });

  it("drops the blank rows below the cursor rather than copying a screen of newlines", () => {
    const text = bufferText(fakeTerm([{ text: "output" }, { text: "" }, { text: "" }, { text: "" }]));
    expect(text).toBe("output");
  });

  it("blank lines inside the output are content, not padding", () => {
    expect(bufferText(fakeTerm([{ text: "a" }, { text: "" }, { text: "b" }]))).toBe("a\n\nb");
  });

  it("an empty pane copies as nothing, which is what makes the button say so", () => {
    expect(bufferText(fakeTerm([]))).toBe("");
    expect(bufferText(fakeTerm([{ text: "" }, { text: "" }]))).toBe("");
  });
});

describe("isPasteChord", () => {
  const ev = (over: Partial<Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">>) => ({
    key: "v",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });

  it("on PC, Ctrl+V and Ctrl+Shift+V are the paste chord; xterm must step aside for both", () => {
    expect(isPasteChord(ev({ ctrlKey: true }), false)).toBe(true);
    // shift must not disqualify the chord: Ctrl+Shift+V is paste-without-formatting
    expect(isPasteChord(ev({ ctrlKey: true, shiftKey: true }), false)).toBe(true);
  });

  it("on Mac, Cmd+V is the paste chord and Ctrl+V is not", () => {
    expect(isPasteChord(ev({ metaKey: true }), true)).toBe(true);
    expect(isPasteChord(ev({ ctrlKey: true }), true)).toBe(false);
  });

  it("AltGr (Ctrl+Alt)+V is a layout character, never a paste", () => {
    expect(isPasteChord(ev({ ctrlKey: true, altKey: true }), false)).toBe(false);
  });

  it("other keys and bare V are not the chord", () => {
    expect(isPasteChord(ev({ key: "c", ctrlKey: true }), false)).toBe(false);
    expect(isPasteChord(ev({}), false)).toBe(false);
  });
});
