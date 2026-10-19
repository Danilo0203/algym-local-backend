#!/usr/bin/env python3
"""Explicit deployment step: create a dedicated read-only role, never business records.
Run on the VPS only after approval. Credentials go through stdin and private files.
"""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

ROLE = 'algym_export_reader'
DB_CONTAINER = 'supabase_db_all-gym-vf'
ROOT = Path('/opt/algym-export')

def sql(statement):
    result = subprocess.run(
        ['docker', 'exec', '-i', DB_CONTAINER, 'psql', '-X', '-At', '-v',
         'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', 'postgres'],
        input=statement, text=True, capture_output=True)
    if result.returncode:
        sys.exit('No se pudo completar la configuración. No se muestran secretos en la salida.')
    return result.stdout.strip()

os.umask(0o077)
config_dir = ROOT / 'config'
config_path = config_dir / 'export.json'
if config_path.exists() or sql("SELECT EXISTS(SELECT FROM pg_roles WHERE rolname='algym_export_reader');") != 'f':
    sys.exit('La cuenta o configuración ya existe. No se reemplazará automáticamente.')
password = secrets.token_urlsafe(48)
# This transaction changes only the new role and its own settings/membership.
sql(f"""BEGIN;
CREATE ROLE {ROLE} LOGIN PASSWORD '{password}' NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION BYPASSRLS CONNECTION LIMIT 6;
GRANT pg_read_all_data TO {ROLE};
ALTER ROLE {ROLE} SET default_transaction_read_only = on;
ALTER ROLE {ROLE} SET statement_timeout = '180s';
ALTER ROLE {ROLE} SET lock_timeout = '3s';
ALTER ROLE {ROLE} SET idle_in_transaction_session_timeout = '240s';
COMMIT;
""")
config = {
    'source': {'host': DB_CONTAINER, 'port': 5432, 'database': 'postgres',
               'user': ROLE, 'password': password},
    'authUrl': 'http://supabase_auth_all-gym-vf:9999',
    'pgBin': '/usr/lib/postgresql/17/bin', 'root': '/data/jobs',
    'tlsCert': '/run/algym/server.crt', 'tlsKey': '/run/algym/server.key', 'port': 54433
}
config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
with config_path.open('x') as handle:
    json.dump(config, handle)
os.chmod(config_path, 0o400)
print('Cuenta exclusiva de lectura creada. Configuración privada preparada; servicio aún sin activar.')
