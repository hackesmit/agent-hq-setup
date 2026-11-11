import { describe, expect, it } from "vitest";
import { scopeArtifacts, type ArtifactRow } from "./Artifacts";

const row = (rig: string): ArtifactRow => ({ ts: "2026-11-04T00:00:00Z", url: `https://claude.ai/artifact/${rig}`, title: rig, session: "s-1", rig, bead: "" });

describe("scopeArtifacts", () => {
  it("keeps everything when no workspace is selected", () => {
    expect(scopeArtifacts([row("hq"), row("chesski")], null)).toHaveLength(2);
  });
  it("keeps only the rigs of the workspace", () => {
    expect(scopeArtifacts([row("hq"), row("chesski")], ["chesski"]).map((r) => r.rig)).toEqual(["chesski"]);
  });
});
