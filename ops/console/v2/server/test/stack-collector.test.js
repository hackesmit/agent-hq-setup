// stack.py against a synthetic HOME/HQ tree (bead hq-fn4n, design 4.3), plus
// mapStack and the slice/badge wiring. The collector is judged on the design's
// hard rules: windows by record timestamp, quote-aware CLI heads, stale means
// a dead path, verdicts are hints.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mapStack, computeBadges } from "../src/map.js";
import { startTestApp } from "./helpers.js";

const STACK_PY = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "collectors", "stack.py",
);
const NOW = "2026-08-19T12:00:00+00:00";

function iso(daysAgo, at = "10:00:00") {
  const d = new Date(Date.parse(NOW) - daysAgo * 86400000);
  return d.toISOString().slice(0, 10) + "T" + at + ".000Z";
}

function record(type, ts, message) {
  return JSON.stringify({ type, timestamp: ts, message });
}

function toolUse(ts, name, input, id) {
  return record("assistant", ts, { content: [{ type: "tool_use", name, input, id }], usage: { input_tokens: 100, output_tokens: 50 } });
}

function toolResult(ts, id, isError, text) {
  return record("user", ts, { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: text || "" }] });
}

function makeTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-stack-"));
  const home = path.join(dir, "home");
  const hq = path.join(dir, "hq");
  const proj = path.join(home, ".claude", "projects", "-x-hq");
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(path.join(hq, "ops", "metrics"), { recursive: true });
  fs.mkdirSync(path.join(hq, "ops", "mcp"), { recursive: true });
  fs.mkdirSync(path.join(hq, ".claude", "skills", "good-skill"), { recursive: true });
  fs.mkdirSync(path.join(hq, ".claude", "skills", "broken-skill"), { recursive: true });
  fs.writeFileSync(path.join(hq, ".claude", "skills", "good-skill", "SKILL.md"), "# skill\n");
  fs.mkdirSync(path.join(hq, "ops", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(hq, "ops", "scripts", "hook-alive.sh"), "#!/bin/sh\n");
  fs.writeFileSync(
    path.join(hq, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "$CLAUDE_PROJECT_DIR/ops/scripts/hook-alive.sh" }] }],
        Stop: [{ hooks: [{ type: "command", command: "$CLAUDE_PROJECT_DIR/ops/scripts/hook-gone.sh" }] }],
      },
    }),
  );
  fs.writeFileSync(path.join(hq, "ops", "mcp", "browsing.json"), "{}");
  // session A: recent (3 days ago)
  fs.writeFileSync(
    path.join(proj, "sess-a.jsonl"),
    [
      toolUse(iso(3), "Bash", { command: 'bd list --json && echo "a;lucy" | grep a' }, "u1"),
      toolResult(iso(3), "u1", false, "ok"),
      toolUse(iso(3), "Bash", { command: "X=1 sudo vault . note --tag gotcha" }, "u2"),
      toolResult(iso(3), "u2", true, "vault exploded"),
      toolUse(iso(3), "Skill", { skill: "code-review" }, "u3"),
      toolUse(iso(3), "mcp__context7__lookup", { q: "x" }, "u4"),
      toolUse(iso(3), "Edit", { file_path: "/x" }, "u5"),
      toolResult(iso(3), "u5", true, "PreToolUse:Edit hook error: [$CLAUDE_PROJECT_DIR/ops/scripts/hook-alive.sh]: BLOCKED: fixture reason one"),
    ].join("\n") + "\n",
  );
  // session B: old (40 days ago), plus an unstamped record
  fs.writeFileSync(
    path.join(proj, "sess-b.jsonl"),
    [
      toolUse(iso(40), "Bash", { command: "bd ready" }, "o1"),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bd show x" }, id: "o2" }] } }),
    ].join("\n") + "\n",
  );
  fs.writeFileSync(path.join(hq, "ops", "egress.log"), `${iso(2, "09:00:00").replace(".000Z", "+00:00")}\texample.com\tWebFetch\thttps://example.com\n`);
  fs.writeFileSync(path.join(hq, "ops", "metrics", "session-eval.log"), `${iso(1, "09:00:00").replace(".000Z", "+00:00")}\tsid=abc\tmodel=m\tverdict=PASS\n`);
  return { dir, home, hq };
}

function runStack(home, hq) {
  return new Promise((resolve, reject) => {
    execFile(
      "python3",
      [STACK_PY, "--home", home, "--hq", hq, "--now", NOW, "--no-bd"],
      { timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`stack.py failed: ${stderr}`));
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`stack.py printed non-JSON: ${stdout.slice(0, 200)}`));
        }
      },
    );
  });
}

