#!/usr/bin/env bash

set -Eeuo pipefail

DB_NAME="${DB_NAME:-algym}"
DB_OWNER="${DB_OWNER:-algym_migrator}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/algym-private-backups/initial-migration}"

PROJECT_ROOT="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/../.."
  pwd
)"

MIGRATIONS_DIR="$PROJECT_ROOT/database/migrations"
SCRIPTS_DIR="$PROJECT_ROOT/database/scripts"

required_commands=(
  psql
  createdb
  dropdb
)

required_files=(
  "$MIGRATIONS_DIR/0001_local_auth_compat.sql"
  "$MIGRATIONS_DIR/0002_algym_schema.sql"
  "$SCRIPTS_DIR/prune_device_commands.sql"
  "$SCRIPTS_DIR/verify_migration.sql"
  "$BACKUP_DIR/auth-users.csv"
  "$BACKUP_DIR/auth-identities.csv"
  "$BACKUP_DIR/data.sql"
)

for command_name in "${required_commands[@]}"; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Falta el comando requerido: $command_name" >&2
    exit 1
  fi
done

for required_file in "${required_files[@]}"; do
  if [[ ! -f "$required_file" ]]; then
    echo "No existe el archivo requerido: $required_file" >&2
    exit 1
  fi
done

if [[ "$DB_NAME" == "postgres" || "$DB_NAME" == "template0" || "$DB_NAME" == "template1" ]]; then
  echo "Nombre de base de datos no permitido: $DB_NAME" >&2
  exit 1
fi

echo
echo "Base que se reconstruirá: $DB_NAME"
echo "Propietario: $DB_OWNER"
echo "Respaldos: $BACKUP_DIR"
echo
echo "ADVERTENCIA: se eliminará la base local '$DB_NAME'."
read -r -p "Escribe RECREAR para continuar: " confirmation

if [[ "$confirmation" != "RECREAR" ]]; then
  echo "Operación cancelada."
  exit 0
fi

echo "1/9 Eliminando base anterior..."
dropdb --if-exists "$DB_NAME"

echo "2/9 Creando base..."
createdb \
  --owner="$DB_OWNER" \
  --encoding=UTF8 \
  "$DB_NAME"

echo "3/9 Instalando compatibilidad de autenticación..."
psql \
  -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 \
  -f "$MIGRATIONS_DIR/0001_local_auth_compat.sql"

echo "4/9 Instalando esquema de ALGYM..."
psql \
  -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 \
  -f "$MIGRATIONS_DIR/0002_algym_schema.sql"

echo "5/9 Importando usuarios..."
psql \
  -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 \
  -c "\copy auth.users (
    id,
    email,
    phone,
    encrypted_password,
    email_confirmed_at,
    phone_confirmed_at,
    last_sign_in_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    deleted_at
  ) FROM '$BACKUP_DIR/auth-users.csv'
  WITH (FORMAT csv, HEADER true)"

echo "6/9 Importando identidades..."
psql \
  -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 \
  -c "\copy auth.identities (
    id,
    user_id,
    provider,
    identity_data,
    created_at,
    updated_at
  ) FROM '$BACKUP_DIR/auth-identities.csv'
  WITH (FORMAT csv, HEADER true)"

echo "7/9 Importando datos operativos..."
psql \
  -X \
  -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 \
  --single-transaction \
  -c "SET LOCAL session_replication_role = replica;" \
  -f "$BACKUP_DIR/data.sql"

echo "8/10 Aplicando migraciones posteriores..."
find "$MIGRATIONS_DIR" \
  -maxdepth 1 \
  -type f \
  -name '*.sql' \
  ! -name '0001_local_auth_compat.sql' \
  ! -name '0002_algym_schema.sql' \
  -print0 |
sort -z |
while IFS= read -r -d '' migration; do
  echo "Ejecutando $(basename "$migration")..."

  psql \
    -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 \
    -f "$migration"
done

echo "9/10 Limpiando comandos biométricos duplicados..."
psql \
  -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 \
  -f "$SCRIPTS_DIR/prune_device_commands.sql"

psql \
  -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 \
  -c "VACUUM (FULL, ANALYZE) public.device_commands;"

echo "10/10 Verificando integridad..."
psql \
  -d "$DB_NAME" \
  -v ON_ERROR_STOP=1 \
  -f "$SCRIPTS_DIR/verify_migration.sql"

echo
echo "Restauración completada correctamente."
echo "Base disponible: $DB_NAME"
