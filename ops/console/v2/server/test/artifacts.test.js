// Artifact registry reader: newest first, deduped by url, and a hostile or garbled row can
// never reach the panel as a link.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { listArtifacts } from "../src/artifacts.js";
import { startTestApp, tmpDir } from "./helpers.js";

const row = (url, ts, extra = {}) => JSON.stringify({ ts, url, title: "t", session: "s-1", rig: "hq", bead: "", ...extra });
const U = (id) => `https://claude.ai/artifact/${id}`;

test("lists the newest ten, newest first, newest row per url wins", () => {
  const dir = tmpDir();
  const lines = [];
  for (let i = 0; i < 12; i++) lines.push(row(U("A" + i), `2026-11-04T00:${String(i).padStart(2, "0")}:00Z`));
  lines.push(row(U("A0"), "2026-11-04T01:00:00Z", { title: "updated" }));
  lines.push(row(U("A5"), "2026-11-04T00:00:30Z", { title: "stale" }));
  fs.writeFileSync(path.join(dir, "artifacts.jsonl"), lines.join("\n") + "\n");
  const out = listArtifacts(dir, 10);
  assert.equal(out.length, 10);
  assert.equal(out[0].url, U("A0"));
  assert.equal(out[0].title, "updated");
  assert.equal(out.find((r) => r.url === U("A5")).title, "t");
  assert.ok(out.every((r, i) => i === 0 || out[i - 1].ts >= r.ts));
});

test("garbled lines, bad urls and bad timestamps are dropped; a missing file is empty", () => {
  const dir = tmpDir();
  assert.deepEqual(listArtifacts(dir), []);
  fs.writeFileSync(
    path.join(dir, "artifacts.jsonl"),
    ["not json", row("javascript:alert(1)", "2026-11-04T00:00:00Z"), row("https://evil.test/artifact/x", "2026-11-04T00:00:00Z"),
      row(U("ok"), "yesterday"), row(U("good"), "2026-11-04T00:00:00Z")].join("\n"),
  );
  const out = listArtifacts(dir);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, U("good"));
});

test("GET /api/artifacts serves the ledger", async () => {
  const app = await startTestApp();
  try {
    fs.writeFileSync(path.join(app.cfg.stateDir, "artifacts.jsonl"), row(U("live"), "2026-11-04T00:00:00Z") + "\n");
    const res = await app.request("GET", "/api/artifacts");
    assert.equal(res.status, 200);
    assert.equal(res.json[0].url, U("live"));
  } finally {
    await app.close();
  }
});
