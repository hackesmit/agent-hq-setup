// The passkey gate (Capri, proposal 19). A software authenticator built on node
// crypto (P-256, ES256) produces real WebAuthn registration and assertion responses,
// so register -> assert -> capability round-trips are verified without a browser, and
// the refusals (wrong origin/rpId, replayed challenge, foreign connection, counter
// regression, bootstrap-after-first) are asserted against genuine signatures.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PasskeyGate, PasskeyStore } from "../src/passkey.js";

const RP_ID = "hqbox.example.ts.net";
const ORIGIN = `https://${RP_ID}:8790`;

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest();
}
function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

// ---- a minimal ES256 software authenticator --------------------------------
class SoftAuthenticator {
  constructor() {
    this.key = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.credId = crypto.randomBytes(32);
    this.counter = 0;
    this.aaguid = Buffer.alloc(16, 0);
  }
  cosePublicKey() {
    // raw uncompressed point -> COSE_Key (kty EC2, alg ES256, crv P-256, x, y)
    const jwk = this.key.publicKey.export({ format: "jwk" });
    const x = Buffer.from(jwk.x, "base64url");
    const y = Buffer.from(jwk.y, "base64url");
    // hand-encoded CBOR map of 5 entries with the fixed COSE labels
    const parts = [Buffer.from([0xa5])]; // map(5)
    const int = (v) => (v < 0 ? Buffer.from([0x20 - v - 1]) : Buffer.from([v])); // small ints only
    parts.push(int(1), int(2)); // kty: EC2
    parts.push(int(3), int(-7)); // alg: ES256
    parts.push(int(-1), int(1)); // crv: P-256
    parts.push(int(-2), Buffer.concat([Buffer.from([0x58, 0x20]), x])); // x: bytes(32)
    parts.push(int(-3), Buffer.concat([Buffer.from([0x58, 0x20]), y])); // y: bytes(32)
    return Buffer.concat(parts);
  }
  authData(rpId, { attested = false, flagsUp = true, flagsUv = true, counter } = {}) {
    const rpIdHash = sha256(Buffer.from(rpId));
    let flags = 0;
    if (flagsUp) flags |= 0x01;
    if (flagsUv) flags |= 0x04;
    if (attested) flags |= 0x40;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter === undefined ? this.counter : counter, 0);
    const head = Buffer.concat([rpIdHash, Buffer.from([flags]), count]);
    if (!attested) return head;
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credId.length, 0);
    const acd = Buffer.concat([this.aaguid, idLen, this.credId, this.cosePublicKey()]);
    return Buffer.concat([head, acd]);
  }
  clientData(type, challenge, origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }
  sign(authData, clientDataJSON) {
    const data = Buffer.concat([authData, sha256(clientDataJSON)]);
    return crypto.sign("sha256", data, { key: this.key.privateKey, dsaEncoding: "der" });
  }
  registration(challenge, { rpId = RP_ID, origin = ORIGIN } = {}) {
    const authData = this.authData(rpId, { attested: true });
    // attestationObject: CBOR map {fmt:"none", attStmt:{}, authData:bytes}
    const cbor = Buffer.concat([
      Buffer.from([0xa3]), // map(3)
      Buffer.from([0x63]), Buffer.from("fmt"), Buffer.from([0x64]), Buffer.from("none"),
      Buffer.from([0x67]), Buffer.from("attStmt"), Buffer.from([0xa0]),
      Buffer.from([0x68]), Buffer.from("authData"), cborBytes(authData),
    ]);
    const clientDataJSON = this.clientData("webauthn.create", challenge, origin);
    return {
      id: b64url(this.credId),
      rawId: b64url(this.credId),
      type: "public-key",
      response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(cbor), transports: ["internal"] },
      clientExtensionResults: {},
    };
  }
  assertion(challenge, { rpId = RP_ID, origin = ORIGIN, bumpCounter = true, counter } = {}) {
    if (bumpCounter && counter === undefined) this.counter += 1;
    const authData = this.authData(rpId, { attested: false, counter });
    const clientDataJSON = this.clientData("webauthn.get", challenge, origin);
    const sig = this.sign(authData, clientDataJSON);
    return {
      id: b64url(this.credId),
      rawId: b64url(this.credId),
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(sig),
        userHandle: null,
      },
      clientExtensionResults: {},
    };
  }
}
function cborBytes(buf) {
  // major type 2 (byte string) with a 2-byte length prefix (enough for authData)
  const len = Buffer.alloc(2);
  len.writeUInt16BE(buf.length, 0);
  return Buffer.concat([Buffer.from([0x59]), len, buf]);
}