test("stack.py: windows by record timestamp, tokenizer, hooks, staleness, tokens", async () => {
  const t = makeTree();
  try {
    const out = await runStack(t.home, t.hq);
    const by = new Map(out.items.map((i) => [i.id, i]));

    // windows: bd used 3d ago (sess-a) and 40d ago (sess-b) -> 7d sees one, 90d sees both sessions
    const bd = by.get("cli:bd");
    assert.ok(bd, "cli:bd exists");
    assert.equal(bd.windows["7"].uses, 1);
    assert.equal(bd.windows["7"].sessions, 1);
    assert.equal(bd.windows["90"].uses, 2);
    assert.equal(bd.windows["90"].sessions, 2);
    assert.equal(bd.unstamped, 1, "the timestamp-less record is bucketed as unstamped, not windowed");

    // tokenizer: the quoted "a;lucy" must NOT count lucy (it stays inventory-only)
    assert.equal(by.get("cli:lucy").windows["90"].uses, 0, "quoted separators must not split");
    // wrapper + env assignment still resolve vault as the head, and its error counts
    const vault = by.get("cli:vault");
    assert.equal(vault.windows["7"].uses, 1);
    assert.equal(vault.windows["7"].errors, 1);

    // skills, mcp, agents, hooks
    assert.equal(by.get("skill:code-review").windows["7"].uses, 1);
    assert.equal(by.get("mcp:context7").windows["7"].uses, 1);
    const alive = by.get("hook:hook-alive");
    assert.equal(alive.blocks90, 1);
    assert.match(alive.topBlockReason, /fixture reason one/);
    assert.equal(alive.stale, null);
    const gone = by.get("hook:hook-gone");
    assert.equal(gone.verdictHint, "stale");
    assert.match(gone.stale, /command missing/);

    // inventory staleness and unused
    assert.equal(by.get("skill:broken-skill").verdictHint, "stale");
    assert.equal(by.get("skill:good-skill").verdictHint, "unused");
    assert.equal(by.get("cli:graphify").verdictHint, "unused", "a CLI in inventory with zero use is unused");
    assert.equal(by.get("mcp-profile:browsing").inventory, true);

    // flat logs
    assert.equal(by.get("domain:example.com").windows["7"].uses, 1);
    assert.equal(by.get("auto:session-eval").windows["7"].uses, 1);

    // coarse token attribution: sess-a spent 8 records x 150? No: 8 lines but
    // usage only on the 5 tool_use records (150 each) = 750; bd used in both
    // sessions -> sess-a 750 + sess-b 150 (single stamped tool_use)
    assert.equal(by.get("cli:bd").tokens90, 900);
    assert.equal(by.get("skill:code-review").tokens90, 750, "skill only rode session A");
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("mapStack coerces junk and computeBadges counts pending keep/revert", () => {
  const mapped = mapStack({
    generatedAt: "2026-08-19T00:00:00Z",
    items: [
      { id: "cli:bd", name: "bd", kind: "cli", windows: { 7: { uses: "9" }, 30: {}, 90: { uses: 9 } }, verdictHint: "value" },
      { id: "skill:x", name: "x", kind: "skill", windows: {}, verdictHint: "unused", inventory: true, acquisitions: [] },
      { id: "hook:y", name: "y", kind: "weird-kind", windows: {}, verdictHint: "stale", acquisitions: [{ id: "hq-1", title: "t" }] },
      { name: "no-id, dropped" },
    ],
  });
  assert.equal(mapped.items.length, 3);
  assert.equal(mapped.items[0].windows["7"].uses, 9);
  assert.equal(mapped.items[2].kind, "tool", "unknown kinds coerce");
  const badges = computeBadges({ requests: [], projects: [], alerts: [], stack: mapped });
  assert.equal(badges.stack, 1, "unused-without-acquisition counts; stale-with-acquisition does not");
});

test("the stack slice is served and the verbs file decisions through bd", async () => {
  const calls = [];
  const t = await startTestApp({
    runner: async (cmd, args) => {
      calls.push(args.slice(1));
      return { code: 0, stdout: "ok", stderr: "" };
    },
    sources: {
      stackData: async () => ({
        generatedAt: "2026-08-19T00:00:00Z",
        items: [{ id: "cli:pp", name: "pp", kind: "cli", windows: { 7: {}, 30: {}, 90: { uses: 3 } }, verdictHint: "value" }],
      }),
    },
  });
  try {
    const full = await t.request("GET", "/api/state");
    assert.equal(full.json.stack.items.length, 1);
    const one = await t.request("GET", "/api/state/stack");
    assert.equal(one.status, 200);

    const keep = await t.request("POST", "/api/stack-keep", {
      body: { item: "cli:pp", bead: "hq-77", note: "daily use" },
      headers: { "x-console-key": t.key },
    });
    assert.equal(keep.status, 202, keep.text);
    const revert = await t.request("POST", "/api/stack-revert", {
      body: { item: "mcp:context7" },
      headers: { "x-console-key": t.key },
    });
    assert.equal(revert.status, 202, revert.text);
    for (let i = 0; i < 50 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    const flat = calls.map((c) => c.join(" "));
    assert.ok(flat.some((c) => c.startsWith("bd comment hq-77 console stack: KEEP cli:pp")), flat.join(" | "));
    assert.ok(flat.some((c) => c.startsWith("bd create Revert: mcp:context7")), flat.join(" | "));

    const bad = await t.request("POST", "/api/stack-keep", { body: { item: "-flag" }, headers: { "x-console-key": t.key } });
    assert.equal(bad.status, 400, "an option-shaped item is refused");
  } finally {
    await t.close();
  }
});

// ---------- lucy review 2026-08-19 (P2.1) ----------

test("lucy: adversarial records cost themselves, never the collector", async () => {
  const t = makeTree();
  try {
    const proj = path.join(t.home, ".claude", "projects", "-x-hq");
    fs.writeFileSync(
      path.join(proj, "hostile.jsonl"),
      [
        "[]",
        '{"type":"assistant","timestamp":"2026-08-19T00:00:00Z","message":{"usage":{"input_tokens":"not-a-number"},"content":[]}}',
        '{"type":"assistant","timestamp":"2026-08-19T00:00:00Z","message":"not an object"}',
        '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":42,"is_error":true,"content":[{"nested":{"deep":"junk"}}]}]}}',
        // future-dated: quarantined as unstamped, never windowed
        toolUse("2099-01-01T00:00:00.000Z", "Bash", { command: "graphify update ." }, "f1"),
        toolUse(iso(1), "Bash", { command: "pp item list" }, "ok1"),
      ].join("\n") + "\n",
    );
    // subagent transcripts nest below the session file and must be scanned
    const sub = path.join(proj, "sess-a", "subagents");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(sub + "/agent-1.jsonl", toolUse(iso(1), "Bash", { command: "notify low t m" }, "s1") + "\n");

    const out = await runStack(t.home, t.hq);
    const by = new Map(out.items.map((i) => [i.id, i]));
    assert.equal(by.get("cli:pp").windows["7"].uses, 1, "the good record after the hostile ones still counts");
    assert.equal(by.get("cli:graphify").windows["90"].uses, 0, "a future-dated record is not windowed");
    assert.equal(by.get("cli:graphify").unstamped, 1, "it is quarantined as unstamped instead");
    assert.equal(by.get("cli:notify").windows["7"].uses, 1, "nested subagent transcripts are scanned");
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("lucy: tokenizer handles comments, substitutions and sudo -u", async () => {
  const t = makeTree();
  try {
    const proj = path.join(t.home, ".claude", "projects", "-x-hq");
    fs.writeFileSync(
      path.join(proj, "tok.jsonl"),
      [
        toolUse(iso(1), "Bash", { command: "echo ok # ; bd delete x" }, "c1"),
        toolUse(iso(1), "Bash", { command: 'echo "$(graphify update .)"' }, "c2"),
        toolUse(iso(1), "Bash", { command: "sudo -u owner snooze +1h --id x" }, "c3"),
        toolUse(iso(1), "Bash", { command: "echo '$(finish x)'" }, "c4"),
      ].join("\n") + "\n",
    );
    const out = await runStack(t.home, t.hq);
    const by = new Map(out.items.map((i) => [i.id, i]));
    assert.equal(by.get("cli:bd").windows["7"].uses, 1, "only sess-a's real bd counts; the commented one does not");
    assert.equal(by.get("cli:graphify").windows["7"].uses, 1, "a substitution inside double quotes executes and counts");
    assert.equal(by.get("cli:snooze").windows["7"].uses, 1, "sudo -u <user> is skipped to the real head");
    assert.equal(by.get("cli:finish").windows["7"].uses, 0, "single quotes suppress substitution");
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test("lucy: secrets in hook block text are redacted, quoted hook paths are not stale", async () => {
  const t = makeTree();
  try {
    const proj = path.join(t.home, ".claude", "projects", "-x-hq");
    fs.writeFileSync(
      path.join(proj, "leak.jsonl"),
      [
        toolUse(iso(1), "Edit", { file_path: "/x" }, "l1"),
        toolResult(iso(1), "l1", true, 'PreToolUse:Edit hook error: [/x/ops/scripts/hook-alive.sh]: BLOCKED: header Authorization: bearer sk-live-abcdef123456 was written'),
      ].join("\n") + "\n",
    );
    const settings = JSON.parse(fs.readFileSync(path.join(t.hq, ".claude", "settings.json"), "utf8"));
    settings.hooks.PreToolUse[0].hooks[0].command = '"$CLAUDE_PROJECT_DIR/ops/scripts/hook-alive.sh"';
    fs.writeFileSync(path.join(t.hq, ".claude", "settings.json"), JSON.stringify(settings));

    const out = await runStack(t.home, t.hq);
    const by = new Map(out.items.map((i) => [i.id, i]));
    const alive = by.get("hook:hook-alive");
    assert.ok(!JSON.stringify(out).includes("sk-live-abcdef123456"), "no secret may survive into the report");
    assert.match(alive.topBlockReason ?? "", /\[redacted\]/);
    assert.equal(alive.stale, null, "a quoted hook command path resolves through shlex");
  } finally {
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});
