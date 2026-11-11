// The Capri (meta terminal) verbs of the real spawn-as-owner.sh, exercised as the
// security surface they are: claude-meta is the one verb that can start an UNCAGED
// claude as owner, so every refusal is a test. meta-verbs.py runs with HQ_META_DIR
// pointed at a fixture tree (without sudo the env survives; under sudo it is reset, so
// production always uses /var/lib/hqconsole/meta).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.join(HERE, "..", "spawn-as-owner.sh");
const META_SRC = path.join(HERE, "..", "..", "meta");

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      "bash",
      [WRAPPER, ...args],
      { timeout: 20000, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    // The runner always closes meta-revert's stdin (it passes input, "" when it
    // has no baseline); mirror that so meta-revert's optional stdin-baseline read
    // gets EOF instead of blocking on an open pipe (bead hq-gbml).
    if (child.stdin) child.stdin.end();
  });
}

/** run() but with `input` written to the wrapper's stdin: the runner hands the
 * trusted revert baseline this way (bead hq-gbml). */
function runStdin(args, input, env = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      "bash",
      [WRAPPER, ...args],
      { timeout: 20000, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/**
 * meta-snapshot sets ok = known.units, and load_snapshot refuses a snapshot whose ok is not
 * true, so every meta-revert path needs a working `systemctl --user`. hqbox has one; a WSL
 * laptop and most CI containers have no user bus at all. Probing is better than assuming:
 * a test that silently passes on the laptop for the wrong reason is worse than a skip.
 * @returns {Promise<string|null>} a reason to skip, or null when the revert path can run
 */
function userSystemdSkipReason() {
  return new Promise((resolve) => {
    execFile("systemctl", ["--user", "show-environment"], { timeout: 10000 }, (err) => {
      resolve(err ? "no user systemd bus here, so meta-snapshot cannot capture a unit baseline (hq-jou4)" : null);
    });
  });
}

/** A fixture meta tree. `locked` makes it look provisioned: dir and files read-only to us. */
function fixture({ locked = true, settingsPatch = null, userAllow = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hq-meta-"));
  const meta = path.join(dir, "meta");
  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(meta, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  for (const h of ["hook-meta-audit.sh", "hook-meta-settings-integrity.sh"]) {
    fs.copyFileSync(path.join(META_SRC, h), path.join(meta, h));
    fs.chmodSync(path.join(meta, h), locked ? 0o555 : 0o755);
  }
  const settings = JSON.parse(fs.readFileSync(path.join(META_SRC, "meta-settings.json"), "utf8"));
  // the repo file names the production paths; the fixture names its own
  const rewrite = (s) => s.replace("/var/lib/hqconsole/meta", meta);
  for (const groups of Object.values(settings.hooks)) {
    for (const g of groups) for (const h of g.hooks) h.command = rewrite(h.command);
  }
  if (settingsPatch) settingsPatch(settings);
  fs.writeFileSync(path.join(meta, "meta-settings.json"), JSON.stringify(settings, null, 2));
  fs.writeFileSync(path.join(meta, "audit.jsonl"), "");
  if (userAllow) {
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: userAllow } }));
  }
  if (locked) {
    fs.chmodSync(path.join(meta, "meta-settings.json"), 0o444);
    fs.chmodSync(meta, 0o555);
  }
  // The wrapper pins HOME; the helper honours HQ_META_HOME only next to HQ_META_DIR
  // (test mode). HOME is set too so nothing else in the chain sees the real home.
  // The fixture files are owned by us, so we name our own uid trusted (in production
  // sudo drops HQ_META_DIR, so the trusted uid is 0 / root and this env is ignored).
  const env = { HQ_META_DIR: meta, HQ_META_HOME: home, HOME: home, HQ_ROOT: path.join(dir, "hq"), HQ_META_TRUSTED_UID: String(process.getuid()) };
  fs.mkdirSync(env.HQ_ROOT, { recursive: true });
  const cleanup = () => {
    try {
      fs.chmodSync(meta, 0o755);
      for (const f of fs.readdirSync(meta)) fs.chmodSync(path.join(meta, f), 0o755);
    } catch {
      /* best effort */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, meta, home, env, cleanup };
}

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

test("claude-meta refuses anything but exactly one sid", async () => {
  const f = fixture();
  try {
    for (const args of [[], ["s1", "--bare"], ["--help"], ["s1", "s2"], ["bad sid!"], ["-x"], ["../etc"]]) {
      const r = await run(["claude-meta", ...args], f.env);
      assert.equal(r.code, 2, `claude-meta ${args.join(" ")} should be refused`);
      assert.match(r.stderr, /wants exactly one sid|bad sid/);
    }
  } finally {
    f.cleanup();
  }
});

test("claude-meta is refused when meta-check fails, with the reasons", async () => {
  const f = fixture({ locked: false });
  try {
    const r = await run(["claude-meta", "s1abc"], f.env);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /refused by meta-check/);
    assert.match(r.stderr, /writable by this user/);
  } finally {
    f.cleanup();
  }
});

