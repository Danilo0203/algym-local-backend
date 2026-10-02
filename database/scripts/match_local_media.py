#!/usr/bin/env python3
"""Sugiere archivos locales para un manifiesto de media, sin red ni escrituras SQL.

Solo empareja sufijos exactos de la ruta de la URL con al menos dos segmentos
(por ejemplo, bucket/ejercicio.png). Una coincidencia ambigua queda vacía.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
import os
from pathlib import Path
import stat
import sys
from urllib.parse import unquote, urlsplit

import import_local_media as importer


def url_segments(value: object) -> tuple[str, ...]:
    if not isinstance(value, str):
        return ()
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return ()
    segments = []
    for encoded in parsed.path.split("/"):
        if not encoded:
            continue
        segment = unquote(encoded)
        if segment in (".", "..") or "/" in segment or "\\" in segment or any(
            ord(character) < 32 or ord(character) == 127 for character in segment
        ):
            return ()
        segments.append(segment)
    return tuple(segments)


def index_files(root: Path) -> dict[tuple[str, ...], list[Path]]:
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise ValueError("--files-root debe ser un directorio absoluto normal")
    suffixes: dict[tuple[str, ...], list[Path]] = defaultdict(list)
    for current, dirs, names in os.walk(root, followlinks=False):
        base = Path(current)
        dirs[:] = sorted(name for name in dirs if not (base / name).is_symlink())
        for name in sorted(names):
            path = base / name
            if not stat.S_ISREG(path.lstat().st_mode):
                continue
            parts = path.relative_to(root).parts
            for length in range(2, len(parts) + 1):
                suffixes[parts[-length:]].append(path)
    return suffixes


def find_file(value: object, index: dict[tuple[str, ...], list[Path]]) -> tuple[Path | None, str]:
    segments = url_segments(value)
    if len(segments) < 2:
        return None, "sin_ruta_segura"
    for length in range(len(segments), 1, -1):
        matches = index.get(segments[-length:], [])
        if len(matches) == 1:
            return matches[0], "coincidencia"
        if len(matches) > 1:
            return None, "ambigua"
    return None, "sin_archivo"


def complete_manifest(raw: dict, index: dict[tuple[str, ...], list[Path]]) -> tuple[dict, Counter]:
    if raw.get("version") != 1 or not isinstance(raw.get("items"), list):
        raise ValueError("Se requiere un manifiesto JSON con version=1 e items")
    counts: Counter = Counter()
    items = []
    for number, original in enumerate(raw["items"], start=1):
        if not isinstance(original, dict) or original.get("kind") not in (
            "exercises", "products", "avatars"
        ) or not isinstance(original.get("id"), str):
            raise ValueError(f"Elemento {number}: kind o id inválido")
        row = original.copy()
        expected = "expected_avatar_url" if row["kind"] == "avatars" else "expected_image_url"
        if expected not in row or not isinstance(row[expected], (str, type(None))):
            raise ValueError(f"Elemento {number}: falta {expected}")
        fields = [("file", "sha256", expected)]
        if row["kind"] == "exercises":
            if "expected_animation_url" not in row or not isinstance(
                row["expected_animation_url"], (str, type(None))
            ):
                raise ValueError(f"Elemento {number}: falta expected_animation_url")
            if row["expected_animation_url"] not in (None, row[expected]):
                fields.append(("animation_file", "animation_sha256", "expected_animation_url"))
        for field, digest_field, url_field in fields:
            if row.get(field) not in (None, ""):
                counts["manual"] += 1
                continue
            if field == "animation_file" and field in row and row[field] is None:
                counts["manual"] += 1  # null limpia la animación deliberadamente
                continue
            path, status = find_file(row[url_field], index)
            if path is None:
                counts[status] += 1
                continue
            try:
                _, _, digest, _ = importer.read_image_file(str(path), None, number, field)
            except (OSError, ValueError):
                counts["archivo_invalido"] += 1
                continue
            if digest_field in row and row[digest_field] != digest:
                counts["hash_distinto"] += 1
                continue
            row[field] = str(path)
            row[digest_field] = digest
            counts["emparejado"] += 1
        items.append(row)
    completed = raw.copy()
    completed["items"] = items
    return completed, counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="Manifiesto privado exportado")
    parser.add_argument("--files-root", type=Path, required=True,
                        help="Carpeta absoluta con los archivos descargados")
    parser.add_argument("--output", type=Path, required=True,
                        help="Nuevo manifiesto privado; nunca sobrescribe")
    args = parser.parse_args()
    if args.manifest.is_symlink() or not args.manifest.is_file():
        raise ValueError("El manifiesto debe ser un archivo normal")
    if not args.output.is_absolute() or not args.output.parent.is_dir():
        raise ValueError("--output debe ser ruta absoluta en un directorio existente")
    raw = json.loads(args.manifest.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("El manifiesto debe ser un objeto JSON")
    completed, counts = complete_manifest(raw, index_files(args.files_root))
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    data = (json.dumps(completed, indent=2, ensure_ascii=False) + "\n").encode()
    with os.fdopen(os.open(args.output, flags, 0o600), "wb") as output:
        output.write(data)
    print(f"Manifiesto privado: {args.output} ({len(completed['items'])} entidades)")
    print("Campos: " + ", ".join(f"{key}={value}" for key, value in sorted(counts.items())))
    print("Revisar los campos vacíos antes de usar import_local_media.py; no se cambió PostgreSQL.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1) from None
