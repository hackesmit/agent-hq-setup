// The sealed-approval flow over real HTTP (COMPILATION-v2 item 20).
//
// finish-approval.test.js proves the verb refuses correctly when called directly. This
// proves the same thing through the router, the op store and the poll the browser
// actually performs, because the gap that matters is between two HTTP calls minutes
// apart, not between two function calls.
//
// Every test closes its app in a finally. The harness listens on a real socket, so a
// missed close does not fail the test, it hangs the whole run.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestApp } from "./helpers.js";

/**
 * A realistic gate reading. `ctl.sh finish-check` emits JSON carrying the branch head,
 * and `ok` is only true when the recorded approval marker equals that head, which is why
 * a new commit invalidates an outstanding approval: the reading itself changes.
 */
const reading = (head = "a".repeat(40)) => JSON.stringify({ bead: "hq-1", ok: true, head, reason: "approved" });

/** A console whose shell-outs always succeed and echo one gate reading. */
const gateApp = (stdout = reading()) => startTestApp({ runner: async () => ({ code: 0, stdout, stderr: "" }) });

/** Run a verb and poll its op the way the web client does, returning the settled record. */
async function settle(t, urlPath, body) {
  const started = await t.request("POST", urlPath, { body, headers: { "x-console-key": t.key } });
  if (started.status !== 202) return { started, op: null };
  let op = started.json;
  for (let i = 0; i < 200 && op && op.state !== "done" && op.state !== "failed"; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
    const polled = await t.request("GET", `/api/op/${started.json.id}`);
    if (polled.json) op = polled.json;
  }
  return { started, op };
}

const post = (t, urlPath, body) => t.request("POST", urlPath, { body, headers: { "x-console-key": t.key } });

test("the happy path: read the gate, then confirm with what it produced", async () => {
  const t = await gateApp();
  try {
    const { op } = await settle(t, "/api/session/t-1/finish-check", {});
    assert.equal(op.state, "done");
    assert.equal(typeof op.seal, "string", "a settled finish-check hands the browser an approval");
    const confirmed = await post(t, "/api/session/t-1/finish", { confirm: true, approvedOp: op.id, seal: op.seal });
    assert.equal(confirmed.status, 202, confirmed.text);
  } finally {
    await t.close();
  }
});

test("a confirmation with no approval is refused over HTTP", async () => {
  const t = await gateApp();
  try {
    const r = await post(t, "/api/session/t-1/finish", { confirm: true });
    assert.equal(r.status, 400, r.text);
    assert.match(String(r.json && r.json.error), /approved op/i);
  } finally {
    await t.close();
  }
});

test("the same approval cannot be spent twice over HTTP", async () => {
  const t = await gateApp();
  try {
    const { op } = await settle(t, "/api/session/t-1/finish-check", {});
    const body = { confirm: true, approvedOp: op.id, seal: op.seal };
    assert.equal((await post(t, "/api/session/t-1/finish", body)).status, 202);
    const second = await post(t, "/api/session/t-1/finish", body);
    assert.equal(second.status, 409, second.text);
    assert.match(String(second.json.error), /already used once/);
  } finally {
    await t.close();
  }
});

test("an approval from one session cannot finish another", async () => {
  const t = await gateApp();
  try {
    const { op } = await settle(t, "/api/session/t-1/finish-check", {});
    const r = await post(t, "/api/session/t-2/finish", { confirm: true, approvedOp: op.id, seal: op.seal });
    assert.equal(r.status, 409, r.text);
  } finally {
    await t.close();
  }
});

test("the dry finish still needs no approval, so the plan stays one click", async () => {
  const t = await gateApp();
  try {
    const r = await post(t, "/api/session/t-1/finish", {});
    assert.equal(r.status, 202, r.text);
  } finally {
    await t.close();
  }
});

test("a rejected seal does not spend the genuine one", async () => {
  const t = await gateApp();
  try {
    const { op } = await settle(t, "/api/session/t-1/finish-check", {});
    for (const seal of ["", "nope", "s1.0.0", null]) {
      const r = await post(t, "/api/session/t-1/finish", { confirm: true, approvedOp: op.id, seal });
      assert.ok(r.status === 409 || r.status === 400, `seal ${JSON.stringify(seal)} gave ${r.status}`);
    }
    const good = await post(t, "/api/session/t-1/finish", { confirm: true, approvedOp: op.id, seal: op.seal });
    assert.equal(good.status, 202, good.text);
  } finally {
    await t.close();
  }
});
