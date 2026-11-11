// Capri, the meta terminal (proposal 19): the browser half of the passkey flow.
//
// Kept out of the component so the whole sequence is testable without a DOM: enrol a
// passkey (bootstrap, or a second device authorized by a fresh assertion), assert to
// earn a one-use capability, and spend that capability on POST /api/meta/new. The
// capability the server hands back is spent by exactly one action; attaching the pane
// later needs its own assertion, which is why `openCapri` returns both the sid and a
// second capability minted for the attach.
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import { api } from "../data/client";
import type { MetaStatus } from "@shared/api";

export interface CapriDeps {
  status: () => Promise<MetaStatus>;
  registerOptions: (capability?: string) => Promise<unknown>;
  register: (response: unknown, challenge: string, label?: string) => Promise<{ verified: boolean; count: number }>;
  assertOptions: () => Promise<unknown>;
  assert: (response: unknown, challenge: string) => Promise<{ capability: string; expiresInS: number }>;
  metaNew: (capability: string) => Promise<{ ok: boolean; sid: string }>;
  doRegistration: typeof startRegistration;
  doAuthentication: typeof startAuthentication;
}

export const liveDeps: CapriDeps = {
  status: () => api.metaStatus(),
  registerOptions: (capability) => api.passkeyRegisterOptions(capability),
  register: (response, challenge, label) => api.passkeyRegister(response, challenge, label),
  assertOptions: () => api.passkeyAssertOptions(),
  assert: (response, challenge) => api.passkeyAssert(response, challenge),
  metaNew: (capability) => api.metaNew(capability),
  doRegistration: startRegistration,
  doAuthentication: startAuthentication,
};

function challengeOf(options: unknown): string {
  const c = (options as { challenge?: unknown } | null)?.challenge;
  if (typeof c !== "string" || !c) throw new Error("the server returned no challenge");
  return c;
}

/** True when this browser can do WebAuthn at all (http on a non-localhost origin cannot). */
export function passkeysAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";
}

/**
 * Proposal 31: when the server says requirePasskey is false (root waived it on this
 * single-user box), privileged Capri actions need no assertion: the empty capability
 * is sent and the server skips the spend. Absent or true keeps the passkey flow.
 */
export async function capabilityFor(deps: CapriDeps = liveDeps): Promise<string> {
  const status = await deps.status();
  if (status.requirePasskey === false) return "";
  return earnCapability(deps);
}

/** One fresh assertion -> one capability. Every privileged Capri action needs its own. */
export async function earnCapability(deps: CapriDeps = liveDeps): Promise<string> {
  const options = deps.assertOptions ? await deps.assertOptions() : null;
  const challenge = challengeOf(options);
  const response = await deps.doAuthentication({ optionsJSON: options as never });
  const { capability } = await deps.assert(response, challenge);
  if (!capability) throw new Error("the server minted no capability");
  return capability;
}

/**
 * Enrol a passkey. The first one is the bootstrap credential and needs no proof; every
 * later device needs a fresh assertion from one already registered, which the server
 * re-checks when it verifies (a stale bootstrap challenge is refused there).
 */
export async function enrolPasskey(label: string, deps: CapriDeps = liveDeps): Promise<{ count: number }> {
  const status = await deps.status();
  const capability = status.bootstrap ? undefined : await earnCapability(deps);
  const options = await deps.registerOptions(capability);
  const challenge = challengeOf(options);
  const response = await deps.doRegistration({ optionsJSON: options as never });
  const r = await deps.register(response, challenge, label || "device");
  if (!r.verified) throw new Error("the passkey was not verified");
  return { count: r.count };
}

/**
 * Assert, start the session, then assert again for the attach. Two assertions is the
 * design, not an oversight: start and attach are separate privileges and each capability
 * is single-use, so a captured one cannot be replayed into the other.
 */
export async function openCapri(deps: CapriDeps = liveDeps): Promise<{ sid: string; attachCapability: string }> {
  const status = await deps.status();
  if (status.requirePasskey === false) {
    // Proposal 31: no assertion to earn; start and attach ride the authenticated
    // console connection alone.
    const { sid } = await deps.metaNew("");
    if (!sid) throw new Error("the server started no session");
    return { sid, attachCapability: "" };
  }
  const startCapability = await earnCapability(deps);
  const { sid } = await deps.metaNew(startCapability);
  if (!sid) throw new Error("the server started no session");
  const attachCapability = await earnCapability(deps);
  return { sid, attachCapability };
}

/**
 * Adopt a Capri session that is already running: one fresh assertion, then re-authorize
 * the open pane. This is the recovery path when the second assertion of `openCapri`
 * was cancelled or lost, which otherwise leaves a live session the tab cannot attach to.
 */
export async function authorizeAttach(
  sid: string,
  reattach: (sid: string, capability: string) => boolean,
  deps: CapriDeps = liveDeps,
): Promise<void> {
  const capability = await capabilityFor(deps);
  if (!reattach(sid, capability)) throw new Error("the console link is down, so the pane could not be re-attached");
}

/** A human sentence for the failures this flow actually produces.
 *
 * WebAuthn's most common error is also its least informative. Browsers report
 * NotAllowedError for THREE different situations on purpose, so that a website
 * cannot probe which passkeys you hold: you cancelled, it timed out, or this
 * device has no passkey for this site at all. That last case is the one that
 * looks like a bug, because the console can see a passkey on file server-side
 * while the browser in front of you holds nothing: a passkey enrolled on a
 * phone or another browser does not exist here unless the platform syncs it.
 * Saying so plainly is the difference between a two minute fix and an evening.
 */
export function capriError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const name = e instanceof Error ? e.name : "";
  if (/SecurityError/i.test(name + raw)) {
    return "this passkey does not match the address you are on. Open the console at its "
      + "usual https address rather than an IP or a short hostname, then try again";
  }
  if (/NotSupportedError/i.test(name + raw)) return "this browser cannot do passkeys here";
  if (/NotAllowedError|abort/i.test(name + raw)) {
    return "no passkey was offered. That means one of three things: you dismissed the prompt, "
      + "it timed out, or THIS device holds no passkey for the console even though one is on "
      + "file. If you enrolled on another device, use Add another device here";
  }
  if (/not enabled/i.test(raw)) return "Capri is switched off on this box (proposal 19 flags)";
  if (/already live/i.test(raw)) return "a Capri session is already running";
  if (/fresh passkey assertion/i.test(raw)) return "that passkey proof was already used; try again";
  if (/meta refused/i.test(raw)) return `the runner refused: ${raw.replace(/^.*meta refused:?\s*/i, "")}`;
  return raw;
}
