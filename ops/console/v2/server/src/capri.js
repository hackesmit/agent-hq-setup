// Capri (hq-ymxzt.2, hq-ymxzt.3): the listener on George hears the word Capri and
// posts {event: "wake"} here, then {event: "done"} when the dictation ends; both are
// relayed on the live channel. Since the 2026-11-04 design change the dictated text
// itself comes as {event: "say", text, transcriptId}: the listener reads it from
// Wispr Flow's local history, and the server types it into the live orchestrator
// terminal and presses Enter there, so delivery never depends on desktop focus.
// Every body is checked key by key: wake and done carry nothing else, say carries
// exactly text and transcriptId, and the text loses every control character before
// it reaches the pty, so it cannot end the bracketed paste or send escapes.

import fs from "node:fs";
import path from "node:path";

export const CAPRI_EVENTS = Object.freeze(["wake", "done", "say"]);
export const SAY_MAX_CHARS = 4000;
const TRANSCRIPT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * @param {unknown} body the parsed JSON body
 * @returns {{ok: true, event: "wake"|"done"} | {ok: true, event: "say", text: string, transcriptId: string} | {ok: false, error: string}}
 */
export function parseCapriEvent(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "bad body" };
  const event = /** @type {any} */ (body).event;
  if (typeof event !== "string" || !CAPRI_EVENTS.includes(event)) return { ok: false, error: "unknown event" };
  const keys = Object.keys(body).sort().join(",");
  if (event !== "say") {
    if (keys !== "event") return { ok: false, error: "only an event is accepted" };
    return { ok: true, event: /** @type {"wake"|"done"} */ (event) };
  }
  if (keys !== "event,text,transcriptId") return { ok: false, error: "say takes exactly text and transcriptId" };
  const { text, transcriptId } = /** @type {any} */ (body);
  if (typeof transcriptId !== "string" || !TRANSCRIPT_ID.test(transcriptId)) return { ok: false, error: "bad transcriptId" };
  if (typeof text !== "string") return { ok: false, error: "bad text" };
  if ([...text].length > SAY_MAX_CHARS) return { ok: false, error: `text over ${SAY_MAX_CHARS} characters` };
  const clean = cleanSayText(text);
  if (!clean) return { ok: false, error: "empty text" };
  return { ok: true, event: "say", text: clean, transcriptId };
}

/**
 * The text as it may reach a terminal: line breaks kept as \n, tabs as spaces,
 * every other C0/C1 control and DEL removed (no ESC, so no early end of the
 * bracketed paste and no terminal escape), trimmed.
 */
export function cleanSayText(text) {
  return String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, "")
    .trim();
}

/** The live-channel message for one event. */
export function capriMessage(event, at = new Date().toISOString()) {
  return { t: "capri", event, at };
}

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
/**
 * Every say reaches the orchestrator with this mark in front, so it knows the
 * words came from a microphone (any sound George hears, not only the owner) and
 * expects dictation errors (ops/templates/orchestrator.md); it acts on voice like typed text.
 */
export const VOICE_MARK = "[voice via Capri] ";
/** The only foreground program a say may type into. */
export const SAY_FOREGROUND = "claude";

const refused = (error) => ({ status: 409, body: { error } });
const NOT_RUNNING = "orchestrator not running";
const UNCERTAIN = { status: 502, body: { error: "delivery uncertain: check the orchestrator terminal", uncertain: true } };
const LANE_UNCERTAIN = { status: 409, body: { error: "an earlier say is uncertain: check the orchestrator terminal, then press Enter or Ctrl-C there", uncertain: true } };
/** What a human may type into the terminal to leave its input empty: Enter submits it, Ctrl-C clears it. */
const RESETS = new Set(["\r", "\u0003"]);

/**
 * Delivers a say into the orchestrator terminal, once per transcriptId.
 * deps.orchestrator(): the live orchestrator session row, or null.
 * deps.foreground(sid): the name of the program in the foreground of that
 *   terminal (the runner's term.fg), or null when it cannot tell.
 * deps.input(sid, data): writes to that session's pty through the runner.
 *
 * The text goes in as one bracketed paste (a line break in it must not submit
 * half a message), then Enter after a short settle. Fails closed: unless the
 * terminal's foreground program is claude, nothing is written (a shell would
 * run the paste on Enter); the check runs again before Enter.
 *
 * One delivery per transcriptId: the id is reserved before the first await, and a
 * repeat shares the first call's result. A refusal before any write (409) frees
 * the id, so the listener's one retry can land. Once a write was tried the id stays
 * taken for good: a failure then answers 502 uncertain, and nothing is pasted again
 * (a repaste would double the text, a lost Enter ack would submit it twice).
 * Paste plus Enter is serialized per terminal, so two says never interleave.
 *
 * An uncertain say may leave its text in the orchestrator's input, and the next
 * say's paste would join it and Enter would submit both (lucy r3 finding 3). So
 * any failure after a write was tried marks the terminal uncertain, and every later
 * say to it is refused before any write (409 uncertain, which frees its id) until
 * a human empties the input: humanInput() sees a lone Enter or Ctrl-C typed into
 * that terminal from the console. A new orchestrator session has a new id and so
 * starts clean. Nothing here clears or resubmits the stranded text itself.
 */
