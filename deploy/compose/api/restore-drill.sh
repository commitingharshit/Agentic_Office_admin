#!/bin/bash
# The restore drill: proves the backups restore. Every DRILL_EVERY_SECONDS (default weekly)
# it takes the newest base backup, replays the archived WAL into a scratch data directory,
# starts a throwaway Postgres on it, checks it answers, and writes the outcome to
# /backups/drills/LATEST.json (mirrored to MinIO; the Admin Console shows it).
set -uo pipefail
DRILL_EVERY_SECONDS="${DRILL_EVERY_SECONDS:-604800}"

drill() {
  local started base dir rc=0 detail users=null lsn=null t0
  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; t0=$(date +%s)
  base="$(cat /backups/base/LATEST 2>/dev/null)"
  if [[ -z "$base" || ! -f "/backups/base/$base.tar.gz" ]]; then
    printf '{"ok":false,"at":"%s","detail":"no base backup yet"}\n' "$started" > /backups/drills/LATEST.json; return
  fi
  dir="$(mktemp -d /tmp/drill.XXXX)"
  tar -C "$dir" -xzf "/backups/base/$base.tar.gz" && cp "/backups/base/$base.label" "$dir/backup_label" || rc=1
  mkdir -p "$dir/pg_wal" && touch "$dir/recovery.signal"
  cat >> "$dir/postgresql.auto.conf" <<CONF
restore_command = 'cp /backups/wal/%f %p'
recovery_target_action = 'promote'
archive_mode = off
CONF
  chown -R 999:999 "$dir" && chmod 700 "$dir"
  if [[ $rc -eq 0 ]]; then
    gosu postgres pg_ctl -D "$dir" -o "-p 55999 -c listen_addresses='' -c unix_socket_directories=/tmp -c shared_preload_libraries=pg_stat_statements -c max_connections=${DRILL_MAX_CONNECTIONS:-200}" -l "$dir/drill.log" -w -t 600 start >/dev/null || rc=1
  fi
  if [[ $rc -eq 0 ]]; then
    for _ in $(seq 1 120); do
      [[ "$(gosu postgres psql -h /tmp -p 55999 -U ao_owner -d agentic_office -tAc 'SELECT pg_is_in_recovery()' 2>/dev/null)" == "f" ]] && break; sleep 2
    done
    users="$(gosu postgres psql -h /tmp -p 55999 -U ao_owner -d agentic_office -tAc 'SELECT count(*) FROM users' 2>/dev/null || echo null)"
    lsn="\"$(gosu postgres psql -h /tmp -p 55999 -U ao_owner -d agentic_office -tAc 'SELECT pg_current_wal_lsn()' 2>/dev/null)\""
    [[ "$users" =~ ^[0-9]+$ ]] || rc=1
    gosu postgres pg_ctl -D "$dir" -m fast stop >/dev/null 2>&1
  fi
  detail="$(tail -n 3 "$dir/drill.log" 2>/dev/null | tr '"\n\\' "' /" | cut -c1-300)"
  printf '{"ok":%s,"at":"%s","base":"%s","users":%s,"lsn":%s,"seconds":%s,"detail":"%s"}\n' \
    "$([[ $rc -eq 0 ]] && echo true || echo false)" "$started" "$base" "${users:-null}" "$lsn" "$(( $(date +%s) - t0 ))" "$detail" \
    > /backups/drills/.LATEST.json && mv /backups/drills/.LATEST.json /backups/drills/LATEST.json
  rm -rf "$dir"
  echo "restore drill: $(cat /backups/drills/LATEST.json)"
}

mkdir -p /backups/drills
sleep "${DRILL_FIRST_DELAY_SECONDS:-600}"   # let the first base backup land
while true; do drill; sleep "$DRILL_EVERY_SECONDS"; done
