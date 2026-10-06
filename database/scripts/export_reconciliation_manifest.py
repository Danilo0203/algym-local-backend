#!/usr/bin/env python3
"""Exporta huellas privadas de filas y media para comparar dos copias locales."""

from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys


BACKEND_ROOT = Path(__file__).resolve().parents[2]
WEB_ROOT = BACKEND_ROOT.parent / "al-gym-sys"
COMPOSE_FILE = WEB_ROOT / "docker-compose.yml"
FORMAT = "algym-reconciliation-v1"
PROJECT_NAME = re.compile(r"[a-z][a-z0-9_-]*\Z")

TABLE_CATALOG_SQL = """
COPY (
  SELECT n.nspname, c.relname,
         COALESCE(json_agg(a.attname ORDER BY k.ord)
           FILTER (WHERE a.attname IS NOT NULL), '[]'::json)::text
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  LEFT JOIN pg_index AS i ON i.indrelid = c.oid AND i.indisprimary
  LEFT JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
  LEFT JOIN pg_attribute AS a ON a.attrelid = c.oid AND a.attnum = k.attnum
  WHERE n.nspname IN ('auth', 'public')
    AND c.relkind IN ('r', 'p')
    AND NOT c.relispartition
  GROUP BY n.nspname, c.relname
  ORDER BY n.nspname, c.relname
) TO STDOUT WITH CSV
"""


def private_output(path: Path) -> Path:
    if not path.is_absolute():
        raise ValueError("El manifiesto debe usar una ruta absoluta")
    parent = path.parent.resolve(strict=True)
    destination = parent / path.name
    if any(destination.is_relative_to(root) for root in (BACKEND_ROOT, WEB_ROOT)):
        raise ValueError("Guardar el manifiesto privado fuera de ambos repositorios")
    if destination.exists() or destination.is_symlink():
        raise ValueError("El manifiesto ya existe; no se sobrescribirá")
    return destination


def psql_command(args: argparse.Namespace) -> list[str]:
    if args.compose_project:
        if not PROJECT_NAME.fullmatch(args.compose_project):
            raise ValueError("Nombre de proyecto Compose inválido")
        return [
            "docker", "compose", "-p", args.compose_project, "-f", str(COMPOSE_FILE),
            "--profile", "container-db", "exec", "-T", "postgres", "psql",
            "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "algym",
        ]
    if args.db_host not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("Solo se admite PostgreSQL del host local")
    if args.db_name not in ("algym", "algym_test"):
        raise ValueError("Solo se admite algym o algym_test")
    return [
        "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "--no-password",
        "--host", args.db_host, "--port", str(args.db_port),
        "--username", args.db_user, "--dbname", args.db_name,
    ]


def copy_rows(command: list[str], sql: str) -> list[list[str]]:
    env = os.environ.copy()
    for key in ("PGHOST", "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGDATABASE", "PGUSER", "PGPORT"):
        env.pop(key, None)
    result = subprocess.run(
        [*command, "-c", "SET TIME ZONE 'UTC'; " + sql],
        check=False, capture_output=True, text=True, encoding="utf-8", env=env,
    )
    if result.returncode:
        raise RuntimeError("Falló la lectura de PostgreSQL local: " + result.stderr.strip()[-500:])
    return list(csv.reader(io.StringIO(result.stdout)))


def quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def database_entities(command: list[str]) -> dict[str, dict[str, str]]:
    catalog = copy_rows(command, TABLE_CATALOG_SQL)
    catalog.append(["public", "product_inventory_overview", '["id"]'])
    entities: dict[str, dict[str, str]] = {}
    for schema, table, key_json in sorted(catalog):
        key_columns = json.loads(key_json)
        if not key_columns:
            raise RuntimeError(f"La tabla {schema}.{table} carece de llave primaria")
        qualified = f"{quote_identifier(schema)}.{quote_identifier(table)}"
        key_values = ", ".join(f"t.{quote_identifier(column)}::text" for column in key_columns)
        key_expression = f"jsonb_build_array({key_values})::text"
        sql = (
            f"COPY (SELECT {key_expression}, to_jsonb(t)::text "
            f"FROM {qualified} AS t ORDER BY {key_expression}) TO STDOUT WITH CSV"
        )
        fingerprints: dict[str, str] = {}
        for key, payload in copy_rows(command, sql):
            if key in fingerprints:
                raise RuntimeError(f"Llave duplicada en {schema}.{table}")
            fingerprints[key] = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        entities[f"{schema}.{table}"] = fingerprints
    return entities


def media_files(root: Path) -> dict[str, str]:
    if root.is_symlink() or not root.is_dir():
        raise ValueError("La carpeta de media debe existir y no ser un enlace simbólico")
    hashes: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("La carpeta de media contiene un enlace simbólico")
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError("La carpeta de media contiene un tipo de archivo no permitido")
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        hashes[path.relative_to(root).as_posix()] = digest.hexdigest()
    return hashes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--media-root", type=Path, required=True)
    parser.add_argument("--compose-project")
    parser.add_argument("--db-host", default="127.0.0.1")
    parser.add_argument("--db-port", type=int, default=5432)
    parser.add_argument("--db-name", default="algym")
    parser.add_argument("--db-user", default=os.environ.get("USER", ""))
    args = parser.parse_args()

    destination = private_output(args.output)
    command = psql_command(args)
    manifest = {
        "format": FORMAT,
        "captured_utc": datetime.now(timezone.utc).isoformat(),
        "database": "algym" if args.compose_project else args.db_name,
        "entities": database_entities(command),
        "media": media_files(args.media_root),
    }
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(destination, flags, 0o600), "w", encoding="utf-8") as output:
        json.dump(manifest, output, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        output.write("\n")
    print(f"Manifiesto privado: {destination}")
    print(f"Entidades: {len(manifest['entities'])}; media: {len(manifest['media'])}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"Exportación detenida: {error}", file=sys.stderr)
        sys.exit(1)
