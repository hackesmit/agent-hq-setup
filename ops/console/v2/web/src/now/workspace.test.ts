import { describe, expect, it } from "vitest";
import type { ActivityEvent, ProjectSummary, ReadyBead, Request, Session } from "@shared/api";
import { buildWorkspaces, findWorkspace, scopeTo, workspaceCounts, workspaceOf } from "./workspace";

const project = (id: string, client: string | null) =>
  ({ id, name: id, kind: "rig", status: "active", sphere: null, client, spawnable: true }) as ProjectSummary;
const session = (id: string, rig: string | null, state: Session["state"] = "running") => ({ id, rig, state }) as Session;
const request = (id: string, rig: string | null, sessionId: string | null = null) =>
  ({ id, rig, session: sessionId, state: "open" }) as Request;

const PROJECTS = [
  project("hq", null),
  project("acme-dashboard", "Orbit Acme"),
  project("lodgeco", "lodgeco"),
  project("lodgeco-ops-automation", "lodgeco"),
  project("acme-financial", "Orbit Acme"),
  project("studioco-digital", null),
  project("nonprofit-a", "Nonprofit A"),
  project("fintrack-portfolio", "Example Artist"),
  project("gym-tracker", null),
];

describe("workspaces", () => {
  it("is the owner's six, in his order, whatever the registry holds", () => {
    const labels = ["agencyco", "Orbit Acme", "Lodgeco", "Nonprofit A", "studioco", "Personal"];
    expect(buildWorkspaces(PROJECTS).map((w) => w.label)).toEqual(labels);
    expect(buildWorkspaces([]).map((w) => w.label)).toEqual(labels);
  });

  it("places rigs by first word or registry client, and the rest in Personal", () => {
    const list = buildWorkspaces(PROJECTS, ["lodgeco-system-152b", "agencyco-site", "acme-avance", null, "hq"]);
    expect(findWorkspace(list, "orbit-acme")?.rigs).toEqual(["acme-dashboard", "acme-financial", "acme-avance"]);
    expect(findWorkspace(list, "lodgeco")?.rigs).toEqual(["lodgeco", "lodgeco-ops-automation", "lodgeco-system-152b"]);
    expect(findWorkspace(list, "agencyco")?.rigs).toEqual(["agencyco-site"]);
    expect(findWorkspace(list, "studioco")?.rigs).toEqual(["studioco-digital"]);
    expect(findWorkspace(list, "personal")?.rigs).toEqual(["hq", "fintrack-portfolio", "gym-tracker"]);
    expect(workspaceOf("something-new")).toBe("personal");
  });

  it("gives every workspace its own hue", () => {
    const list = buildWorkspaces(PROJECTS);
    expect(new Set(list.map((w) => w.hue)).size).toBe(list.length);
  });

  it("scopes every slice to the workspace, and a rigless request follows its session", () => {
    const list = buildWorkspaces(PROJECTS);
    const acme = findWorkspace(list, "orbit-acme");
    const all = {
      sessions: [session("s1", "acme-financial"), session("s2", "hq"), session("s3", null)],
      requests: [request("r1", "acme-dashboard"), request("r2", null, "s1"), request("r3", null, "s2"), request("r4", null)],
      ready: [{ rig: "hq", id: "b1" }, { rig: "acme-dashboard", id: "b2" }] as ReadyBead[],
      activity: [{ id: "a1", rig: "acme-financial" }, { id: "a2", rig: null }] as ActivityEvent[],
    };
    const scoped = scopeTo(acme, all);
    expect(scoped.sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(scoped.requests.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(scoped.ready.map((b) => b.id)).toEqual(["b2"]);
    expect(scoped.activity.map((e) => e.id)).toEqual(["a1"]);
    expect(scopeTo(null, all)).toBe(all);
    expect(workspaceCounts(acme, all)).toEqual({ asks: 2, live: 1 });
  });

  it("a stale stored id is everything, not an empty page", () => {
    expect(findWorkspace(buildWorkspaces(PROJECTS), "client:gone")).toBeNull();
  });
});
