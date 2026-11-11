# Disk health on hqbox

Two things watch the single NVMe.

`hq-disk-health.timer` takes a S.M.A.R.T. reading every ten minutes and writes
`/var/lib/hq-health/disk.json`. The console's hw.py passes it through, the
Machines tab shows it in the Health card, and the console raises an alert in
Now when the drive's self-check fails, spare capacity hits the drive's floor,
wear passes 90 percent, media errors appear, or the readings stop arriving.

`smartd` (package smartmontools) is the backstop for when the console itself
is down: on a failing health check or a temperature over 80 C it runs
`20hq-notify`, which sends an urgent HQ notification.

## Install or update

```
cd ~/hq/ops/services/disk-health
sudo install -m 755 hq-disk-health.sh /usr/local/sbin/hq-disk-health
sudo install -m 644 hq-disk-health.service hq-disk-health.timer /etc/systemd/system/
sudo install -m 644 smartd.conf /etc/smartd.conf
sudo install -m 755 20hq-notify /etc/smartmontools/run.d/20hq-notify
sudo systemctl daemon-reload
sudo systemctl enable --now hq-disk-health.timer
sudo systemctl restart smartmontools
```

## Check by hand

```
sudo smartctl -H -A /dev/nvme0
cat /var/lib/hq-health/disk.json
```
