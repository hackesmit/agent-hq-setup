// Render smoke test. No jsdom is installed (and none is wanted): react-dom/server needs
// no DOM, so this catches a broken tree, a bad prop or a crash on null state without
// pulling a browser environment into the test run. Written with createElement rather than
// JSX so the file stays a .ts and matches the vitest include pattern.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "../App";
import { shortRelease } from "../app/Shell";
import { mockState } from "../data/mock";
import { NowTab } from "../tabs/NowTab";
import { ProjectDetail, ProjectsTab } from "../tabs/ProjectsTab";
import { StackTab } from "../tabs/StackTab";
import { MachinesTab } from "../tabs/MachinesTab";
import { MoneyTab } from "../tabs/MoneyTab";

describe("shell smoke", () => {
  it("renders without throwing", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain("Token Burner 5000");
    expect(html).not.toContain("Needs you");
    expect(html).toContain("Capri");
  });

  it("renders every tab with mock data", () => {
    const state = mockState();
    const now = renderToStaticMarkup(createElement(NowTab, { state, focusRequest: "r-1187" }));
    expect(now).toContain("supabase db push --linked");
    expect(now).toContain("w-3f2a");
    // Ready work opens COLLAPSED by project now, so a bead id is not on the
    // first paint. What must be there is the project section it lives under.
    expect(now).toContain("acme-dashboard");

    const projects = renderToStaticMarkup(createElement(ProjectsTab, { projects: state.projects, discovered: state.discovered }));
    expect(projects).toContain("fintrack-portfolio");
    // a repo the registry has not been told about is surfaced rather than adopted
    expect(projects).toContain("brand-new");

    const detail = renderToStaticMarkup(
      createElement(ProjectDetail, { project: state.projects[0]!, id: "fintrack-portfolio" }),
    );
    expect(detail).toContain("truths.json");

    expect(renderToStaticMarkup(createElement(StackTab, { stack: state.stack }))).toContain("Inventory");
    expect(
      renderToStaticMarkup(createElement(MachinesTab, { machine: state.machine, collectors: state.collectors, services: state.services, monitors: state.monitors, deploys: state.deploys })),
    ).toContain("hqbox");
    expect(renderToStaticMarkup(createElement(MoneyTab, { usage: state.usage, money: state.money }))).toContain("Tokens today");
  });
});

describe("the rail footer", () => {
  it("short forms a commit sha so it cannot overflow a 212 pixel rail", () => {
    expect(shortRelease("804724ed64f3b105c07036d6392e4b2fe97807bf")).toBe("804724ed");
  });

  it("leaves a release name that is not a sha alone", () => {
    expect(shortRelease("dev")).toBe("dev");
    expect(shortRelease("dev-mock")).toBe("dev-mock");
    expect(shortRelease("no release")).toBe("no release");
  });

  it("keeps the whole release in reach through the title", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('title="no release, protocol ?"');
    // truncate is the guard for any release name the short form does not catch
    expect(html).toContain("mb-1 truncate");
  });
});
