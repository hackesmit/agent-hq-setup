// The mail outbox state machine (COMPILATION-v2 phase 3).
//
// The property every test here defends: an agent may compose freely, and nothing it wrote
// can leave without a human approving that exact text. Most of the file is therefore about
// the ways text can change out from under an approval, because an approval that names only
// a draft id is an approval somebody can move to a different payload.
import test from "node:test";
import assert from "node:assert/strict";
import { MailError, Outbox, TRANSMITTED, messageDigest, normaliseMessage } from "../src/mail/outbox.js";

/**
 * An in-memory store with a real (single-threaded) transaction: the callback runs to
 * completion or its writes are discarded, which is what the claim test needs to be able
 * to reason about.
 */
function memStore() {
  const rows = new Map();
  return {
    rows,
    get: (id) => (rows.has(id) ? { ...rows.get(id) } : null),
    put: (row) => rows.set(row.id, { ...row }),
    listByState: (state) => [...rows.values()].filter((r) => r.state === state).map((r) => ({ ...r })),
    tx(fn) {
      const snapshot = new Map([...rows].map(([k, v]) => [k, { ...v }]));
      try {
        return fn();
      } catch (e) {
        rows.clear();
        for (const [k, v] of snapshot) rows.set(k, v);
        throw e;
      }
    },
  };
}

const box = () => new Outbox({ store: memStore(), now: () => 1_700_000_000_000 });

const MSG = {
  id: "m-1",
  author: /** @type {const} */ ("agent"),
  to: ["someone@example.com"],
  subject: "the quarterly thing",
  body: "As discussed.",
};

/** Approve whatever the draft currently says, the way a UI would after rendering it. */
const approveAsShown = (o, id) => o.approve(id, { digest: messageDigest(o.store.get(id)) });

test("the happy path: compose, approve, claim once, settle sent", () => {
  const o = box();
  const d = o.draft(MSG);
  assert.equal(d.state, "draft");
  assert.equal(d.approvedDigest, null);

  const approved = approveAsShown(o, "m-1");
  assert.equal(approved.state, "approved");
  assert.equal(approved.approvedDigest, messageDigest(MSG));
  assert.equal(typeof approved.idempotencyKey, "string", "an approved send is identified for whatever transmits it");

  const claimed = o.claim("m-1");
  assert.equal(claimed.state, "sending");
  const sent = o.settle("m-1", { ok: true });
  assert.equal(sent.state, "sent");
});

test("an agent draft cannot reach sending without an approval", () => {
  // The reason the whole file exists.
  const o = box();
  o.draft(MSG);
  assert.throws(() => o.claim("m-1"), /a draft message cannot be sent/);
  assert.equal(o.store.get("m-1").state, "draft");
});

test("an approval covers the text, so changing the text loses it", () => {
  const o = box();
  o.draft(MSG);
  approveAsShown(o, "m-1");
  // An approved message cannot be edited at all: the only route to changed text is one
  // that says out loud that the approval is gone.
  assert.throws(() => o.edit("m-1", { body: "Actually, send money." }), /approved message cannot be edited/);

  const back = o.revise("m-1");
  assert.equal(back.state, "draft");
  assert.equal(back.approvedDigest, null);
  assert.equal(back.idempotencyKey, null, "a revised message is not still carrying its old send identity");
  assert.throws(() => o.claim("m-1"), /a draft message cannot be sent/);
});

test("approving text that is not what is stored is refused", () => {
  // The two disagree about what is being approved. Guessing which is right is not a
  // decision code gets to make.
  const o = box();
  o.draft(MSG);
  const stale = messageDigest({ ...MSG, body: "something else entirely" });
  assert.throws(() => o.approve("m-1", { digest: stale }), /read it again and approve the new text/);
  assert.equal(o.store.get("m-1").state, "draft");
  assert.throws(() => o.approve("m-1", { digest: "" }), /must say what it is approving/);
});

test("a message that changed between approval and send is not sent", () => {
  // Approval and transmission are separated in time and the row is durable in between,
  // so the digest is checked again rather than trusted.
  const o = box();
  o.draft(MSG);
  approveAsShown(o, "m-1");
  // Simulate the row being altered by something that bypassed edit(), which is the case
  // the re-check exists for: a corrupted row, a restore, a bug elsewhere.
  o.store.put({ ...o.store.get("m-1"), body: "wire the money to a different account" });
  assert.throws(() => o.claim("m-1"), /no longer matches what was approved/);
  assert.equal(o.store.get("m-1").state, "approved", "and it is left where it was, not half-sent");
});

test("a claim is exactly once, so a retry cannot send twice", () => {
  const o = box();
  o.draft(MSG);
  approveAsShown(o, "m-1");
  assert.equal(o.claim("m-1").state, "sending");
  assert.throws(() => o.claim("m-1"), /already being sent/);
});

