import test from "node:test";
import assert from "node:assert/strict";
import { Csrf } from "../src/csrf.js";

test("a fresh key is random and hex", () => {
  const a = new Csrf().key;
  const b = new Csrf().key;
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{48}$/);
});

test("the placeholder is replaced when the build left one", () => {
  const c = new Csrf("KEY123");
  const out = c.inject("<script>const k = '__CONSOLE_BOOT_KEY__';</script>");
  assert.equal(out, "<script>const k = 'KEY123';</script>");
  assert.ok(!out.includes("__CONSOLE_BOOT_KEY__"));
});

test("without a placeholder a meta tag is injected into head (never an inline script: CSP)", () => {
  const c = new Csrf("KEY123");
  const out = c.inject("<html><head><title>x</title></head><body></body></html>");
  assert.match(out, /<meta name="console-boot-key" content="KEY123" \/>\n<\/head>/);
  assert.doesNotMatch(out, /<script>/);
});

test("a headless document still gets the key", () => {
  const c = new Csrf("KEY123");
  assert.match(c.inject("<div>hi</div>"), /^<meta name="console-boot-key" content="KEY123" \/>/);
});

test("check refuses a wrong, missing or truncated key with reload:true", () => {
  const c = new Csrf("KEY123");
  assert.deepEqual(c.check({ headers: { "x-console-key": "KEY123" } }), { ok: true });
  for (const v of [undefined, "", "KEY12", "KEY1234", "nope"]) {
    const r = c.check({ headers: { "x-console-key": v } });
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.equal(r.body.reload, true);
  }
});
