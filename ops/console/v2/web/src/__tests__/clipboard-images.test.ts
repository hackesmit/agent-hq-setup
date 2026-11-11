// The screenshot-paste decision: which pastes are treated as images, and what
// the uploaded file gets called.

import { describe, expect, it } from "vitest";
import { pastedImages, screenshotName, type PastedItem } from "../now/clipboardImages";

const PNG = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });

function item(over: Partial<PastedItem> & { type: string }): PastedItem {
  return { kind: "file", getAsFile: () => PNG, ...over };
}

describe("pastedImages", () => {
  it("an image-only paste (a screenshot) is the images it carries", () => {
    expect(pastedImages([item({ type: "image/png" })], "")).toEqual([PNG]);
  });

  it("text wins: a mixed clipboard (Excel, Word) stays a text paste", () => {
    expect(pastedImages([item({ type: "image/png" })], "A1\tB1")).toEqual([]);
  });

  it("whitespace-only text does not count as text", () => {
    expect(pastedImages([item({ type: "image/png" })], "  \n")).toEqual([PNG]);
  });

  it("non-image files and string items are left alone", () => {
    expect(pastedImages([item({ type: "application/pdf" })], "")).toEqual([]);
    expect(pastedImages([{ kind: "string", type: "text/plain", getAsFile: () => null }], "")).toEqual([]);
  });

  it("an item whose file is gone contributes nothing", () => {
    expect(pastedImages([{ kind: "file", type: "image/png", getAsFile: () => null }], "")).toEqual([]);
  });
});

describe("screenshotName", () => {
  it("stamps date, time and the real extension", () => {
    const when = new Date(2026, 7, 27, 9, 5, 3);
    expect(screenshotName(PNG, when)).toBe("screenshot-20260827-090503.png");
    const jpeg = new File([""], "image.jpg", { type: "image/jpeg" });
    expect(screenshotName(jpeg, when)).toBe("screenshot-20260827-090503.jpeg");
  });

  it("an unknown image type still gets a safe extension", () => {
    const odd = new File([""], "x", { type: "image/svg+xml" });
    expect(screenshotName(odd, new Date(2026, 7, 27, 9, 5, 3))).toBe("screenshot-20260827-090503.svgxml");
  });
});
