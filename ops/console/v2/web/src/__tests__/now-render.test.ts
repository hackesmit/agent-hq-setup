// Render smoke test for the Now tab (beads hq-tsom, hq-uyes, hq-prru, hq-6m48).
//
// Same technique as the shell's own smoke test: react-dom/server needs no DOM, so a broken
// tree, a bad prop or a crash on null state is caught without pulling jsdom into the run.
// Effects do not run here, so nothing fetches and no timer starts; this only asserts that
// every panel of the tab renders and shows the data it is given.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mockState } from "../data/mock";
import { NowTab } from "../tabs/NowTab";

describe("Now tab", () => {
  it("renders every panel with mock data", () => {
    const html = renderToStaticMarkup(
      createElement(NowTab, { state: mockState(), focusRequest: "r-1187" }),
    );

    // No Needs-you panel (hq-zqqu.1): questions sit on the asking terminal's card, and
    // the ones with no live terminal at the foot of the Sessions card.
    expect(html).not.toContain("Needs you");
    expect(html).toContain("waiting on you");
    expect(html).toContain("Questions with no terminal");
    expect(html).toContain("supabase db push --linked");
    expect(html).toContain("Copy");
    expect(html).toContain("Approve");
    expect(html).toContain("Snooze");
    expect(html).toContain("Sink");

    // Sessions and their actions.
    expect(html).toContain("Sessions");
    expect(html).toContain("w-3f2a");
    expect(html).toContain("New terminal");
    expect(html).toContain("waiting on you");

    // Ready work and the Capri panel are gone from Now (hq-4npjr.17).
    expect(html).not.toContain("Ready work");
    expect(html).not.toContain("Dispatch");
    expect(html).not.toContain("Attach to");
    expect(html).not.toContain("passkey");
    // Every section folds from its head.
    expect(html).toContain('data-testid="fold-toggle"');
    expect(html).toContain("Quick capture");
    expect(html).toContain("Files in");
    expect(html).toContain("Upload files");

    // The terminal deck is lazy: with no pane open, xterm is not part of the tree.
    expect(html).toContain("No terminal open");
  });

  it("renders with no state at all", () => {
    const html = renderToStaticMarkup(createElement(NowTab, { state: null, focusRequest: null }));
    expect(html).not.toContain("Needs you");
    expect(html).not.toContain("Questions with no terminal");
    expect(html).toContain("No live sessions");
    expect(html).not.toContain("Nothing unblocked right now");
  });
});
