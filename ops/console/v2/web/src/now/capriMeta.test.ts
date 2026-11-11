// The Capri (proposal 19) browser flow: enrol, assert, open. The WebAuthn calls and
// the API are injected, so these prove the SEQUENCE and its rules without a browser:
// bootstrap needs no proof, a second device does, start and attach each burn their own
// capability, and a cancelled touch reads as a cancelled touch.
import { describe, expect, it, vi } from "vitest";
import { authorizeAttach, capabilityFor, earnCapability, enrolPasskey, capriError, openCapri, type CapriDeps } from "./capriMeta";
import type { MetaStatus } from "@shared/api";

function status(over: Partial<MetaStatus> = {}): MetaStatus {
  return { enabled: true, passkeys: 1, bootstrap: false, live: null, unreconciled: [], lastClose: null, ...over };
}

function deps(over: Partial<CapriDeps> = {}): CapriDeps & { calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  const base: CapriDeps = {
    status: async () => {
      calls.push("status");
      return status();
    },
    registerOptions: async (capability) => {
      calls.push(`registerOptions(${capability ? "with-cap" : "bootstrap"})`);
      return { challenge: "reg-challenge" };
    },
    register: async () => {
      calls.push("register");
      return { verified: true, count: 1 };
    },
    assertOptions: async () => {
      calls.push("assertOptions");
      return { challenge: `assert-challenge-${++n}` };
    },
    assert: async () => {
      calls.push("assert");
      return { capability: `cap-${n}`, expiresInS: 60 };
    },
    metaNew: async (capability) => {
      calls.push(`metaNew(${capability})`);
      return { ok: true, sid: "smeta1" };
    },
    doRegistration: (async () => {
      calls.push("touch:register");
      return { id: "cred" };
    }) as unknown as CapriDeps["doRegistration"],
    doAuthentication: (async () => {
      calls.push("touch:assert");
      return { id: "cred" };
    }) as unknown as CapriDeps["doAuthentication"],
  };
  return Object.assign({ calls }, base, over) as CapriDeps & { calls: string[] };
}

describe("enrolPasskey", () => {
  it("registers the first credential with no prior proof", async () => {
    const d = deps({ status: async () => status({ bootstrap: true, passkeys: 0 }) });
    const r = await enrolPasskey("laptop", d);
    expect(r.count).toBe(1);
    // (the bootstrap override replaces the logging status stub, so only the rest shows)
    expect(d.calls).toEqual(["registerOptions(bootstrap)", "touch:register", "register"]);
    expect(d.calls).not.toContain("assert");
  });

  it("requires a fresh assertion before adding a second device", async () => {
    const d = deps();
    await enrolPasskey("phone", d);
    // the flow checks the store, then asserts, and only then asks for options: the
    // assertion happens BEFORE the registration options are requested
    expect(d.calls.slice(0, 5)).toEqual(["status", "assertOptions", "touch:assert", "assert", "registerOptions(with-cap)"]);
  });

  it("refuses when the server does not verify the credential", async () => {
    const d = deps({ status: async () => status({ bootstrap: true }), register: async () => ({ verified: false, count: 0 }) });
    await expect(enrolPasskey("x", d)).rejects.toThrow(/not verified/);
  });

  it("refuses when the server returns no challenge", async () => {
    const d = deps({ status: async () => status({ bootstrap: true }), registerOptions: async () => ({}) });
    await expect(enrolPasskey("x", d)).rejects.toThrow(/no challenge/);
  });
});

describe("openCapri", () => {
  it("burns one capability on the start and a second on the attach", async () => {
    const d = deps();
    const r = await openCapri(d);
    expect(r.sid).toBe("smeta1");
    expect(r.attachCapability).toBe("cap-2");
    expect(d.calls).toEqual([
      "status",
      "assertOptions",
      "touch:assert",
      "assert",
      "metaNew(cap-1)",
      "assertOptions",
      "touch:assert",
      "assert",
    ]);
    // the start capability is never reused for the attach
    expect(r.attachCapability).not.toBe("cap-1");
  });

  it("does not ask for the attach touch when the session fails to start", async () => {
    const d = deps({
      metaNew: async () => {
        throw new Error("meta session already live");
      },
    });
    await expect(openCapri(d)).rejects.toThrow(/already live/);
    expect(d.calls.filter((c) => c === "touch:assert")).toHaveLength(1);
  });

  it("refuses when the server starts no session", async () => {
    const d = deps({ metaNew: async () => ({ ok: true, sid: "" }) });
    await expect(openCapri(d)).rejects.toThrow(/no session/);
  });
});

