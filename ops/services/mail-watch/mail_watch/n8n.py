"""The work mailbox through n8n, without spending its execution quota on polling.

Measured 2026-11-04: the work inbox gets about 133 mails in 30 days and the
n8n instance already runs about 1,500 executions a month. A webhook poll
every 5 minutes would add about 8,600 a month, so the design is:

  "Mail watch: work inbox trigger" (persistent)
    Gmail Trigger (every 5 min, INBOX, read or unread) -> Code (id and
    threadId only) -> Data Table insert. A poll that finds nothing starts
    no execution, so this costs about one execution per new mail.
  hqbox reads and deletes the table rows through the public API (no
  execution), then calls
  "Mail watch: work Gmail proxy" (persistent)
    Webhook (Header Auth) -> Plan (Code: get <= 25 messages, or create one
    draft; nothing else can be built) -> Gmail HTTP (credential
    BA74UOAI766aWIP5) -> Join.

Neither workflow saves execution data, so no mail text is stored in n8n.
The proxy cannot send: its Plan node only builds messages.get and
drafts.create URLs. The header token lives only in ~/.config/mail-watch/env.
"""

import json
import urllib.parse

from . import config
from voice.n8n_gmail import GMAIL_CRED, N8N, N8N_BASE, _api_key, _call  # noqa: E402

TOKEN_HEADER = "X-Mail-Watch-Token"
GET_BATCH = 25
TABLE_NAME = "mail_watch_work_inbox"
TRIGGER_NAME = "Mail watch: work inbox trigger (hq-w32vy.2)"
PROXY_NAME = "Mail watch: work Gmail proxy, drafts only (hq-w32vy.2)"
CRED_NAME = "Mail watch proxy token (hq-w32vy.2)"
NO_SAVE = {"executionOrder": "v1", "saveDataSuccessExecution": "none", "saveDataErrorExecution": "none",
           "saveManualExecutions": False, "saveExecutionProgress": False}

PLAN_JS = r"""
const b = $input.first().json.body || {};
const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
const ok = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(s);
if (b.op === 'get') {
  if (!Array.isArray(b.ids) || b.ids.length < 1 || b.ids.length > %d || !b.ids.every(ok))
    throw new Error('bad ids');
  return b.ids.map((id) => ({ json: { method: 'GET', url: base + '/messages/' + id + '?format=full', body: {} } }));
}
if (b.op === 'draft') {
  if (!ok(b.threadId)) throw new Error('bad threadId');
  if (typeof b.raw !== 'string' || b.raw.length > 3000000 || !/^[A-Za-z0-9_=-]+$/.test(b.raw))
    throw new Error('bad raw');
  return [{ json: { method: 'POST', url: base + '/drafts', body: { message: { threadId: b.threadId, raw: b.raw } } } }];
}
throw new Error('bad op');
""" % GET_BATCH

JOIN_JS = "return [{ json: { items: $input.all().map((i) => i.json) } }];\n"
IDS_JS = ("return $input.all().filter((i) => i.json.id)"
          ".map((i) => ({ json: { msg_id: String(i.json.id), thread_id: String(i.json.threadId || i.json.id) } }));\n")


def _col(name):
    return {"id": name, "displayName": name, "required": False, "defaultMatch": False, "display": True,
            "type": "string", "canBeUsedToMatch": True}


def trigger_workflow(table_id):
    return {
        "name": TRIGGER_NAME,
        "nodes": [
            {"id": "d1a2e0a0-0002-4c00-8000-000000000001", "name": "New inbox mail", "type": "n8n-nodes-base.gmailTrigger",
             "typeVersion": 1.2, "position": [0, 0],
             "parameters": {"pollTimes": {"item": [{"mode": "everyX", "value": 5, "unit": "minutes"}]},
                            "simple": True,
                            "filters": {"labelIds": ["INBOX"], "readStatus": "both", "includeSpamTrash": False,
                                        "includeDrafts": False},
                            "options": {}},
             "credentials": {"gmailOAuth2": GMAIL_CRED}},
            {"id": "d1a2e0a0-0002-4c00-8000-000000000002", "name": "Ids only", "type": "n8n-nodes-base.code",
             "typeVersion": 2, "position": [220, 0], "parameters": {"jsCode": IDS_JS}},
            {"id": "d1a2e0a0-0002-4c00-8000-000000000003", "name": "Queue", "type": "n8n-nodes-base.dataTable",
             "typeVersion": 1, "position": [440, 0],
             "parameters": {"resource": "row", "operation": "insert",
                            "dataTableId": {"__rl": True, "mode": "id", "value": table_id},
                            "columns": {"mappingMode": "defineBelow",
                                        "value": {"msg_id": "={{ $json.msg_id }}", "thread_id": "={{ $json.thread_id }}"},
                                        "matchingColumns": [], "schema": [_col("msg_id"), _col("thread_id")]},
                            "options": {}}},
        ],
        "connections": {
            "New inbox mail": {"main": [[{"node": "Ids only", "type": "main", "index": 0}]]},
            "Ids only": {"main": [[{"node": "Queue", "type": "main", "index": 0}]]},
        },
        "settings": dict(NO_SAVE),
    }


