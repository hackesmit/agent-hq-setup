// The hq-runner wire protocol: newline-delimited JSON, one object per line,
// both directions. Spec: ops/console/v2/runner/PROTOCOL.md.
//
// Requests carry a client-chosen `id` echoed on the reply. Events (data, exit)
// carry `sid` and no `id`, so a client tells them apart without a table.

export const RUNNER_PROTOCOL = 1;

// A single line is one JSON document. The largest legitimate one is an attach
// reply carrying the replay buffer (256 KB) plus its JSON escaping, so 2 MB is
// generous; anything past it is a client bug or an attack and kills the link.
export const MAX_LINE_BYTES = 2 * 1024 * 1024;

export const REQUEST_OPS = Object.freeze([
  "hello",
  "spawn",
  "attach",
  "detach",
  "input",
  "resize",
  "kill",
  "list",
  "drain",
  "status",
  "meta.capability",
  "meta.status",
  "term.snooze",
  "term.wake",
  "term.redraw",
  "term.fg",
]);

export const SESSION_KINDS = Object.freeze(["worker", "interactive", "tmux", "meta"]);

/** Error codes that are part of the contract (the console branches on them). */
export const ERR = Object.freeze({
  protocol: "protocol",
  draining: "draining",
  readOnly: "read-only",
  noSession: "no such session",
  notTerm: "not a console terminal",
  metaDisabled: "meta disabled (RUNNER_META_ENABLED is off, proposal 19)",
  metaRefused: "meta refused",
  metaCapability: "meta capability required",
  metaBusy: "meta session already live",
  ptyUnavailable: "pty unavailable",
});

/** A protocol-level failure the server turns into `{ok:false, error}`. */
export class RunnerError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : String(code));
    this.code = String(code);
    this.detail = detail || null;
  }
}

/**
 * Newline framing over a byte stream. Feed it Buffers; it calls onLine with a
 * parsed object per complete line and onError for a bad line or an overlong
 * one (the caller decides whether that kills the connection).
 * @param {{onLine: (obj: any) => void, onError?: (reason: string) => void, max?: number}} opts
 */
export function createLineDecoder(opts) {
  const max = opts.max || MAX_LINE_BYTES;
  const onError = opts.onError || (() => {});
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      for (;;) {
        const i = buf.indexOf(0x0a);
        if (i < 0) break;
        const line = buf.subarray(0, i);
        buf = buf.subarray(i + 1);
        if (!line.length) continue;
        let obj;
        try {
          obj = JSON.parse(line.toString("utf8"));
        } catch {
          onError("bad json");
          continue;
        }
        if (!obj || typeof obj !== "object") {
          onError("not an object");
          continue;
        }
        opts.onLine(obj);
      }
      if (buf.length > max) {
        buf = Buffer.alloc(0);
        onError("line too long");
      }
    },
    get pending() {
      return buf.length;
    },
  };
}

/** One JSON document plus its newline. */
export function encodeLine(obj) {
  return JSON.stringify(obj) + "\n";
}
