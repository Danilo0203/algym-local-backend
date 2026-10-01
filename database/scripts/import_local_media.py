#!/usr/bin/env python3
"""Vincula archivos locales a ejercicios/productos de PostgreSQL sin usar internet.

El manifiesto JSON indica el ID, los valores actuales esperados y el archivo local.
Sin --apply solo valida y muestra la propuesta. Para algym, --apply exige un
respaldo verificado de base y media. Nunca descarga archivos del origen.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from dataclasses import dataclass


BACKEND_ROOT = Path(__file__).resolve().parents[2]
COMPOSE_FILE = BACKEND_ROOT.parent / "al-gym-sys" / "docker-compose.yml"
MAX_BYTES = 5 * 1024 * 1024
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
UUID_PATTERN = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z")


@dataclass(frozen=True)
class MediaItem:
    kind: str
    entity_id: str
    source: Path
    expected_image_url: str | None
    expected_animation_url: str | None
    data: bytes
    digest: str
    extension: str

    @property
    def filename(self) -> str:
        return f"{self.digest}.{self.extension}"

    @property
    def url(self) -> str:
        return f"/api/media/{self.kind}/{self.filename}"


def image_extension(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data[:6] in (b"GIF87a", b"GIF89a") and len(data) >= 16:
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP" and len(data) >= 16:
        return "webp"
    raise ValueError("El archivo no es PNG, JPEG, GIF ni WebP")


def read_manifest(path: Path) -> list[MediaItem]:
    if path.is_symlink() or not path.is_file():
        raise ValueError("El manifiesto debe ser un archivo normal")
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("version") != 1 or not isinstance(raw.get("items"), list):
        raise ValueError("Se requiere un manifiesto JSON con version=1 e items")
    if not raw["items"]:
        raise ValueError("El manifiesto no contiene elementos")

    items: list[MediaItem] = []
    seen: set[tuple[str, str]] = set()
    for index, row in enumerate(raw["items"], start=1):
        if not isinstance(row, dict):
            raise ValueError(f"Elemento {index}: se requiere un objeto")
        kind, entity_id = row.get("kind"), row.get("id")
        if kind not in ("exercises", "products") or not isinstance(entity_id, str):
            raise ValueError(f"Elemento {index}: kind o id inválido")
        if (kind == "exercises" and not re.fullmatch(r"[1-9][0-9]*", entity_id)) or (
            kind == "products" and not UUID_PATTERN.fullmatch(entity_id)
        ):
            raise ValueError(f"Elemento {index}: id inválido")
        key = kind, entity_id.lower()
        if key in seen:
            raise ValueError(f"Elemento {index}: entidad repetida")
        seen.add(key)

        if "expected_image_url" not in row or not isinstance(row["expected_image_url"], (str, type(None))):
            raise ValueError(f"Elemento {index}: falta expected_image_url")
        if kind == "exercises" and (
            "expected_animation_url" not in row
            or not isinstance(row["expected_animation_url"], (str, type(None)))
        ):
            raise ValueError(f"Elemento {index}: falta expected_animation_url")
        source_value = row.get("file")
        if not isinstance(source_value, str) or not source_value.startswith("/"):
            raise ValueError(f"Elemento {index}: file debe ser ruta absoluta")
        source = Path(source_value)
        if source.is_symlink() or not source.is_file():
            raise ValueError(f"Elemento {index}: archivo inexistente o enlace simbólico")
        if source.stat().st_size == 0 or source.stat().st_size > MAX_BYTES:
            raise ValueError(f"Elemento {index}: tamaño fuera del límite de 5 MB")
        data = source.read_bytes()
        if not data or len(data) > MAX_BYTES:
            raise ValueError(f"Elemento {index}: archivo vacío o demasiado grande")
        extension = image_extension(data)
        digest = hashlib.sha256(data).hexdigest()
        expected_digest = row.get("sha256")
        if expected_digest is not None and (
            not isinstance(expected_digest, str)
            or not SHA256_PATTERN.fullmatch(expected_digest)
            or expected_digest != digest
        ):
            raise ValueError(f"Elemento {index}: SHA-256 incorrecto")
        items.append(MediaItem(
            kind, entity_id, source, row["expected_image_url"],
            row.get("expected_animation_url"), data, digest, extension,
        ))
    return items


def sql_literal(value: str | None) -> str:
    if value is None:
        return "NULL"
    if "\x00" in value:
        raise ValueError("Texto con NUL no permitido")
    return "'" + value.replace("'", "''") + "'"


def psql_command(args: argparse.Namespace) -> list[str]:
    if args.db_mode == "compose":
        if not COMPOSE_FILE.is_file():
            raise ValueError("Falta docker-compose.yml del repositorio hermano")
        command = ["docker", "compose", "-f", str(COMPOSE_FILE)]
        if args.project_name:
            command += ["-p", args.project_name]
        return command + ["--profile", "container-db", "exec", "-T", "postgres",
                          "psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
                          "-U", "postgres", "-d", args.db_name]
    return ["psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
            "--host", args.db_host, "--port", str(args.db_port),
            "--username", args.db_user, "--dbname", args.db_name]


def require_local_docker_context() -> None:
    explicit_host = os.environ.get("DOCKER_HOST", "")
    if explicit_host and not explicit_host.startswith("unix://"):
        raise ValueError("DOCKER_HOST remoto no permitido para importar media")
    result = subprocess.run(
        ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode or not result.stdout.strip().startswith("unix://"):
        raise ValueError("El contexto Docker debe usar un socket Unix local")


def run_psql(args: argparse.Namespace, sql: str) -> str:
    env = os.environ.copy()
    for key in ("PGHOST", "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGDATABASE", "PGUSER", "PGPORT"):
        env.pop(key, None)
    result = subprocess.run(psql_command(args), input="SET standard_conforming_strings = on;\n" + sql, text=True,
                            capture_output=True, check=False, env=env)
    if result.returncode:
        raise RuntimeError(f"PostgreSQL rechazó la operación: {result.stderr.strip()[:500]}")
    return result.stdout.strip()


def read_rows(args: argparse.Namespace, items: list[MediaItem]) -> dict[tuple[str, str], dict]:
    selects = []
    for kind in ("exercises", "products"):
        ids = [sql_literal(item.entity_id) for item in items if item.kind == kind]
        if not ids:
            continue
        id_type = "bigint" if kind == "exercises" else "uuid"
        animation = "animation_url" if kind == "exercises" else "NULL::text AS animation_url"
        selects.append(
            f"SELECT {sql_literal(kind)}::text AS kind, id::text AS id, image_url, {animation} "
            f"FROM public.{kind} WHERE id = ANY(ARRAY[{', '.join(ids)}]::{id_type}[])"
        )
    query = " UNION ALL ".join(selects)
    payload = run_psql(args, "SELECT COALESCE(json_agg(row_to_json(rows)), '[]'::json)\n"
                      f"FROM ({query}) AS rows;")
    rows = json.loads(payload)
    return {(row["kind"], row["id"].lower()): row for row in rows}


def verify_rows(args: argparse.Namespace, items: list[MediaItem]) -> None:
    rows = read_rows(args, items)
    for item in items:
        row = rows.get((item.kind, item.entity_id.lower()))
        if row is None:
            raise ValueError(f"No existe {item.kind}/{item.entity_id} en {args.db_name}")
        if row["image_url"] != item.expected_image_url or (
            item.kind == "exercises" and row["animation_url"] != item.expected_animation_url
        ):
            raise ValueError(f"Cambió la URL de {item.kind}/{item.entity_id}; generar un manifiesto nuevo")


def verify_backup(path: Path) -> None:
    expected = {"database.dump", "media.tar", "manifest.txt"}
    checksum_file = path / "SHA256SUMS"
    if path.is_symlink() or not path.is_dir() or checksum_file.is_symlink():
        raise ValueError("Directorio de respaldo inválido")
    hashes: dict[str, str] = {}
    for line in checksum_file.read_text().splitlines():
        digest, separator, filename = line.partition("  ")
        if not separator or filename not in expected or filename in hashes or not SHA256_PATTERN.fullmatch(digest):
            raise ValueError("Lista SHA256SUMS inválida")
        hashes[filename] = digest
    if set(hashes) != expected:
        raise ValueError("Faltan archivos del respaldo")
    for filename, expected_digest in hashes.items():
        file_path = path / filename
        if file_path.is_symlink() or not file_path.is_file():
            raise ValueError(f"Archivo inválido en respaldo: {filename}")
        digest = hashlib.sha256()
        with file_path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected_digest:
            raise ValueError(f"Hash incorrecto en respaldo: {filename}")
    if "database=algym" not in (path / "manifest.txt").read_text().splitlines():
        raise ValueError("El respaldo no corresponde a algym")


def store_files(media_root: Path, items: list[MediaItem]) -> int:
    if media_root.is_symlink() or not media_root.is_dir():
        raise ValueError("LOCAL_MEDIA_ROOT debe ser un directorio existente sin enlace simbólico")
    missing: list[tuple[MediaItem, Path]] = []
    for item in items:
        directory = media_root / item.kind
        if directory.is_symlink():
            raise ValueError(f"Directorio de media con enlace simbólico: {directory}")
        directory.mkdir(mode=0o700, exist_ok=True)
        destination = directory / item.filename
        if destination.is_symlink():
            raise ValueError(f"Archivo de destino con enlace simbólico: {destination}")
        if destination.exists():
            if destination.stat().st_size > MAX_BYTES or hashlib.sha256(destination.read_bytes()).hexdigest() != item.digest:
                raise ValueError(f"Archivo existente con hash incorrecto: {destination}")
            continue
        missing.append((item, destination))
    created = 0
    for item, destination in missing:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(destination, flags, 0o600), "wb") as output:
            output.write(item.data)
            output.flush()
            os.fsync(output.fileno())
        created += 1
    return created


def update_rows(args: argparse.Namespace, items: list[MediaItem]) -> None:
    statements = ["BEGIN;", "SET LOCAL lock_timeout = '5s';", "SET LOCAL statement_timeout = '60s';",
                  "DO $algym_media$ DECLARE changed integer; BEGIN"]
    for item in items:
        if item.kind == "exercises":
            statements.append(
                "UPDATE public.exercises SET image_url = {url}, animation_url = {url} "
                "WHERE id = {id}::bigint AND image_url IS NOT DISTINCT FROM {old_image} "
                "AND animation_url IS NOT DISTINCT FROM {old_animation};".format(
                    url=sql_literal(item.url), id=sql_literal(item.entity_id),
                    old_image=sql_literal(item.expected_image_url),
                    old_animation=sql_literal(item.expected_animation_url),
                )
            )
        else:
            statements.append(
                "UPDATE public.products SET image_url = {url} WHERE id = {id}::uuid "
                "AND image_url IS NOT DISTINCT FROM {old_image};".format(
                    url=sql_literal(item.url), id=sql_literal(item.entity_id),
                    old_image=sql_literal(item.expected_image_url),
                )
            )
        statements.append("GET DIAGNOSTICS changed = ROW_COUNT;")
        statements.append(
            f"IF changed <> 1 THEN RAISE EXCEPTION 'Conflicto al importar {item.kind}/{item.entity_id}'; END IF;"
        )
    statements += ["END $algym_media$;", "COMMIT;"]
    run_psql(args, "\n".join(statements))


def verify_imported_rows(args: argparse.Namespace, items: list[MediaItem]) -> None:
    rows = read_rows(args, items)
    for item in items:
        row = rows.get((item.kind, item.entity_id.lower()))
        if row is None or row["image_url"] != item.url or (
            item.kind == "exercises" and row["animation_url"] != item.url
        ):
            raise RuntimeError(f"No se confirmó la URL local de {item.kind}/{item.entity_id}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--media-root", type=Path, required=True)
    parser.add_argument("--db-mode", choices=("host", "compose"), default="host")
    parser.add_argument("--db-name", choices=("algym", "algym_test"), default="algym_test")
    parser.add_argument("--db-host", choices=("127.0.0.1", "localhost", "::1"), default="127.0.0.1")
    parser.add_argument("--db-port", type=int, default=5432)
    parser.add_argument("--db-user", default=getpass.getuser())
    parser.add_argument("--project-name", help="Proyecto Compose que contiene postgres")
    parser.add_argument("--backup", type=Path, help="Respaldo verificado obligatorio al aplicar en algym")
    parser.add_argument("--apply", action="store_true", help="Copiar archivos y actualizar PostgreSQL")
    args = parser.parse_args()

    if not (1 <= args.db_port <= 65535):
        raise ValueError("Puerto PostgreSQL inválido")
    if args.db_mode == "compose" and args.db_name != "algym":
        raise ValueError("El modo Compose solo admite la base algym del contenedor")
    if args.project_name and args.db_mode != "compose":
        raise ValueError("--project-name solo corresponde al modo Compose")
    if args.db_mode == "compose":
        require_local_docker_context()
    media_root = args.media_root.expanduser()
    if not media_root.is_absolute():
        raise ValueError("--media-root debe ser una ruta absoluta")
    items = read_manifest(args.manifest)
    if args.apply and args.db_name == "algym":
        if args.backup is None:
            raise ValueError("Para aplicar en algym se requiere --backup verificado")
        verify_backup(args.backup)
    verify_rows(args, items)
    if args.apply:
        created = store_files(media_root, items)
        try:
            update_rows(args, items)
        except RuntimeError:
            print(f"PostgreSQL rechazó la actualización; revisar hasta {created} archivos nuevos sin vínculo.",
                  file=sys.stderr)
            raise
        verify_imported_rows(args, items)
        for item in items:
            destination = media_root / item.kind / item.filename
            if not destination.is_file() or hashlib.sha256(destination.read_bytes()).hexdigest() != item.digest:
                raise RuntimeError(f"No se confirmó el archivo de {item.kind}/{item.entity_id}")
        print(f"Importados {len(items)} registros y {created} archivos nuevos en {args.db_name}")
    else:
        for item in items:
            print(f"{item.kind}/{item.entity_id}: {item.url} sha256={item.digest}")
        print(f"Validación sin escritura: {len(items)} registros de {args.db_name}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1) from None