test("a transient failure keeps the approval; a permanent one does not", () => {
  const o = box();
  o.draft(MSG);
  approveAsShown(o, "m-1");
  o.claim("m-1");
  // The approval was for the text, and the text has not changed. A transport hiccup is
  // not a reason to make somebody read it again.
  const retryable = o.settle("m-1", { ok: false, detail: "connection reset" });
  assert.equal(retryable.state, "approved");
  assert.equal(retryable.claimedAt, null, "and it is claimable again");
  assert.equal(retryable.detail, "connection reset");
  assert.equal(o.claim("m-1").state, "sending");

  const dead = o.settle("m-1", { ok: false, permanent: true, detail: "mailbox does not exist" });
  assert.equal(dead.state, "failed");
  assert.throws(() => o.claim("m-1"), /a failed message cannot be sent/);
});

test("sent and cancelled are terminal", () => {
  const o = box();
  o.draft(MSG);
  approveAsShown(o, "m-1");
  o.claim("m-1");
  o.settle("m-1", { ok: true });
  assert.throws(() => o.cancel("m-1"), /a sent message cannot be cancelled/);
  assert.throws(() => o.settle("m-1", { ok: true }), /only a sending message can be settled/);
  assert.throws(() => o.revise("m-1"), /only an approved message can be revised/);

  const o2 = box();
  o2.draft({ ...MSG, id: "m-2" });
  o2.cancel("m-2", "changed my mind");
  assert.equal(o2.store.get("m-2").state, "cancelled");
  assert.throws(() => o2.approve("m-2", { digest: "x" }), /cancelled message cannot be approved/);
});

test("cancelling an in-flight send REQUESTS it, because nothing here can stop a connector", () => {
  // The first version declared it cancelled immediately. Review was right that this
  // allows a message to be both delivered and durably recorded as cancelled, which is a
  // comfortable lie rather than a state. The request is honoured only if the attempt
  // does not succeed.
  const o = box();
  o.draft(MSG);
  approveAsShown(o, "m-1");
  o.claim("m-1");
  const requested = o.cancel("m-1", "hung for an hour");
  assert.equal(requested.state, "sending", "still sending: the connector still holds it");
  assert.ok(requested.cancelRequestedAt);

  // The attempt failed, so the cancellation stands.
  const settled = o.settle("m-1", { ok: false });
  assert.equal(settled.state, "cancelled");
});

test("a cancellation that loses the race to a successful send does not rewrite history", () => {
  const o = box();
  o.draft(MSG);
  approveAsShown(o, "m-1");
  o.claim("m-1");
  o.cancel("m-1", "changed my mind");
  const sent = o.settle("m-1", { ok: true });
  assert.equal(sent.state, "sent", "it went out; recording it cancelled would be false");
});

test("an ambiguous delivery waits for a person instead of guessing", () => {
  // The connector handed the message over and never learned whether it was accepted.
  // Retrying sends it twice; failing loses a message that was delivered. Neither is a
  // decision code should make on its own.
  const o = box();
  o.draft(MSG);
  approveAsShown(o, "m-1");
  o.claim("m-1");
  const unsure = o.settle("m-1", { ok: false, uncertain: true, detail: "connection dropped after DATA" });
  assert.equal(unsure.state, "delivery-uncertain");
  assert.deepEqual(o.needsReconciliation().map((r) => r.id), ["m-1"]);
  // It is not claimable while unresolved: that would be the silent retry.
  assert.throws(() => o.claim("m-1"), /cannot be sent/);

  // A human looks in the sent folder and says.
  const resolved = o.resolveUncertain("m-1", { delivered: true, detail: "found in Sent" });
  assert.equal(resolved.state, "sent");

  const o2 = box();
  o2.draft({ ...MSG, id: "m-2" });
  o2.approve("m-2", { digest: messageDigest(o2.store.get("m-2")) });
  o2.claim("m-2");
  o2.settle("m-2", { ok: false, uncertain: true });
  const notSent = o2.resolveUncertain("m-2", { delivered: false });
  assert.equal(notSent.state, "approved", "not delivered means it may be sent again");
  assert.equal(o2.claim("m-2").state, "sending");
});

test("failed is terminal, like sent and cancelled", () => {
  // It was absent from the terminal set, so a permanently rejected message could still be
  // cancelled, destroying the distinction between a rejection and a decision.
  const o = box();
  o.draft(MSG);
  approveAsShown(o, "m-1");
  o.claim("m-1");
  o.settle("m-1", { ok: false, permanent: true, detail: "no such mailbox" });
  assert.throws(() => o.cancel("m-1"), /a failed message cannot be cancelled/);
});

test("an approval identity cannot be chosen by the caller", () => {
  // A caller-chosen key could collide two unrelated messages, and a transmitter
  // deduplicating on it would drop one of them.
  const o = box();
  o.draft(MSG);
  o.draft({ ...MSG, id: "m-2" });
  const a = o.approve("m-1", { digest: messageDigest(o.store.get("m-1")), idempotencyKey: "shared" });
  const b = o.approve("m-2", { digest: messageDigest(o.store.get("m-2")), idempotencyKey: "shared" });
  assert.notEqual(a.idempotencyKey, "shared");
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
});