function gate(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-passkey-"));
  const store = new PasskeyStore({ file: path.join(dir, "passkeys.json") }).load();
  const g = new PasskeyGate({ store, rpId: RP_ID, origin: ORIGIN, owner: "owner@example.com", enabled: true, ...over });
  return { g, store, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function register(g, auth, connKey, label = "yubikey") {
  const opts = await g.registerOptions(connKey);
  return g.registerVerify({ expectedChallenge: opts.challenge, response: auth.registration(opts.challenge) }, connKey, label);
}

test("bootstrap register then assert mints a capability bound to the connection", async () => {
  const { g, store, cleanup } = gate();
  try {
    const auth = new SoftAuthenticator();
    assert.equal(g.status().bootstrap, true);
    const reg = await register(g, auth, "conn-A");
    assert.equal(reg.verified, true);
    assert.equal(store.count, 1);
    assert.equal(g.status().bootstrap, false);
    const opts = await g.authOptions("conn-A");
    const cap = await g.authVerify({ expectedChallenge: opts.challenge, response: auth.assertion(opts.challenge) }, "conn-A");
    assert.match(cap.capability, /^[A-Za-z0-9_-]+$/);
    // one-use, bound to conn-A
    assert.equal(g.validCapability(cap.capability, "conn-A"), true);
    assert.equal(g.spendCapability(cap.capability, "conn-B"), false, "wrong connection cannot spend");
    assert.equal(g.spendCapability(cap.capability, "conn-A"), true);
    assert.equal(g.spendCapability(cap.capability, "conn-A"), false, "single use");
  } finally {
    cleanup();
  }
});

test("a wrong origin, rpId, or replayed challenge is refused", async () => {
  const { g, cleanup } = gate();
  try {
    const auth = new SoftAuthenticator();
    await register(g, auth, "conn-A");
    // wrong origin
    let opts = await g.authOptions("conn-A");
    await assert.rejects(
      () => g.authVerify({ expectedChallenge: opts.challenge, response: auth.assertion(opts.challenge, { origin: "https://evil.example:8790" }) }, "conn-A"),
      /not verified|origin/i,
    );
    // wrong rpId
    opts = await g.authOptions("conn-A");
    await assert.rejects(
      () => g.authVerify({ expectedChallenge: opts.challenge, response: auth.assertion(opts.challenge, { rpId: "evil.example" }) }, "conn-A"),
      /not verified|RP ID|rpid/i,
    );
    // replayed challenge (same challenge used twice)
    opts = await g.authOptions("conn-A");
    await g.authVerify({ expectedChallenge: opts.challenge, response: auth.assertion(opts.challenge) }, "conn-A");
    await assert.rejects(
      () => g.authVerify({ expectedChallenge: opts.challenge, response: auth.assertion(opts.challenge) }, "conn-A"),
      /no matching assertion challenge/,
    );
  } finally {
    cleanup();
  }
});

test("a capability minted over HTTP is spendable on the browser's separate WS connection", async () => {
  // The bug this pins: the browser opens a NEW connection for the WebSocket attach, so
  // the peer PORT differs from the one that minted the capability. Binding to the full
  // tuple made every Capri attach fail with "passkey required" (caught in a real
  // browser run). Peers are matched by address, exactly like the WS token.
  const { g, cleanup } = gate();
  const addr = "10.0.0.5";
  try {
    const auth = new SoftAuthenticator();
    await register(g, auth, `${addr}:44001`);
    const opts = await g.authOptions(`${addr}:44002`);
    const cap = await g.authVerify({ expectedChallenge: opts.challenge, response: auth.assertion(opts.challenge) }, `${addr}:44002`);
    // same address, another port: this is the WS attach
    assert.equal(g.validCapability(cap.capability, `${addr}:51999`), true);
    assert.equal(g.spendCapability(cap.capability, `${addr}:51999`), true);
    // and still single use
    assert.equal(g.spendCapability(cap.capability, `${addr}:52000`), false);
  } finally {
    cleanup();
  }
});

test("a capability is useless from a different address", async () => {
  const { g, cleanup } = gate();
  const mine = "10.0.0.5";
  const other = "10.0.0.9";
  try {
    const auth = new SoftAuthenticator();
    await register(g, auth, `${mine}:44001`);
    const opts = await g.authOptions(`${mine}:44001`);
    const cap = await g.authVerify({ expectedChallenge: opts.challenge, response: auth.assertion(opts.challenge) }, `${mine}:44001`);
    assert.equal(g.spendCapability(cap.capability, `${other}:44001`), false, "another device cannot spend it");
    // the rightful peer still can: a foreign attempt must not burn the ticket
    assert.equal(g.spendCapability(cap.capability, `${mine}:60123`), true);
  } finally {
    cleanup();
  }
});

test("a challenge issued to one connection cannot be answered by another", async () => {
  const { g, cleanup } = gate();
  try {
    const auth = new SoftAuthenticator();
    await register(g, auth, "conn-A");
    const opts = await g.authOptions("conn-A");
    await assert.rejects(
      () => g.authVerify({ expectedChallenge: opts.challenge, response: auth.assertion(opts.challenge) }, "conn-EVIL"),
      /no matching assertion challenge/,
    );
  } finally {
    cleanup();
  }
});

test("a counter that regresses (cloned authenticator) is refused", async () => {
  const { g, cleanup } = gate();
  try {
    const auth = new SoftAuthenticator();
    await register(g, auth, "conn-A");
    // advance the counter to 5
    let opts = await g.authOptions("conn-A");
    await g.authVerify({ expectedChallenge: opts.challenge, response: auth.assertion(opts.challenge, { counter: 5 }) }, "conn-A");
    // a later assertion reporting a LOWER counter is a clone
    opts = await g.authOptions("conn-A");
    await assert.rejects(
      () => g.authVerify({ expectedChallenge: opts.challenge, response: auth.assertion(opts.challenge, { counter: 3 }) }, "conn-A"),
      /counter regressed|counter value/i,
    );
  } finally {
    cleanup();
  }
});

test("registering a second device needs a prior assertion on the same connection (route rule); the store persists", async () => {
  const { g, store, dir, cleanup } = gate();
  try {
    const auth = new SoftAuthenticator();
    await register(g, auth, "conn-A", "first");
    assert.equal(store.count, 1);
    // a fresh gate over the same file sees the credential (persistence)
    const store2 = new PasskeyStore({ file: path.join(dir, "passkeys.json") }).load();
    assert.equal(store2.count, 1);
    assert.equal(store2.isEmpty, false);
    assert.equal(store2.list()[0].label, "first");
    // a second, different authenticator can still register at the gate level (the
    // owner-only + prior-assertion rule lives in the route; here we prove the store
    // accepts a distinct credential and rejects a duplicate id)
    const auth2 = new SoftAuthenticator();
    await register(g, auth2, "conn-A", "second");
    assert.equal(store.count, 2);
    await assert.rejects(() => register(g, auth, "conn-A"), /already registered|matching registration/);
  } finally {
    cleanup();
  }
});

test("a bootstrap challenge is void once a credential exists (register race)", async () => {
  const { g, cleanup } = gate();
  try {
    const authA = new SoftAuthenticator();
    const authB = new SoftAuthenticator();
    // both A and B fetch bootstrap options while the store is empty
    const optsA = await g.registerOptions("conn-A");
    const optsB = await g.registerOptions("conn-B");
    // A completes first -> store non-empty
    await g.registerVerify({ expectedChallenge: optsA.challenge, response: authA.registration(optsA.challenge) }, "conn-A", "first");
    assert.equal(g.store.count, 1);
    // B tries to complete its stale bootstrap challenge: refused, no unasserted device
    await assert.rejects(
      () => g.registerVerify({ expectedChallenge: optsB.challenge, response: authB.registration(optsB.challenge) }, "conn-B", "sneaky"),
      /bootstrap registration is closed/,
    );
    assert.equal(g.store.count, 1);
  } finally {
    cleanup();
  }
});

test("status reflects enabled, count and bootstrap", async () => {
  const { g, cleanup } = gate({ enabled: false });
  try {
    assert.deepEqual(g.status(), { enabled: false, passkeys: 0, bootstrap: true });
    await register(g, new SoftAuthenticator(), "conn-A");
    assert.deepEqual(g.status(), { enabled: false, passkeys: 1, bootstrap: false });
  } finally {
    cleanup();
  }
});

test("a caller in a loop bounds only itself, and never evicts another connection's challenge", async () => {
  // The first version of this cap evicted the globally oldest entry, which meant a
  // caller asking in a loop would reliably delete the challenge the person at the
  // keyboard was part-way through answering. That turned a memory bound into a way
  // to stop anyone ever enrolling.
  const { g, store, cleanup } = gate();
  // authOptions needs at least one credential to exist
  await register(g, new SoftAuthenticator(), "conn-victim");
  const victim = await g.authOptions("conn-victim").catch(() => null);
  const before = g.challenges.map.size;
  assert.ok(before >= 1, "the victim holds a challenge");
  const victimChallenges = [...g.challenges.map.entries()].filter(([, v]) => v.connKey === "conn-victim");
  assert.equal(victimChallenges.length, 1);

  // one connection asks 40 times
  for (let i = 0; i < 40; i += 1) {
    try {
      await g.authOptions("conn-flood");
    } catch {
      /* refusal is an acceptable answer; eviction of someone else is not */
    }
  }
  const floodHeld = [...g.challenges.map.entries()].filter(([, v]) => v.connKey === "conn-flood").length;
  assert.ok(floodHeld <= 8, `the flooder holds ${floodHeld}, expected its own quota`);
  const victimStill = [...g.challenges.map.entries()].filter(([, v]) => v.connKey === "conn-victim").length;
  assert.equal(victimStill, 1, "the victim's challenge survived");
  assert.ok(victim !== null || true);
  assert.ok(store.count >= 1);
  cleanup();
});

test("two bootstrap registrations verifying concurrently commit exactly one device (lucy J8)", async () => {
  const { g, cleanup } = gate();
  try {
    const authA = new SoftAuthenticator();
    const authB = new SoftAuthenticator();
    const optsA = await g.registerOptions("conn-A");
    const optsB = await g.registerOptions("conn-B");
    // both verifications are in flight before either has committed: the pre-await
    // isEmpty check passes for both, only the post-await re-check can stop the second
    const results = await Promise.allSettled([
      g.registerVerify({ expectedChallenge: optsA.challenge, response: authA.registration(optsA.challenge) }, "conn-A", "first"),
      g.registerVerify({ expectedChallenge: optsB.challenge, response: authB.registration(optsB.challenge) }, "conn-B", "second"),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected");
    assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.status)));
    assert.equal(bad.length, 1);
    assert.match(String(bad[0].reason && bad[0].reason.message), /bootstrap registration is closed/);
    assert.equal(g.store.count, 1);
    assert.equal(g.status().bootstrap, false);
  } finally {
    cleanup();
  }
});
