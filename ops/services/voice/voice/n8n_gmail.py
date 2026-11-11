"""Read-only Gmail access to owner@example.com through n8n.

The work mailbox has no password or token of ours; n8n holds its Gmail
OAuth2 credential (BA74UOAI766aWIP5, credentials-map.md). This module puts
up a temporary workflow for the length of one fetch and removes it after:

  Webhook POST (Header Auth, random token)
    -> Plan (Code: accepts only {op: list, pageToken} or {op: get, ids<=25},
       builds gmail.googleapis.com GET urls; nothing else can be asked for)
    -> Gmail (HTTP Request, predefined gmailOAuth2 credential, one GET per item)
    -> Join (Code: all responses in one JSON reply)

Executions are not saved (success, error, manual, progress), so no message
body is stored in n8n. The header token and the workflow live only for the
run; `with WorkProxy() as px:` deletes both even when the fetch fails.
"""

import json
import os
import secrets
import subprocess
import time
import urllib.error
import urllib.request

N8N = os.environ.get("VOICE_N8N_API", "https://orbitacme.app.n8n.cloud/api/v1")
N8N_BASE = N8N.rsplit("/api/", 1)[0]
GMAIL_CRED = {"id": "BA74UOAI766aWIP5", "name": "Gmail OAuth2 API"}
PP_VAULT = "Imported on 2026-07-13 at 14.56.53"
GET_BATCH = 25
TOKEN_HEADER = "X-Voice-Token"

PLAN_JS = r"""
const b = $input.first().json.body || {};
const base = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const ok = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(s);
if (b.op === 'list') {
  let u = base + '?maxResults=500&q=' + encodeURIComponent('in:sent');
  if (b.pageToken !== undefined && b.pageToken !== null) {
    if (!ok(b.pageToken)) throw new Error('bad pageToken');
    u += '&pageToken=' + b.pageToken;
  }
  return [{ json: { url: u } }];
}
if (b.op === 'get') {
  if (!Array.isArray(b.ids) || b.ids.length < 1 || b.ids.length > %d || !b.ids.every(ok))
    throw new Error('bad ids');
  return b.ids.map((id) => ({ json: { url: base + '/' + id + '?format=full' } }));
}
throw new Error('bad op');
""" % GET_BATCH

JOIN_JS = "return [{ json: { items: $input.all().map((i) => i.json) } }];\n"


def workflow(path, token_cred):
    return {
        "name": "Voice: temporary Gmail read (hq-w32vy.1, delete after run)",
        "nodes": [
            {"id": "c0a1e0a0-0001-4c00-8000-000000000001", "name": "Webhook", "type": "n8n-nodes-base.webhook",
             "typeVersion": 2, "position": [0, 0], "webhookId": "c0a1e0a0-0001-4c00-8000-0000000000aa",
             "parameters": {"httpMethod": "POST", "path": path, "authentication": "headerAuth",
                            "responseMode": "lastNode", "options": {}},
             "credentials": {"httpHeaderAuth": token_cred}},
            {"id": "c0a1e0a0-0001-4c00-8000-000000000002", "name": "Plan", "type": "n8n-nodes-base.code",
             "typeVersion": 2, "position": [220, 0], "parameters": {"jsCode": PLAN_JS}},
            {"id": "c0a1e0a0-0001-4c00-8000-000000000003", "name": "Gmail", "type": "n8n-nodes-base.httpRequest",
             "typeVersion": 4.2, "position": [440, 0],
             "parameters": {"method": "GET", "url": "={{ $json.url }}",
                            "authentication": "predefinedCredentialType", "nodeCredentialType": "gmailOAuth2",
                            "options": {"timeout": 60000}},
             "credentials": {"gmailOAuth2": GMAIL_CRED}},
            {"id": "c0a1e0a0-0001-4c00-8000-000000000004", "name": "Join", "type": "n8n-nodes-base.code",
             "typeVersion": 2, "position": [660, 0], "parameters": {"jsCode": JOIN_JS}},
        ],
        "connections": {
            "Webhook": {"main": [[{"node": "Plan", "type": "main", "index": 0}]]},
            "Plan": {"main": [[{"node": "Gmail", "type": "main", "index": 0}]]},
            "Gmail": {"main": [[{"node": "Join", "type": "main", "index": 0}]]},
        },
        "settings": {"executionOrder": "v1", "saveDataSuccessExecution": "none", "saveDataErrorExecution": "none",
                     "saveManualExecutions": False, "saveExecutionProgress": False},
    }


