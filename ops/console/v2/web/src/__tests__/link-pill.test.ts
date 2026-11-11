// hq-aukwy: a drop shows one small "reconnecting" pill, never an offline page.
import { describe, expect, it } from "vitest";
import { linkPill } from "../app/linkPill";

describe("linkPill", () => {
  it("live is plain green text", () => {
    expect(linkPill("live", "socket")).toEqual({ label: "live", tone: "text-ok", pill: false });
  });
  it("connecting and polling both read as reconnecting, in a pill", () => {
    expect(linkPill("connecting", "socket")).toMatchObject({ label: "reconnecting", pill: true });
    expect(linkPill("polling", "poll")).toMatchObject({ label: "reconnecting", pill: true });
  });
  it("offline is only for a stopped link", () => {
    expect(linkPill("offline", "none")).toMatchObject({ label: "offline", pill: true });
  });
  it("mock data says so", () => {
    expect(linkPill("live", "mock").label).toBe("mock data");
  });
});
