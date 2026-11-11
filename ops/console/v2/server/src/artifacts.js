// Artifact registry reader (bead hq-7llgp.9). hook-artifact-ledger.sh appends one row per
// published artifact to state/artifacts.jsonl; this reads the newest ones for the Now
// panel. The file is data written by a hook, so every row is validated again here: only a
// claude.ai artifact URL is ever handed to the browser as a link target.
import fs from "node:fs";
import path from "node:path";

const URL_RE = /^https:\/\/claude\.ai\/artifact\/[A-Za-z0-9_-]+$/;
const TEXT = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");

/** Newest-first list of at most `limit` artifacts, deduped by url (newest row wins). */
export function listArtifacts(stateDir, limit = 10) {
  let raw = "";
  try {
    raw = fs.readFileSync(path.join(stateDir, "artifacts.jsonl"), "utf8");
  } catch {
    return [];
  }
  const byUrl = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o.url !== "string" || !URL_RE.test(o.url)) continue;
    const ts = TEXT(o.ts, 40);
    if (!Number.isFinite(Date.parse(ts))) continue;
    const prev = byUrl.get(o.url);
    if (prev && prev.ts > ts) continue;
    byUrl.set(o.url, {
      ts,
      url: o.url,
      title: TEXT(o.title, 200) || prev?.title || "",
      session: TEXT(o.session, 80),
      rig: TEXT(o.rig, 80),
      bead: TEXT(o.bead, 80),
    });
  }
  return [...byUrl.values()].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)).slice(0, limit);
}
