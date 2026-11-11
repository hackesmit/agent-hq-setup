import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Csrf } from "../src/csrf.js";
import { StaticServer, isHashedAsset } from "../src/static.js";
import { tmpDir } from "./helpers.js";

function release() {
  const root = tmpDir("hqconsole-release-");
  const web = path.join(root, "web");
  fs.mkdirSync(path.join(web, "assets"), { recursive: true });
  fs.writeFileSync(path.join(web, "index.html"), "<html><head></head><body>console</body></html>");
  fs.writeFileSync(path.join(web, "assets", "index-abc12345.js"), "console.log(1)");
  fs.writeFileSync(path.join(web, "manifest.webmanifest"), "{}");
  // the secret a traversal would be after
  fs.writeFileSync(path.join(root, "secret.txt"), "PAT");
  return { root, web };
}

test("a plain file, the SPA fallback and a missing asset", async () => {
  const { root } = release();
  const s = new StaticServer({ root });
  await s.reload();
  assert.equal(s.available, true);
  assert.equal((await s.resolve("/index.html")).rel, "index.html");
  assert.equal((await s.resolve("/")).rel, "index.html");
  assert.equal((await s.resolve("/now")).fallback, true); // SPA route
  assert.equal((await s.resolve("/projects/acme-dashboard")).fallback, true);
  assert.equal(await s.resolve("/assets/missing-99999999.js"), null); // a bad bundle ref stays 404
  assert.equal((await s.resolve("/projects/hq/beads/hq-o6wn.7")).fallback, true); // a dotted bead id is a route
  assert.equal(await s.resolve("/favicon.ico"), null); // a missing known file type stays 404
  assert.equal(await s.resolve("/cues/missing.wav"), null); // a missing sound cue stays 404
});

test("a symlink out of the release root is refused", async () => {
  const { root, web } = release();
  fs.symlinkSync(path.join(root, "secret.txt"), path.join(web, "escape.txt"));
  fs.symlinkSync("/etc", path.join(web, "etc"));
  const s = new StaticServer({ root });
  await s.reload();
  assert.equal(await s.resolve("/escape.txt"), null);
  assert.equal(await s.resolve("/etc/hostname"), null);
});

test("nested and encoded traversal is refused", async () => {
  const { root } = release();
  const s = new StaticServer({ root });
  await s.reload();
  for (const p of [
    "/../secret.txt",
    "/assets/../../secret.txt",
    "/a/b/../../../secret.txt",
    "/%2e%2e/secret.txt",
    "/%2e%2e%2fsecret.txt",
    "/assets/%2e%2e/%2e%2e/secret.txt",
    "/\0/index.html",
  ]) {
    const hit = await s.resolve(p);
    assert.ok(hit === null || hit.file.startsWith(path.join(root, "web")), `${p} escaped the root`);
    if (hit) assert.ok(!hit.file.includes("secret.txt"), `${p} reached the secret`);
  }
});

test("an absent release root is a first-boot state, not a crash", async () => {
  const s = new StaticServer({ root: "/var/lib/hqconsole/releases/definitely-not-here" });
  assert.equal(await s.reload(), false);
  assert.equal(s.available, false);
  assert.equal(s.release, "dev");
  assert.equal(await s.resolve("/index.html"), null);
});

test("cache headers: hashed assets immutable, index no-store", async () => {
  const { root } = release();
  const s = new StaticServer({ root });
  await s.reload();
  assert.match(s.headers("assets/index-abc12345.js")["cache-control"], /immutable/);
  assert.equal(s.headers("index.html")["cache-control"], "no-store");
  assert.equal(s.headers("manifest.webmanifest")["cache-control"], "no-cache");
  assert.equal(s.headers("index.html")["content-type"], "text/html; charset=utf-8");
  assert.equal(s.headers("assets/index-abc12345.js")["content-type"], "text/javascript; charset=utf-8");
  assert.ok(s.headers("index.html")["content-security-policy"].includes("script-src 'self'"));
  assert.ok(isHashedAsset("assets/index-CEv3umwq.js"));
  assert.ok(!isHashedAsset("index.html"));
});

test("index.html is served with the boot key injected", async () => {
  const { root } = release();
  const s = new StaticServer({ root, csrf: new Csrf("BOOTKEY") });
  await s.reload();
  const chunks = [];
  const res = {
    writeHead(code, headers) {
      this.code = code;
      this.headers = headers;
    },
    end(b) {
      if (b) chunks.push(b);
    },
  };
  assert.equal(await s.serve({ method: "GET" }, res, "/"), true);
  assert.equal(res.code, 200);
  assert.match(Buffer.concat(chunks).toString(), /BOOTKEY/);
});

test("the release name comes from the resolved root basename", async () => {
  const { root } = release();
  const link = path.join(path.dirname(root), `current-${path.basename(root)}`);
  fs.symlinkSync(root, link);
  const s = new StaticServer({ root: link });
  await s.reload();
  assert.equal(s.release, path.basename(root)); // realpath, not the link name
});

test("the CSP pins the socket to this install and states what has no fallback", async () => {
  const { root } = release();
  const s = new StaticServer({ root, origins: ["https://box.example.ts.net:8787"] });
  await s.reload();
  const csp = s.headers("index.html")["content-security-policy"];
  // A bare `wss:` allowed a socket to any host, which would have handed a future
  // script-execution bug a ready way out. It is pinned to our own origin now.
  assert.match(csp, /connect-src 'self' wss:\/\/box\.example\.ts\.net:8787/);
  assert.ok(!/connect-src[^;]*\bwss:(?!\/\/)/.test(csp), csp);
  // These four have no fallback to default-src: stated explicitly or absent.
  for (const d of ["object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) {
    assert.ok(csp.includes(d), `${d} missing from: ${csp}`);
  }
});
