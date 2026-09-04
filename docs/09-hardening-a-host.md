# 09 - Hardening a host

`08-self-hosting.md` gets an instance running. This is about the machine under
it: what a small rented server needs so that it patches itself, reboots itself
when a kernel demands it, comes back on its own, refuses everything that was not
deliberately opened, and keeps its one irreplaceable asset, the database,
somewhere else every day.

It is written from the reference instance, a Debian 13 VPS at OVH with 2 vCPU,
3.7 GB of RAM and 40 GB of disk, hardened on 2 September 2026 and verified by
rebooting it. Every configuration block below is what runs there. Names are
Debian's; another distribution needs the same ideas with different paths.

The reader is assumed to be new to running servers. Where a step can lock you
out, it says so and gives the way back.

---

## 1. What the machine looks like afterwards

| Layer | What is in place | Why |
|---|---|---|
| SSH | Keys only, root login off, one allowed account, fail2ban | The key is the whole lock, so the door around it should be small |
| Firewall | ufw: 22, 80, 443 in, nothing else | Everything else is reachable only on loopback |
| Docker | `live-restore`, published ports default to loopback, log caps | Docker bypasses ufw for published ports; an upgrade of Docker should not be an outage |
| Updates | Debian security and stable, plus Caddy, install themselves; services restart; the box reboots at 05:00 UTC when a kernel is waiting | Nobody remembers to patch a household server |
| Disk | Container logs capped, journal capped, untagged images pruned weekly | On the smallest VPS the disk fills before anything else fails |
| Backups | Nightly dump on the server, pulled every morning to a workstation | A dump beside its database is not a backup |
| Proxy | Caddy on the host, one site block per hostname | One pair of ports can serve several sites |

---

## 2. SSH

### Keys only, and where that setting really lives

A cloud image is delivered with password login off in `sshd_config` and, on this
one, turned back on by `/etc/ssh/sshd_config.d/50-cloud-init.conf`. sshd reads
`Include /etc/ssh/sshd_config.d/*.conf` at the top of its main file and keeps
the **first** value it meets for any keyword, so a drop-in wins over the main
file, and among drop-ins the lexically first wins. That has two consequences:

- Never trust a config file to tell you what is in force. Ask sshd:
  `sudo sshd -T | grep -i passwordauthentication`.
- To own a setting for good, put it in a drop-in that sorts before every other.

The reference host has this as `/etc/ssh/sshd_config.d/10-hardening.conf`:

```
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
# root has no password and an empty authorized_keys. Say so explicitly.
PermitRootLogin no
# Only this account may log in at all. Add a name here before creating a user.
AllowUsers debian
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 30
```

`AllowUsers` is the line to remember when you add an account later: a user not
named there cannot log in, however good their key.

### Changing sshd without locking yourself out

Any edit to sshd is a chance to lose the only way in. The safe sequence:

```sh
sudo sshd -t                                   # syntax check, before anything else
sudo systemd-run --unit=sshd-revert --on-active=240 \
  /bin/sh -c 'rm -f /etc/ssh/sshd_config.d/10-hardening.conf && systemctl reload ssh'
sudo systemctl reload ssh
```

Then, **from a new terminal**, log in again. If it works:

```sh
sudo systemctl stop sshd-revert.timer          # cancel the revert
```

If it does not, do nothing: four minutes later the drop-in is removed and sshd
reloaded, and the old configuration is back. A reload never drops the session
you are already in, so the first terminal stays usable throughout.

### fail2ban

A key-only host is not at risk from password guessing, but the guessing still
arrives. The reference host saw 269 failed attempts in its first day, and the
noise buries anything real in the log. fail2ban bans the source after a few
tries.

Two things are specific to Debian 13. It ships no rsyslog, so there is no
`/var/log/auth.log` for the default backend to read: fail2ban has to read the
journal. And with passwords off, a bot never produces a `Failed password` line,
only a pre-authentication disconnect, which the default filter ignores.
`mode = aggressive` counts those.

```sh
sudo apt install fail2ban
```

`/etc/fail2ban/jail.local` (never edit `jail.conf`, a package upgrade replaces it):

```ini
[DEFAULT]
backend = systemd
# Loopback, plus the address you administer from. A home address changes, so
# this is a courtesy, not a guarantee.
ignoreip = 127.0.0.1/8 ::1
bantime = 1h
findtime = 10m
maxretry = 5
# Repeat offenders stay out longer each time, up to a week.
bantime.increment = true
bantime.maxtime = 1w

[sshd]
enabled = true
mode = aggressive
```

```sh
sudo systemctl enable --now fail2ban
sudo fail2ban-client status sshd                    # counts and the banned list
sudo fail2ban-client set sshd unbanip 203.0.113.7   # let one address back in
```

