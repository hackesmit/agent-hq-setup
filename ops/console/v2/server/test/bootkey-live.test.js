// The per-boot CSRF key must reach the page in a LIVE meta tag (not inside an HTML
// comment, not an inline script the CSP would block). Regression for review finding B1.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Csrf } from "../src/csrf.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = fs.readFileSync(path.join(here, "..", "..", "web", "index.html"), "utf8");

test("the shipped index.html carries the placeholder in a live meta tag", () => {
  const stripped = indexHtml.replace(/<!--[\s\S]*?-->/g, "");
  assert.match(stripped, /<meta name="console-boot-key" content="__CONSOLE_BOOT_KEY__"/);
});

test("after injection the key is outside comments and there is no inline script", () => {
  const out = new Csrf("BOOTKEY123").inject(indexHtml);
  const stripped = out.replace(/<!--[\s\S]*?-->/g, "");
  assert.match(stripped, /<meta name="console-boot-key" content="BOOTKEY123"/);
  assert.doesNotMatch(out, /<script>window\.__CONSOLE_BOOT_KEY__/);
});
