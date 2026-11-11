import { describe, expect, it } from "vitest";
import { addDraft, draftLabel, headDraft, removeDraft, submitBytes, type Draft } from "../now/injectBanner";

describe("the voice-draft banner queue", () => {
  it("queues drafts FIFO: a second task does not drop the first", () => {
    let q: Draft[] = [];
    q = addDraft(q, { id: "1", text: "restart the server" });
    q = addDraft(q, { id: "2", text: "check the deploy" });
    expect(q.map((d) => d.id)).toEqual(["1", "2"]);
    expect(headDraft(q)).toEqual({ id: "1", text: "restart the server" });
  });

  it("de-dupes by id and ignores empty/whitespace and id-less drafts", () => {
    let q = addDraft([], { id: "1", text: "one" });
    q = addDraft(q, { id: "1", text: "one again" }); // dup id
    q = addDraft(q, { id: "2", text: "   " });        // empty
    q = addDraft(q, { id: "", text: "no id" });       // no id
    expect(q).toEqual([{ id: "1", text: "one" }]);
  });

  it("trims the text it queues", () => {
    expect(addDraft([], { id: "1", text: "  hi  " })).toEqual([{ id: "1", text: "hi" }]);
  });

  it("removeDraft pops the sent/dismissed one, exposing the next", () => {
    let q = addDraft(addDraft([], { id: "1", text: "a" }), { id: "2", text: "b" });
    q = removeDraft(q, "1");
    expect(headDraft(q)).toEqual({ id: "2", text: "b" });
  });

  it("headDraft is null on an empty queue", () => {
    expect(headDraft([])).toBeNull();
  });

  it("Send commits the text plus one submit newline, and only that", () => {
    expect(submitBytes({ id: "1", text: "do the thing" })).toBe("do the thing\r");
  });

  it("truncates a long dictation to one line", () => {
    const label = draftLabel({ id: "1", text: "x".repeat(200) }, 120);
    expect(label.length).toBe(120);
    expect(label.endsWith("…")).toBe(true);
  });
});
