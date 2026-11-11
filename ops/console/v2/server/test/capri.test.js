// Capri (hq-ymxzt.2): POST /api/capri relays wake/done to every open page over the
// live socket and refuses anything else: an unknown event, an extra key (no text or
// audio may ride along), a missing page key.

import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { WS_PROTOCOL } from "../src/protocol.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CapriSay, SAY_MAX_CHARS, VOICE_MARK, capriManifest, capriMessage, cleanSayText, parseCapriEvent, readCapriFrame } from "../src/capri.js";
import { startTestApp } from "./helpers.js";

test("parseCapriEvent accepts wake, done and say, and nothing else", () => {
  assert.deepEqual(parseCapriEvent({ event: "wake" }), { ok: true, event: "wake" });
  assert.deepEqual(parseCapriEvent({ event: "done" }), { ok: true, event: "done" });
  for (const bad of [null, [], "wake", {}, { event: "WAKE" }, { event: "submit" }, { event: 1 }]) {
    assert.equal(parseCapriEvent(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(parseCapriEvent({ event: "wake", text: "rm -rf" }).ok, false);
  assert.equal(parseCapriEvent({ event: "wake", audio: "AAAA" }).ok, false);
  assert.deepEqual(capriMessage("wake", "T"), { t: "capri", event: "wake", at: "T" });
});

test("say carries exactly text and transcriptId, up to 4000 characters", () => {
  assert.deepEqual(parseCapriEvent({ event: "say", text: " hello there ", transcriptId: "abc-1" }), {
    ok: true,
    event: "say",
    text: "hello there",
    transcriptId: "abc-1",
  });
  const ok = (b) => parseCapriEvent(b).ok;
  assert.equal(ok({ event: "say", text: "x".repeat(SAY_MAX_CHARS), transcriptId: "t" }), true);
  assert.equal(ok({ event: "say", text: "x".repeat(SAY_MAX_CHARS + 1), transcriptId: "t" }), false);
  assert.equal(ok({ event: "say", text: "hi" }), false, "no transcriptId");
  assert.equal(ok({ event: "say", transcriptId: "t" }), false, "no text");
  assert.equal(ok({ event: "say", text: "hi", transcriptId: "t", audio: "AAAA" }), false, "extra key");
  assert.equal(ok({ event: "say", text: 5, transcriptId: "t" }), false);
  assert.equal(ok({ event: "say", text: "hi", transcriptId: "a b" }), false);
  assert.equal(ok({ event: "say", text: "hi", transcriptId: "x".repeat(129) }), false);
  assert.equal(ok({ event: "say", text: " \u001b\u0007 ", transcriptId: "t" }), false, "only controls is empty");
  assert.equal(ok({ event: "wake", text: "hi", transcriptId: "t" }), false, "wake carries nothing");
});

test("cleanSayText drops escapes and controls so the paste cannot be ended early", () => {
  assert.equal(cleanSayText("a\u001b[201~\rrm -rf /\u0003b"), "a[201~\nrm -rf /b");
  assert.equal(cleanSayText("one\r\ntwo\tthree\u009b"), "one\ntwo three");
});

const ORCH = { id: "s-orch", name: "orchestrator", runner: "pty", writable: true, kind: "interactive" };
const PASTE = (t) => `\u001b[200~${VOICE_MARK}${t}\u001b[201~`;

/**
 * A CapriSay over fakes. fail: the write numbers (1-based) that throw. fg: the
 * foreground program, a string or a function of the call number.
 */
function fakeSay({ row = ORCH, fail = [], fg = "claude", orchestratorDelay = 0 } = {}) {
  const writes = [];
  let n = 0;
  let fgCalls = 0;
  const say = new CapriSay({
    orchestrator: async () => {
      if (orchestratorDelay) await new Promise((r) => setTimeout(r, orchestratorDelay));
      return row;
    },
    foreground: async () => {
      fgCalls += 1;
      const v = typeof fg === "function" ? fg(fgCalls) : fg;
      if (v instanceof Error) throw v;
      return v;
    },
    input: async (sid, data) => {
      n += 1;
      await new Promise((r) => setTimeout(r, 1));
      if (fail.includes(n)) throw new Error("runner down");
      writes.push([sid, data]);
    },
    sleep: async () => new Promise((r) => setTimeout(r, 2)),
  });
  return { say, writes };
}

test("say types the text into the orchestrator as one bracketed paste with the voice mark, then Enter", async () => {
  const { say, writes } = fakeSay();
  const r = await say.deliver({ text: "line one\nline two", transcriptId: "t1" });
  assert.equal(r.status, 200);
  assert.equal(r.body.chars, 17);
  assert.deepEqual(writes, [
    ["s-orch", PASTE("line one\nline two")],
    ["s-orch", "\r"],
  ]);
  assert.ok(writes[0][1].startsWith("\u001b[200~[voice via Capri] "), "the orchestrator sees the words came from a microphone");
});

test("say delivers once per transcriptId; a repeat is ignored", async () => {
  const { say, writes } = fakeSay();
  await say.deliver({ text: "hi", transcriptId: "t1" });
  const again = await say.deliver({ text: "hi", transcriptId: "t1" });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(writes.length, 2);
  await say.deliver({ text: "hi", transcriptId: "t2" });
  assert.equal(writes.length, 4);
});

test("a replay while the first say is in flight types nothing and shares the first result", async () => {
  // The round 2 probe (state/review/hq-ymxzt.3/r2/probe_replay_race.test.mjs): the
  // real orchestrator() awaits the sessions collector, so the replay lands in that gap.
  const { say, writes } = fakeSay({ orchestratorDelay: 5 });
  const req = { text: "send the invoice", transcriptId: "tr-1" };
  const [a, b] = await Promise.all([say.deliver(req), say.deliver(req)]);
  assert.equal(writes.filter((w) => w[1] === "\r").length, 1, JSON.stringify(writes));
  assert.equal(writes.length, 2);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(b.body.duplicate, true);

  // A replay of a delivery that fails is told it failed, never ok.
  const f = fakeSay({ orchestratorDelay: 5, fail: [1] });
  const [x, y] = await Promise.all([f.say.deliver(req), f.say.deliver(req)]);
  assert.equal(x.status, 502);
  assert.equal(y.status, 502);
  assert.equal(y.body.duplicate, true);
  assert.equal(f.writes.length, 0);
});

test("two says at once go in one after the other: paste, Enter, paste, Enter", async () => {
  const { say, writes } = fakeSay();
  await Promise.all([say.deliver({ text: "one", transcriptId: "a" }), say.deliver({ text: "two", transcriptId: "b" })]);
  assert.deepEqual(
    writes.map((w) => w[1]),
    [PASTE("one"), "\r", PASTE("two"), "\r"],
  );
});

test("say fails closed unless the orchestrator terminal's foreground program is claude", async () => {
  for (const fg of ["bash", "zsh", "sh", null, "", new Error("not a console terminal")]) {
    const { say, writes } = fakeSay({ fg });
    const r = await say.deliver({ text: "touch /tmp/capri-owned", transcriptId: "clip-1" });
    assert.equal(r.status, 409, String(fg));
    assert.match(r.body.error, /not at claude/);
    assert.equal(writes.length, 0, "nothing reaches a shell");
  }
  // A refusal before any write frees the id: once claude is back, the retry lands.
  let fg = "bash";
  const { say, writes } = fakeSay({ fg: () => fg });
  assert.equal((await say.deliver({ text: "hi", transcriptId: "t1" })).status, 409);
  fg = "claude";
  assert.equal((await say.deliver({ text: "hi", transcriptId: "t1" })).status, 200);
  assert.equal(writes.length, 2);
});

test("claude leaving the foreground between paste and Enter means no Enter, and the result is uncertain", async () => {
  const { say, writes } = fakeSay({ fg: (n) => (n === 1 ? "claude" : "bash") });
  const r = await say.deliver({ text: "rm -rf build", transcriptId: "t1" });
  assert.equal(r.status, 502);
  assert.equal(r.body.uncertain, true);
  assert.deepEqual(
    writes.map((w) => w[1]),
    [PASTE("rm -rf build")],
    "a shell never gets the Enter",
  );
});

test("say answers 409 with no live writable orchestrator and keeps the id open for a retry", async () => {
  for (const row of [null, { id: "x", runner: "tmux", writable: true }, { id: "x", runner: "pty", writable: false }, { id: "m", runner: "pty", writable: true, kind: "meta" }]) {
    const { say, writes } = fakeSay({ row });
    const r = await say.deliver({ text: "hi", transcriptId: "t1" });
    assert.equal(r.status, 409, JSON.stringify(row));
    assert.equal(r.body.error, "orchestrator not running");
    assert.equal(writes.length, 0);
  }
  let row = null;
  const writes = [];
  const say = new CapriSay({ orchestrator: async () => row, foreground: async () => "claude", input: async (sid, d) => writes.push(d), sleep: async () => {} });
  assert.equal((await say.deliver({ text: "hi", transcriptId: "t1" })).status, 409);
  row = { id: "s-orch", runner: "pty", writable: true };
  assert.equal((await say.deliver({ text: "hi", transcriptId: "t1" })).status, 200, "the retry lands");
  assert.equal(writes.length, 2);
});

test("once a write was tried the id stays taken: a failed Enter is uncertain and never pasted again", async () => {
  const { say, writes } = fakeSay({ fail: [2] });
  const r = await say.deliver({ text: "hello", transcriptId: "t1" });
  assert.equal(r.status, 502);
  assert.equal(r.body.uncertain, true);
  const retry = await say.deliver({ text: "hello", transcriptId: "t1" });
  assert.equal(retry.status, 502);
  assert.equal(retry.body.duplicate, true);
  assert.deepEqual(
    writes.map((w) => w[1]),
    [PASTE("hello")],
    "no second paste, so no hellohello",
  );
  // A failed paste is uncertain too (its ack may be what got lost).
  const p = fakeSay({ fail: [1] });
  assert.equal((await p.say.deliver({ text: "hi", transcriptId: "t1" })).status, 502);
  assert.equal((await p.say.deliver({ text: "hi", transcriptId: "t1" })).status, 502);
  assert.equal(p.writes.length, 0);
});

test("after an uncertain say the lane refuses the next say: no paste joins the stranded text (lucy r3 finding 3)", async () => {
  // Paste lands, Enter fails: "hello" may sit unsubmitted in the orchestrator input.
  const { say, writes } = fakeSay({ fail: [2] });
  assert.equal((await say.deliver({ text: "hello", transcriptId: "t1" })).status, 502);
  const next = await say.deliver({ text: "buy milk", transcriptId: "t2" });
  assert.equal(next.status, 409, "refused before any write");
  assert.equal(next.body.uncertain, true);
  assert.match(next.body.error, /check the orchestrator terminal/);
  assert.deepEqual(
    writes.map((w) => w[1]),
    [PASTE("hello")],
    "nothing typed after the uncertain say, so Enter never submits hello and buy milk together",
  );
  // A 409 frees the id: the same say lands once the lane is reset.
  assert.equal((await say.deliver({ text: "buy milk", transcriptId: "t2" })).status, 409, "still refused on retry");
  // the owner presses Enter in that terminal himself: the input is his again, and empty.
  say.humanInput("s-other", "\r");
  assert.equal((await say.deliver({ text: "buy milk", transcriptId: "t2" })).status, 409, "input to another terminal resets nothing");
  say.humanInput("s-orch", "x\r");
  assert.equal((await say.deliver({ text: "buy milk", transcriptId: "t2" })).status, 409, "only a lone Enter or Ctrl-C resets");
  say.humanInput("s-orch", "\r");
  assert.equal((await say.deliver({ text: "buy milk", transcriptId: "t2" })).status, 200);
  assert.deepEqual(
    writes.map((w) => w[1]),
    [PASTE("hello"), PASTE("buy milk"), "\r"],
  );
});

test("an uncertain lane resets on Ctrl-C, and a new orchestrator session starts clean", async () => {
  // A failed paste (fail [1]) and a foreground change both mark the lane.
  const a = fakeSay({ fail: [1] });
  assert.equal((await a.say.deliver({ text: "one", transcriptId: "t1" })).status, 502);
  assert.equal((await a.say.deliver({ text: "two", transcriptId: "t2" })).status, 409);
  a.say.humanInput("s-orch", "\u0003");
  assert.equal((await a.say.deliver({ text: "two", transcriptId: "t2" })).status, 200);

  const b = fakeSay({ fg: (n) => (n === 2 ? "bash" : "claude") });
  assert.equal((await b.say.deliver({ text: "one", transcriptId: "t1" })).status, 502);
  assert.equal((await b.say.deliver({ text: "two", transcriptId: "t2" })).status, 409);

  // A refusal before any write (not claude) leaves the lane clean.
  const c = fakeSay({ fg: (n) => (n === 1 ? "bash" : "claude") });
  assert.equal((await c.say.deliver({ text: "one", transcriptId: "t1" })).status, 409);
  assert.equal((await c.say.deliver({ text: "two", transcriptId: "t2" })).status, 200);

  // The orchestrator restarts under a new sid: its input starts empty.
  const writes = [];
  let row = ORCH;
  let n = 0;
  const say = new CapriSay({
    orchestrator: async () => row,
    foreground: async () => "claude",
    input: async (sid, d) => {
      n += 1;
      if (n === 2) throw new Error("runner down");
      writes.push([sid, d]);
    },
    sleep: async () => {},
  });
  assert.equal((await say.deliver({ text: "one", transcriptId: "t1" })).status, 502);
  assert.equal((await say.deliver({ text: "two", transcriptId: "t2" })).status, 409);
  row = { ...ORCH, id: "s-orch2" };
  assert.equal((await say.deliver({ text: "two", transcriptId: "t2" })).status, 200);
  assert.deepEqual(writes.at(-2), ["s-orch2", PASTE("two")]);
});

test("POST /api/capri say: 400 on a bad body, 409 with no orchestrator, wake reports orchestrator false", async () => {
  const t = await startTestApp();
  try {
    const post = (body) => t.request("POST", "/api/capri", { body, headers: { "x-console-key": t.key } });
    assert.equal((await post({ event: "say", text: "hi" })).status, 400);
    assert.equal((await post({ event: "say", text: "x".repeat(4001), transcriptId: "t" })).status, 400);
    const r = await post({ event: "say", text: "hi", transcriptId: "t1" });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "orchestrator not running");
    const w = await post({ event: "wake" });
    assert.equal(w.status, 200);
    assert.equal(w.json.orchestrator, false);
    const noKey = await t.request("POST", "/api/capri", { body: { event: "say", text: "hi", transcriptId: "t2" } });
    assert.equal(noKey.status, 403, "the per-boot key still gates say");
  } finally {
    await t.close();
  }
});

async function openPage(t) {
  const r = await t.request("POST", "/api/ws-token", { body: {}, headers: { "x-console-key": t.key } });
  const ws = new WebSocket(`ws://127.0.0.1:${t.port}/ws`, [WS_PROTOCOL, `tok.${r.json.token}`], {
    headers: { host: `127.0.0.1:${t.cfg.port}`, origin: `http://127.0.0.1:${t.cfg.port}` },
  });
  const messages = [];
  ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  const got = async (want) => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const i = messages.findIndex((m) => m.t === want);
      if (i >= 0) return messages.splice(i, 1)[0];
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${want}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  await got("hello");
  return { ws, messages, got };
}

test("a wake reaches every open page, counts the pages that focused, and done follows it", async () => {
  const t = await startTestApp();
  try {
    const a = await openPage(t);
    const b = await openPage(t);
    const started = Date.now();
    const pending = t.request("POST", "/api/capri", { body: { event: "wake" }, headers: { "x-console-key": t.key } });
    const ma = await a.got("capri");
    const mb = await b.got("capri");
    for (const m of [ma, mb]) {
      assert.equal(m.event, "wake");
      assert.deepEqual(Object.keys(m).sort(), ["at", "event", "id", "t"]);
    }
    assert.equal(ma.id, mb.id);
    a.ws.send(JSON.stringify({ t: "capri.ack", id: ma.id, focused: true }));
    a.ws.send(JSON.stringify({ t: "capri.ack", id: ma.id, focused: true })); // a page counts once
    b.ws.send(JSON.stringify({ t: "capri.ack", id: mb.id, focused: false }));
    const r = await pending;
    assert.equal(r.status, 200);
    assert.equal(r.json.event, "wake");
    assert.equal(r.json.pages, 2);
    assert.equal(r.json.focused, 1);
    assert.ok(Date.now() - started < 300, "every page acked, so no wait for the timeout");
    await t.request("POST", "/api/capri", { body: { event: "done" }, headers: { "x-console-key": t.key } });
    assert.equal((await a.got("capri")).event, "done");
    a.ws.close();
    b.ws.close();
  } finally {
    await t.close();
  }
});

test("a wake no page acks, or with no page open, reports zero focused", async () => {
  const t = await startTestApp();
  try {
    const none = await t.request("POST", "/api/capri", { body: { event: "wake" }, headers: { "x-console-key": t.key } });
    assert.deepEqual([none.json.pages, none.json.focused], [0, 0]);
    const page = await openPage(t);
    const started = Date.now();
    const r = await t.request("POST", "/api/capri", { body: { event: "wake" }, headers: { "x-console-key": t.key } });
    assert.deepEqual([r.json.pages, r.json.focused], [1, 0]);
    assert.ok(Date.now() - started < 1500, "a silent page costs the timeout, no more");
    const m = await page.got("capri");
    page.ws.send(JSON.stringify({ t: "capri.ack", id: m.id, focused: true })); // too late: ignored
    page.ws.close();
  } finally {
    await t.close();
  }
});

test("an unknown event or an extra key is 400 and pushes nothing", async () => {
  const t = await startTestApp();
  try {
    const page = await openPage(t);
    for (const body of [{ event: "listen" }, { event: "wake", text: "hello" }, {}]) {
      const r = await t.request("POST", "/api/capri", { body, headers: { "x-console-key": t.key } });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(page.messages.filter((m) => m.t === "capri").length, 0);
    page.ws.close();
  } finally {
    await t.close();
  }
});

test("without the page key the wake is refused like any other POST", async () => {
  const t = await startTestApp();
  try {
    const r = await t.request("POST", "/api/capri", { body: { event: "wake" } });
    assert.equal(r.status, 403);
  } finally {
    await t.close();
  }
});

// hq-ymxzt.5: the owner's own frames, from state/capri/frames/<state>/, by exact name only.
function framesFixture(stateDir) {
  const root = path.join(stateDir, "capri", "frames");
  for (const s of ["idle", "speaking", "dancing"]) fs.mkdirSync(path.join(root, s), { recursive: true });
  fs.writeFileSync(path.join(root, "idle", "001.png"), "png");
  fs.writeFileSync(path.join(root, "speaking", "10.webp"), "w10");
  fs.writeFileSync(path.join(root, "speaking", "2.webp"), "w2");
  fs.writeFileSync(path.join(root, "speaking", "notes.txt"), "skip");
  fs.writeFileSync(path.join(root, "speaking", ".hidden.png"), "skip");
  fs.writeFileSync(path.join(root, "dancing", "1.png"), "skip");
  fs.writeFileSync(path.join(stateDir, "secret.png"), "no");
  fs.symlinkSync(path.join(stateDir, "secret.png"), path.join(root, "idle", "002.png"));
  fs.writeFileSync(path.join(root, "capri.json"), JSON.stringify({ ms: { speaking: 90, idle: "x", thinking: 1 } }));
  return root;
}

test("frames: the manifest lists each state's frames in name order, nothing else", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capri-"));
  try {
    assert.deepEqual(capriManifest(dir), { version: 1, states: {} }, "no folder means no frames");
    framesFixture(dir);
    assert.deepEqual(capriManifest(dir), {
      version: 1,
      states: {
        idle: { ms: 700, frames: ["idle/001.png"] },
        speaking: { ms: 90, frames: ["speaking/2.webp", "speaking/10.webp"] },
      },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("frames: served by state and exact name; symlinks, other folders and traversal are 404", async () => {
  const t = await startTestApp();
  try {
    framesFixture(t.cfg.stateDir);
    const m = await t.request("GET", "/api/capri/frames");
    assert.equal(m.status, 200);
    assert.deepEqual(m.json.states.speaking.frames, ["speaking/2.webp", "speaking/10.webp"]);
    const f = await t.request("GET", "/api/capri/frames/speaking/2.webp");
    assert.equal(f.status, 200);
    assert.equal(f.text, "w2");
    assert.equal(f.headers["content-type"], "image/webp");
    assert.equal(f.headers["x-content-type-options"], "nosniff");
    assert.equal((await t.request("GET", "/api/capri/frames/idle/001.png")).headers["content-type"], "image/png");
    for (const bad of ["idle/002.png", "dancing/1.png", "speaking/notes.txt", "speaking/.hidden.png", "idle/..%2F..%2F..%2Fsecret.png",
      "idle/missing.png", "../secret.png", "idle", "capri.json"]) {
      const r = await t.request("GET", `/api/capri/frames/${bad}`);
      assert.equal(r.status, 404, bad);
    }
  } finally {
    await t.close();
  }
});

test("readCapriFrame refuses anything outside the state folders without touching disk", () => {
  for (const [s, n] of [["idle", "../x.png"], ["idle", "x.svg"], ["glitch", "1.png"], ["IDLE", "1.png"], ["idle", ""], ["__proto__", "1.png"]]) {
    assert.equal(readCapriFrame("/nonexistent", s, n), null, `${s}/${n}`);
  }
});

test("frames are never tracked: state/capri is ignored and git holds no file under it", () => {
  const root = path.resolve(import.meta.dirname, "../../../..");
  const git = (...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
  assert.equal(git("ls-files", "state/capri").stdout.trim(), "", "a Capri frame is tracked");
  assert.equal(git("check-ignore", "-q", "state/capri/frames/idle/001.png").status, 0, "state/capri/ must be gitignored");
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("0000000d49484452", "hex")]);

test("Load images: the owner posts raw bytes, they land unchanged and play; remove deletes", async (t0) => {
  const t = await startTestApp();
  try {
    const h = { "x-console-key": t.key };
    const up = await t.request("POST", "/api/capri/frames/idle/my%20face.png", { raw: PNG, headers: h });
    assert.equal(up.status, 200, up.text);
    assert.equal(up.json.frame, "idle/my_face.png");
    assert.deepEqual(fs.readFileSync(path.join(t.cfg.stateDir, "capri/frames/idle/my_face.png")), PNG);
    const again = await t.request("POST", "/api/capri/frames/idle/my%20face.png", { raw: PNG, headers: h });
    assert.equal(again.json.frame, "idle/my_face-2.png");
    assert.deepEqual((await t.request("GET", "/api/capri/frames")).json.states.idle.frames, ["idle/my_face-2.png", "idle/my_face.png"]);
    const del = await t.request("POST", "/api/capri/frames/idle/my_face.png/delete", { headers: h });
    assert.equal(del.status, 200);
    assert.equal((await t.request("GET", "/api/capri/frames/idle/my_face.png")).status, 404);
    assert.equal((await t.request("POST", "/api/capri/frames/idle/nope.png/delete", { headers: h })).status, 404);
  } finally {
    await t.close();
  }
});

test("Load images: needs the key; refuses non-images (even named .png), svg, empty, over 5 MB and bad states", async () => {
  const t = await startTestApp();
  try {
    const h = { "x-console-key": t.key };
    assert.equal((await t.request("POST", "/api/capri/frames/idle/a.png", { raw: PNG })).status, 403);
    assert.equal((await t.request("POST", "/api/capri/frames/idle/a.png", { raw: PNG, headers: { "x-console-key": "wrong" } })).status, 403);
    assert.equal((await t.request("POST", "/api/capri/frames/idle/a.png", { raw: Buffer.from("<svg onload=alert(1)></svg>"), headers: h })).status, 415);
    assert.equal((await t.request("POST", "/api/capri/frames/idle/a.png", { raw: Buffer.from("not an image at all"), headers: h })).status, 415);
    assert.equal((await t.request("POST", "/api/capri/frames/dancing/a.png", { raw: PNG, headers: h })).status, 404);
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    assert.equal((await t.request("POST", "/api/capri/frames/idle/a.png", { raw: big, headers: h })).status, 413);
    assert.equal(fs.existsSync(path.join(t.cfg.stateDir, "capri/frames/idle")), false);
  } finally {
    await t.close();
  }
});