test("a message in flight cannot be revised out from under the connector", () => {
  const o = box();
  o.draft(MSG);
  approveAsShown(o, "m-1");
  o.claim("m-1");
  assert.throws(() => o.revise("m-1"), /only an approved message can be revised/);
});

test("EVERY transmitted field changes the digest: the closure that stops the next bypass", () => {
  // Review found the same bug three times: a field a connector would transmit that the
  // digest did not cover, so it could be changed after approval without invalidating it.
  // inReplyTo was one, and threading is visible to a recipient. Rather than fix the three
  // and hope, this asserts the property for the whole declared set, so a field added
  // later without a matching digest entry fails here.
  const base = normaliseMessage({ to: ["a@x.com"], subject: "hi", body: "there" });
  for (const field of TRANSMITTED) {
    const changed = { ...base };
    changed[field] = Array.isArray(base[field]) ? [...base[field], "added"] : `${base[field]} changed`;
    assert.notEqual(messageDigest(base), messageDigest(changed), `${field} does not reach the digest`);
  }
});

test("nothing about a recipient is normalised away", () => {
  const base = normaliseMessage({ to: ["a@x.com", "b@x.com"] });
  // The local part of a mailbox is case-sensitive by specification and a display name
  // certainly is, so casing must not be smoothed over.
  assert.notEqual(messageDigest(base), messageDigest(normaliseMessage({ to: ["A@x.com", "b@x.com"] })));
  // Order is visible in what the human read, so a reorder invalidates. That costs an
  // occasional pointless re-approval and is the right direction to be wrong in.
  assert.notEqual(messageDigest(base), messageDigest(normaliseMessage({ to: ["b@x.com", "a@x.com"] })));
  // Surrounding whitespace is not visible to anyone and is a parsing artefact.
  assert.equal(messageDigest(base), messageDigest(normaliseMessage({ to: [" a@x.com ", "b@x.com "] })));
  // Bookkeeping stays out, so re-approving unchanged text after a restart is stable.
  assert.equal(
    messageDigest({ ...base, id: "one", createdAt: "then", state: "draft" }),
    messageDigest({ ...base, id: "two", createdAt: "now", state: "approved" }),
  );
  assert.equal(typeof messageDigest({}), "string");
  assert.equal(typeof messageDigest(null), "string");
});

test("a malformed field is refused, never coerced into the payload", () => {
  // The sharpest of the three bypasses: `to` as a bare string left the string in the
  // payload while the digest, expecting a list, hashed an empty one. A connector that
  // accepts strings would then have sent to a recipient no approval covered.
  const o = box();
  assert.throws(() => o.draft({ id: "bad-1", to: "attacker@example.com" }), /to must be a list/);
  assert.throws(() => o.draft({ id: "bad-2", to: [42] }), /to\[0\] must be a string/);
  assert.throws(() => o.draft({ id: "bad-3", subject: { toString: () => "x" } }), /subject must be a string/);
  assert.equal(o.store.get("bad-1"), null, "and nothing is stored");

  o.draft(MSG);
  assert.throws(() => o.edit("m-1", { to: "someone@example.com" }), /to must be a list/);
  assert.deepEqual(o.store.get("m-1").to, MSG.to, "a refused edit changes nothing");
});

test("threading is part of the message, because a recipient sees where it lands", () => {
  // The blocker in full: approve a reply to thread A, then move it to thread B.
  const o = box();
  o.draft({ ...MSG, inReplyTo: "<thread-A>" });
  const shown = messageDigest(o.store.get("m-1"));
  o.edit("m-1", { inReplyTo: "<thread-B>" });
  assert.throws(() => o.approve("m-1", { digest: shown }), /read it again and approve the new text/);
});

test("what a claim hands back cannot be edited into something else", () => {
  const o = box();
  o.draft(MSG);
  approveAsShown(o, "m-1");
  const envelope = o.claim("m-1");
  assert.throws(() => envelope.to.push("attacker@example.com"), TypeError);
  assert.throws(() => {
    envelope.body = "different";
  }, TypeError);
  // A guard rail, not a boundary: the connector is trusted code and must still re-verify
  // the digest against what it is about to transmit.
  assert.equal(messageDigest(envelope), envelope.approvedDigest);
});

test("errors carry a status, because these become HTTP responses", () => {
  const o = box();
  assert.throws(
    () => o.claim("nope"),
    (e) => e instanceof MailError && e.status === 404,
  );
  o.draft(MSG);
  assert.throws(
    () => o.draft(MSG),
    (e) => e instanceof MailError && e.status === 409,
  );
});

test("the two queues answer the two questions a human has", () => {
  const o = box();
  o.draft(MSG);
  o.draft({ ...MSG, id: "m-2" });
  approveAsShown(o, "m-2");
  assert.deepEqual(o.awaitingApproval().map((r) => r.id), ["m-1"]);
  assert.deepEqual(o.readyToSend().map((r) => r.id), ["m-2"]);
});
