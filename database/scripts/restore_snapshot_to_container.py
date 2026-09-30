#!/usr/bin/env python3
"""Restaura un respaldo completo en un PostgreSQL de Compose vacío y aislado."""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile


BACKEND_ROOT = Path(__file__).resolve().parents[2]
WEB_ROOT = BACKEND_ROOT.parent / "al-gym-sys"
COMPOSE_FILE = WEB_ROOT / "docker-compose.yml"


def read_env(path: Path, name: str) -> str:
    for line in path.read_text().splitlines():
        if line.startswith(name + "="):
            value = line.split("=", 1)[1].strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            if value:
                return value
    raise RuntimeError(f"Falta {name} en {path}")


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def verify_backup(backup_dir: Path) -> tuple[Path, list[tarfile.TarInfo], int]:
    expected = {"database.dump", "media.tar", "manifest.txt"}
    hashes = {}
    for line in (backup_dir / "SHA256SUMS").read_text().splitlines():
        digest, separator, filename = line.partition("  ")
        if not separator or filename not in expected or filename in hashes:
            raise RuntimeError("Lista de hashes inválida")
        hashes[filename] = digest
    if set(hashes) != expected:
        raise RuntimeError("El respaldo no contiene los tres archivos requeridos")

    for filename, expected_digest in hashes.items():
        file_path = backup_dir / filename
        if file_path.is_symlink() or not file_path.is_file():
            raise RuntimeError(f"Archivo de respaldo inválido: {filename}")
        digest = hashlib.sha256()
        with file_path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected_digest:
            raise RuntimeError(f"Hash incorrecto: {filename}")

    manifest = dict(
        line.split("=", 1) for line in (backup_dir / "manifest.txt").read_text().splitlines()
        if "=" in line
    )
    if manifest.get("database") != "algym":
        raise RuntimeError("El respaldo no corresponde a algym")
    expected_media_count = int(manifest["media_files"])

    with tarfile.open(backup_dir / "media.tar", "r:") as archive:
        members = archive.getmembers()
    count = 0
    for member in members:
        path = PurePosixPath(member.name)
        if (path.is_absolute() or ".." in path.parts or "\\" in member.name
                or (path.parts and ":" in path.parts[0])
                or not (member.isfile() or member.isdir())):
            raise RuntimeError("El archivo de media contiene una ruta o tipo no permitido")
        if member.isfile() and not path.name.startswith("._"):
            count += 1
    if count != expected_media_count:
        raise RuntimeError("El número de archivos de media no coincide con el manifiesto")
    return backup_dir / "database.dump", members, expected_media_count


def compose_command(project_name: str | None) -> list[str]:
    command = ["docker", "compose", "-f", str(COMPOSE_FILE)]
    if project_name:
        command += ["-p", project_name]
    return command + ["--profile", "container-db"]


def run(command: list[str], *, input_data: bytes | None = None) -> bytes:
    result = subprocess.run(command, input=input_data, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise RuntimeError(f"Falló {' '.join(command[:3])}; revisa el contenedor y los roles")
    return result.stdout


def psql(compose: list[str], database: str, sql: str) -> str:
    output = run(compose + ["exec", "-T", "postgres", "psql", "-X", "-q", "-A", "-t",
                            "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database],
                 input_data=sql.encode())
    return output.decode().strip()


def restore_media(archive_path: Path, members: list[tarfile.TarInfo], target: Path) -> None:
    target.mkdir(parents=True, mode=0o700, exist_ok=True)
    with tarfile.open(archive_path, "r:") as archive:
        for member in members:
            if PurePosixPath(member.name).name.startswith("._"):
                continue
            parts = [part for part in PurePosixPath(member.name).parts if part != "."]
            if not parts:
                continue
            destination = target.joinpath(*parts)
            if member.isdir():
                destination.mkdir(parents=True, mode=0o700, exist_ok=True)
                continue
            destination.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise RuntimeError("No se pudo extraer un archivo de media")
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
            with source, os.fdopen(os.open(destination, flags, 0o600), "wb") as output:
                shutil.copyfileobj(source, output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("backup_dir", type=Path)
    parser.add_argument("--media-target", type=Path, required=True,
                        help="Directorio nuevo y vacío para restaurar los archivos")
    parser.add_argument("--project-name", help="Nombre de proyecto Docker Compose aislado")
    args = parser.parse_args()

    backup_dir = args.backup_dir.resolve(strict=True)
    dump_path, media_members, expected_media_count = verify_backup(backup_dir)
    media_target = args.media_target.expanduser()
    if media_target.is_symlink() or (media_target.exists() and any(media_target.iterdir())):
        raise RuntimeError("El destino de media debe ser un directorio vacío sin enlace simbólico")
    if not COMPOSE_FILE.is_file():
        raise RuntimeError("No existe docker-compose.yml en el repositorio hermano")

    compose = compose_command(args.project_name)
    container_id = run(compose + ["ps", "-q", "postgres"]).decode().strip()
    if not container_id:
        raise RuntimeError("Primero inicia el servicio postgres del perfil container-db")
    if psql(compose, "postgres", "SELECT 1 FROM pg_database WHERE datname = 'algym';"):
        raise RuntimeError("La base algym ya existe; no se sobrescribirá")
    existing_roles = psql(compose, "postgres", """
        SELECT rolname FROM pg_roles WHERE rolname IN
        ('algym_migrator','algym_app','algym_sync','anon','authenticated','service_role');
    """)
    if existing_roles:
        raise RuntimeError("Ya existen roles de ALGYM; se requiere una instancia vacía")

    app_password = read_env(BACKEND_ROOT / ".env", "DB_PASSWORD")
    sync_password = read_env(WEB_ROOT / "deploy/env/sync.env", "DB_PASSWORD")
    roles_sql = "\n".join([
        "CREATE ROLE algym_migrator NOLOGIN CREATEDB;",
        f"CREATE ROLE algym_app LOGIN PASSWORD {sql_literal(app_password)};",
        f"CREATE ROLE algym_sync LOGIN PASSWORD {sql_literal(sync_password)};",
        "CREATE ROLE anon NOLOGIN;",
        "CREATE ROLE authenticated NOLOGIN;",
        "CREATE ROLE service_role NOLOGIN BYPASSRLS;",
        "CREATE DATABASE algym OWNER algym_migrator;",
    ])
    psql(compose, "postgres", roles_sql)
    with dump_path.open("rb") as source:
        result = subprocess.run(
            compose + ["exec", "-T", "postgres", "pg_restore", "-U", "postgres", "-d", "algym",
                       "--role=algym_migrator", "--no-owner", "--single-transaction", "--exit-on-error"],
            stdin=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
    if result.returncode:
        raise RuntimeError("Falló pg_restore; la base parcial queda para inspección")
    psql(compose, "postgres", "GRANT authenticated TO algym_app;")
    counts = psql(compose, "algym", """
        SELECT 'profiles=' || count(*) FROM public.profiles;
        SELECT 'payments=' || count(*) FROM public.payments;
        SELECT 'attendance_logs=' || count(*) FROM public.attendance_logs;
    """)
    restore_media(backup_dir / "media.tar", media_members, media_target)
    actual_media_count = sum(path.is_file() for path in media_target.rglob("*"))
    if actual_media_count != expected_media_count:
        raise RuntimeError("El conteo de media restaurada no coincide")
    print("Restauración en instancia independiente verificada:")
    print(counts)
    print(f"media_files={actual_media_count}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, KeyError, ValueError, tarfile.TarError, RuntimeError) as error:
        print(f"Restauración detenida: {error}", file=sys.stderr)
        sys.exit(1)
