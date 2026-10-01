#!/bin/sh

set -eu
umask 077

project_root="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)"
cd "$project_root"

db_host="${DB_HOST:-127.0.0.1}"
db_port="${DB_PORT:-5432}"
db_name="${DB_NAME:-algym}"
db_user="${DB_USER:-$(id -un)}"
media_root="${LOCAL_MEDIA_ROOT:-./data/media}"
backup_root="${BACKUP_ROOT:-./backups/local}"

case "$db_host" in
  127.0.0.1|localhost|::1) ;;
  postgres)
    if [ "${ALGYM_CONTAINER_BACKUP:-}" != "1" ]; then
      echo "El servicio postgres solo se admite en el respaldo de Compose." >&2
      exit 1
    fi
    ;;
  *) echo "Solo se permite respaldar PostgreSQL local." >&2; exit 1 ;;
esac

case "$db_name" in
  postgres|template0|template1|"") echo "Nombre de base no permitido." >&2; exit 1 ;;
esac

for program in pg_dump pg_restore tar; do
  command -v "$program" >/dev/null 2>&1 || { echo "Falta $program." >&2; exit 1; }
done

if ! command -v sha256sum >/dev/null 2>&1 &&
   ! command -v shasum >/dev/null 2>&1; then
  echo "Falta sha256sum o shasum." >&2
  exit 1
fi

hash_files() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

check_hashes() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c SHA256SUMS
  else
    shasum -a 256 -c SHA256SUMS
  fi
}

if [ "${ALGYM_CONTAINER_BACKUP:-}" = "1" ]; then
  if [ -z "${POSTGRES_PASSWORD:-}" ]; then
    echo "Falta POSTGRES_PASSWORD para el respaldo de Compose." >&2
    exit 1
  fi
  PGPASSWORD="$POSTGRES_PASSWORD"
  export PGPASSWORD
fi

# No permitir que variables libpq heredadas desvíen la conexión del host indicado.
unset PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGDATABASE PGUSER PGPORT

if [ ! -d "$media_root" ]; then
  echo "No existe LOCAL_MEDIA_ROOT; no se permite un respaldo sin revisar los archivos." >&2
  exit 1
fi
if [ -L "$media_root" ] || [ -n "$(find "$media_root" -type l -print -quit)" ]; then
  echo "El directorio de archivos contiene enlaces simbólicos; revisar antes de respaldar." >&2
  exit 1
fi

mkdir -p "$backup_root"
backup_root="$(cd "$backup_root" && pwd)"
tmp_dir="$(mktemp -d "$backup_root/.algym-backup.XXXXXXXX")"
cleanup() { if [ -n "$tmp_dir" ] && [ -d "$tmp_dir" ]; then rm -rf -- "$tmp_dir"; fi; }
trap cleanup 0

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="$backup_root/algym-$timestamp"
if [ -e "$backup_dir" ]; then
  echo "Ya existe el respaldo $backup_dir." >&2
  exit 1
fi

pg_dump --no-password --host "$db_host" --port "$db_port" --username "$db_user" \
  --dbname "$db_name" --format=custom --file "$tmp_dir/database.dump"
pg_restore --list "$tmp_dir/database.dump" >/dev/null

COPYFILE_DISABLE=1 tar -C "$media_root" -cf "$tmp_dir/media.tar" .
media_count="$(find "$media_root" -type f | wc -l | tr -d ' ')"
tar -tf "$tmp_dir/media.tar" >/dev/null

printf 'database=%s\ncreated_utc=%s\nmedia_files=%s\n' \
  "$db_name" "$timestamp" "$media_count" > "$tmp_dir/manifest.txt"
if [ "${ALGYM_AUTOMATED_BACKUP:-}" = "1" ]; then
  printf 'backup_type=automatic\n' >> "$tmp_dir/manifest.txt"
fi
(
  cd "$tmp_dir"
  hash_files database.dump media.tar manifest.txt > SHA256SUMS
  check_hashes >/dev/null
)

mv -- "$tmp_dir" "$backup_dir"
tmp_dir=""
echo "Respaldo verificado: $backup_dir"
echo "Archivos de media: $media_count"
