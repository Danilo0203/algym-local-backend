#!/usr/bin/env python3
"""Crea un manifiesto privado desde una copia local de ejercicios/productos/avatares."""

from __future__ import annotations

import argparse
import getpass
import json
import os
from pathlib import Path
import re
import sys

import import_local_media as importer


LOCAL_URL = {
    "exercises": re.compile(r"/api/media/exercises/[a-f0-9]{64}\.(?:png|jpg|webp|gif)\Z"),
    "products": re.compile(r"/api/media/products/[a-f0-9]{64}\.(?:png|jpg|webp|gif)\Z"),
    "avatars": re.compile(r"/api/media/avatars/[a-f0-9]{64}\.(?:png|jpg|webp|gif)\Z"),
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="JSON nuevo con permisos privados")
    parser.add_argument("--all", action="store_true", help="Incluir también filas sin URL o ya locales")
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
    if not args.output.is_absolute() or not args.output.parent.is_dir():
        raise ValueError("--output debe ser ruta absoluta en un directorio existente")

    payload = importer.run_psql(args, """
        SELECT COALESCE(json_agg(row_to_json(rows)), '[]'::json)
        FROM (
          SELECT 'exercises'::text AS kind, id::text AS id, image_url,
                 animation_url
          FROM public.exercises
          UNION ALL
          SELECT 'products'::text AS kind, id::text AS id, image_url,
                 NULL::text AS animation_url
          FROM public.products
          UNION ALL
          SELECT 'avatars'::text AS kind, id::text AS id, avatar_url AS image_url,
                 NULL::text AS animation_url
          FROM public.profiles
        ) AS rows;
    """)
    rows = json.loads(payload)
    items = []
    for row in sorted(rows, key=lambda value: (value["kind"], value["id"])):
        kind = row["kind"]
        old_urls = [row["image_url"]]
        if kind == "exercises":
            old_urls.append(row["animation_url"])
        if not args.all and not any(
            url is not None and not LOCAL_URL[kind].fullmatch(url) for url in old_urls
        ):
            continue
        expected_key = "expected_avatar_url" if kind == "avatars" else "expected_image_url"
        item = {"kind": kind, "id": row["id"],
                expected_key: row["image_url"], "file": ""}
        if kind == "exercises":
            item["expected_animation_url"] = row["animation_url"]
            if row["animation_url"] not in (None, row["image_url"]):
                item["animation_file"] = ""
        items.append(item)

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    data = (json.dumps({"version": 1, "items": items}, indent=2, ensure_ascii=False) + "\n").encode()
    with os.fdopen(os.open(args.output, flags, 0o600), "wb") as output:
        output.write(data)
    print(f"Manifiesto privado: {args.output} ({len(items)} filas; completar file antes de importar)")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1) from None
