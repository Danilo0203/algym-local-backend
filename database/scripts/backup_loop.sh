#!/bin/sh

set -eu
umask 077

interval="${BACKUP_INTERVAL_SECONDS:-86400}"
backup_root="${BACKUP_ROOT:-/backups}"
BACKUP_ROOT="$backup_root"
export BACKUP_ROOT
script_dir="$(CDPATH='' cd "$(dirname "$0")" && pwd)"
ALGYM_AUTOMATED_BACKUP=1
export ALGYM_AUTOMATED_BACKUP
case "$interval" in
  ''|*[!0-9]*) echo "BACKUP_INTERVAL_SECONDS debe ser un número entero." >&2; exit 1 ;;
esac
if [ "$interval" -lt 3600 ]; then
  echo "El intervalo mínimo de respaldo es una hora." >&2
  exit 1
fi

while :; do
  sh "$script_dir/backup_local_database.sh"
  completed_at="$(date -u +%s)"
  status_tmp="$backup_root/.last-success-epoch.$$"
  printf '%s\n' "$completed_at" > "$status_tmp"
  mv -- "$status_tmp" "$backup_root/.last-success-epoch"
  sh "$script_dir/prune_automatic_backups.sh"
  sleep "$interval"
done
