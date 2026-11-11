// Process helpers. Every shell-out uses execFile with an argument array, so a
// string from the browser or from state can never become shell syntax.

import { execFile } from "node:child_process";

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?: string, timeout?: number, env?: Record<string,string>, maxBuffer?: number}} [opts]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeout || 30000,
        maxBuffer: opts.maxBuffer || 8 * 1024 * 1024,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({
          code,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          killed: Boolean(err && err.killed),
        });
      },
    );
  });
}

/** Same as run() but throws on a non-zero exit, with a filtered stderr tail. */
export async function runOk(cmd, args, opts = {}) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    const tail = (r.stderr || r.stdout).split("\n").slice(-5).join("\n").slice(0, 500);
    throw new Error(`${cmd} ${args[0] || ""} exited ${r.code}: ${tail}`);
  }
  return r;
}

/** Parse the first JSON value in a string; `fallback` when it is not JSON. */
export function firstJson(raw, fallback) {
  const s = String(raw || "").trim();
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    // tolerate trailing noise after a complete JSON document
    for (const open of ["{", "["]) {
      const i = s.indexOf(open);
      if (i < 0) continue;
      const close = open === "{" ? "}" : "]";
      const j = s.lastIndexOf(close);
      if (j > i) {
        try {
          return JSON.parse(s.slice(i, j + 1));
        } catch {
          /* fall through */
        }
      }
    }
    return fallback;
  }
}

/** Last N lines of combined output, bounded, for op records. */
export function tail(stdout, stderr, lines = 25, cap = 4000) {
  const combined = String(stdout || "") + (stderr ? "\n" + stderr : "");
  return combined.split("\n").slice(-lines).join("\n").slice(-cap);
}
