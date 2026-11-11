# Monitoring on hqbox

Uptime Kuma: external service checks plus dead-man-switch push monitors for
scheduled jobs, alerting through the ntfy we already run. This is what turns a
silent failure into a phone ping.

## Access

Tailnet only, over HTTPS via `tailscale serve`:

```
https://hqbox.example.ts.net:8443
```

Bound to `127.0.0.1:3001` inside the box; the serve proxy is the only way in.
No LAN listener, nothing public, no tailnet-address bind race at boot.

## Operating it

```
sudo docker compose -f ~/hq/ops/services/monitoring/docker-compose.yml up -d
sudo docker compose -f ~/hq/ops/services/monitoring/docker-compose.yml logs -f
```

The serve route (survives reboots once set):

```
sudo tailscale serve --bg --https=8443 http://127.0.0.1:3001
```

## First-run setup (one time, needs the web UI)

1. Open the URL above, create the admin account (store it in Proton Pass).
2. Add the ntfy notification: Settings, Notifications, type ntfy, the same
   topic notify.sh already posts to.
3. Add monitors. The high-value first set:
   - Minecraft relay: TCP 203.0.113.10:25565 (the public path players use).
   - code-server: HTTP https://hqbox.example.ts.net (needs a monitor that
     follows the tailnet cert, or check 127.0.0.1:8080 from a local agent).
   - The relay VPS ping: 203.0.113.10.
   - Push (dead-man) monitors for the scheduled jobs, so silence pages:
     the vault bridge, git-sync, and (when they land) restic backups each
     curl their Kuma push URL on success; no ping in the window fires ntfy.

Once the admin account exists, these can be seeded programmatically with the
`uptime-kuma-api` Python client instead of by hand; note the account in a
bead and a follow-up can script the whole monitor set.

## Why Uptime Kuma and not the others

Beszel (resource and SMART-disk metrics) is the planned companion, added next;
it catches a dying NVMe on this single-disk box days ahead. Netdata was
rejected (heavier for no gain here), Watchtower is archived. See the homelab
stack plan in the vault for the full reasoning.
