#!/bin/sh
# Pull the nightly dumps off the server onto the machine running this, so the
# disk that holds the database is not the only disk that holds its backups.
#
# Pull rather than push, on purpose. The server then holds no credential to
# anywhere else, and a server that has been broken into cannot reach the copies
# of its own database. The workstation already has an SSH key for the server,
# so nothing new is created or stored.
#
# Run it from a scheduler on the workstation, not on the server. A macOS launchd
# agent and a crontab line are in docs/09-hardening-a-host.md, section 7. Copy
# this file somewhere outside the checkout first: a scheduler pointed into a
# repository stops working the day the branch it is on goes away.
#
# Settings, all with defaults:
#
#   BACKUP_HOST        ssh destination; an alias from ~/.ssh/config works   (cooking)
#   BACKUP_REMOTE_DIR  BACKUP_DIR on the server, relative to the login home  (cooking-app/backups)
#   BACKUP_DEST        where the dumps land on this machine                  (~/Backups/cooking-app)
#   BACKUP_KEEP_DAYS   retention here, independent of the server's           (90)
#
# rsync must exist on both ends. macOS ships openrsync, which talks to a real
# rsync without trouble, so on a Debian server: sudo apt install rsync.
#
# Nothing is ever deleted on the server from here: rsync runs without --delete,
# and the server prunes on its own schedule (BACKUP_KEEP_DAYS in the timer unit).
#
# Restoring one of these is in docs/08-self-hosting.md, section 4.
set -eu

BACKUP_HOST=${BACKUP_HOST:-cooking}
BACKUP_REMOTE_DIR=${BACKUP_REMOTE_DIR:-cooking-app/backups}
BACKUP_DEST=${BACKUP_DEST:-$HOME/Backups/cooking-app}
BACKUP_KEEP_DAYS=${BACKUP_KEEP_DAYS:-90}

mkdir -p "$BACKUP_DEST"
echo "$(date '+%F %T') pull start from $BACKUP_HOST:$BACKUP_REMOTE_DIR"

# A .partial is a dump the server is still writing. Leave it there.
rsync -a --timeout=60 --exclude '*.partial' \
  "$BACKUP_HOST:$BACKUP_REMOTE_DIR/" "$BACKUP_DEST/"

# Only after the pull landed, so a run that failed prunes nothing.
find "$BACKUP_DEST" -maxdepth 1 -name '*.dump' -mtime "+$BACKUP_KEEP_DAYS" -print -delete |
  while read -r old; do echo "pruned $old"; done

count=$(find "$BACKUP_DEST" -maxdepth 1 -name '*.dump' | wc -l | tr -d ' ')
latest=$(ls -t "$BACKUP_DEST"/*.dump 2>/dev/null | head -1)
echo "$(date '+%F %T') pull done: $count dumps kept, latest ${latest##*/}"
