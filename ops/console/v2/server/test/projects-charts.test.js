import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry } from "../src/projects/registry.js";
import { projectRoutes } from "../src/projects/routes.js";
import { flowVaultDir, listFlows, readFlow } from "../src/projects/detail.js";

const CFG = { hqRoot: "/home/owner/hq", rigsDir: "/home/owner/hq/rigs", devNoAuth: true };
const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.resolve(HERE, "../../runner/spawn-as-owner.sh");

// A wrapper that runs the real spawn-as-owner.sh verbs against a temp vault, so the
// listing, the title parse and the path checks are the shipped ones.
function vaultWrapper(vault) {
  const calls = [];
  return {
    calls,
    async call(verb, args = []) {
      calls.push({ verb, args });
      try {
        const stdout = execFileSync("bash", [WRAPPER, verb, ...args], {
          env: { ...process.env, HQ_VAULT_MIRROR: vault },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { code: 0, stdout, stderr: "" };
      } catch (e) {
        return { code: e.status ?? 1, stdout: String(e.stdout || ""), stderr: String(e.stderr || "") };
      }
    },
  };
}

function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flows-"));
  const dir = path.join(root, "01 Projects", "chesski", "flows");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "engine-loop.mmd"), "%% title: Engine loop\nflowchart LR\n  A-->B\n");
  fs.writeFileSync(path.join(dir, "plain.mmd"), "flowchart TD\n  X-->Y\n");
  fs.writeFileSync(path.join(dir, "Not_Allowed.mmd"), "flowchart TD\n");
  fs.writeFileSync(path.join(root, "secret.md"), "do not serve\n");
  const old = new Date("2026-10-01T00:00:00Z");
  fs.utimesSync(path.join(dir, "plain.mmd"), old, old);
  return root;
}

function fakeRes() {
  let resolve;
  const done = new Promise((r) => (resolve = r));
  return {
    status: null,
    json: null,
    done,
    writeHead(code) {
      this.status = code;
    },
    end(body) {
      try {
        this.json = JSON.parse(String(body));
      } catch {
        this.json = null;
      }
      resolve(this);
    },
  };
}

function router(wrapper) {
  return projectRoutes({ cfg: CFG, wrapper, registry: new Registry(CFG), now: () => NOW, log: () => {} });
}

async function get(route, url, method = "GET") {
  const req = Object.assign(new EventEmitter(), { method, url, body: {} });
  const res = fakeRes();
  route(req, res, url.split("?")[0]);
  return res.done;
}

test("flowVaultDir: the hub folder, else 01 Projects/<id>", () => {
  assert.equal(flowVaultDir({ id: "x", vaultDir: "01 Projects/hq" }), "01 Projects/hq");
  assert.equal(flowVaultDir({ id: "acme-avance", vaultDir: null }), "01 Projects/acme-avance");
});

test("GET flows lists charts newest first, titled, with dates; bad names skipped", async () => {
  const res = await get(router(vaultWrapper(makeVault())), "/api/projects/chesski/flows");
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.json.map((c) => [c.name, c.title]),
    [
      ["engine-loop", "Engine loop"],
      ["plain", "plain"],
    ],
  );
  assert.equal(res.json[1].updatedAt, "2026-10-01T00:00:00.000Z");
});

test("GET flows/:name returns the source", async () => {
  const res = await get(router(vaultWrapper(makeVault())), "/api/projects/chesski/flows/engine-loop");
  assert.equal(res.status, 200);
  assert.equal(res.json.name, "engine-loop");
  assert.match(res.json.source, /^%% title: Engine loop\nflowchart LR/);
});

test("a missing flows folder is an empty list", async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "flows-empty-"));
  const res = await get(router(vaultWrapper(vault)), "/api/projects/chesski/flows");
  assert.deepEqual([res.status, res.json], [200, []]);
});

test("bad names and traversal are refused with 400, unknown charts 404", async () => {
  const route = router(vaultWrapper(makeVault()));
  for (const name of ["Not_Allowed", "..", "..%2F..%2Fsecret", "..%2F..%2F..%2Fsecret.md", "a.b", "%E0%A4%A"]) {
    assert.equal((await get(route, `/api/projects/chesski/flows/${name}`)).status, 400, name);
  }
  assert.equal((await get(route, "/api/projects/chesski/flows/nope")).status, 404);
  assert.equal((await get(route, "/api/projects/chesski/flows", "POST")).status, 404, "nothing writes a chart");
});

test("readFlow and listFlows never reach outside flows/", async () => {
  const vault = makeVault();
  const w = vaultWrapper(vault);
  assert.equal(await readFlow(w, { id: "chesski", vaultDir: "01 Projects/chesski" }, "../../secret"), null);
  await assert.rejects(listFlows(w, { id: "x", vaultDir: "../.." }), /vault-flows failed/);
  assert.ok(w.calls.every((c) => c.verb !== "vault-read" || c.args[0].endsWith(".mmd")));
});

test("readFlow: a missing chart is null, a reader failure is a 502", async () => {
  const project = { id: "chesski", vaultDir: "01 Projects/chesski" };
  const missing = { async call() { return { code: 1, stdout: "", stderr: "no such vault file" }; } };
  assert.equal(await readFlow(missing, project, "nope"), null);
  const broken = { async call() { return { code: 126, stdout: "", stderr: "runner unreachable" }; } };
  await assert.rejects(readFlow(broken, project, "nope"), (e) => e.status === 502);
});