export class CapriSay {
  constructor({ orchestrator, foreground, input, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), settleMs = 150, remember = 500 }) {
    this.orchestrator = orchestrator;
    this.foreground = foreground || (async () => null);
    this.input = input;
    this.sleep = sleep;
    this.settleMs = settleMs;
    this.remember = remember;
    /** @type {Map<string, Promise<{status: number, body: object}>>} */
    this.seen = new Map();
    /** @type {Map<string, Promise<unknown>>} per terminal: the tail of its queue */
    this.lanes = new Map();
    /** @type {Set<string>} terminals whose input may hold an unsubmitted say */
    this.uncertain = new Set();
  }

  /** A human typed into a terminal from the console (term.input). */
  humanInput(sid, data) {
    if (RESETS.has(String(data))) this.uncertain.delete(String(sid));
  }

  /** @returns {Promise<{status: number, body: object}>} */
  deliver({ text, transcriptId }) {
    const prior = this.seen.get(transcriptId);
    if (prior) return prior.result.then((r) => ({ status: r.status, body: { ...r.body, duplicate: true } }));
    // Reserved here, synchronously, before anything awaits.
    const entry = { result: null };
    this.seen.set(transcriptId, entry);
    while (this.seen.size > this.remember) this.seen.delete(this.seen.keys().next().value);
    const free = (r) => {
      if (this.seen.get(transcriptId) === entry) this.seen.delete(transcriptId);
      return r;
    };
    entry.result = this.run(text, free);
    return entry.result;
  }

  async run(text, free) {
    let row;
    try {
      row = await this.orchestrator();
    } catch {
      row = null;
    }
    if (!row || row.runner !== "pty" || row.writable !== true || row.kind === "meta") return free(refused(NOT_RUNNING));
    return this.inLane(row.id, () => this.write(row.id, text, free));
  }

  inLane(sid, fn) {
    const tail = this.lanes.get(sid) || Promise.resolve();
    const next = tail.then(fn, fn);
    const settled = next.then(
      () => {},
      () => {},
    );
    this.lanes.set(sid, settled);
    settled.then(() => {
      if (this.lanes.get(sid) === settled) this.lanes.delete(sid);
    });
    return next;
  }

  async isClaude(sid) {
    try {
      return (await this.foreground(sid)) === SAY_FOREGROUND;
    } catch {
      return false;
    }
  }

  async write(sid, text, free) {
    if (this.uncertain.has(sid)) return free(LANE_UNCERTAIN);
    if (!(await this.isClaude(sid))) return free(refused("the orchestrator terminal is not at claude"));
    const stranded = () => {
      this.uncertain.add(sid);
      return UNCERTAIN;
    };
    try {
      await this.input(sid, PASTE_START + VOICE_MARK + text + PASTE_END);
      await this.sleep(this.settleMs);
      // The paste may have landed: from here on the id is never freed again.
      if (!(await this.isClaude(sid))) return stranded();
      await this.input(sid, "\r");
    } catch {
      return stranded();
    }
    return { status: 200, body: { ok: true, event: "say", chars: [...text].length } };
  }
}

// ---------- the corner's frames (hq-ymxzt.5) ----------
// the owner prepares Capri's frames himself and drops them in
// state/capri/frames/<state>/ (idle, listening, thinking, speaking; gitignored,
// never committed). Nothing here crops, cuts out or draws anything: the server
// lists those folders as a manifest and serves the files by exact name. Format:
// docs/capri-frames.md.

export const CAPRI_STATES = Object.freeze(["idle", "listening", "thinking", "speaking"]);
/** Default time per frame; frames/capri.json {"ms": {"idle": 700}} overrides a state. */
export const CAPRI_FRAME_MS = Object.freeze({ idle: 700, listening: 400, thinking: 500, speaking: 110 });
const FRAME_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(png|webp|jpe?g|gif)$/i;
const FRAME_TYPES = { png: "image/png", webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif" };
export const FRAME_MAX_BYTES = 5 * 1024 * 1024;
const FRAMES_PER_STATE = 120;

function framesRoot(stateDir) {
  return path.join(stateDir, "capri", "frames");
}

/** A regular file (never a symlink) of at most FRAME_MAX_BYTES, else null. */
function plainFile(file) {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && st.size <= FRAME_MAX_BYTES ? st : null;
  } catch {
    return null;
  }
}

