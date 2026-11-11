// Machines tab (bead hq-7icm): pure model helpers and a render smoke.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { JobRow, ServiceRow } from "@shared/api";
import { jobDetail, jobTone, serviceTone, opKey } from "../machines/model";
import { mockState } from "../data/mock";
import { MachinesTab } from "../tabs/MachinesTab";

const svc = (state: string): ServiceRow => ({
  id: "s", label: "s", kind: "systemd-user", unit: "s.service", restartable: false, logs: false, state,
});
const job = (state: JobRow["state"], cadenceS = 45): JobRow => ({
  id: "j", label: "j", kind: "loop", heartbeat: "x", source: "mtime", cadenceS, lastRun: null, state, missed: state === "stale",
});

describe("machines model", () => {
  it("tones map states honestly", () => {
    expect(serviceTone(svc("active"))).toBe("ok");
    expect(serviceTone(svc("running"))).toBe("ok");
    expect(serviceTone(svc("failed"))).toBe("bad");
    expect(serviceTone(svc("unavailable"))).toBe("bad");
    expect(serviceTone(svc("inactive"))).toBe("off");
    expect(jobTone(job("ok"))).toBe("ok");
    expect(jobTone(job("stale"))).toBe("bad");
    expect(jobTone(job("future"))).toBe("warn");
  });

  it("job detail names cadence and abnormal states", () => {
    expect(jobDetail(job("ok"))).toBe("every 1m");
    expect(jobDetail(job("stale", 604800))).toBe("every 168h, stale");
  });

  it("op keys are unique per intent", () => {
    expect(opKey()).not.toBe(opKey());
    expect(opKey()).toMatch(/^op-/);
  });
});

describe("MachinesTab", () => {
  it("renders services, jobs, switches and honest empty states", () => {
    const state = mockState();
    const html = renderToStaticMarkup(
      createElement(MachinesTab, { machine: state.machine, collectors: state.collectors, services: state.services, monitors: state.monitors, deploys: state.deploys }),
    );
    expect(html).toContain("Programs");
    expect(html).toContain("hq-mail poll");
    expect(html).toContain("code-server");
    expect(html).toContain("Restart");
    expect(html).toContain("Logs");
    expect(html).toContain("kill switches");
    expect(html).toContain("LOG_ONLY");
    expect(html).toContain("git-sync");
    expect(html).toContain("weekly retro");
    // monitors from Kuma render with their real states
    expect(html).toContain("Monitors");
    expect(html).toContain("acme prod");
    expect(html).toContain("1 down");
    expect(html).toContain("status page");
    // disk and backup health, with the server's own words for what is wrong
    expect(html).toContain("Health");
    expect(html).toContain("self-check passed");
    expect(html).toContain("101 unsafe shutdowns");
    expect(html).toContain("Backup to george");
    expect(html).toContain("61 hours old");
    expect(html).toContain("needs a look");
  });

  it("says why monitors are missing rather than implying health", () => {
    const state = mockState();
    const html = renderToStaticMarkup(
      createElement(MachinesTab, {
        machine: null, collectors: [], services: null, deploys: null,
        monitors: { generatedAt: "x", source: null, monitors: [], error: "no status page configured" },
      }),
    );
    expect(html).toContain("no status page configured");
    expect(html).not.toContain("all up");
    void state;
  });

  it("says so when no policy exists instead of pretending health", () => {
    const html = renderToStaticMarkup(
      createElement(MachinesTab, { machine: null, collectors: [], services: null, monitors: null, deploys: null }),
    );
    expect(html).toContain("has not reported yet");
    expect(html).toContain("the disk check has not reported on this box");
  });
});
