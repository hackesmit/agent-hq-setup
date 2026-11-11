// The state machine that stands between an agent writing an email and an email leaving.
//
// Why this exists (COMPILATION-v2 phase 3, and the shape cross-vendor review asked for by
// name: draft -> approved -> sending -> sent | failed | cancelled, with an immutable
// digest over the approved message, one-shot approval, a transactional claim and an
// idempotency key).
//
// WHAT IS AND IS NOT HERE. There is no IMAP, no SMTP, no stored login material and no
// network in this file, and that is the constraint rather than an unfinished edge. hqbox
// currently grants the account that runs worker sessions passwordless root (bead
// hq-l7et), so there is nowhere on that box to keep mail login material a prompt-injected
// worker could not read. The state machine does not need any, so it exists now and the
// connector waits behind claim().
//
// THE PROPERTY THIS EXISTS TO PROVIDE. An agent may compose freely; nothing it writes can
// leave without a human approving that exact text. An approval covers the message, not
// the draft id, because an approval that names only an object is one somebody can move to
// a different payload.
//
// THE GUARANTEE, STATED HONESTLY. This provides AT MOST ONE ACTIVE CLAIM, not exactly-once
// delivery. SMTP cannot promise the latter: a connector can hand a message to a server,
// have the connection drop before the acceptance is read, and have no way to know whether
// it went. That case has a state of its own (`delivery-uncertain`) and needs a human,
// because silently retrying it sends the message twice and silently failing it loses a
// message that was actually delivered.

import crypto from "node:crypto";

/**
 * @typedef {"draft" | "approved" | "sending" | "sent" | "failed" | "cancelled" | "delivery-uncertain"} MailState
 */

/** Nothing leaves these. `delivery-uncertain` is deliberately NOT one: it needs a person. */
const TERMINAL = new Set(["sent", "failed", "cancelled"]);

/**
 * Every field that reaches a recipient or shapes where the message lands.
 *
 * This list is the contract between the payload and the digest, and the closure test in
 * mail-outbox.test.js asserts they cannot drift apart. The failure this prevents is the
 * one review found three times over: a field that a connector would transmit but the
 * digest did not cover, so it could be changed after approval without invalidating it.
 * `inReplyTo` was exactly that, and threading is visible to a recipient.
 */
export const TRANSMITTED = Object.freeze([
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "body",
  "attachments",
  "inReplyTo",
  "references",
]);

/** Which of those are lists of strings; the rest are plain strings. */
const LIST_FIELDS = new Set(["to", "cc", "bcc", "replyTo", "attachments", "references"]);

export class MailError extends Error {
  /** @param {string} msg @param {number} [status] */
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

/**
 * Validate and canonicalise the transmitted half of a message.
 *
 * Two rules, both learned from review.
 *
 * A malformed value is REFUSED, never coerced. Passing `to: "someone@example.com"` as a
 * bare string used to leave the string sitting in the payload while the digest, which
 * expected a list, hashed an empty one. A connector that accepts strings would then have
 * sent to a recipient no approval covered. Anything that is not the declared shape is now
 * an error at the point somebody wrote it.
 *
 * Addresses are NOT lowercased and NOT sorted. The local part of a mailbox is
 * case-sensitive by specification, display names certainly are, and the order recipients
 * appear in is visible in what the human read. Normalising any of that would let a
 * changed message keep an old approval. The only thing removed is surrounding whitespace,
 * which no recipient can see. The cost is that a pure reorder invalidates an approval,
 * and that is the right direction to be wrong in.
 *
 * @param {any} input
 * @param {{partial?: boolean}} [opts] when partial, only the fields present are checked
 * @returns {Record<string, any>}
 */
export function normaliseMessage(input, opts = {}) {
  const src = input && typeof input === "object" ? input : {};
  /** @type {Record<string, any>} */
  const out = {};
  for (const field of TRANSMITTED) {
    const present = Object.prototype.hasOwnProperty.call(src, field);
    if (!present) {
      if (opts.partial) continue;
      out[field] = LIST_FIELDS.has(field) ? [] : "";
      continue;
    }
    const value = src[field];
    if (LIST_FIELDS.has(field)) {
      if (value == null) {
        out[field] = [];
        continue;
      }
      if (!Array.isArray(value)) throw new MailError(`${field} must be a list, not a ${typeof value}`);
      out[field] = value.map((v, i) => {
        if (typeof v !== "string") throw new MailError(`${field}[${i}] must be a string`);
        return v.trim();
      });
    } else {
      if (value == null) {
        out[field] = "";
        continue;
      }
      if (typeof value !== "string") throw new MailError(`${field} must be a string, not a ${typeof value}`);
      out[field] = value;
    }
  }
  return out;
}

/**
 * What an approval is taken over: every transmitted field, exactly as stored.
 *
 * Bookkeeping (ids, timestamps, state) is excluded so that re-approving unchanged text
 * after a restart produces the same value.
 *
 * @param {any} msg
 * @returns {string}
 */
export function messageDigest(msg) {
  const src = msg && typeof msg === "object" ? msg : {};
  /** @type {Record<string, any>} */
  const canonical = {};
  for (const field of TRANSMITTED) {
    const v = src[field];
    if (LIST_FIELDS.has(field)) canonical[field] = Array.isArray(v) ? v.map(String) : [];
    else canonical[field] = typeof v === "string" ? v : "";
  }
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** A deep, frozen copy: what a caller gets can never become what gets sent. */
function sealed(row) {
  const copy = JSON.parse(JSON.stringify(row));
  for (const field of TRANSMITTED) if (Array.isArray(copy[field])) Object.freeze(copy[field]);
  return Object.freeze(copy);
}

export class Outbox {
  /** @param {{store: any, now?: () => number}} opts */
  constructor(opts) {
    this.store = opts.store;
    this.now = opts.now || (() => Date.now());
  }

  #require(id) {
    const row = this.store.get(String(id || ""));
    if (!row) throw new MailError("no such message", 404);
    return row;
  }

  #at() {
    return new Date(this.now()).toISOString();
  }

