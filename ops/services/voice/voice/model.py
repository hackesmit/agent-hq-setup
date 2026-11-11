"""Model calls: `claude -p` with no tools, a JSON schema, and a hard spend cap.

Same boundary as ops/security/news.sh: no tools, no MCP, no settings, no
session file; mail text goes in on stdin between nonce markers and the
system prompt says that text is data. The CLI reports total_cost_usd per
call (API list price); Budget adds it up and refuses a call that could
take the run over the cap.
"""

import json
import os
import secrets
import subprocess
import tempfile
import threading

CLAUDE = os.environ.get("VOICE_CLAUDE", "claude")
HAIKU = "claude-haiku-5-5"
OPUS = "claude-opus-5-5"
# USD per million tokens (input, output); claude-api skill table, cached 2026-10-06.
PRICE = {HAIKU: (0.10, 0.50), OPUS: (4.00, 20.00)}
CALL_OVERHEAD_TOKENS = 4000  # the CLI's own system text, measured 2026-11-04


class OverBudget(RuntimeError):
    pass


class ModelError(RuntimeError):
    pass


def est_tokens(chars):
    return int(chars / 3.2) + 1


def est_cost(model, in_chars, out_tokens):
    pi, po = PRICE[model]
    return ((est_tokens(in_chars) + CALL_OVERHEAD_TOKENS) * pi + out_tokens * po) / 1e6


class Budget:
    def __init__(self, cap_usd):
        self.cap, self.spent, self.reserved = cap_usd, 0.0, 0.0
        self.calls, self.tokens_in, self.tokens_out = 0, 0, 0
        self.lock = threading.Lock()

    def reserve(self, amount):
        with self.lock:
            if self.spent + self.reserved + amount > self.cap:
                raise OverBudget("next call would pass the cap: spent %.4f + pending %.4f + %.4f > %.2f USD"
                                 % (self.spent, self.reserved, amount, self.cap))
            self.reserved += amount

    def settle(self, reserved, actual, usage):
        with self.lock:
            self.reserved -= reserved
            self.spent += actual
            self.calls += 1
            self.tokens_in += sum(usage.get(k) or 0 for k in
                                  ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
            self.tokens_out += usage.get("output_tokens") or 0

    def line(self):
        return "calls %d, tokens in %d out %d, cost %.4f USD of cap %.2f" % (
            self.calls, self.tokens_in, self.tokens_out, self.spent, self.cap)


def fence(blocks):
    """Wrap untrusted text in nonce markers; returns (begin, end, text)."""
    nonce = secrets.token_hex(8)
    begin, end = "MAIL-%s-BEGIN" % nonce, "MAIL-%s-END" % nonce
    body = "\n".join(b.replace(nonce, "") for b in blocks)
    return begin, end, "%s\n%s\n%s" % (begin, body, end)


def run(model, system, prompt, schema, budget, out_tokens, effort=None, timeout=900):
    """One structured call. Returns structured_output (a dict)."""
    reserve = est_cost(model, len(system) + len(prompt), out_tokens) * 1.5
    budget.reserve(reserve)
    actual, usage = reserve, {}
    try:
        with tempfile.TemporaryDirectory(prefix="voice-") as cwd:
            os.chmod(cwd, 0o700)
            cmd = [CLAUDE, "-p", "--tools", "", "--strict-mcp-config", "--setting-sources", "",
                   "--no-session-persistence", "--model", model, "--output-format", "json",
                   "--system-prompt", system, "--json-schema", json.dumps(schema)]
            if effort:
                cmd += ["--effort", effort]
            p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, cwd=cwd, timeout=timeout,
                               env={**os.environ, "HQ_SESSION_EVAL": "1"})
        try:
            ans = json.loads(p.stdout)
        except ValueError:
            raise ModelError("model run failed (rc %s, no JSON)" % p.returncode) from None
        actual = float(ans.get("total_cost_usd") or reserve)
        usage = ans.get("usage") or {}
        if p.returncode or ans.get("is_error") or not isinstance(ans.get("structured_output"), dict):
            raise ModelError("model run failed (rc %s, subtype %s)" % (p.returncode, ans.get("subtype")))
        return ans["structured_output"]
    finally:
        budget.settle(reserve, actual, usage)
