#!/bin/sh
# One compressed dump of the application database, plus pruning of old ones.
#
# There is one database worth backing up and nothing on disk beside it: recipe
# images are addresses, not uploads, so Postgres is the whole backup surface. A
# development machine also has cooking_test and cooking_verify, both disposable
# by construction, and neither is touched here.
#
# Custom format (-Fc), because it restores selectively and compresses itself:
#
#   docker compose exec -T db pg_restore -U cooking -d cooking --clean cooking-2026-09-02.dump
#
# Run it from the repository root. Every setting has a default matching
# compose.yaml, so on an ordinary install it takes no arguments:
#
#   sh scripts/backup.sh
#   npm run backup
#
# Scheduled by the two units in deploy/, which is the recommended way and the
# only one that works on an image with no cron installed, such as a minimal
# Debian 13:
#
#   sudo cp deploy/cooking-backup.{service,timer} /etc/systemd/system/
#
# In cron instead, as the user that owns the checkout:
#
#   17 4 * * * cd /srv/cooking-app && sh scripts/backup.sh >> backups/backup.log 2>&1
#
# A dump is only a backup once it is somewhere else. Copy BACKUP_DIR off the
# machine, or the disk that loses the database loses its dumps with it.
#
# POSIX sh, so `set -o pipefail` is not available: it is a bash and ksh
# extension and this runs under dash on Debian. Nothing below pipes anything
# whose failure would be swallowed, which is a property of the code rather than
# of the shell, and the prune at the end is written the way it is to keep it
# true.
set -eu

# Word-split on purpose: the value is a command with its subcommand, and Podman
# users pass `podman-compose` or `podman compose`.
COMPOSE_CMD=${COMPOSE_CMD:-docker compose}
DB_SERVICE=${DB_SERVICE:-db}
POSTGRES_USER=${POSTGRES_USER:-cooking}
POSTGRES_DB=${POSTGRES_DB:-cooking}
BACKUP_DIR=${BACKUP_DIR:-./backups}
BACKUP_KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}

# Checked before anything is written, because this value decides what gets
# deleted. `find -mtime +$x` with a non-numeric x is an error on GNU find and an
# unpredictable argument elsewhere, and the run that hits it has already taken
# the dump: the failure lands in the prune, after the point where a reader
# assumes the dangerous part is over.
case "$BACKUP_KEEP_DAYS" in
    '' | *[!0-9]*)
        echo "backup: BACKUP_KEEP_DAYS must be a whole number of days, not \"$BACKUP_KEEP_DAYS\"" >&2
        exit 1
        ;;
esac

mkdir -p "$BACKUP_DIR"

stamp=$(date +%Y-%m-%dT%H%M%S)
target="$BACKUP_DIR/$POSTGRES_DB-$stamp.dump"

# Written to a partial name first, so an interrupted dump cannot be mistaken for
# a complete one by the pruning below or by whoever reaches for it in a hurry.
# -T because there is no terminal in cron.
# shellcheck disable=SC2086
$COMPOSE_CMD exec -T "$DB_SERVICE" \
    pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner > "$target.partial"

# The exit status is not enough to promote it. Older `podman-compose exec`
# returns 0 whatever the command inside the container did, so the redirection
# above can leave an empty file, or a file holding an error message, and a
# 0 exit beside it. Promoting that and then pruning on age deletes the last good
# dump and reports success.
#
# So the file itself is checked. Custom-format output always opens with the
# five bytes PGDMP, which no error message does, and the partial is left in
# place rather than removed: it is the evidence, and the prune sweeps abandoned
# partials on the same window as the dumps.
size=$(wc -c < "$target.partial" | tr -d ' ')
magic=$(head -c 5 "$target.partial" 2>/dev/null || true)
if [ "$magic" != "PGDMP" ] || [ "$size" -lt 1024 ]; then
    echo "backup: refusing to keep $target.partial: $size byte(s), and not a pg_dump archive." >&2
    echo "backup: the first line of it was:" >&2
    head -c 200 "$target.partial" >&2 || true
    echo >&2
    exit 1
fi

mv "$target.partial" "$target"
echo "backup: wrote $target ($(du -h "$target" | cut -f1))"

# Only after this one landed, so a run that failed leaves the previous good
# dumps alone. Abandoned partials go too, on the same window: a run interrupted
# every night would otherwise leave one behind every night.
#
# Through a file rather than a pipe. `find ... | while read` reports the exit
# status of the `while`, so an unreadable directory or a bad -mtime argument
# reads as a clean prune, and `set -o pipefail` is not available here to fix it.
pruned=$(mktemp "${TMPDIR:-/tmp}/cooking-backup-prune.XXXXXX")
trap 'rm -f "$pruned"' EXIT INT TERM
find "$BACKUP_DIR" -maxdepth 1 \
    \( -name "$POSTGRES_DB-*.dump" -o -name "$POSTGRES_DB-*.dump.partial" \) \
    -mtime "+$BACKUP_KEEP_DAYS" -print -delete > "$pruned"
while read -r old; do
    echo "backup: pruned $old"
done < "$pruned"
