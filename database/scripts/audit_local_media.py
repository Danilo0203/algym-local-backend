#!/usr/bin/env python3
"""Compara las imágenes del disco con las URLs de PostgreSQL local, sin modificar nada.

Incluye image_url y animation_url de ejercicios, image_url de productos y avatar_url de perfiles.
Informa archivos sin vínculo, referencias sin archivo válido y archivos inválidos.
El informe puede contener nombres de archivos locales: consérvalo fuera de Git.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

import import_local_media as importer


FILENAME = re.compile(r"[a-f0-9]{64}\.(png|jpg|webp|gif)\Z")
KINDS = ("exercises", "products", "avatars")


def read_references(args: argparse.Namespace) -> tuple[set[str], int, int, list[str]]:
    payload = importer.run_psql(args, """
        SELECT COALESCE(json_agg(row_to_json(rows)), '[]'::json)
        FROM (
          SELECT 'exercises'::text AS kind, image_url AS url FROM public.exercises
          UNION ALL
          SELECT 'exercises'::text AS kind, animation_url AS url FROM public.exercises
          UNION ALL
          SELECT 'products'::text AS kind, image_url AS url FROM public.products
          UNION ALL
          SELECT 'avatars'::text AS kind, avatar_url AS url FROM public.profiles
        ) AS rows
        WHERE url IS NOT NULL;
    """)
    rows = json.loads(payload)
    references: set[str] = set()
    invalid_local: set[str] = set()
    external_count = 0
    other_count = 0
    for row in rows:
        kind, url = row["kind"], row["url"]
        if not isinstance(kind, str) or not isinstance(url, str):
            raise ValueError("PostgreSQL devolvió una referencia de media inválida")
        prefix = f"/api/media/{kind}/"
        if url.startswith(prefix):
            if FILENAME.fullmatch(url[len(prefix):]):
                references.add(url)
            else:
                invalid_local.add(url)
        elif url.startswith("/api/media/"):
            invalid_local.add(url)
        elif url.startswith(("http://", "https://", "//")):
            external_count += 1
        else:
            other_count += 1
    return references, external_count, other_count, sorted(invalid_local)


def scan_files(media_root: Path, references: set[str]) -> dict:
    if media_root.is_symlink() or not media_root.is_dir():
        raise ValueError("--media-root debe ser un directorio existente sin enlace simbólico")
    valid: set[str] = set()
    unreferenced: list[str] = []
    invalid: list[dict[str, str]] = []
    for kind in KINDS:
        directory = media_root / kind
        if directory.is_symlink():
            raise ValueError(f"Directorio de media con enlace simbólico: {kind}")
        if not directory.exists():
            continue
        if not directory.is_dir():
            raise ValueError(f"La ruta de media no es directorio: {kind}")
        for entry in sorted(directory.iterdir(), key=lambda item: item.name):
            relative = f"{kind}/{entry.name}"
            metadata = entry.lstat()
            if not stat.S_ISREG(metadata.st_mode):
                invalid.append({"file": relative, "reason": "no es archivo normal"})
                continue
            match = FILENAME.fullmatch(entry.name)
            if not match:
                invalid.append({"file": relative, "reason": "nombre inválido"})
                continue
            if metadata.st_size == 0 or metadata.st_size > importer.MAX_BYTES:
                invalid.append({"file": relative, "reason": "tamaño fuera del límite de 5 MB"})
                continue
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            with os.fdopen(os.open(entry, flags), "rb") as stream:
                opened = os.fstat(stream.fileno())
                if (not stat.S_ISREG(opened.st_mode) or opened.st_dev != metadata.st_dev
                        or opened.st_ino != metadata.st_ino or opened.st_size != metadata.st_size):
                    invalid.append({"file": relative, "reason": "archivo cambió durante la lectura"})
                    continue
                data = stream.read(importer.MAX_BYTES + 1)
            if len(data) != metadata.st_size or hashlib.sha256(data).hexdigest() != entry.name[:64]:
                invalid.append({"file": relative, "reason": "SHA-256 no coincide"})
                continue
            try:
                extension = importer.image_extension(data)
            except ValueError:
                extension = None
            if extension != match.group(1):
                invalid.append({"file": relative, "reason": "firma de imagen no coincide"})
                continue
            url = f"/api/media/{relative}"
            valid.add(url)
            if url not in references:
                unreferenced.append(relative)
    return {
        "valid_file_count": len(valid),
        "referenced_file_count": len(valid & references),
        "unreferenced_files": unreferenced,
        "invalid_files": invalid,
        "missing_references": sorted(references - valid),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--media-root", type=Path, required=True)
    parser.add_argument("--db-mode", choices=("host", "compose"), default="host")
    parser.add_argument("--db-name", choices=("algym", "algym_test"), default="algym_test")
    parser.add_argument("--db-host", choices=("127.0.0.1", "localhost", "::1"), default="127.0.0.1")
    parser.add_argument("--db-port", type=int, default=5432)
    parser.add_argument("--db-user", default=getpass.getuser())
    parser.add_argument("--project-name")
    args = parser.parse_args()

    if not (1 <= args.db_port <= 65535):
        raise ValueError("Puerto PostgreSQL inválido")
    if args.db_mode == "compose" and args.db_name != "algym":
        raise ValueError("El modo Compose solo admite algym")
    if args.project_name and args.db_mode != "compose":
        raise ValueError("--project-name solo corresponde a Compose")
    if args.db_mode == "compose":
        importer.require_local_docker_context()
    media_root = args.media_root.expanduser()
    if not media_root.is_absolute():
        raise ValueError("--media-root debe ser una ruta absoluta")
    references, external_count, other_count, invalid_local = read_references(args)
    result = scan_files(media_root, references)
    result.update({"database": args.db_name, "local_reference_count": len(references),
                   "external_reference_count": external_count,
                   "other_reference_count": other_count,
                   "invalid_local_references": invalid_local})
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1) from None