test("meta-check passes on a provisioned-looking tree and names every broken rule otherwise", { skip: isRoot ? "root can write everything" : false }, async () => {
  const good = fixture();
  try {
    const r = await run(["meta-check", "s1abc"], good.env);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true, JSON.stringify(j.reasons));
    assert.equal(j.sid, "s1abc");
  } finally {
    good.cleanup();
  }
  // rule 1 only fires when the launch would load user settings, so these
  // sub-cases pass HQ_META_SETTING_SOURCES=user (bead hq-ngef). The default
  // (empty sources) case is asserted separately below.
  // rule 1: a user-level allow for a mutating tool
  const r1 = fixture({ userAllow: ["Bash(git *)", "Read(**)"] });
  try {
    const j = JSON.parse((await run(["meta-check"], { ...r1.env, HQ_META_SETTING_SOURCES: "user" })).stdout);
    assert.equal(j.ok, false);
    assert.ok(j.reasons.some((x) => x.includes("user settings allow: Bash(git *)")), JSON.stringify(j.reasons));
    assert.ok(!j.reasons.some((x) => x.includes("Read(**)")));
  } finally {
    r1.cleanup();
  }
  // rule 2 is retired (full trust): a bypassing meta settings file no longer refuses
  const r2 = fixture({
    settingsPatch: (s) => {
      s.permissions.defaultMode = "bypassPermissions";
      s.permissions.allow = ["Edit"];
    },
  });
  try {
    const j = JSON.parse((await run(["meta-check"], r2.env)).stdout);
    assert.ok(!j.reasons.some((x) => x.includes("defaultMode") || x.includes("meta settings allow")), JSON.stringify(j.reasons));
  } finally {
    r2.cleanup();
  }
  // rule 3: a hook that lives outside the meta dir (owner could replace it)
  const r3 = fixture({
    settingsPatch: (s) => {
      s.hooks.PostToolUse[0].hooks[0].command = "/tmp/evil-hook.sh";
    },
  });
  try {
    const j = JSON.parse((await run(["meta-check"], r3.env)).stdout);
    assert.equal(j.ok, false);
    assert.ok(j.reasons.some((x) => x.includes("hook not directly inside the meta dir")));
  } finally {
    r3.cleanup();
  }
  // rule 3 again: a hook in a SUBDIR of the meta dir (writable parent) is refused too
  const r3s = fixture({
    settingsPatch: (s) => {
      s.hooks.PostToolUse[0].hooks[0].command = s.hooks.PostToolUse[0].hooks[0].command.replace("/hook-meta-audit.sh", "/hooks/hook-meta-audit.sh");
    },
  });
  try {
    const j = JSON.parse((await run(["meta-check"], r3s.env)).stdout);
    assert.equal(j.ok, false);
    assert.ok(j.reasons.some((x) => x.includes("hook not directly inside the meta dir")), JSON.stringify(j.reasons));
  } finally {
    r3s.cleanup();
  }
  // rule 1 (lucy): user-level hooks would run unprompted under --setting-sources user
  const r1h = fixture();
  try {
    fs.writeFileSync(path.join(r1h.home, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/tmp/x.sh" }] }] } }));
    const j = JSON.parse((await run(["meta-check"], { ...r1h.env, HQ_META_SETTING_SOURCES: "user" })).stdout);
    assert.equal(j.ok, false);
    assert.ok(j.reasons.some((x) => x.includes("user settings define hooks: SessionStart")), JSON.stringify(j.reasons));
  } finally {
    r1h.cleanup();
  }
  // rule 1 (hq-fb1y): remoteControlAtStartup at user level makes the uncaged
  // session reachable from outside the box, so meta-check must refuse it.
  const rrc = fixture();
  try {
    fs.writeFileSync(path.join(rrc.home, ".claude", "settings.json"), JSON.stringify({ remoteControlAtStartup: true }));
    const j = JSON.parse((await run(["meta-check"], { ...rrc.env, HQ_META_SETTING_SOURCES: "user" })).stdout);
    assert.equal(j.ok, false);
    assert.ok(j.reasons.some((x) => x.includes("remoteControlAtStartup")), JSON.stringify(j.reasons));
  } finally {
    rrc.cleanup();
  }
  // hq-ngef: with the DEFAULT empty sources the launch loads only the pinned
  // meta file, so ~/.claude/settings.json is never read and a dangerous one must
  // NOT refuse (no false positive) and cannot introduce a TOCTOU (never read).
  const rNgef = fixture();
  try {
    fs.writeFileSync(path.join(rNgef.home, ".claude", "settings.json"), JSON.stringify({
      permissions: { allow: ["Bash(rm *)"], defaultMode: "bypassPermissions" },
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/tmp/evil.sh" }] }] },
      remoteControlAtStartup: true,
    }));
    const j = JSON.parse((await run(["meta-check"], rNgef.env)).stdout); // no HQ_META_SETTING_SOURCES = empty
    assert.ok(!j.reasons.some((x) => x.startsWith("user settings")), "empty sources must not validate user settings: " + JSON.stringify(j.reasons));
    assert.ok(!j.reasons.some((x) => x.includes("remoteControlAtStartup")), JSON.stringify(j.reasons));
  } finally {
    rNgef.cleanup();
  }
  // and it stays ok when the flag is absent or explicitly false (the audit
  // setting agentPushNotifEnabled is deliberately NOT refused: notification,
  // not access), so a false value must not trip the gate
  const rrcOff = fixture();
  try {
    fs.writeFileSync(path.join(rrcOff.home, ".claude", "settings.json"), JSON.stringify({ remoteControlAtStartup: false, agentPushNotifEnabled: true }));
    const j = JSON.parse((await run(["meta-check"], { ...rrcOff.env, HQ_META_SETTING_SOURCES: "user" })).stdout);
    assert.ok(!j.reasons.some((x) => x.includes("remoteControlAtStartup")), JSON.stringify(j.reasons));
    assert.ok(!j.reasons.some((x) => x.includes("agentPushNotif")), JSON.stringify(j.reasons));
  } finally {
    rrcOff.cleanup();
  }
  // lucy round 2 BLOCKER: a hook owned by a NON-trusted uid (hqconsole in prod) is
  // writable by that uid even when owner cannot write it, so it must be refused. We
  // model "not root-owned" by naming a trusted uid that is not the file owner.
  const rown = fixture();
  try {
    const env = { ...rown.env, HQ_META_TRUSTED_UID: String(process.getuid() + 1) };
    const j = JSON.parse((await run(["meta-check"], env)).stdout);
    assert.equal(j.ok, false);
    assert.ok(j.reasons.some((x) => x.includes("not owned by the trusted uid")), JSON.stringify(j.reasons));
  } finally {
    rown.cleanup();
  }
  // group/other write bits on a hook are refused even if the owner is trusted
  const rmode = fixture();
  try {
    fs.chmodSync(rmode.meta, 0o755); // make it traversable to chmod the hook
    fs.chmodSync(path.join(rmode.meta, "hook-meta-audit.sh"), 0o757);
    fs.chmodSync(rmode.meta, 0o555);
    const j = JSON.parse((await run(["meta-check"], rmode.env)).stdout);
    assert.equal(j.ok, false);
    assert.ok(j.reasons.some((x) => x.includes("group/other writable")), JSON.stringify(j.reasons));
  } finally {
    rmode.cleanup();
  }
  // rule 3 again: writable files
  const r3b = fixture({ locked: false });
  try {
    const j = JSON.parse((await run(["meta-check"], r3b.env)).stdout);
    assert.equal(j.ok, false);
    assert.ok(j.reasons.some((x) => x.includes("meta dir writable")));
    assert.ok(j.reasons.some((x) => x.includes("meta settings writable")));
    assert.ok(j.reasons.some((x) => x.includes("hook writable")));
  } finally {
    r3b.cleanup();
  }
  // rule 4: no session state dir
  const r4 = fixture();
  try {
    fs.chmodSync(r4.meta, 0o755);
    fs.rmdirSync(path.join(r4.meta, "sessions"));
    fs.chmodSync(r4.meta, 0o555);
    const j = JSON.parse((await run(["meta-check"], r4.env)).stdout);
    assert.equal(j.ok, false);
    assert.ok(j.reasons.some((x) => x.includes("meta state dir missing")));
  } finally {
    r4.cleanup();
  }
});

test("the claude-meta launch loads only the pinned meta settings, never user (hq-ngef)", () => {
  const src = fs.readFileSync(WRAPPER, "utf8");
  // the launch must pass the single-source-of-truth variable, empty by default,
  // and must NOT hardcode --setting-sources user (which would read the
  // owner-writable ~/.claude/settings.json and reopen the TOCTOU)
  assert.match(src, /--setting-sources "\$META_SETTING_SOURCES"/, "launch must use the sources variable");
  assert.ok(!/--setting-sources user\b/.test(src), "the wrapper must not hardcode --setting-sources user");
  // production is a hardcoded empty string; the env override is honoured only in
  // test mode (HQ_META_DIR set), so a real launch cannot be pushed to load
  // user/project/local settings (bead hq-ngef, lucy round 2).
  assert.match(src, /else\s*\n\s*META_SETTING_SOURCES=""/, "production must hardcode empty sources");
  assert.match(src, /if \[ -n "\$\{HQ_META_DIR:-\}" \]; then/, "the override must be gated on test mode");
});

test("meta-check refuses a bad sid or extra args at the wrapper", async () => {
  const f = fixture();
  try {
    assert.equal((await run(["meta-check", "bad sid!"], f.env)).code, 2);
    assert.equal((await run(["meta-check", "s1", "s2"], f.env)).code, 2);
  } finally {
    f.cleanup();
  }
});

test("meta-revert validates sid, kind and name shapes before python runs", async () => {
  const f = fixture();
  try {
    const cases = [
      [["meta-revert", "s1"], /wants sid kind name/],
      [["meta-revert", "bad sid!", "unit", "x.service"], /bad sid/],
      [["meta-revert", "s1", "rm", "x"], /bad revert kind/],
      [["meta-revert", "s1", "unit", "../../.bashrc"], /bad unit name/],
      [["meta-revert", "s1", "unit", "x.txt"], /bad unit name/],
      [["meta-revert", "s1", "autostart", "../x.desktop"], /bad autostart name/],
      [["meta-revert", "s1", "at", "12; rm -rf"], /bad at job/],
      [["meta-revert", "s1", "restore", "../../etc/passwd"], /bad restore path/],
      [["meta-revert", "s1", "restore", "home/.config/evil/persist.sh"], /no baseline on stdin|not in the allowed set/],
      [["meta-revert", "s1", "stop", "hq-runner.service; id"], /bad unit name/],
    ];
    for (const [args, re] of cases) {
      const r = await run(args, f.env);
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.stdout} ${r.stderr}`);
      assert.match(r.stderr + r.stdout, re, args.join(" "));
    }
  } finally {
    f.cleanup();
  }
});

/** Refuse to run anything that writes under HOME unless the helper reports the FIXTURE home. */
async function assertFixtureHome(f) {
  const r = await run(["meta-check", "s1abc"], f.env);
  const j = JSON.parse(r.stdout);
  assert.equal(j.home, f.home, "the helper must resolve HOME to the fixture, never the real home");
  assert.equal(j.metaDir, f.meta);
}

test("the helper resolves HOME to the fixture only together with a fixture meta dir", async () => {
  const f = fixture();
  try {
    await assertFixtureHome(f);
    // HQ_META_HOME alone (no HQ_META_DIR) must be ignored: the wrapper pins HOME
    const env = { ...f.env };
    delete env.HQ_META_DIR;
    const r = await run(["meta-check"], env);
    const j = JSON.parse(r.stdout);
    assert.notEqual(j.home, f.home);
  } finally {
    f.cleanup();
  }
});

test("meta-revert is bound to the session snapshot: restore only what existed, remove only what did not", async (t) => {
  const skip = await userSystemdSkipReason();
  if (skip) return t.skip(skip);
  const f = fixture();
  try {
    await assertFixtureHome(f);
    // no baseline on stdin: every revert is refused outright (fail closed)
    const none = await run(["meta-revert", "s1abc", "restore", "home/.bashrc"], f.env);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /no baseline on stdin/);
    // snapshot with .bashrc present and an autostart entry present
    fs.writeFileSync(path.join(f.home, ".bashrc"), "original\n");
    fs.mkdirSync(path.join(f.home, ".config", "autostart"), { recursive: true });
    fs.writeFileSync(path.join(f.home, ".config", "autostart", "old.desktop"), "[Desktop Entry]\n");
    const snap = await run(["meta-snapshot", "s1abc"], f.env);
    assert.equal(snap.code, 0, snap.stderr);
    assert.equal(JSON.parse(snap.stdout).ok, true, snap.stdout);
    // the runner holds this snapshot; hand it to every revert on stdin
    const baseline = fs.readFileSync(path.join(f.meta, "sessions", "s1abc", "snapshot.json"), "utf8");
    // the session tampers with .bashrc and adds a new autostart entry
    fs.writeFileSync(path.join(f.home, ".bashrc"), "tampered\n");
    fs.writeFileSync(path.join(f.home, ".config", "autostart", "new.desktop"), "[Desktop Entry]\n");
    // restore of a pre-existing file works
    const r = await runStdin(["meta-revert", "s1abc", "restore", "home/.bashrc"], baseline, f.env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).ok, true);
    assert.equal(fs.readFileSync(path.join(f.home, ".bashrc"), "utf8"), "original\n");
    // a destination turned into a symlink is replaced, never followed
    const victim = path.join(f.dir, "victim.txt");
    fs.writeFileSync(victim, "victim\n");
    fs.unlinkSync(path.join(f.home, ".bashrc"));
    fs.symlinkSync(victim, path.join(f.home, ".bashrc"));
    const r2 = await runStdin(["meta-revert", "s1abc", "restore", "home/.bashrc"], baseline, f.env);
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(fs.readFileSync(victim, "utf8"), "victim\n", "the symlink target must be untouched");
    assert.equal(fs.lstatSync(path.join(f.home, ".bashrc")).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(f.home, ".bashrc"), "utf8"), "original\n");
    // removing the NEW autostart entry is allowed, removing the OLD one is refused
    const okRm = await runStdin(["meta-revert", "s1abc", "autostart", "new.desktop"], baseline, f.env);
    assert.equal(okRm.code, 0, okRm.stderr);
    assert.equal(fs.existsSync(path.join(f.home, ".config", "autostart", "new.desktop")), false);
    const badRm = await runStdin(["meta-revert", "s1abc", "autostart", "old.desktop"], baseline, f.env);
    assert.equal(badRm.code, 2);
    assert.match(badRm.stderr, /existed at snapshot time/);
    assert.equal(fs.existsSync(path.join(f.home, ".config", "autostart", "old.desktop")), true);
    // restoring something that did not exist at snapshot time is refused
    const noRestore = await runStdin(["meta-revert", "s1abc", "restore", "home/.zshrc"], baseline, f.env);
    assert.equal(noRestore.code, 2);
    assert.match(noRestore.stderr, /absent at snapshot time/);
    // a path outside the allowed set is refused before any backup lookup
    const bad = await runStdin(["meta-revert", "s1abc", "restore", "home/.config/evil/persist.sh"], baseline, f.env);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /not in the allowed set/);
    assert.equal(fs.existsSync(path.join(f.home, ".config", "evil", "persist.sh")), false);
    // a second pre-start snapshot for the same sid is refused (stale backups)
    const again = await run(["meta-snapshot", "s1abc"], f.env);
    assert.equal(again.code, 0);
    assert.equal(JSON.parse(again.stdout).ok, false);
    assert.match(JSON.parse(again.stdout).error, /already exists/);
    // but the close-time "after" view is fine and writes no backups
    const after = await run(["meta-snapshot", "s1abc", "after"], f.env);
    assert.equal(after.code, 0, after.stderr);
    assert.equal(JSON.parse(after.stdout).after, true);
    assert.equal((await run(["meta-snapshot", "s1abc", "before"], f.env)).code, 2);
  } finally {
    f.cleanup();
  }
});

test("meta-revert trusts the runner-held baseline on stdin, not the owner-writable disk copy (hq-gbml)", async () => {
  const crypto = await import("node:crypto");
  const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
  const f = fixture();
  try {
    await assertFixtureHome(f);
    // a pre-existing file and its session backup, as meta-snapshot would have left them
    const original = "original\n";
    fs.writeFileSync(path.join(f.home, ".bashrc"), original);
    const sdir = path.join(f.meta, "sessions", "s1abc");
    fs.mkdirSync(path.join(sdir, "backup", "home"), { recursive: true });
    fs.writeFileSync(path.join(sdir, "backup", "home", ".bashrc"), original);
    // the runner holds THIS baseline; the on-disk snapshot.json is written GARBAGE
    // to prove the disk copy is not what gets trusted
    const baseline = JSON.stringify({
      ok: true, sid: "s1abc", present: [".bashrc"], files: { ".bashrc": sha(original) },
      units: { files: {}, units: {}, systemctl: true }, crontab: { available: true, lines: [] },
      at: { available: true, lines: [] }, known: { units: true, crontab: true, at: true, files: true },
    });
    fs.writeFileSync(path.join(sdir, "snapshot.json"), "{ this is not a usable snapshot }");
    // the session also tampers the live file
    fs.writeFileSync(path.join(f.home, ".bashrc"), "tampered\n");

    // with the baseline on stdin, the restore works despite the garbage on disk
    const ok = await runStdin(["meta-revert", "s1abc", "restore", "home/.bashrc"], baseline, f.env);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(fs.readFileSync(path.join(f.home, ".bashrc"), "utf8"), original);

    // WITHOUT a baseline on stdin it fails closed: the owner-writable disk copy
    // is never read as a fallback (lucy J8-2), so the garbage on disk is moot.
    const noStdin = await run(["meta-revert", "s1abc", "restore", "home/.bashrc"], f.env);
    assert.equal(noStdin.code, 2);
    assert.match(noStdin.stderr, /no baseline on stdin/);

    // a baseline for a DIFFERENT sid is refused, not silently used
    const wrongSid = JSON.parse(baseline); wrongSid.sid = "s9zzz";
    const bad = await runStdin(["meta-revert", "s1abc", "restore", "home/.bashrc"], JSON.stringify(wrongSid), f.env);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /not bound to this sid/);

    // now the session TAMPERS the backup itself: the hash no longer matches the
    // runner-held baseline, so the restore is refused instead of writing evil bytes
    fs.writeFileSync(path.join(sdir, "backup", "home", ".bashrc"), "evil\n");
    fs.writeFileSync(path.join(f.home, ".bashrc"), "tampered-again\n");
    const tampered = await runStdin(["meta-revert", "s1abc", "restore", "home/.bashrc"], baseline, f.env);
    assert.equal(tampered.code, 2);
    assert.match(tampered.stderr, /does not match the baseline|tampered/);
    assert.equal(fs.readFileSync(path.join(f.home, ".bashrc"), "utf8"), "tampered-again\n", "a tampered backup must not be written");
  } finally {
    f.cleanup();
  }
});

test("meta-snapshot records shell files and writes backups under the session dir", async () => {
  const f = fixture();
  try {
    await assertFixtureHome(f);
    fs.writeFileSync(path.join(f.home, ".bashrc"), "export X=1\n");
    fs.mkdirSync(path.join(f.home, ".config", "autostart"), { recursive: true });
    fs.writeFileSync(path.join(f.home, ".config", "autostart", "a.desktop"), "[Desktop Entry]\n");
    const r = await run(["meta-snapshot", "s1abc"], f.env);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.sid, "s1abc");
    assert.equal(typeof j.files[".bashrc"], "string");
    assert.equal(j.files[".profile"], null);
    assert.equal(typeof j.files[".config/autostart/a.desktop"], "string");
    assert.ok(fs.existsSync(path.join(f.meta, "sessions", "s1abc", "backup", "home", ".bashrc")));
    assert.ok(fs.existsSync(path.join(f.meta, "sessions", "s1abc", "snapshot.json")));
    // the integrity hook fails closed without this file: four watched files, one line each
    const base = fs.readFileSync(path.join(f.meta, "sessions", "s1abc", "settings-baseline.sha256"), "utf8");
    assert.equal(base.trim().split("\n").length, 4);
    assert.match(base, /^[0-9a-f]{64}  .*meta-settings\.json$/m);
    assert.ok("crontab" in j && "at" in j && "units" in j);
    assert.equal((await run(["meta-snapshot"], f.env)).code, 2);
    assert.equal((await run(["meta-snapshot", "x", "y"], f.env)).code, 2);
  } finally {
    f.cleanup();
  }
});

test("meta-scopes and meta-integrity take no args; meta-stop wants one sid", async () => {
  const f = fixture();
  try {
    assert.equal((await run(["meta-scopes", "x"], f.env)).code, 2);
    assert.equal((await run(["meta-integrity", "x"], f.env)).code, 2);
    assert.equal((await run(["meta-stop"], f.env)).code, 2);
    assert.equal((await run(["meta-stop", "bad sid!"], f.env)).code, 2);
    const sc = await run(["meta-scopes"], f.env);
    assert.equal(sc.code, 0, sc.stderr);
    const j = JSON.parse(sc.stdout);
    assert.ok(Array.isArray(j.scopes));
  } finally {
    f.cleanup();
  }
});

test("meta-revert stop refuses a unit that was running at snapshot time, not one that merely existed (lucy J8)", async () => {
  const f = fixture();
  try {
    const sdir = path.join(f.meta, "sessions", "s1abc");
    fs.mkdirSync(sdir, { recursive: true });
    const snap = {
      ok: true,
      sid: "s1abc",
      known: { units: true, crontab: true, at: true, files: true },
      units: { files: {}, units: { "busy.service": "active/running", "starting.service": "activating/start", "sleeper.service": "inactive/dead" }, systemctl: true },
      crontab: { available: true, lines: [] },
      at: { available: true, lines: [] },
      files: {},
      present: [],
    };
    fs.writeFileSync(path.join(sdir, "snapshot.json"), JSON.stringify(snap));
    const busy = await runStdin(["meta-revert", "s1abc", "stop", "busy.service"], JSON.stringify(snap), f.env);
    assert.equal(busy.code, 2, busy.stdout + busy.stderr);
    assert.match(busy.stderr + busy.stdout, /was active at snapshot time/);
    const starting = await runStdin(["meta-revert", "s1abc", "stop", "starting.service"], JSON.stringify(snap), f.env);
    assert.equal(starting.code, 2, starting.stdout + starting.stderr);
    assert.match(starting.stderr + starting.stdout, /was active at snapshot time/);
    // inactive before: the guard lets the stop through (systemctl may or may not
    // exist on the test box; what is asserted is that the snapshot rule no longer refuses)
    const sleeper = await runStdin(["meta-revert", "s1abc", "stop", "sleeper.service"], JSON.stringify(snap), f.env);
    assert.ok(!/snapshot time/.test(sleeper.stderr + sleeper.stdout), sleeper.stderr + sleeper.stdout);
  } finally {
    f.cleanup();
  }
});

test("meta-revert stop refuses a terminal scope even when it is new since the snapshot (hq-4npjr.20)", async () => {
  const f = fixture();
  try {
    const sdir = path.join(f.meta, "sessions", "s1abc");
    fs.mkdirSync(sdir, { recursive: true });
    const snap = {
      ok: true,
      sid: "s1abc",
      known: { units: true, crontab: true, at: true, files: true },
      units: { files: {}, units: {}, systemctl: true },
      crontab: { available: true, lines: [] },
      at: { available: true, lines: [] },
      files: {},
      present: [],
    };
    fs.writeFileSync(path.join(sdir, "snapshot.json"), JSON.stringify(snap));
    for (const unit of ["tmux-spawn-4111035a-4253-44cb-8308-a3508773a7bb.scope", "hq-term-tmux.scope"]) {
      const r = await runStdin(["meta-revert", "s1abc", "stop", unit], JSON.stringify(snap), f.env);
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stderr + r.stdout, /terminal scope/);
    }
  } finally {
    f.cleanup();
  }
});