  /**
   * Compose. Anything may call this, including an agent: composing is not sending.
   * @param {any} msg
   */
  draft(msg) {
    const id = String((msg && msg.id) || "");
    if (!id) throw new MailError("a draft needs an id");
    const fields = normaliseMessage(msg);
    // Inside a transaction like every other transition: a check outside one can be
    // overtaken by a committed write before its own write lands.
    return this.store.tx(() => {
      if (this.store.get(id)) throw new MailError("that draft already exists", 409);
      const row = {
        id,
        state: /** @type {MailState} */ ("draft"),
        author: msg && msg.author === "owner" ? "owner" : "agent",
        ...fields,
        createdAt: this.#at(),
        approvedAt: null,
        approvedDigest: null,
        idempotencyKey: null,
        claimedAt: null,
        cancelRequestedAt: null,
        settledAt: null,
        detail: null,
      };
      this.store.put(row);
      return sealed(row);
    });
  }

  /** Edit a draft. Only a draft: see revise() for anything further along. */
  edit(id, patch) {
    const fields = normaliseMessage(patch, { partial: true });
    return this.store.tx(() => {
      const row = this.#require(id);
      if (row.state !== "draft") throw new MailError(`a ${row.state} message cannot be edited`, 409);
      const next = { ...row, ...fields };
      this.store.put(next);
      return sealed(next);
    });
  }

  /**
   * Take an approved message back to draft, deliberately discarding the approval.
   *
   * Refused once a send is in flight. Allowing it would let the text change under a
   * connector that already holds the message, and a stale write could put the row back to
   * draft while an attempt was still running.
   */
  revise(id) {
    return this.store.tx(() => {
      const row = this.#require(id);
      if (row.state !== "approved") throw new MailError(`only an approved message can be revised, not a ${row.state} one`, 409);
      const next = { ...row, state: "draft", approvedAt: null, approvedDigest: null, idempotencyKey: null };
      this.store.put(next);
      return sealed(next);
    });
  }

  /**
   * Approve exactly this text.
   *
   * The idempotency key is generated here and cannot be supplied. A caller-chosen key
   * could collide two unrelated messages, and a transmitter deduplicating on it would
   * then drop one of them.
   *
   * @param {string} id
   * @param {{digest: string}} arg
   */
  approve(id, arg) {
    return this.store.tx(() => {
      const row = this.#require(id);
      if (row.state !== "draft") throw new MailError(`a ${row.state} message cannot be approved`, 409);
      const claimed = String((arg && arg.digest) || "");
      if (!claimed) throw new MailError("an approval must say what it is approving");
      const actual = messageDigest(row);
      if (claimed !== actual) {
        throw new MailError("the message changed since it was shown; read it again and approve the new text", 409);
      }
      const next = {
        ...row,
        state: "approved",
        approvedAt: this.#at(),
        approvedDigest: actual,
        idempotencyKey: crypto.randomUUID(),
      };
      this.store.put(next);
      return sealed(next);
    });
  }

