#!/bin/sh

set -eu

status_file="${BACKUP_ROOT:-/backups}/.last-success-epoch"
[ -f "$status_file" ] || exit 1
last="$(cat "$status_file")"
interval="${BACKUP_INTERVAL_SECONDS:-86400}"
case "$last:$interval" in
  *[!0-9:]*|:*|*:) exit 1 ;;
esac
now="$(date -u +%s)"
age=$((now - last))
[ "$age" -ge 0 ] && [ "$age" -le "$((interval + 3600))" ]
