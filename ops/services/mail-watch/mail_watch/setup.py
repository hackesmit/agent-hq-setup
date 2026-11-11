"""Provision, update or remove the n8n side of the watcher. Idempotent.

  python3 -m mail_watch.setup            # create what is missing, update the rest, activate
  python3 -m mail_watch.setup --rotate   # new proxy token (old credential deleted)
  python3 -m mail_watch.setup --status
  python3 -m mail_watch.setup --remove   # delete both workflows, the token credential and the table

Writes ~/.config/mail-watch/env (0600): the proxy path and token, and the ids.
"""

import argparse
import secrets
import time

from . import config, n8n


def write_env(env):
    lines = ["# mail-watch n8n wiring (hq-w32vy.2); written by mail_watch.setup. Secret: do not copy."]
    lines += ["%s=%s" % (k, env[k]) for k in sorted(env)]
    config.write_private(config.ENV_FILE, "\n".join(lines) + "\n")


def find_table(api):
    for t in api.call("GET", "/data-tables?limit=100").get("data") or []:
        if t.get("name") == n8n.TABLE_NAME:
            return t["id"]
    return None


def ensure_table(api):
    tid = find_table(api)
    if tid:
        return tid
    return api.call("POST", "/data-tables", {"name": n8n.TABLE_NAME, "columns": [
        {"name": "msg_id", "type": "string"}, {"name": "thread_id", "type": "string"}]})["id"]


def new_cred(api, token):
    c = api.call("POST", "/credentials", {"name": n8n.CRED_NAME, "type": "httpHeaderAuth",
                                          "data": {"name": n8n.TOKEN_HEADER, "value": token}})
    return c["id"]


def upsert_workflow(api, wf_id, body):
    if wf_id:
        try:
            api.call("GET", "/workflows/%s" % wf_id)
        except RuntimeError:
            wf_id = None
    if wf_id:
        api.call("PUT", "/workflows/%s" % wf_id, body)
    else:
        wf_id = api.call("POST", "/workflows", body)["id"]
    api.call("POST", "/workflows/%s/activate" % wf_id, {})
    return wf_id


def provision(rotate=False):
    api = n8n.Api()
    env = config.read_env()
    env["MW_TABLE"] = ensure_table(api)
    old_cred = None
    if rotate or not (env.get("MW_TOKEN") and env.get("MW_CRED")):
        old_cred = env.get("MW_CRED")
        env["MW_TOKEN"] = secrets.token_urlsafe(32)
        env["MW_CRED"] = new_cred(api, env["MW_TOKEN"])
    env.setdefault("MW_PATH", "mail-watch-" + secrets.token_hex(10))
    # Save before the workflow calls: a crash after this point leaves ids we can clean up.
    write_env(env)
    env["MW_PROXY_WF"] = upsert_workflow(api, env.get("MW_PROXY_WF"), n8n.proxy_workflow(
        env["MW_PATH"], {"id": env["MW_CRED"], "name": n8n.CRED_NAME}))
    write_env(env)
    env["MW_TRIGGER_WF"] = upsert_workflow(api, env.get("MW_TRIGGER_WF"), n8n.trigger_workflow(env["MW_TABLE"]))
    write_env(env)
    if old_cred and old_cred != env["MW_CRED"]:
        try:
            api.call("DELETE", "/credentials/%s" % old_cred)
        except RuntimeError as e:
            print("mail-watch: old token credential %s not deleted (%s)" % (old_cred, e))
    time.sleep(2)
    return env


def status():
    api, env = n8n.Api(), config.read_env()
    if not env:
        print("mail-watch: not set up (%s missing)" % config.ENV_FILE)
        return 1
    for k in ("MW_TRIGGER_WF", "MW_PROXY_WF"):
        print("%s %s active=%s" % (k, env.get(k), api.workflow_active(env[k]) if env.get(k) else None))
    print("queued rows: %d" % len(api.rows(env["MW_TABLE"])))
    return 0


def remove():
    api, env = n8n.Api(), config.read_env()
    errors = []
    for k in ("MW_TRIGGER_WF", "MW_PROXY_WF"):
        if env.get(k):
            for verb, suffix in (("POST", "/deactivate"), ("DELETE", "")):
                try:
                    api.call(verb, "/workflows/%s%s" % (env[k], suffix), {} if verb == "POST" else None)
                except RuntimeError as e:
                    errors.append(str(e))
    for k, path in (("MW_CRED", "/credentials/%s"), ("MW_TABLE", "/data-tables/%s")):
        if env.get(k):
            try:
                api.call("DELETE", path % env[k])
            except RuntimeError as e:
                errors.append(str(e))
    if errors:
        print("mail-watch: cleanup problems, remove by hand: %s" % "; ".join(errors))
        return 1
    config.ENV_FILE.unlink(missing_ok=True)
    print("mail-watch: n8n side removed")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="mail_watch.setup")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--rotate", action="store_true")
    g.add_argument("--status", action="store_true")
    g.add_argument("--remove", action="store_true")
    a = ap.parse_args(argv)
    if a.status:
        return status()
    if a.remove:
        return remove()
    env = provision(rotate=a.rotate)
    print("mail-watch: trigger %s, proxy %s, table %s (env %s)"
          % (env["MW_TRIGGER_WF"], env["MW_PROXY_WF"], env["MW_TABLE"], config.ENV_FILE))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
