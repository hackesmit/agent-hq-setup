// Adversarial review probes (hq-px56): static serving containment.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { StaticServer } from "../src/static.js";
import { tmpDir } from "./helpers.js";

/**
 * Layout:
 *   base/outside/secret.txt
 *   base/outside/dir/inner/leak.js
 *   base/outside/dir/hop -> base/outside/dir/inner        (nested symlink)
 *   base/releases/<sha>/web/index.html
 *   base/releases/<sha>/web/assets/app-abcdefgh12.js
 *   base/releases/<sha>/web/link.txt   -> ../../../outside/secret.txt   (file symlink out)
 *   base/releases/<sha>/web/esc        -> ../../../outside/dir          (dir symlink out)
 *   base/releases/<sha>/web/nest/deep  -> ../../../../outside/dir       (dir symlink out, deeper)
 *   base/releases/<sha>/web/loop       -> loop                          (self-referential)
 *   base/releases/<sha>/web/inside     -> assets                        (symlink that stays inside)
 *   base/releases/current -> base/releases/<sha>                        (the switch)
 */
function layout() {
  const base = tmpDir("hqconsole-review-static-");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(outside, "dir", "inner"), { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET");
  fs.writeFileSync(path.join(outside, "dir", "inner", "leak.js"), "LEAK");
  fs.symlinkSync(path.join(outside, "dir", "inner"), path.join(outside, "dir", "hop"));
  const rel = path.join(base, "releases", "abc123");
  const web = path.join(rel, "web");
  fs.mkdirSync(path.join(web, "assets"), { recursive: true });
  fs.mkdirSync(path.join(web, "nest"));
  fs.writeFileSync(path.join(web, "index.html"), "<html><head></head><body>INDEX</body></html>");
  fs.writeFileSync(path.join(web, "assets", "app-abcdefgh12.js"), "APP");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(web, "link.txt"));
  fs.symlinkSync(path.join(outside, "dir"), path.join(web, "esc"));
  fs.symlinkSync(path.join(outside, "dir"), path.join(web, "nest", "deep"));
  fs.symlinkSync("loop", path.join(web, "loop"));
  fs.symlinkSync("assets", path.join(web, "inside"));
  fs.symlinkSync(rel, path.join(base, "releases", "current"));
  return { base, current: path.join(base, "releases", "current"), outside };
}

async function serve(s, url) {
  const res = { code: null, headers: null, body: null, writeHead(c, h) { this.code = c; this.headers = h; }, end(b) { this.body = b; } };
  const ok = await s.serve({ method: "GET" }, res, url);
  return { ok, code: res.code, body: res.body ? res.body.toString() : null };
}

test("static: symlink escapes (file, dir, nested, deeper) never serve and never fall back to index", async () => {
  const L = layout();
  const s = new StaticServer({ root: L.current, log: () => {} });
  assert.equal(await s.reload(), true);
  assert.equal(s.release, "abc123");
  const escapes = [
    "/link.txt",
    "/esc/inner/leak.js",
    "/esc/hop/leak.js",
    "/esc",
    "/esc/",
    "/esc/whatever",
    "/nest/deep/inner/leak.js",
    "/nest/deep/hop/leak.js",
    "/nest/deep/route",
  ];
  for (const u of escapes) {
    const r = await serve(s, u);
    assert.equal(r.ok, false, `${u} must not be served (got ${r.code} ${String(r.body).slice(0, 20)})`);
  }
  // a dangling self-referential link inside the root is an ordinary SPA route (nothing to leak)
  const loop = await serve(s, "/loop");
  assert.ok(!loop.ok || String(loop.body).includes("INDEX"));
  // symlink that stays inside is fine
  const inside = await serve(s, "/inside/app-abcdefgh12.js");
  assert.equal(inside.ok, true);
  assert.equal(inside.body, "APP");
});

test("static: traversal in every encoding stays inside the root", async () => {
  const L = layout();
  const s = new StaticServer({ root: L.current, log: () => {} });
  await s.reload();
  const attempts = [
    "/../outside/secret.txt",
    "/../../outside/secret.txt",
    "/assets/../../outside/secret.txt",
    "/%2e%2e/outside/secret.txt",
    "/%2e%2e/%2e%2e/outside/secret.txt",
    "/assets/%2e%2e/%2e%2e/outside/secret.txt",
    "/..%2foutside/secret.txt",
    "/assets/..%2f..%2foutside/secret.txt",
    "/%2e%2e%2f%2e%2e%2foutside%2fsecret.txt",
    "/..\\..\\outside\\secret.txt",
    "/assets/app-abcdefgh12.js%00.html",
    "/./../outside/secret.txt",
    "//../outside/secret.txt",
    "/%252e%252e/outside/secret.txt",
    "/%c0%ae%c0%ae/outside/secret.txt",
  ];
  for (const u of attempts) {
    const r = await serve(s, u);
    assert.notEqual(r.body, "SECRET", `${u} leaked the secret`);
    // anything that resolves must resolve to a real file inside web/
    if (r.ok) assert.ok(r.body === "INDEX" || r.body === "APP", `${u} served unexpected ${r.body}`);
  }
});

test("static: a swapped current link pointing to a tree with a symlink out is still contained after reload", async () => {
  const L = layout();
  const s = new StaticServer({ root: L.current, log: () => {} });
  await s.reload();
  // attacker (or a bad release) repoints current at outside/, whose files are not the web build
  fs.unlinkSync(L.current);
  fs.symlinkSync(L.outside, L.current);
  // before reload the canonical root is still the old release; nothing from outside is reachable
  const r1 = await serve(s, "/secret.txt");
  assert.notEqual(r1.body, "SECRET");
  // after reload, web/ under outside does not exist, so the server serves nothing
  assert.equal(await s.reload(), false);
  const r2 = await serve(s, "/secret.txt");
  assert.equal(r2.ok, false);
  const r3 = await serve(s, "/");
  assert.equal(r3.ok, false);
});

test("static: root itself as a symlink out of the release tree is honoured only via realpath (no prefix trick)", async () => {
  const L = layout();
  // sibling directory whose name shares the root as a prefix
  const web = fs.realpathSync(path.join(L.current, "web"));
  const sibling = web + "x";
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, "p.txt"), "PREFIX");
  fs.symlinkSync(sibling, path.join(web, "pre"));
  const s = new StaticServer({ root: L.current, log: () => {} });
  await s.reload();
  const r = await serve(s, "/pre/p.txt");
  assert.equal(r.ok, false, "a directory named <root>x must not pass the containment check");
});
