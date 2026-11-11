// Shared bits of chrome for the Now tab.

/** Phone touch target: 44 px tall below md, normal density above it. */
export const TOUCH = "min-h-11 px-3 md:min-h-0 md:px-2.5";

/** Same, for the small buttons inside rows. */
export const TOUCH_SM = "min-h-11 px-2.5 md:min-h-0 md:px-2";

export const SEVERITY_STRIPE: Record<string, string> = {
  P0: "border-l-p0",
  P1: "border-l-p1",
  P2: "border-l-p2",
};

export const SEVERITY_SWATCH: Record<string, string> = {
  P0: "bg-p0",
  P1: "bg-p1",
  P2: "bg-p2",
};
