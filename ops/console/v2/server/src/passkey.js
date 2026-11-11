// The passkey gate for Capri, the meta terminal (proposal 19, design 4.4).
//
// Tailnet identity alone is not proof of a human at the keyboard, and the meta
// terminal is the one session that runs uncaged as owner. So starting or attaching
// to it needs a fresh WebAuthn assertion from a passkey registered on the owner's own
// devices: the server verifies the assertion and mints a one-use capability, bound to
// the exact browser connection, that the runner accepts for exactly one start or one
// attach. hqconsole cannot forge an assertion (it does not hold the private key), and
// self-peer connections are refused at the auth layer, so a worker cannot reach here.
//
// Verification uses @simplewebauthn/server (pinned 13.3.2); this module owns the
// store, the challenge lifecycle, the owner-only and bootstrap rules, and the
// capability mint. The credential store holds only public keys.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sameConn } from "./ws.js";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
// A ceiling on pending challenges. Asking for options is cheap and needs no
// assertion, so without this the map is a free write primitive for anyone past
// the owner gate.
const MAX_PENDING_CHALLENGES = 64;
// Per connection, so one caller in a loop bounds only itself.
const PER_CONN_CHALLENGES = 8;
const CAPABILITY_TTL_MS = 60 * 1000;

/** Persistent set of registered credentials (public keys only). */
export class PasskeyStore {
  /** @param {{file: string, log?: Function}} o */
  constructor(o) {
    this.file = o.file;
    this.log = o.log || (() => {});
    this.creds = [];
    this.loaded = false;
  }
  load() {
    this.loaded = true;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.creds = Array.isArray(j && j.credentials) ? j.credentials : [];
    } catch {
      this.creds = [];
    }
    return this;
  }
  save() {
    const dir = path.dirname(this.file);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    } catch {
      /* already there */
    }
    const tmp = `${this.file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, credentials: this.creds }, null, 1), { mode: 0o640 });
    fs.renameSync(tmp, this.file);
  }
  get isEmpty() {
    return this.creds.length === 0;
  }
  get count() {
    return this.creds.length;
  }
  byId(id) {
    return this.creds.find((c) => c.id === id) || null;
  }
  add(cred) {
    if (this.byId(cred.id)) throw new Error("credential already registered");
    this.creds.push(cred);
    this.save();
  }
  updateCounter(id, counter) {
    const c = this.byId(id);
    if (c) {
      c.counter = counter;
      c.lastUsedAt = new Date().toISOString();
      this.save();
    }
  }
  list() {
    return this.creds.map((c) => ({ id: c.id, label: c.label, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt || null }));
  }
}

/** A pending WebAuthn challenge, single-use with a short TTL and a purpose. */
class Challenges {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.map = new Map();
  }
  put(challenge, purpose, connKey, data = {}) {
    // Sweep on the way IN as well as on the way out. Only `take` used to sweep,
    // so a caller that asks for options and never answers left an entry behind
    // for the life of the process, and a loop of them was unbounded growth for
    // the price of one request each.
    this.sweep();
    // The cap is PER CONNECTION, and a connection over its own quota loses its own
    // oldest entry. Evicting globally-oldest looked fairer and was worse: a caller
    // asking in a loop would deterministically delete the challenge the person at
    // the keyboard was part-way through answering, which turns a memory bound into
    // a reliable way to stop anyone ever enrolling.
    const key = String(connKey || "");
    const mine = [...this.map.entries()].filter(([, v]) => v.connKey === key);
    if (mine.length >= PER_CONN_CHALLENGES) {
      mine.sort((a, b) => a[1].expires - b[1].expires);
      this.map.delete(mine[0][0]);
    }
    // A global ceiling still exists as a backstop, and at the ceiling we REFUSE
    // rather than evict, so no connection can push another's challenge out.
    if (this.map.size >= MAX_PENDING_CHALLENGES) throw new Error("too many pending challenges; try again shortly");
    this.map.set(String(challenge), { purpose, connKey: String(connKey || ""), expires: this.now() + CHALLENGE_TTL_MS, data });
  }
  /** Take a challenge, returning its stored data on success or null on any mismatch. */
  take(challenge, purpose, connKey, strictPort) {
    this.sweep();
    const c = this.map.get(String(challenge || ""));
    if (!c) return null;
    this.map.delete(String(challenge));
    if (c.purpose !== purpose) return null;
    // Two fetches from the same browser may land on different peer ports (keep-alive
    // is not guaranteed), so match the peer the way the rest of the server does.
    if (!sameConn(c.connKey, String(connKey || ""), strictPort)) return null;
    if (c.expires <= this.now()) return null;
    return c.data || {};
  }
  sweep() {
    const now = this.now();
    for (const [k, v] of this.map) if (v.expires <= now) this.map.delete(k);
  }
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

/**
 * The passkey gate. rpId is the console host; origin is its https URL. A capability
 * is minted only by a verified assertion and is bound to the peer connection key.
 */
export class PasskeyGate {
  /**
   * @param {{store: PasskeyStore, rpId: string, rpName?: string, origin: string,
   *          owner: string, enabled: boolean, now?: Function, log?: Function}} o
   */
  constructor(o) {
    this.store = o.store;
    this.rpId = o.rpId;
    this.rpName = o.rpName || "HQ Console";
    this.origin = o.origin;
    this.owner = o.owner;
    this.enabled = Boolean(o.enabled);
    // Bound to the peer ADDRESS, never the port, and this is deliberately not a knob:
    // an attach always arrives on a second connection (the WebSocket), so a
    // tuple-strict capability could never be spent and the flow would be dead by
    // construction. The controls that carry the weight are the whois owner gate on
    // every connection, single use, and the 60 s TTL; the port adds nothing that an
    // attacker already on the same address would lack.
    this.strictPort = false;
    this.now = o.now || (() => Date.now());
    this.log = o.log || (() => {});
    this.challenges = new Challenges(this.now);
    /** @type {Map<string, {connKey: string, expires: number}>} */
    this.capabilities = new Map();
  }

  status() {
    return { enabled: this.enabled, passkeys: this.store.count, bootstrap: this.store.isEmpty };
  }

  /** A user handle stable for this single operator. */
  get userId() {
    return Buffer.from(`hq-meta:${this.owner}`).toString("base64url");
  }

  async registerOptions(connKey) {
    // Bootstrap: the first credential may be registered with no prior assertion,
    // but only while the store is empty. Adding a second device is gated by an
    // assertion at the route layer (assertVerified must have run this connection).
    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpId,
      userID: Buffer.from(this.userId),
      userName: this.owner,
      timeout: CHALLENGE_TTL_MS,
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: this.store.creds.map((c) => ({ id: c.id, transports: c.transports })),
    });
    // track the challenge, bound to this connection, tagged with how it was
    // authorized: a bootstrap challenge is only honoured at verify if the store is
    // STILL empty then (so a concurrent first registration cannot leave a second,
    // unasserted device authorized through a stale bootstrap challenge).
    this.challenges.put(options.challenge, "register", connKey, { bootstrap: this.store.isEmpty });
    return options;
  }

  async registerVerify(body, connKey, label) {
    const expectedChallenge = String((body && body.expectedChallenge) || "");
    const data = this.challenges.take(expectedChallenge, "register", connKey, this.strictPort);
    if (!data) throw new Error("no matching registration challenge for this connection");
    // a bootstrap challenge is void the moment any credential exists: registering a
    // second device requires a capability-authorized challenge (bootstrap:false)
    if (data.bootstrap && !this.store.isEmpty) throw new Error("bootstrap registration is closed; a fresh passkey assertion is required to add a device");
    const verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpId,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) throw new Error("registration not verified");
    // re-checked after the await: a second bootstrap registration that was in flight
    // while the first one verified must not commit as a second unasserted device
    if (data.bootstrap && !this.store.isEmpty) throw new Error("bootstrap registration is closed; a fresh passkey assertion is required to add a device");
    const info = verification.registrationInfo;
    const cred = info.credential;
    this.store.add({
      id: cred.id,
      publicKey: Buffer.from(cred.publicKey).toString("base64url"),
      counter: cred.counter,
      transports: cred.transports || (body.response && body.response.response && body.response.response.transports) || [],
      label: String(label || "device").slice(0, 60),
      createdAt: new Date(this.now()).toISOString(),
      lastUsedAt: null,
    });
    this.log(`passkey registered (${this.store.count} total)`);
    return { verified: true, count: this.store.count };
  }

  async authOptions(connKey) {
    if (this.store.isEmpty) throw new Error("no passkey registered");
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      timeout: CHALLENGE_TTL_MS,
      userVerification: "required",
      allowCredentials: this.store.creds.map((c) => ({ id: c.id, transports: c.transports })),
    });
    this.challenges.put(options.challenge, "assert", connKey);
    return options;
  }

  /** Verify an assertion and mint a one-use capability bound to this connection. */
  async authVerify(body, connKey) {
    const expectedChallenge = String((body && body.expectedChallenge) || "");
    if (!this.challenges.take(expectedChallenge, "assert", connKey, this.strictPort)) throw new Error("no matching assertion challenge for this peer");
    const resp = body.response;
    const cred = this.store.byId(resp && resp.id);
    if (!cred) throw new Error("unknown credential");
    const verification = await verifyAuthenticationResponse({
      response: resp,
      expectedChallenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpId,
      requireUserVerification: true,
      credential: {
        id: cred.id,
        publicKey: Buffer.from(cred.publicKey, "base64url"),
        counter: cred.counter,
        transports: cred.transports,
      },
    });
    if (!verification.verified) throw new Error("assertion not verified");
    // Counter regression (a cloned authenticator) is refused. A 0/0 authenticator
    // reports counter 0 forever; only a DECREASE is rejected.
    const newCounter = verification.authenticationInfo.newCounter;
    if (newCounter < cred.counter) throw new Error("authenticator counter regressed");
    this.store.updateCounter(cred.id, newCounter);
    return this.mintCapability(connKey);
  }

  /** A one-use start/attach ticket bound to the connection that earned it. */
  mintCapability(connKey) {
    this.sweepCapabilities();
    const cap = base64url(crypto.randomBytes(32));
    this.capabilities.set(cap, { connKey: String(connKey || ""), expires: this.now() + CAPABILITY_TTL_MS });
    return { capability: cap, expiresInS: Math.round(CAPABILITY_TTL_MS / 1000) };
  }

  /**
   * Spend a capability. True exactly once, only for the connection it is bound to.
   * A wrong-connection attempt does NOT consume the ticket (so a foreign connection
   * cannot burn a capability the owner just earned); an expired one is dropped.
   */
  spendCapability(cap, connKey) {
    this.sweepCapabilities();
    const key = String(cap || "");
    const c = this.capabilities.get(key);
    if (!c) return false;
    if (!sameConn(c.connKey, String(connKey || ""), this.strictPort)) return false; // not this peer: leave it
    this.capabilities.delete(key); // right connection: consume whatever the outcome
    if (c.expires <= this.now()) return false;
    return true;
  }

  /** Peek without spending: the WS attach checks the same ticket the runner will. */
  validCapability(cap, connKey) {
    this.sweepCapabilities();
    const c = this.capabilities.get(String(cap || ""));
    return Boolean(c && sameConn(c.connKey, String(connKey || ""), this.strictPort) && c.expires > this.now());
  }

  sweepCapabilities() {
    const now = this.now();
    for (const [k, v] of this.capabilities) if (v.expires <= now) this.capabilities.delete(k);
  }
}
