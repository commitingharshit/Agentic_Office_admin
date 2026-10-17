#!/bin/bash
# Every BACKUP_EVERY_SECONDS:
#   1. pg_dump (custom format) → /backups/<ts>.dump, LATEST names the newest good one;
#   2. a physical base backup → /backups/base/<ts>.tar.gz (+ .label), taken with the
#      low-level API (pg_backup_start / tar of the data directory / pg_backup_stop) over a
#      normal connection — no replication slot or pg_hba change needed;
#   3. prune dumps, base backups and archived WAL older than BACKUP_KEEP_DAYS.
# Postgres archives WAL into /backups/wal (archive_command), so base + WAL restore to any
# point in between. The backup-mirror service copies /backups to MinIO ao-backups/pg/.
set -uo pipefail
mkdir -p /backups/base /backups/wal /backups/drills
chown 999:999 /backups/wal && chmod 700 /backups/wal     # the postgres server writes here

base_backup() {
  local ts="$1" out="/backups/base/.$1"
  psql -X -q -v ON_ERROR_STOP=1 -t -A <<SQL
SELECT pg_backup_start('ao-$ts', true);
\! tar -C /pgdata --exclude=./pg_wal --exclude=./postmaster.pid --exclude=./postmaster.opts -czf $out.tar.gz.part .
\o $out.label.part
SELECT labelfile FROM pg_backup_stop(true);
\o
SQL
}

while true; do
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  name="$ts.dump"
  if pg_dump -Fc -f "/backups/.$name.part" && mv "/backups/.$name.part" "/backups/$name"; then
    echo "$name" > /backups/LATEST
    echo "backup ok: $name"
  else
    rm -f "/backups/.$name.part"
    echo "backup FAILED at $(date -u)" >&2
  fi
  if base_backup "$ts" && mv "/backups/base/.$ts.tar.gz.part" "/backups/base/$ts.tar.gz" && mv "/backups/base/.$ts.label.part" "/backups/base/$ts.label"; then
    echo "$ts" > /backups/base/LATEST
    echo "base backup ok: $ts ($(du -h "/backups/base/$ts.tar.gz" | cut -f1))"
  else
    rm -f /backups/base/.$ts.*
    echo "base backup FAILED at $(date -u)" >&2
  fi
  psql -X -q -c "DELETE FROM device_metrics WHERE reported_at < now() - interval '30 days'" 2>/dev/null || true
  find /backups -maxdepth 1 -name '*.dump' -mtime "+${BACKUP_KEEP_DAYS}" -delete
  find /backups/base -name '*.tar.gz' -mtime "+${BACKUP_KEEP_DAYS}" -delete
  find /backups/base -name '*.label' -mtime "+${BACKUP_KEEP_DAYS}" -delete
  find /backups/wal -type f -mtime "+$((BACKUP_KEEP_DAYS + 1))" -delete
  sleep "$BACKUP_EVERY_SECONDS"
done
