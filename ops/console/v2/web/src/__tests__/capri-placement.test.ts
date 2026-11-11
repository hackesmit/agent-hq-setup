// Where Capri appears, and where he does not (the owner, 2026-09-01).
//
// Since hq-4npjr.17 the Now card is gone too: the orchestrator terminal on top is the
// control surface, and the floating CapriCorner is the only Capri on the page.
//
// Earlier rules, kept for history. The crystal is a PRESENCE organism, so it belongs on the
// one surface every page shares: the rail. It used to render a second time inside the
// Now card, which made a single presence read as two of him. The Now card is the
// CONTROLS, and it heads the right column because opening the Capri session is
// the most consequential button in the console and should not be something you scroll
// to find.
//
// Same technique as the other smoke tests: react-dom/server needs no DOM, effects do
// not run, so nothing fetches and no canvas is ever painted. `hq-facet` is the
// indicator's own wrapper class, which makes its presence and absence assertable.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../App";
import { mockState } from "../data/mock";
import { NowTab } from "../tabs/NowTab";

const FACET = "hq-facet";

describe("Capri placement", () => {
  it("has no voice block in the rail: the Capri hex corner is the only presence (the owner 2026-11-04)", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).not.toContain(FACET);
    expect(html).not.toContain("hq-facet-crystal");
    expect(html).not.toContain("voice offline");
  });

  it("does not render the animation on the Now tab", () => {
    const html = renderToStaticMarkup(
      createElement(NowTab, { state: mockState(), focusRequest: null }),
    );
    expect(html).not.toContain(FACET);
  });

  it("has no Capri panel on Now: the orchestrator terminal replaces it (the owner, hq-4npjr.17)", () => {
    const html = renderToStaticMarkup(
      createElement(NowTab, { state: mockState(), focusRequest: null }),
    );
    expect(html).not.toContain("Attach to");
    expect(html).not.toContain("passkey");
    expect(html.indexOf("Sessions")).toBeGreaterThan(-1);
    expect(html.indexOf("Terminals")).toBeGreaterThan(-1);
  });

  it("has no Needs-you panel to outrank it (hq-zqqu.1)", () => {
    const html = renderToStaticMarkup(
      createElement(NowTab, { state: mockState(), focusRequest: null }),
    );
    expect(html).not.toContain("Needs you");
  });
});