def _api_key():
    out = subprocess.run(["pp", "item", "view", "--vault-name", PP_VAULT, "--item-title", "n8n API",
                          "--field", "API Key"], capture_output=True, text=True, timeout=60,
                         env={**os.environ, "PROTON_PASS_AGENT_REASON": "voice profile work mail read hq-w32vy.1"})
    key = out.stdout.strip()
    if out.returncode or not key:
        raise RuntimeError("n8n API key not readable from Proton Pass")
    return key


def _call(method, url, headers, body=None, timeout=180):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={**headers, "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        # The error text can quote a Gmail reply; keep only the status.
        raise RuntimeError("%s %s -> HTTP %s" % (method, url.split("?")[0].rsplit("/", 2)[-2:], e.code)) from None
    return json.loads(raw) if raw else {}


class WorkProxy:
    def __init__(self, api_key=None):
        self.key = api_key or _api_key()
        self.h = {"X-N8N-API-KEY": self.key}
        self.token = secrets.token_urlsafe(32)
        self.path = "voice-read-" + secrets.token_hex(8)
        self.cred_id = self.wf_id = None

    def __enter__(self):
        cred = _call("POST", N8N + "/credentials", self.h, {
            "name": "Voice temporary read token (hq-w32vy.1)", "type": "httpHeaderAuth",
            "data": {"name": TOKEN_HEADER, "value": self.token}})
        self.cred_id = cred["id"]
        wf = _call("POST", N8N + "/workflows", self.h,
                   workflow(self.path, {"id": self.cred_id, "name": cred.get("name", "")}))
        self.wf_id = wf["id"]
        _call("POST", "%s/workflows/%s/activate" % (N8N, self.wf_id), self.h, {})
        time.sleep(2)
        return self

    def __exit__(self, *exc):
        errors = []
        if self.wf_id:
            for verb, suffix in (("POST", "/deactivate"), ("DELETE", "")):
                try:
                    _call(verb, "%s/workflows/%s%s" % (N8N, self.wf_id, suffix), self.h, {} if verb == "POST" else None)
                except Exception as e:  # keep going: the delete matters most
                    errors.append(str(e))
        if self.cred_id:
            try:
                _call("DELETE", "%s/credentials/%s" % (N8N, self.cred_id), self.h)
            except Exception as e:
                errors.append(str(e))
        if errors:
            print("voice: n8n cleanup problem, remove by hand: workflow %s credential %s (%s)"
                  % (self.wf_id, self.cred_id, "; ".join(errors)))
        return False

    def ask(self, body, tries=3):
        url = "%s/webhook/%s" % (N8N_BASE, self.path)
        for i in range(tries):
            try:
                return _call("POST", url, {TOKEN_HEADER: self.token}, body, timeout=300)
            except RuntimeError:
                if i == tries - 1:
                    raise
                time.sleep(5 * (i + 1))

    def list_sent_ids(self):
        ids, token = [], None
        while True:
            r = self.ask({"op": "list", "pageToken": token})
            page = (r.get("items") or [{}])[0]
            ids += [m["id"] for m in page.get("messages") or []]
            token = page.get("nextPageToken")
            if not token:
                return ids

    def get(self, ids):
        r = self.ask({"op": "get", "ids": list(ids)})
        got = r.get("items") or []
        if len(got) != len(ids) or any("payload" not in g for g in got):
            raise RuntimeError("n8n returned %d of %d messages" % (len(got), len(ids)))
        return got
