// Folding sections and the resizable orchestrator box on Now (bead hq-4npjr.17).

import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Fold, readFolded, saveFolded } from "../ui/Fold";
import { Card, CardBody, CardHead } from "../ui/primitives";
import { ORCH_HEIGHT_KEY, ORCH_MIN_PX, clampHeight, defaultHeight, dragHeight, readHeight, saveHeight } from "../now/orchHeight";
import { mockState } from "../data/mock";
import { NowTab } from "../tabs/NowTab";

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}

function card(id: string | null) {
  const inner = createElement(Card, null, createElement(CardHead, { title: "Uploads", chip: "3 files" }), createElement(CardBody, null, "the body"));
  return renderToStaticMarkup(id ? createElement(Fold, { id }, inner) : inner);
}

afterEach(() => vi.unstubAllGlobals());

describe("fold state", () => {
  it("round-trips per section id and forgets an unfold", () => {
    const store = memoryStorage();
    expect(readFolded("now.uploads", store)).toBe(false);
    saveFolded("now.uploads", true, store);
    expect(readFolded("now.uploads", store)).toBe(true);
    expect(readFolded("now.activity", store)).toBe(false);
    saveFolded("now.uploads", false, store);
    expect(store.data.size).toBe(0);
  });

  it("survives a storage that throws", () => {
    const bad = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    expect(readFolded("x", bad)).toBe(false);
    expect(() => saveFolded("x", true, bad)).not.toThrow();
  });
});

describe("Fold around a card", () => {
  it("a plain card has no toggle", () => {
    const html = card(null);
    expect(html).not.toContain("fold-toggle");
    expect(html).not.toContain("data-folded");
  });

  it("an open fold puts a toggle in the head and keeps the body", () => {
    const html = card("t.open");
    expect(html).toContain('data-testid="fold-toggle"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain("data-folded");
    expect(html).toContain("the body");
  });

  it("a stored fold marks the card folded and keeps head and count", () => {
    vi.stubGlobal("localStorage", memoryStorage({ "hq.fold.t.shut": "1" }));
    const html = card("t.shut");
    expect(html).toContain('data-folded=""');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("hq-card-head");
    expect(html).toContain("3 files");
  });

  it("a card nested in a folded card does not take the outer toggle", () => {
    const nested = createElement(Card, null, createElement(CardHead, { title: "Inner" }));
    const outer = createElement(Fold, { id: "t.nest" }, createElement(Card, null, createElement(CardHead, { title: "Outer" }), createElement(CardBody, null, nested)));
    const html = renderToStaticMarkup(outer);
    expect(html.match(/data-testid="fold-toggle"/g)?.length).toBe(1);
  });
});

describe("orchestrator box height", () => {
  it("opens at 65 percent of the window", () => {
    expect(defaultHeight(1000)).toBe(650);
  });

  it("clamps between 240 px and 90 percent of the window", () => {
    expect(clampHeight(100, 1000)).toBe(ORCH_MIN_PX);
    expect(clampHeight(5000, 1000)).toBe(900);
    expect(clampHeight(500.4, 1000)).toBe(500);
    // A window shorter than the floor still gives the floor.
    expect(clampHeight(500, 200)).toBe(ORCH_MIN_PX);
  });

  it("a drag moves the bottom edge with the pointer", () => {
    expect(dragHeight(400, 300, 450, 1000)).toBe(550);
    expect(dragHeight(400, 300, 0, 1000)).toBe(ORCH_MIN_PX);
  });

  it("stores and reads the height, rejecting junk", () => {
    const store = memoryStorage();
    expect(readHeight(store)).toBeNull();
    saveHeight(store, 612.7);
    expect(store.data.get(ORCH_HEIGHT_KEY)).toBe("613");
    expect(readHeight(store)).toBe(613);
    expect(readHeight(memoryStorage({ [ORCH_HEIGHT_KEY]: "tall" }))).toBeNull();
    expect(readHeight(null)).toBeNull();
  });
});

describe("Now page sections", () => {
  it("the orchestrator box has a resize handle and the stored height", () => {
    vi.stubGlobal("localStorage", memoryStorage({ [ORCH_HEIGHT_KEY]: "520" }));
    const state = mockState();
    const orch = { ...state.sessions[0]!, id: "s-orch", name: "orchestrator", role: "orchestrator", state: "running" as const, attachable: true };
    const html = renderToStaticMarkup(createElement(NowTab, { state: { ...state, sessions: [orch, ...state.sessions] }, focusRequest: null }));
    expect(html).toContain('data-testid="orch-resize"');
    expect(html).toContain("min(520px, 90vh)");
  });
});

describe("pop out", () => {
  function popout(state: ReturnType<typeof mockState> | null) {
    vi.stubGlobal("window", { location: { pathname: "/term/s-gone" }, addEventListener: () => {}, removeEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) });
    return renderToStaticMarkup(createElement(NowTab, { state, focusRequest: null }));
  }

  it("shows loading, never not found, before the first state", () => {
    const html = popout(null);
    expect(html).toContain('data-testid="popout-loading"');
    expect(html).not.toContain("No live session");
    expect(html).not.toContain("not in the registry");
  });

  it("says not found once state is in and the id is absent", () => {
    const html = popout(mockState());
    expect(html).toContain("No live session");
    expect(html).not.toContain("popout-loading");
  });
});
