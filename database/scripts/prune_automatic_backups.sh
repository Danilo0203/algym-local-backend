#!/bin/sh

set -eu
umask 077

backup_root="${BACKUP_ROOT:-/backups}"
keep_count="${BACKUP_KEEP_COUNT:-30}"

case "$keep_count" in
  ''|*[!0-9]*) echo "BACKUP_KEEP_COUNT debe ser un número entero." >&2; exit 1 ;;
esac
if [ "$keep_count" -lt 7 ] || [ "$keep_count" -gt 365 ]; then
  echo "BACKUP_KEEP_COUNT debe estar entre 7 y 365." >&2
  exit 1
fi
if [ ! -d "$backup_root" ] || [ -L "$backup_root" ]; then
  echo "BACKUP_ROOT debe ser un directorio real." >&2
  exit 1
fi

find "$backup_root" -mindepth 1 -maxdepth 1 -type d \
  -name 'algym-????????T??????Z' -print | sort -r | while IFS= read -r candidate; do
  if [ ! -f "$candidate/SHA256SUMS" ] || [ ! -f "$candidate/database.dump" ] ||
     ! grep -qx 'backup_type=automatic' "$candidate/manifest.txt" 2>/dev/null; then
    continue
  fi
  kept="${kept:-0}"
  kept=$((kept + 1))
  if [ "$kept" -gt "$keep_count" ]; then
    rm -rf -- "$candidate"
  fi
done
