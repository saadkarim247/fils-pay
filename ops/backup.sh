#!/bin/sh
# Runs in the backup service (ops/docker-compose.yml): one custom-format
# pg_dump a night at 23:30 UTC, keeping 7 days. `sh /ops/backup.sh now`
# takes one immediately and exits.
set -eu
dump() {
  f=/backups/filspay-$(date -u +%Y%m%dT%H%M%SZ).dump
  pg_dump -Fc -f "$f.part" && mv "$f.part" "$f"
  find /backups -name 'filspay-*.dump' -mtime +7 -delete
  echo "backup: wrote $f ($(du -h "$f" | cut -f1))"
}
if [ "${1:-}" = now ]; then dump; exit 0; fi
while :; do
  if [ "$(date -u +%H:%M)" = "23:30" ]; then dump || echo "backup: FAILED"; sleep 60; fi
  sleep 30
done
