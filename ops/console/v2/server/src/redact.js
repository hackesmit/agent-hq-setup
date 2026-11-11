// Redaction for anything derived from an error, a URL, or command output before it is
// logged, stored on an op record, or returned to a browser.
//
// Why this exists (bead hq-766m): the console had no redaction at all. Raw `e.message`
// reached an HTTP response body in projects/routes.js, the durable op record in
// actions.js, and the log from a dozen collectors. Exec-backed actions record whatever
// the command printed on stderr, and a git remote failure carries
// https://<token>@github.com, so a credential in an error was one bad push away.
//
// The design rule throughout: redact what is credential-shaped, and leave everything
// else exactly as it was. An error that has been scrubbed into uselessness gets ignored,
// and an ignored error is worse than a slightly verbose one. In particular a git sha
// survives on purpose, because it is usually the only useful part of a git error.

/** Query parameter names whose VALUE is assumed secret. Substring match, case-insensitive. */
const SECRET_PARAM = /(token|secret|passw|apikey|api_key|auth|credential|session|signature|^sig$|^key$|^code$)/i;

/**
 * Token shapes worth catching by prefix. These are recognisable on sight, which means
 * they are also recognisable in a log someone pastes into an issue.
 * Ordered longest-prefix-first so `github_pat_` wins over a bare word boundary.
 */
const TOKEN_PREFIX =
  /\b(github_pat_[A-Za-z0-9_]{10,}|gh[pousr]_[A-Za-z0-9]{10,}|glpat-[A-Za-z0-9_-]{10,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{12,})/g;

/**
 * A long opaque run that is probably a token.
 *
 * The negative case is the point: a 40-character git sha is pure lowercase hex, and
 * losing it would gut the usefulness of every git error we log. So a match must be at
 * least 40 characters AND contain something hex cannot: an uppercase letter, or one of
 * the base64url punctuation characters. Pure hex of any length therefore survives.
 *
 * Anchored with lookaround on the character class rather than \b. `=` is not a word
 * character, so a trailing \b matched BEFORE base64 padding and left a bare `==` in the
 * output, which both looked broken and proved the match had not covered the whole token.
 */
const LONG_OPAQUE =
  /(?<![A-Za-z0-9_\-+/=])(?=[A-Za-z0-9_\-+/=]*(?:[A-Z]|[_\-+/=]))[A-Za-z0-9_\-+/=]{40,}(?![A-Za-z0-9_\-+/=])/g;

/** `Authorization: Bearer <x>`, and the bare `Bearer <x>` that ends up in prose. */
const BEARER = /\b(bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{8,})/gi;

const MASK = "[redacted]";

/**
 * Redact the credential-bearing parts of a URL, keeping it recognisable.
 *
 * Userinfo: BOTH halves go, not just the password. A GitHub PAT URL is
 * `https://<token>@github.com/...` with the token as the *username* and no password at
 * all, so redacting only the password would miss the exact case this was written for.
 *
 * Fragment: dropped whole when it contains `=`. The OAuth implicit flow returns
 * `#access_token=...`, and picking through fragment syntax to find the secret half is
 * more ways to be wrong than simply not keeping it.
 *
 * @param {unknown} input a URL string (or anything, which is returned unchanged)
 * @returns {string}
 */
export function redactUrl(input) {
  const raw = typeof input === "string" ? input : String(input == null ? "" : input);
  if (!raw) return raw;
  let u;
  try {
    u = new URL(raw);
  } catch {
    // Not parseable as a URL. It may still be credential-shaped text, and the caller
    // asked about a URL specifically, so hand it to the text rules rather than guessing.
    return redactText(raw);
  }
  if (u.username || u.password) {
    if (u.username) u.username = MASK;
    if (u.password) u.password = MASK;
  }
  for (const key of [...u.searchParams.keys()]) {
    if (SECRET_PARAM.test(key)) u.searchParams.set(key, MASK);
  }
  let out = u.toString();
  if (u.hash && u.hash.includes("=")) out = out.slice(0, out.length - u.hash.length) + "#" + MASK;
  // URL encodes the mask brackets in userinfo; put them back so the output reads as
  // deliberate redaction rather than as a value that happened to contain %5B.
  return out.replace(/%5Bredacted%5D/gi, MASK);
}

/**
 * Redact credential-shaped substrings in free text: URLs embedded in prose, bearer
 * values, known token prefixes, and long opaque runs.
 *
 * Order matters. URLs go first so that a token inside a query string is handled by the
 * URL rules (which keep the surrounding structure) rather than being swallowed whole by
 * LONG_OPAQUE.
 *
 * @param {unknown} input
 * @returns {string}
 */
export function redactText(input) {
  let s = typeof input === "string" ? input : String(input == null ? "" : input);
  if (!s) return s;
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]}]+/gi, (m) => {
    // Trailing punctuation is almost always the sentence, not the URL.
    const trail = m.match(/[.,;:!?]+$/);
    const url = trail ? m.slice(0, -trail[0].length) : m;
    return redactUrl(url) + (trail ? trail[0] : "");
  });
  s = s.replace(BEARER, (_m, scheme) => `${scheme} ${MASK}`);
  s = s.replace(TOKEN_PREFIX, MASK);
  s = s.replace(LONG_OPAQUE, MASK);
  return s;
}

/**
 * A bounded, redacted, stack-free string for an error.
 *
 * No stack, ever: a stack names internal paths and adds length without telling the
 * reader anything they can act on from a response body or an op record.
 *
 * @param {unknown} e
 * @param {{max?: number, fallback?: string}} [opts]
 * @returns {string}
 */
export function sanitizeError(e, opts = {}) {
  const max = Number.isFinite(opts.max) ? Number(opts.max) : 300;
  const fallback = opts.fallback || "server error";
  let msg = "";
  if (e && typeof e === "object" && "message" in e) msg = String(e.message == null ? "" : e.message);
  else if (typeof e === "string") msg = e;
  else if (e != null) msg = String(e);
  msg = redactText(msg).replace(/\s+/g, " ").trim();
  if (!msg) return fallback;
  if (max > 0 && msg.length > max) return msg.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
  return msg;
}
