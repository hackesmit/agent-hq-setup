# restic backup of hqbox

Encrypted restic snapshots of hqbox, stored on George (the desktop) at
`C:\Users\owner\Backups\hqbox-restic`, reached over sftp with the same key the
`/mnt/george` mount uses. This is a second machine, not an offsite copy: both
boxes sit in the same house.

## What runs

`hq-restic-backup.timer` (system unit) fires hourly. The script exits at once
when the last snapshot is under 20 hours old and skips quietly when George is
asleep. Retention: 7 daily, 4 weekly, 6 monthly. `restic check` on Sundays.

Every run writes `/var/lib/hq-health/backup.json`. The console shows it in the
Health card on the Machines tab and raises an alert in Now when no snapshot
has succeeded for 48 hours.

Covered paths are in `include.txt`, left-out paths in `exclude.txt`.
`required.txt` lists what must stay covered (the HQ state, the beads Dolt
dir, the vault, the Supabase dumps). `coverage-check.sh` proves it with restic
itself: a `backup --dry-run` of each required path into a throwaway local
repository, with the real exclude file, must save every file under it
(cache-tagged dirs such as uv venvs and rebuildable names excepted). To check
the installed lists, copy them readable first:
`sudo cat /etc/restic/include.txt >/tmp/inc; sudo cat /etc/restic/exclude.txt >/tmp/exc; ./coverage-check.sh /tmp/inc /tmp/exc`.
`tests/coverage-check.test.sh` gates changes.

## Install or update

```
cd ~/hq/ops/services/restic-backup
sudo install -D -m 755 hq-restic-backup.sh /usr/local/sbin/hq-restic-backup
sudo install -D -m 644 include.txt exclude.txt -t /etc/restic/
sudo install -m 644 hq-restic-backup.service hq-restic-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now hq-restic-backup.timer
```

## Use

```
sudo /usr/local/sbin/hq-restic-backup --force     # back up now
sudo journalctl -u hq-restic-backup -n 50         # last runs
```

Listing and restoring (as root, so the password file is readable):

```
export RESTIC_REPOSITORY=sftp:owner@george:/C:/Users/owner/Backups/hqbox-restic
export RESTIC_PASSWORD_FILE=/etc/restic/hqbox.pass
SFTP='sftp.command=ssh -i /home/owner/.ssh/id_ed25519_george -o UserKnownHostsFile=/home/owner/.ssh/known_hosts owner@george -s sftp'
restic -o "$SFTP" snapshots
restic -o "$SFTP" restore latest --target /tmp/restore --include /srv/minecraft/data
```

The repository password is in `/etc/restic/hqbox.pass` and in Proton Pass
(Personal / "Repo Password"). If hqbox's disk dies, the Proton Pass
copy is the only way to read the snapshots.