describe("authorizeAttach (the recovery path)", () => {
  it("earns a fresh capability and hands it to the re-attach", async () => {
    const d = deps();
    const seen: Array<[string, string]> = [];
    await authorizeAttach("scapri1", (sid, cap) => {
      seen.push([sid, cap]);
      return true;
    }, d);
    expect(seen).toEqual([["scapri1", "cap-1"]]);
    expect(d.calls).toEqual(["status", "assertOptions", "touch:assert", "assert"]);
  });

  it("says so when the link is down, rather than silently losing the proof", async () => {
    const d = deps();
    await expect(authorizeAttach("scapri1", () => false, d)).rejects.toThrow(/link is down/);
  });
});

describe("earnCapability", () => {
  it("passes the server challenge to the authenticator and returns the minted capability", async () => {
    const doAuthentication = vi.fn(async () => ({ id: "cred" }));
    const d = deps({ doAuthentication: doAuthentication as unknown as CapriDeps["doAuthentication"] });
    const cap = await earnCapability(d);
    expect(cap).toBe("cap-1");
    expect(doAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: "assert-challenge-1" } });
  });

  it("refuses when the server mints nothing", async () => {
    const d = deps({ assert: async () => ({ capability: "", expiresInS: 0 }) });
    await expect(earnCapability(d)).rejects.toThrow(/no capability/);
  });
});

describe("capriError", () => {
  it("tells him to use the real address when the origin does not match", () => {
    const e = new Error("bad relying party");
    e.name = "SecurityError";
    expect(capriError(e)).toMatch(/usual https address/);
  });

  it("says plainly when the browser cannot do passkeys at all", () => {
    const e = new Error("nope");
    e.name = "NotSupportedError";
    expect(capriError(e)).toMatch(/cannot do passkeys/);
  });

  it("says what actually happened", () => {
    // NotAllowedError is deliberately ambiguous in the spec, so the message has
    // to name all three causes rather than guessing the flattering one.
    const msg = capriError(new Error("NotAllowedError: The operation either timed out"));
    expect(msg).toMatch(/no passkey was offered/);
    expect(msg).toMatch(/THIS device/);
    expect(msg).toMatch(/Add another device/);
    expect(capriError(new Error("the meta terminal is not enabled"))).toMatch(/switched off/);
    expect(capriError(new Error("meta session already live"))).toMatch(/already running/);
    expect(capriError(new Error("a fresh passkey assertion is required"))).toMatch(/already used/);
    expect(capriError(new Error("meta refused: meta settings writable by this user"))).toMatch(/writable by this user/);
    expect(capriError("plain string")).toBe("plain string");
  });
});

describe("proposal 31: the waived passkey", () => {
  it("openCapri skips every WebAuthn touch and starts with an empty capability", async () => {
    const d = deps({ status: async () => status({ requirePasskey: false, passkeys: 0, bootstrap: true }) });
    const r = await openCapri(d);
    expect(r.sid).toBe("smeta1");
    expect(r.attachCapability).toBe("");
    expect(d.calls).toEqual(["metaNew()"]);
  });

  it("authorizeAttach hands the re-attach an empty capability without a touch", async () => {
    const d = deps({ status: async () => status({ requirePasskey: false }) });
    const seen: Array<[string, string]> = [];
    await authorizeAttach("scapri1", (sid, cap) => {
      seen.push([sid, cap]);
      return true;
    }, d);
    expect(seen).toEqual([["scapri1", ""]]);
    expect(d.calls).toEqual([]);
  });

  it("an absent requirePasskey keeps the passkey flow (fail-secure default)", async () => {
    const d = deps();
    const cap = await capabilityFor(d);
    expect(cap).toBe("cap-1");
    expect(d.calls).toContain("touch:assert");
  });
});