function frameMs(root) {
  const out = { ...CAPRI_FRAME_MS };
  if (!plainFile(path.join(root, "capri.json"))) return out;
  try {
    const ms = JSON.parse(fs.readFileSync(path.join(root, "capri.json"), "utf8"))?.ms;
    for (const s of CAPRI_STATES) {
      const v = ms?.[s];
      if (Number.isFinite(v)) out[s] = Math.min(5000, Math.max(40, Math.round(v)));
    }
  } catch {
    /* a broken capri.json keeps the defaults */
  }
  return out;
}

/**
 * The manifest the corner plays: each state's frames in file-name order.
 * @param {string} stateDir
 * @returns {{version: 1, states: Record<string, {ms: number, frames: string[]}>}}
 */
export function capriManifest(stateDir) {
  const root = framesRoot(stateDir);
  const ms = frameMs(root);
  /** @type {Record<string, {ms: number, frames: string[]}>} */
  const states = {};
  for (const s of CAPRI_STATES) {
    let names = [];
    try {
      const dir = path.join(root, s);
      if (!fs.lstatSync(dir).isDirectory()) continue;
      names = fs.readdirSync(dir).filter((n) => FRAME_FILE.test(n) && plainFile(path.join(dir, n)));
    } catch {
      continue;
    }
    names.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    if (names.length) states[s] = { ms: ms[s], frames: names.slice(0, FRAMES_PER_STATE).map((n) => `${s}/${n}`) };
  }
  return { version: 1, states };
}

/**
 * One frame by state and file name, exactly as the manifest lists it.
 * @returns {{type: string, body: Buffer} | null}
 */
export function readCapriFrame(stateDir, state, name) {
  if (!CAPRI_STATES.includes(state) || !FRAME_FILE.test(name)) return null;
  const dir = path.join(framesRoot(stateDir), state);
  try {
    if (!fs.lstatSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  const file = path.join(dir, name);
  if (!plainFile(file)) return null;
  const ext = /** @type {keyof typeof FRAME_TYPES} */ (name.split(".").pop().toLowerCase());
  try {
    return { type: FRAME_TYPES[ext], body: fs.readFileSync(file) };
  } catch {
    return null;
  }
}

// ---------- Load images (hq-ymxzt.8) ----------
// the owner cannot reach hqbox from his PC, so the corner takes his own files: the owner
// picks an image, the page posts the raw bytes, and they land unchanged in
// state/capri/frames/<state>/. The type comes from the file's first bytes, never from
// the name or the header the page sent. Nothing is resized, cropped or re-encoded.

/** png, jpg, webp or gif by magic bytes, else null. */
export function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  const head = buf.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return "gif";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

function cleanBase(raw) {
  const base = String(raw || "").replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+/, "");
  return (base || "frame").slice(0, 50);
}

/**
 * Stores one image in a state's folder.
 * @returns {{ok: true, frame: string} | {ok: false, status: number, error: string}}
 */
export function saveCapriFrame(stateDir, state, name, buf) {
  if (!CAPRI_STATES.includes(state)) return { ok: false, status: 404, error: "no such state" };
  if (!buf.length) return { ok: false, status: 400, error: "empty file" };
  if (buf.length > FRAME_MAX_BYTES) return { ok: false, status: 413, error: "image is over 5 MB" };
  const ext = sniffImage(buf);
  if (!ext) return { ok: false, status: 415, error: "use a png, jpg, webp or gif" };
  const dir = path.join(framesRoot(stateDir), state);
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.readdirSync(dir);
  if (existing.filter((n) => FRAME_FILE.test(n)).length >= FRAMES_PER_STATE) {
    return { ok: false, status: 409, error: `at most ${FRAMES_PER_STATE} images per state` };
  }
  const base = cleanBase(name);
  let file = `${base}.${ext}`;
  for (let i = 2; existing.includes(file); i++) file = `${base}-${i}.${ext}`;
  // wx: never overwrite, never follow a planted symlink
  fs.writeFileSync(path.join(dir, file), buf, { flag: "wx", mode: 0o640 });
  return { ok: true, frame: `${state}/${file}` };
}

/** Removes one listed frame (a regular file only). */
export function removeCapriFrame(stateDir, state, name) {
  if (!CAPRI_STATES.includes(state) || !FRAME_FILE.test(name)) return { ok: false, status: 404, error: "no such frame" };
  const file = path.join(framesRoot(stateDir), state, name);
  try {
    if (!fs.lstatSync(file).isFile()) return { ok: false, status: 404, error: "no such frame" };
    fs.unlinkSync(file);
    return { ok: true };
  } catch {
    return { ok: false, status: 404, error: "no such frame" };
  }
}
