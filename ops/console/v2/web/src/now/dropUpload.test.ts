import { describe, expect, it } from "vitest";
import { droppedFiles, pasteText, runDrop, shellQuote } from "./dropUpload";

const f = (name: string) => new File(["x"], name);

describe("shellQuote", () => {
  it("leaves plain paths alone", () => expect(shellQuote("/srv/in/a-b_1.png")).toBe("/srv/in/a-b_1.png"));
  it("quotes a space", () => expect(shellQuote("/srv/in/my file.png")).toBe("'/srv/in/my file.png'"));
  it("escapes a single quote", () => expect(shellQuote("/srv/in/it's.png")).toBe(`'/srv/in/it'\\''s.png'`));
  it("quotes shell metacharacters", () => expect(shellQuote("/srv/in/a$(x).png")).toBe("'/srv/in/a$(x).png'"));
});

describe("pasteText", () => {
  it("joins with spaces", () => expect(pasteText(["/a", "/b c"])).toBe("/a '/b c'"));
});

describe("droppedFiles", () => {
  it("counts folders and keeps files", () => {
    const file = f("a.txt");
    const out = droppedFiles([
      { kind: "file", getAsFile: () => null, webkitGetAsEntry: () => ({ isDirectory: true }) },
      { kind: "file", getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: false }) },
      { kind: "string", getAsFile: () => null },
    ]);
    expect(out).toEqual({ files: [file], folders: 1 });
  });
});

describe("runDrop", () => {
  it("one refused, two pasted, in order", async () => {
    const seen: string[] = [];
    const text = await runDrop([f("one.txt"), f("bad.bin"), f("two three.txt")], async (file) => {
      seen.push(file.name);
      return file.name === "bad.bin" ? null : `/srv/in/${file.name}`;
    });
    expect(seen).toEqual(["one.txt", "bad.bin", "two three.txt"]);
    expect(text).toBe("/srv/in/one.txt '/srv/in/two three.txt' ");
  });
  it("null when nothing uploaded", async () => {
    expect(await runDrop([f("a")], async () => null)).toBeNull();
  });
});
