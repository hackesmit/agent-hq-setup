// A real WebSocket round trip over a real socket: mint a token on the
// authenticated origin, present it in Sec-WebSocket-Protocol, get hello, then
// ping/pong, a slice push and the term stub.

import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { WS_PROTOCOL } from "../src/protocol.js";
import { startTestApp } from "./helpers.js";

function open(t, token, over = {}) {
  return new WebSocket(`ws://127.0.0.1:${t.port}/ws`, [WS_PROTOCOL, `tok.${token}`], {
    headers: {
      host: `127.0.0.1:${t.cfg.port}`,
      origin: over.origin || `http://127.0.0.1:${t.cfg.port}`,
    },
  });
}

async function mint(t) {
  const r = await t.request("POST", "/api/ws-token", { body: {}, headers: { "x-console-key": t.key } });
  return r.json.token;
}

test("hello, pong, slice push and the term stub over a live socket", async () => {
  const t = await startTestApp();
  try {
    const ws = open(t, await mint(t));
    const messages = [];
    // attach before the handshake completes: hello arrives immediately on open
    ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    const got = async (want, extra = () => true) => {
      const deadline = Date.now() + 5000;
      for (;;) {
        const i = messages.findIndex((m) => m.t === want && extra(m));
        if (i >= 0) return messages.splice(i, 1)[0];
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${want}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    await new Promise((r, j) => {
      ws.on("open", r);
      ws.on("error", j);
    });
    assert.equal(ws.protocol, WS_PROTOCOL);

    const hello = await got("hello");
    assert.equal(hello.owner, "owner@example.com");
    assert.equal(hello.protocol, 1);
    assert.ok(Array.isArray(hello.state.sessions));

    ws.send(JSON.stringify({ t: "ping", ts: 7 }));
    assert.equal((await got("pong")).ts, 7);

    ws.send(JSON.stringify({ t: "term.attach", sid: "t-1", cols: 80, rows: 24 }));
    assert.equal((await got("term.error")).error, "runner not connected");

    t.app.collectors.emit("sessions", [{ id: "t-9" }]);
    const push = await got("state", (m) => m.slice === "sessions" && m.data.length === 1);
    assert.deepEqual(push.data, [{ id: "t-9" }]);

    ws.close();
  } finally {
    await t.close();
  }
});

test("a used token cannot open a second socket", async () => {
  const t = await startTestApp();
  try {
    const token = await mint(t);
    const first = open(t, token);
    await new Promise((r, j) => {
      first.on("open", r);
      first.on("error", j);
    });
    const second = open(t, token);
    const err = await new Promise((r) => second.on("error", r));
    assert.match(String(err.message), /403/);
    first.close();
  } finally {
    await t.close();
  }
});

test("a foreign Origin cannot open a socket even with a fresh token", async () => {
  const t = await startTestApp();
  try {
    const ws = open(t, await mint(t), { origin: "https://evil.example.com" });
    const err = await new Promise((r) => ws.on("error", r));
    assert.match(String(err.message), /403/);
  } finally {
    await t.close();
  }
});

test("without the token subprotocol the upgrade is refused", async () => {
  const t = await startTestApp();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${t.port}/ws`, [WS_PROTOCOL], {
      headers: { host: `127.0.0.1:${t.cfg.port}`, origin: `http://127.0.0.1:${t.cfg.port}` },
    });
    const err = await new Promise((r) => ws.on("error", r));
    assert.match(String(err.message), /403/);
  } finally {
    await t.close();
  }
});
