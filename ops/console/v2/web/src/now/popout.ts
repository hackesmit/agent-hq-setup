// Pop-out terminals: /term/<sid> is one session, full screen, in its own browser tab.
//
// The app router (app/routes.ts) does not know this path yet and falls back to Now, which
// is why the Now tab itself recognises it and renders the single-terminal view instead of
// the panels. The lead has been asked for a real route; when it lands this helper keeps
// working unchanged, because it only ever reads the path.

import { useEffect, useState } from "react";

export const TERM_PREFIX = "/term/";

export function termPath(sid: string): string {
  return `${TERM_PREFIX}${encodeURIComponent(sid)}`;
}

/** The session id in a /term/<sid> path, or null for every other path. */
export function popoutSid(pathname: string): string | null {
  if (!pathname.startsWith(TERM_PREFIX)) return null;
  const rest = pathname.slice(TERM_PREFIX.length).split("/")[0] ?? "";
  if (!rest) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

function currentSid(): string | null {
  if (typeof window === "undefined") return null;
  return popoutSid(window.location.pathname);
}

export function usePopoutSid(): string | null {
  const [sid, setSid] = useState<string | null>(() => currentSid());
  useEffect(() => {
    const update = (): void => setSid(currentSid());
    update();
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return sid;
}

// There was an openPopout() here that called window.open and, when the browser
// blocked it, fell back to window.location.assign. That fallback is why popping
// out replaced the console instead of opening beside it: a blocked popup became a
// navigation away from the page you were working on. The affordance is a plain
// anchor with target=_blank now, which browsers do not block, so nothing needs to
// script a window and nothing needs a fallback that can strand you.
