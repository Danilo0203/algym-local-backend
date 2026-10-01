#!/bin/sh
set -eu

project_root="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)"
db_host="${DB_HOST:-127.0.0.1}"
db_port="${DB_PORT:-5432}"
db_name="${DB_NAME:-algym}"
db_user="${DB_USER:-$(id -un)}"

case "$db_host" in
  127.0.0.1|localhost|::1) ;;
  *) echo "La conciliación solo admite PostgreSQL local." >&2; exit 1 ;;
esac
case "$db_name" in
  algym|algym_test) ;;
  *) echo "La conciliación solo admite algym o algym_test." >&2; exit 1 ;;
esac

unset PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGDATABASE PGUSER PGPORT
exec psql --no-psqlrc --host "$db_host" --port "$db_port" --username "$db_user" \
  --dbname "$db_name" -v ON_ERROR_STOP=1 -f "$project_root/database/scripts/reconcile_local.sql"
