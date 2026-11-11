// Runtime protocol constants.
//
// shared/api.ts declares WS_PROTOCOL and PROTOCOL_VERSION, but shared/index.js
// is `export {}` (types only), so there is nothing importable at runtime yet.
// These constants are the server's copy and MUST stay in step with api.ts.
// Contract change requested: export both from shared/index.js so server and web
// read one value instead of two copies.

export const WS_PROTOCOL = "hq-console-v1";
export const PROTOCOL_VERSION = 1;

/** Rigs from the CLAUDE.md rig table. Replaced by ops/projects.json in P1.6. */
export const RIGS = [
  { id: "hq", name: "hq", kind: "other", path: "." },
  { id: "acme-dashboard", name: "acme-dashboard", kind: "rig", path: "rigs/acme-dashboard" },
  { id: "gym-tracker", name: "gym-tracker", kind: "rig", path: "rigs/gym-tracker" },
  { id: "chesski", name: "chesski", kind: "rig", path: "rigs/chesski" },
  { id: "fintrack-portfolio", name: "fintrack-portfolio", kind: "rig", path: "rigs/fintrack-portfolio" },
];

/** Bead id prefix to project id, same table ctl.sh uses. */
export const BEAD_RIG = {
  hq: "hq",
  xd: "acme-dashboard",
  gt: "gym-tracker",
  ck: "chesski",
  dh: "fintrack-portfolio",
};

/** Models ctl.sh dispatch accepts; kept in step with its allowlist. */
export const MODELS = new Set([
  "claude-fable-5-2",
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-haiku-5-5",
  "",
]);