  /**
   * Take an approved message for sending. At most one claim is ever active.
   *
   * What comes back is deep-copied and frozen, so a connector cannot add a recipient to
   * the object it was handed. That is a guard rail and not a boundary: the connector is
   * trusted code, and it should re-verify messageDigest against approvedDigest on the
   * exact values it is about to transmit, immediately before transmitting them.
   */
  claim(id) {
    return this.store.tx(() => {
      const row = this.#require(id);
      if (row.state === "sending") throw new MailError("that message is already being sent", 409);
      if (row.state !== "approved") throw new MailError(`a ${row.state} message cannot be sent`, 409);
      if (messageDigest(row) !== row.approvedDigest) {
        throw new MailError("the message no longer matches what was approved; it will not be sent", 409);
      }
      const next = { ...row, state: "sending", claimedAt: this.#at() };
      this.store.put(next);
      return sealed(next);
    });
  }

  /**
   * Record what happened to an attempt.
   *
   * `uncertain` is the case that matters and the one a naive design gets wrong. If the
   * connector cannot tell whether the server accepted the message, neither retrying nor
   * failing is safe: one sends it twice, the other loses a message that was delivered. It
   * goes to `delivery-uncertain` and waits for a person.
   *
   * A cancellation requested while the attempt was running is honoured only if the
   * attempt did not succeed. If it did, the message went out, and recording it as
   * cancelled would be a comfortable lie.
   *
   * @param {string} id
   * @param {{ok: boolean, permanent?: boolean, uncertain?: boolean, detail?: string}} outcome
   */
  settle(id, outcome) {
    return this.store.tx(() => {
      const row = this.#require(id);
      if (row.state !== "sending") throw new MailError(`only a sending message can be settled, not a ${row.state} one`, 409);
      const at = this.#at();
      const detail = outcome && outcome.detail ? String(outcome.detail).slice(0, 500) : null;

      if (outcome && outcome.uncertain) {
        const next = { ...row, state: "delivery-uncertain", claimedAt: null, settledAt: at, detail };
        this.store.put(next);
        return sealed(next);
      }
      if (outcome && outcome.ok) {
        const next = { ...row, state: "sent", settledAt: at, detail };
        this.store.put(next);
        return sealed(next);
      }
      if (row.cancelRequestedAt) {
        const next = { ...row, state: "cancelled", claimedAt: null, settledAt: at, detail: detail || "cancelled while sending" };
        this.store.put(next);
        return sealed(next);
      }
      const permanent = Boolean(outcome && outcome.permanent);
      const next = {
        ...row,
        state: permanent ? "failed" : "approved",
        settledAt: permanent ? at : null,
        claimedAt: null,
        detail,
      };
      this.store.put(next);
      return sealed(next);
    });
  }

  /**
   * Resolve a message nobody could tell the fate of. Only a human calls this, because
   * only a human can go and look in the sent folder.
   * @param {string} id @param {{delivered: boolean, detail?: string}} verdict
   */
  resolveUncertain(id, verdict) {
    return this.store.tx(() => {
      const row = this.#require(id);
      if (row.state !== "delivery-uncertain") {
        throw new MailError(`only an uncertain delivery can be resolved, not a ${row.state} one`, 409);
      }
      const next = {
        ...row,
        state: verdict && verdict.delivered ? "sent" : "approved",
        settledAt: verdict && verdict.delivered ? this.#at() : null,
        detail: verdict && verdict.detail ? String(verdict.detail).slice(0, 500) : row.detail,
      };
      this.store.put(next);
      return sealed(next);
    });
  }

  /**
   * Abandon a message.
   *
   * From `sending` this REQUESTS cancellation rather than declaring it. Nothing here can
   * reach into a connector mid-attempt, so recording the message as cancelled while it
   * was still being transmitted would mean a message could be both delivered and durably
   * marked cancelled. The request is honoured by settle() only if the attempt did not
   * succeed.
   *
   * @param {string} id @param {string} [reason]
   */
  cancel(id, reason) {
    return this.store.tx(() => {
      const row = this.#require(id);
      if (TERMINAL.has(row.state)) throw new MailError(`a ${row.state} message cannot be cancelled`, 409);
      const detail = reason ? String(reason).slice(0, 500) : null;
      if (row.state === "sending") {
        const next = { ...row, cancelRequestedAt: this.#at(), detail };
        this.store.put(next);
        return sealed(next);
      }
      const next = { ...row, state: "cancelled", settledAt: this.#at(), detail };
      this.store.put(next);
      return sealed(next);
    });
  }

  /** Everything a human still has to decide about. */
  awaitingApproval() {
    return this.store.listByState("draft").map(sealed);
  }

  /** Approved and not yet taken: what a connector would pick up, when one exists. */
  readyToSend() {
    return this.store.listByState("approved").map(sealed);
  }

  /** Sent or not? Nobody knows. These need a person and a sent folder. */
  needsReconciliation() {
    return this.store.listByState("delivery-uncertain").map(sealed);
  }
}