def proxy_workflow(path, token_cred):
    return {
        "name": PROXY_NAME,
        "nodes": [
            {"id": "d1a2e0a0-0003-4c00-8000-000000000001", "name": "Webhook", "type": "n8n-nodes-base.webhook",
             "typeVersion": 2, "position": [0, 0], "webhookId": "d1a2e0a0-0003-4c00-8000-0000000000aa",
             "parameters": {"httpMethod": "POST", "path": path, "authentication": "headerAuth",
                            "responseMode": "lastNode", "options": {}},
             "credentials": {"httpHeaderAuth": token_cred}},
            {"id": "d1a2e0a0-0003-4c00-8000-000000000002", "name": "Plan", "type": "n8n-nodes-base.code",
             "typeVersion": 2, "position": [220, 0], "parameters": {"jsCode": PLAN_JS}},
            {"id": "d1a2e0a0-0003-4c00-8000-000000000003", "name": "Gmail", "type": "n8n-nodes-base.httpRequest",
             "typeVersion": 4.2, "position": [440, 0],
             "parameters": {"method": "={{ $json.method }}", "url": "={{ $json.url }}",
                            "authentication": "predefinedCredentialType", "nodeCredentialType": "gmailOAuth2",
                            "sendBody": True, "specifyBody": "json",
                            "jsonBody": "={{ JSON.stringify($json.body) }}",
                            "options": {"timeout": 60000}},
             "credentials": {"gmailOAuth2": GMAIL_CRED}},
            {"id": "d1a2e0a0-0003-4c00-8000-000000000004", "name": "Join", "type": "n8n-nodes-base.code",
             "typeVersion": 2, "position": [660, 0], "parameters": {"jsCode": JOIN_JS}},
        ],
        "connections": {
            "Webhook": {"main": [[{"node": "Plan", "type": "main", "index": 0}]]},
            "Plan": {"main": [[{"node": "Gmail", "type": "main", "index": 0}]]},
            "Gmail": {"main": [[{"node": "Join", "type": "main", "index": 0}]]},
        },
        "settings": dict(NO_SAVE),
    }


class Api:
    """n8n public API calls; none of these start an execution."""

    def __init__(self, key=None):
        self.h = {"X-N8N-API-KEY": key or _api_key()}

    def call(self, method, path, body=None):
        return _call(method, N8N + path, self.h, body)

    def rows(self, table_id, limit=250):
        out, cursor = [], None
        while True:
            q = "?limit=%d" % limit + ("&cursor=" + urllib.parse.quote(cursor) if cursor else "")
            r = self.call("GET", "/data-tables/%s/rows%s" % (table_id, q))
            out += r.get("data") or []
            cursor = r.get("nextCursor")
            if not cursor:
                return out

    def delete_rows(self, table_id, msg_id):
        f = json.dumps({"type": "and", "filters": [{"columnName": "msg_id", "condition": "eq", "value": msg_id}]})
        return self.call("DELETE", "/data-tables/%s/rows/delete?filter=%s" % (table_id, urllib.parse.quote(f)))

    def workflow_active(self, wf_id):
        return bool(self.call("GET", "/workflows/%s" % wf_id).get("active"))


class Proxy:
    def __init__(self, path, token):
        self.url = "%s/webhook/%s" % (N8N_BASE, path)
        self.h = {TOKEN_HEADER: token}

    def get(self, ids):
        ids = list(ids)
        r = _call("POST", self.url, self.h, {"op": "get", "ids": ids}, timeout=300)
        got = r.get("items") or []
        if len(got) != len(ids) or any("payload" not in g for g in got):
            raise RuntimeError("n8n returned %d of %d messages" % (len(got), len(ids)))
        return got

    def draft(self, thread_id, raw):
        r = _call("POST", self.url, self.h, {"op": "draft", "threadId": thread_id, "raw": raw}, timeout=120)
        got = (r.get("items") or [{}])[0]
        if not got.get("id"):
            raise RuntimeError("n8n draft call returned no draft id")
        return got["id"]
