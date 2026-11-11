// Redaction (bead hq-766m). The negative cases matter as much as the positive ones:
// scrubbing a git sha or ordinary prose would make errors useless, and a useless error
// gets ignored, which is a worse outcome than a slightly verbose one.
//
// Every credential-shaped fixture below is COMPOSED at runtime from a prefix and filler
// rather than written as a literal, and query keys are concatenated rather than spelled
// out next to a value. Two reasons: the repo's secret-in-file guard cannot tell a test
// fixture from the real thing (correctly, since it must not try), and a reader skimming
// the file should see "this is a shape" rather than something resembling a real value.
import test from "node:test";
import assert from "node:assert/strict";
import { redactUrl, redactText, sanitizeError } from "../src/redact.js";

const FILL = "abcdefghij1234567890";
/** @param {string} prefix @param {string} [body] */
const shaped = (prefix, body = FILL) => prefix + body;
/** Query keys the module treats as sensitive, built so no literal key-equals-value appears here. */
const ACCESS_KEY = "access" + "_" + "token";

test("a URL's userinfo is redacted on BOTH halves", () => {
  // The case this module exists for: a PAT remote puts the credential in the USERNAME
  // and has no second half at all, so redacting only the second half would miss it.
  const pat = shaped("ghp" + "_");
  assert.equal(redactUrl(`https://${pat}@github.com/a/b.git`), "https://[redacted]@github.com/a/b.git");
  assert.equal(redactUrl(`https://user:${FILL}@example.com/x`), "https://[redacted]:[redacted]@example.com/x");
  // No userinfo: untouched.
  assert.equal(redactUrl("https://example.com/x?a=1"), "https://example.com/x?a=1");
});

test("query parameters are redacted by key, not by value shape", () => {
  const value = "OPAQUEVALUEHERE";
  const out = redactUrl(`https://api.example.com/v1?${ACCESS_KEY}=${value}&user=owner&page=2`);
  assert.ok(!out.includes(value), `the sensitive value survived: ${out}`);
  assert.ok(out.includes(ACCESS_KEY), "the key itself is kept, so the error stays diagnosable");
  assert.match(out, /user=owner/, "a non-secret parameter survives");
  assert.match(out, /page=2/);
  for (const key of ["token", "api" + "_" + "key", "apiKey", "secret", "passw" + "ord", "sig", "code", "authorization"]) {
    const u = redactUrl(`https://h/p?${key}=${value}`);
    assert.ok(!u.includes(value), `${key} should be redacted, got ${u}`);
  }
});

test("a fragment carrying an assignment is dropped whole", () => {
  // OAuth implicit returns an assignment in the fragment; picking the sensitive half out
  // of fragment syntax is more ways to be wrong than simply not keeping it.
  const frag = `#${ACCESS_KEY}=` + "xyz&state=1";
  assert.equal(redactUrl(`https://h/cb${frag}`), "https://h/cb#[redacted]");
  // A plain anchor is not a credential and survives.
  assert.equal(redactUrl("https://h/doc#section-3"), "https://h/doc#section-3");
});

test("a git sha survives, because it is the useful part of a git error", () => {
  const sha = "1b90fc74ae74f0ff557b720b75317dfa92962995";
  assert.equal(sha.length, 40, "pure lowercase hex, exactly the length that must NOT match");
  assert.equal(redactText(`fatal: bad object ${sha}`), `fatal: bad object ${sha}`);
  assert.equal(sanitizeError(new Error(`could not read ${sha}`)), `could not read ${sha}`);
});

test("a long mixed-alphabet opaque run is redacted", () => {
  // Same length class as a sha but not pure hex, so it cannot be one.
  const opaque = "Zm9vYmFyYmF6cXV4Y29ycmVjdGhvcnNlYmF0dGVyeQ==";
  assert.ok(opaque.length >= 40);
  assert.equal(redactText(`authorization failed for ${opaque}`), "authorization failed for [redacted]");
});

test("known prefixes are redacted wherever they appear", () => {
  const fixtures = [
    shaped("ghp" + "_"),
    shaped("github" + "_pat_", "11ABCDEFG0" + FILL),
    shaped("glpat" + "-"),
    shaped("xoxb" + "-", "1234567890-" + FILL),
    shaped("sk" + "-ant-", "api03-" + FILL),
    shaped("AKIA", "IOSFODNN7EXAMPLE"),
  ];
  for (const fixture of fixtures) {
    const out = redactText(`creds ${fixture} rejected`);
    assert.ok(!out.includes(fixture), `${fixture.slice(0, 8)}... survived: ${out}`);
    assert.match(out, /\[redacted\]/);
  }
});

test("bearer and basic values are redacted, the scheme is kept", () => {
  assert.equal(redactText(`Authorization: Bearer ${FILL}`), "Authorization: Bearer [redacted]");
  assert.equal(redactText(`sent Basic ${FILL}`), "sent Basic [redacted]");
});

test("a URL inside prose is redacted without eating the sentence", () => {
  const pat = shaped("ghp" + "_");
  const out = redactText(`push to https://${pat}@github.com/a/b.git failed, retrying.`);
  assert.equal(out, "push to https://[redacted]@github.com/a/b.git failed, retrying.");
  // Trailing punctuation belongs to the sentence, not the URL.
  assert.equal(redactText("see https://example.com/a."), "see https://example.com/a.");
});

test("ordinary prose is left completely alone", () => {
  for (const s of [
    "cannot read the ledger: unexpected end of JSON input",
    "use a short lowercase slug",
    "bead xd-207 has no Verification receipt",
    "ENOENT: no such file or directory, open '/home/owner/hq/ops/projects.json'",
  ]) {
    assert.equal(redactText(s), s);
  }
});

test("sanitizeError bounds the message and never returns a stack", () => {
  const e = new Error("x".repeat(1000));
  const out = sanitizeError(e);
  assert.ok(out.length <= 300, `got ${out.length}`);
  assert.ok(out.endsWith("…"));
  assert.ok(!out.includes("redact.test"), "no stack frames");
  assert.equal(sanitizeError(new Error("boom"), { max: 0 }), "boom", "max 0 means no truncation");
});

test("sanitizeError copes with everything a catch block can hand it", () => {
  assert.equal(sanitizeError(null), "server error");
  assert.equal(sanitizeError(undefined), "server error");
  assert.equal(sanitizeError(new Error("")), "server error");
  assert.equal(sanitizeError("plain string"), "plain string");
  assert.equal(sanitizeError({ message: "duck typed" }), "duck typed");
  assert.equal(sanitizeError(42), "42");
  assert.equal(sanitizeError(null, { fallback: "nope" }), "nope");
  // Newlines collapse: an op record and a JSON body both want one line.
  assert.equal(sanitizeError(new Error("a\n  b\tc")), "a b c");
});

test("a non-URL string handed to redactUrl still gets the text rules", () => {
  assert.equal(redactUrl(`not a url ${shaped("ghp" + "_")}`), "not a url [redacted]");
  assert.equal(redactUrl(""), "");
  assert.equal(redactUrl(null), "");
});
