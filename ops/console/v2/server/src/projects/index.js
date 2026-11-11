// The two entry points server.js wires (everything else is internal):
//
//   registerProjectCollectors({ collectors, wrapper, cfg })
//     registers the real `projects` collector, REPLACING the placeholder that
//     src/collectors.js registerAll() installs. Call it AFTER registerAll.
//     Returns { registry, facts } so the routes can share both.
//
//   projectRoutes({ wrapper, cfg, truths, registry, facts, collectors })
//     returns (req, res, url) => boolean: true when it owns the URL and has
//     taken over the response, false to fall through to the rest of server.js.
//
// See routes.js for the URL table and truths.js for the `write-truths` wrapper
// verb this module is the client of.

export { registerProjectCollectors, ProjectFacts, summarize, perDay, activityOf, attentionOf, parseGitLog } from "./collectors.js";
export { projectRoutes } from "./routes.js";
export { Registry, RegistryError, parseRegistry, normalizeProject, terminalDir } from "./registry.js";
export { DetailSource, buildDetail, readDoc, DOC_NAMES } from "./detail.js";
export { projectTimeline, milestones } from "./timeline.js";
export {
  TruthsStore,
  TruthsError,
  StaleRevision,
  assumptionCards,
  auditTruths,
  parseAuditHead,
  parseAuditLines,
  TRAILER_KEY,
  canonicalBytes,
  loadTruthsKey,
  renderTruthsMarkdown,
  sha256Hex,
  trailerLine,
  trailerMac,
  verifyTrailer,
} from "./truths.js";
export { normalizeBead, normalizeBeads, bdArgv } from "./bd.js";
export { buildBoardRow, sortBoard, pickEpic, parentOf } from "./board.js";
