// Per-boot CSRF key. Generated fresh at every start, never persisted, injected
// into the served index.html as window.__CONSOLE_BOOT_KEY__ and required as
// X-Console-Key on every POST. A stale page therefore gets 403 {reload:true}
// instead of silently acting with an old key.

import crypto from "node:crypto";

const PLACEHOLDER = "__CONSOLE_BOOT_KEY__";

export class Csrf {
  constructor(key) {
    this.key = key || crypto.randomBytes(24).toString("hex");
    this._buf = Buffer.from(this.key, "utf8");
  }

  /**
   * Put the key in the page. Uses the placeholder when the build left one,
   * otherwise injects a script tag before </head> (or at the top of <body>,
   * or, failing both, at the front of the document).
   */
  inject(html) {
    const src = String(html);
    if (src.includes(PLACEHOLDER)) return src.split(PLACEHOLDER).join(this.key);
    // No placeholder: inject a meta tag (never an inline script, the CSP forbids it).
    const meta = `<meta name="console-boot-key" content="${this.key}" />`;
    if (src.includes("</head>")) return src.replace("</head>", `${meta}\n</head>`);
    const tag = meta;
    const head = src.match(/<\/head\s*>/i);
    if (head) return src.replace(head[0], `${tag}${head[0]}`);
    const body = src.match(/<body[^>]*>/i);
    if (body) return src.replace(body[0], `${body[0]}${tag}`);
    return tag + src;
  }

  /** Constant-time compare of the header against this boot's key. */
  valid(header) {
    const got = Buffer.from(String(header || ""), "utf8");
    if (got.length !== this._buf.length) return false;
    return crypto.timingSafeEqual(got, this._buf);
  }

  /**
   * @returns {{ok: true} | {ok: false, status: number, body: object}}
   */
  check(req) {
    if (this.valid(req.headers["x-console-key"])) return { ok: true };
    return { ok: false, status: 403, body: { error: "stale page key", reload: true } };
  }
}
