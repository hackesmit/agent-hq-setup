// Feature flags for work whose server half is not live yet. A flag here is a promise to
// remove it, not a config surface: flip it on in the same change that lands the route.

export const FEATURES = {
  /**
   * Drag a bar's end in the timeline to set a bead's due date.
   * Needs POST /api/projects/:id/beads/:bead {due} (wrapper: bd update <id> --due).
   * Until that answers, the bars are read-only and the hint says so.
   */
  timelineDueDrag: true,
} as const;