It banned its first bot within minutes of starting. If you ever ban yourself:
wait an hour, or open the KVM console in the provider's control panel and run
the unban from there. Successful key logins never count against you, so this
takes a run of failures from your own address, which with `IdentitiesOnly yes`
in your ssh config does not happen by accident.

---

## 3. The firewall, and the hole Docker makes in it

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp        # HTTP/3
sudo ufw enable
```

Note that ufw's own systemd unit can show `inactive` when ufw was enabled after
boot, even though the rules are loaded. `sudo systemctl start ufw` makes the two
agree, and with `ENABLED=yes` in `/etc/ufw/ufw.conf` the rules load at every boot.

**Docker does not go through ufw.** A container port published on `0.0.0.0` is
reachable from the internet whatever the firewall says, because Docker writes
its own rules ahead of ufw's. `compose.yaml` publishes on `127.0.0.1` explicitly
for that reason. The daemon setting in section 4 makes loopback the default for
anything else, so a `docker run -p 8080:80` typed in a hurry stays private.

Two small extras, both about not listening where nothing is expected.
systemd-resolved answers LLMNR and mDNS on port 5355 on every interface by
default, which is for LANs and this host has none:

```ini
# /etc/systemd/resolved.conf.d/10-no-llmnr.conf
[Resolve]
LLMNR=no
MulticastDNS=no
```

And a few kernel settings, `/etc/sysctl.d/60-hardening.conf`. `ip_forward` is
deliberately absent: Docker needs it on and manages it itself.

```
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
# Loose reverse-path filtering. 1 (strict) can drop traffic on the asymmetric
# routes Docker bridges create; 2 still refuses obviously spoofed packets.
net.ipv4.conf.all.rp_filter = 2
net.ipv4.conf.default.rp_filter = 2
kernel.kptr_restrict = 2
```

`sudo sysctl --system` applies it; the resolved file takes effect at the next
restart of the service or the next boot.

---

## 4. Docker daemon defaults

`/etc/docker/daemon.json`:

```json
{
  "live-restore": true,
  "ip": "127.0.0.1",
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
```

- `live-restore`: containers keep running while the Docker daemon itself
  restarts or is upgraded. Without it, every `apt upgrade` that touches
  `docker-ce` stops the site.
- `ip`: the default address for published ports, as explained in section 3.
- `log-*`: the same cap `compose.yaml` sets per service, for anything started
  outside Compose.

`sudo systemctl restart docker` applies it. That one restart is the last time the
containers go down with the daemon, since live-restore is not yet on when it
runs; they come back on their own under `restart: unless-stopped`. Confirm with
`docker info --format '{{.LiveRestoreEnabled}}'`.

---

## 5. Updates that apply themselves

Debian's `unattended-upgrades` is installed and on by default in the cloud
image, with a scope worth knowing: Debian security and Debian stable, nothing
from third-party repositories, and no reboot ever. On this host two of those
repositories matter. Caddy faces the internet and should be patched without
anyone remembering to. Docker CE is deliberately left manual: a container engine
upgrade is worth doing with eyes on it, once a month, and with live-restore it
costs no downtime.

A new file rather than an edit, because a list block in a second file appends to
the shipped one. `/etc/apt/apt.conf.d/52unattended-upgrades-local`:

```
Unattended-Upgrade::Origins-Pattern {
        // Point-release updates that are not security fixes (tzdata and the like).
        "origin=Debian,codename=${distro_codename}-updates";
        // Caddy faces the internet. Docker CE is NOT here on purpose.
        "origin=cloudsmith/caddy/stable";
};

Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";

// A kernel update is inert until the box reboots. Reboot at 05:00 UTC when one
// is pending, after the 04:17 database dump, and never while someone is logged in.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "false";
Unattended-Upgrade::Automatic-Reboot-Time "05:00";
```

The origin strings come from `apt-cache policy`, in the `release o=...` lines.
`apt-config dump Unattended-Upgrade::Origins-Pattern` shows the merged list.

Upgrading a library does nothing for a service still holding the old one in
memory. `needrestart` handles that, in automatic mode:

```sh
sudo apt install needrestart
```

```perl
# /etc/needrestart/conf.d/50-auto.conf
$nrconf{restart} = 'a';
```

Observed on the reference host, running `sudo unattended-upgrade -v` by hand
with twenty security updates pending, kernel included: all installed, fail2ban
and a few system services restarted, `/var/run/reboot-required` left behind, and
the line `Found /var/run/reboot-required, but not rebooting because {'debian'}
is logged in`. That is the reboot rule working exactly as written. Logging out
and letting 05:00 come, or rebooting by hand, finishes the job.

The monthly manual step, and the checks:

```sh
sudo apt update && sudo apt upgrade        # Docker CE, the one thing not automatic
ls /var/run/reboot-required                # exists: a reboot is pending
sudo needrestart -b | grep KSTA            # 1 is fine, 3 means a newer kernel is installed
sudo journalctl -u unattended-upgrades -n 30
```

---

## 6. Disk: the things that fill it

On a 40 GB disk with a 10 MB database the only way to run out is logs and
leftovers. Four caps:

1. **Container logs.** `compose.yaml` caps every service at three 10 MB files,
   and the daemon default in section 4 covers anything started outside Compose.
2. **The journal.** Caddy's access log and every service's output go there. The
   default cap is 10% of the disk, up to 4 GB. Half a gigabyte is months of
   logs on a household host:

   ```ini
   # /etc/systemd/journald.conf.d/10-cap.conf
   [Journal]
   SystemMaxUse=500M
   ```

3. **Old images.** Every deploy pulls a new image and untags the old one, which
   stays on disk. A weekly prune of untagged images only, never volumes, never
   containers. `/etc/systemd/system/docker-image-prune.service`:

   ```ini
   [Unit]
   Description=Remove Docker images no tag points at any more
   After=docker.service
   Requires=docker.service

   [Service]
   Type=oneshot
   ExecStart=/usr/bin/docker image prune -f
   ```

   and `docker-image-prune.timer`, after the backup and off the daily minute:

   ```ini
   [Unit]
   Description=Weekly removal of untagged Docker images

   [Timer]
   OnCalendar=Sun *-*-* 04:40:00
   Persistent=true
   RandomizedDelaySec=300

   [Install]
   WantedBy=timers.target
   ```

   ```sh
   sudo systemctl daemon-reload && sudo systemctl enable --now docker-image-prune.timer
   ```

4. **SSD trim.** `fstrim.timer` is on by default in Debian. Leave it.

What to look at when in doubt: `df -h /`, `docker system df`,
`journalctl --disk-usage`.

What never to run on this machine: anything with `--volumes`, and
`docker compose down -v`. Both delete the database volume. Plain
`docker system prune` leaves a volume that a running container uses alone, but
the habit is not worth forming when `docker image prune -f` does the useful
part.

---

## 7. Backups leave the machine

Section 4 of `08-self-hosting.md` puts a dump in `backups/` every night with a
systemd timer. On the same disk as the database, that protects against a bad
migration and nothing else. The copy that matters is on a different machine.

The reference instance pulls, from the workstation, rather than pushing from the
server. The server then holds no credential to anywhere else, and a server that
has been broken into cannot reach the copies of its own database. The
workstation already has an SSH key for the server, so nothing new is created.
`deploy/pull-backups.sh` does it with rsync over SSH, without `--delete`, so
nothing on the server is ever removed from the workstation side. The server
keeps 7 days, the workstation 90.

```sh
sudo apt install rsync          # on the server; macOS ships openrsync and needs a real one to talk to
cp deploy/pull-backups.sh ~/.local/bin/    # on the workstation, outside any checkout
BACKUP_HOST=ovh sh ~/.local/bin/pull-backups.sh    # once, by hand
```

Scheduled on macOS with a launchd agent, which unlike cron runs a job it missed
while the Mac slept. `~/Library/LaunchAgents/fr.example.cooking-backup-pull.plist`,
with your username and ssh alias in place of the placeholders:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>fr.example.cooking-backup-pull</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>/Users/YOU/.local/bin/pull-backups.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BACKUP_HOST</key>
    <string>ovh</string>
  </dict>
  <!-- 09:00 local time, well after the 04:17 UTC dump on the server. -->
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>9</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <!-- Also at login, which covers a Mac that was powered off at 09:00. -->
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/YOU/Library/Logs/cooking-backup-pull.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOU/Library/Logs/cooking-backup-pull.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/fr.example.cooking-backup-pull.plist
tail ~/Library/Logs/cooking-backup-pull.log
```

The SSH key's passphrase is not a problem for launchd: macOS gives user agents
the same `SSH_AUTH_SOCK` as the terminal, so a key held in the keychain is
available to the job. On a Linux workstation, the equivalent is a crontab line,
`0 9 * * * BACKUP_HOST=ovh sh ~/.local/bin/pull-backups.sh >> ~/cooking-backup-pull.log 2>&1`,
with the usual cron caveat that a missed run is skipped.

If the workstation is not reliably on, the provider's own offering is the
fallback: OVH sells an automated daily backup of the whole VPS for a few euros a
month, and a manual snapshot before risky work is free.

Restoring a pulled dump is the `pg_restore` command in `08-self-hosting.md`,
section 4, after copying the file back to the server.

---

## 8. The reverse proxy on the host, not in the stack

`deploy/compose.proxy.yaml` runs Caddy inside the application's own Compose
project and gives it ports 80 and 443. That is the right shape for one
application on one machine, and the wrong one for a host meant to serve several
sites, because nothing else can have those ports.

The reference host installs Caddy from its apt repository instead. It owns 80
and 443, gets and renews certificates itself, and forwards each hostname to a
service on loopback: one site block per hostname in `/etc/caddy/Caddyfile`, the
cooking block being a copy of `deploy/Caddyfile`. `APP_DOMAIN` from `.env` is
therefore unused on this host: nothing reads it.

Its logs go to journald, not a file. The packaged systemd unit sets
`ProtectSystem=full`, which makes `/var/log` read-only to the service whatever
the directory's ownership, and an override would have to be remembered across
package upgrades. `sudo journalctl -u caddy -f` reads them. Caddy is in the
automatic update origins of section 5.

After any edit:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

If you go the other way and do use the overlay on a host hardened like this,
note that the two halves of that decision interact. The daemon setting in
section 4 makes loopback the default for a port published without an address, so
Caddy in the stack would bind loopback, answer nobody, and fail every ACME
challenge, with nothing in the logs naming the cause. `deploy/compose.proxy.yaml`
therefore publishes `0.0.0.0:80:80` and `0.0.0.0:443:443` explicitly: those three
ports are the only ones in the project meant to be reachable from off the
machine, so they are the only ones that say so, and the daemon default keeps
protecting everything else.

---

## 9. Prove it comes back

Everything above assumes the box returns from a reboot with no hands on it,
because section 5 will reboot it at 05:00 one morning. Assume nothing: reboot
it once while watching, before the first automatic one does.

```sh
sudo systemctl reboot
```

Then, once SSH answers again, in this order:

```sh
uname -r                          # the new kernel
systemctl --failed                # empty
systemctl is-active docker caddy fail2ban ufw ssh cooking-backup.timer docker-image-prune.timer
swapon --show                     # the swapfile, from /etc/fstab
docker ps                         # both containers Up (healthy)
curl -sI https://cooking.yanadam.fr/api/health | head -1   # HTTP/2 200
sudo ss -tulpn | grep 5355        # nothing: LLMNR is off
sudo sshd -T | grep -iE '^(permitrootlogin|allowusers) '
```

The reference host was back, containers healthy and site answering, about
twenty seconds after the reboot command, on 2 September 2026. Every unit above
is `enabled`, the containers carry `restart: unless-stopped`, and the swap is in
`fstab`. A box that passes this once will pass the 05:00 one.

---

## 10. A runbook on the host

The operator of the reference host is new to this, so the machine carries its
own map at `~/SERVER.md`: what runs where, the three deploy commands, how to
tell it is healthy, what to do when the site is down, backups and restore,
updates, security, disk, and a table of every configuration file this document
introduces. When a step here changes, that file changes with it.

| File | Purpose |
|---|---|
| `/etc/ssh/sshd_config.d/10-hardening.conf` | SSH rules |
| `/etc/fail2ban/jail.local` | fail2ban rules |
| `/etc/docker/daemon.json` | Docker defaults |
| `/etc/caddy/Caddyfile` | Sites and TLS |
| `/etc/apt/apt.conf.d/52unattended-upgrades-local` | Automatic updates and reboot |
| `/etc/needrestart/conf.d/50-auto.conf` | Service restarts after upgrades |
| `/etc/systemd/system/cooking-backup.{service,timer}` | Nightly dump |
| `/etc/systemd/system/docker-image-prune.{service,timer}` | Weekly image cleanup |
| `/etc/systemd/journald.conf.d/10-cap.conf` | Journal size cap |
| `/etc/systemd/resolved.conf.d/10-no-llmnr.conf` | No LAN name resolution |
| `/etc/sysctl.d/60-hardening.conf` | Kernel network settings |

---

## 11. Things that bit

Small, and each cost time once.

- **sshd keeps the first value it reads.** A drop-in named `50-` loses to one
  named `10-`, and cloud-init writes a `50-` that turns passwords back on.
  `sudo sshd -T` is the only honest source.
- **Debian 13 minimal ships without rsyslog, cron and rsync.** No `auth.log`
  for fail2ban, no `crontab` for scheduling, no server end for the backup pull.
  Each is a line to install or a systemd equivalent to use.
- **`sysctl` and `swapon` are not on a normal user's PATH.** They live in
  `/usr/sbin`. Prefix with `sudo` or the path.
- **A script piped over ssh dies on `head`.** `ssh host 'bash -s' < script.sh`
  with `set -o pipefail` and a `... | head -2` somewhere exits 141 (SIGPIPE)
  the moment `head` closes the pipe, and nothing after it runs. Drop `head` on
  the right of a pipe, or drop `pipefail`.
- **Strict reverse-path filtering fights Docker.** `rp_filter = 1` can drop
  traffic on the routes Docker bridges create. `2` keeps the useful part.
- **ufw's unit can say `inactive` while the rules are live.** It happens when
  ufw is enabled after boot. Harmless, and `systemctl start ufw` clears it.
