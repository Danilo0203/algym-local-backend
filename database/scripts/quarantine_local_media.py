#!/usr/bin/env python3
"""Previsualiza o mueve media huérfana antigua a una cuarentena reversible.

Detener las escrituras del backend antes de --apply. La vista previa entrega un
SHA-256 que debe pasarse como --expect al aplicar. Nunca borra los archivos.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import time

import audit_local_media as auditor
import import_local_media as importer


def snapshot(args: argparse.Namespace, media_root: Path) -> dict:
    references, external_count, other_count, invalid_local = auditor.read_references(args)
    report = auditor.scan_files(media_root, references)
    if invalid_local or report["invalid_files"] or report["missing_references"]:
        raise ValueError("La auditoría contiene referencias o archivos inválidos; resolverlos antes de mover media")
    cutoff_ns = time.time_ns() - int(args.min_age_hours * 3_600_000_000_000)
    candidates = []
    skipped_recent = 0
    for relative in report["unreferenced_files"]:
        source = media_root / relative
        info = source.lstat()
        if not stat.S_ISREG(info.st_mode):
            raise ValueError(f"Cambió el archivo {relative}")
        if info.st_mtime_ns > cutoff_ns:
            skipped_recent += 1
            continue
        candidates.append({"file": relative, "size": info.st_size,
                           "mtime_ns": info.st_mtime_ns, "device": info.st_dev,
                           "inode": info.st_ino})
    return {"database": args.db_name, "media_root": str(media_root),
            "references": sorted(references), "external_reference_count": external_count,
            "other_reference_count": other_count, "min_age_hours": args.min_age_hours,
            "skipped_recent": skipped_recent, "candidates": candidates}


def fingerprint(data: dict) -> str:
    encoded = json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def verify_candidate(media_root: Path, item: dict) -> Path:
    source = media_root / item["file"]
    info = source.lstat()
    if not stat.S_ISREG(info.st_mode) or any(
        getattr(info, name) != item[key]
        for name, key in (("st_size", "size"), ("st_mtime_ns", "mtime_ns"),
                          ("st_dev", "device"), ("st_ino", "inode"))
    ):
        raise ValueError(f"Cambió el archivo {item['file']}")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(source, flags), "rb") as stream:
        opened = os.fstat(stream.fileno())
        if opened.st_dev != info.st_dev or opened.st_ino != info.st_ino:
            raise ValueError(f"Cambió el archivo {item['file']}")
        payload = stream.read(importer.MAX_BYTES + 1)
    if len(payload) != info.st_size or hashlib.sha256(payload).hexdigest() != source.name[:64]:
        raise ValueError(f"Hash incorrecto para {item['file']}")
    if importer.image_extension(payload) != source.suffix[1:]:
        raise ValueError(f"Firma de imagen incorrecta para {item['file']}")
    return source


def quarantine(args: argparse.Namespace, media_root: Path, data: dict, digest: str) -> int:
    if not args.writers_stopped:
        raise ValueError("--apply requiere --writers-stopped después de detener las escrituras")
    if args.db_name == "algym":
        if args.backup is None:
            raise ValueError("--apply en algym requiere --backup verificado de DB y media")
        importer.verify_backup(args.backup)
    target = args.quarantine_dir
    if target is None or not target.is_absolute() or target.exists() or target.is_symlink():
        raise ValueError("--quarantine-dir debe ser una ruta absoluta nueva")
    parent = target.parent
    if not parent.is_dir() or parent.is_symlink():
        raise ValueError("El padre de la cuarentena debe ser un directorio normal existente")
    if target.resolve().is_relative_to(media_root.resolve()):
        raise ValueError("La cuarentena debe estar fuera de LOCAL_MEDIA_ROOT")
    if parent.stat().st_dev != media_root.stat().st_dev:
        raise ValueError("La cuarentena debe estar en el mismo sistema de archivos")
    current = snapshot(args, media_root)
    if fingerprint(current) != digest or current != data:
        raise ValueError("Cambió la auditoría; obtener una vista previa nueva")
    target.mkdir(mode=0o700)
    moved: list[tuple[Path, Path]] = []
    try:
        for item in data["candidates"]:
            current_refs, _, _, _ = auditor.read_references(args)
            url = "/api/media/" + item["file"]
            if url in current_refs:
                raise ValueError(f"El archivo pasó a estar referenciado: {item['file']}")
            source = verify_candidate(media_root, item)
            destination = target / item["file"]
            destination.parent.mkdir(mode=0o700, exist_ok=True)
            if destination.exists() or destination.is_symlink():
                raise ValueError(f"Destino ocupado: {item['file']}")
            source.rename(destination)
            moved.append((source, destination))
        current_refs, _, _, _ = auditor.read_references(args)
        if any("/api/media/" + item["file"] in current_refs for item in data["candidates"]):
            raise ValueError("Apareció una referencia durante la cuarentena")
        manifest = {"version": 1, "snapshot_sha256": digest,
                    "source_media_root": str(media_root), "files": data["candidates"]}
        with (target / "manifest.json").open("x", encoding="utf-8") as output:
            os.fchmod(output.fileno(), 0o600)
            json.dump(manifest, output, indent=2)
            output.flush()
            os.fsync(output.fileno())
    except Exception:
        for source, destination in reversed(moved):
            if source.exists() or source.is_symlink():
                raise RuntimeError(f"No se pudo revertir {source}; quedó en {destination}")
            destination.rename(source)
        raise
    return len(moved)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--media-root", type=Path, required=True)
    parser.add_argument("--db-mode", choices=("host", "compose"), default="host")
    parser.add_argument("--db-name", choices=("algym", "algym_test"), default="algym_test")
    parser.add_argument("--db-host", choices=("127.0.0.1", "localhost", "::1"), default="127.0.0.1")
    parser.add_argument("--db-port", type=int, default=5432)
    parser.add_argument("--db-user", default=getpass.getuser())
    parser.add_argument("--project-name")
    parser.add_argument("--min-age-hours", type=int, default=24)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expect", help="SHA-256 de la vista previa")
    parser.add_argument("--backup", type=Path)
    parser.add_argument("--quarantine-dir", type=Path)
    parser.add_argument("--writers-stopped", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.db_port <= 65535 or args.min_age_hours < 0:
        raise ValueError("Puerto o antigüedad inválidos")
    if args.db_mode == "compose" and args.db_name != "algym":
        raise ValueError("Compose solo admite algym")
    if args.project_name and args.db_mode != "compose":
        raise ValueError("--project-name requiere Compose")
    if args.db_mode == "compose":
        importer.require_local_docker_context()
    media_root = args.media_root.expanduser()
    if not media_root.is_absolute() or media_root.is_symlink() or not media_root.is_dir():
        raise ValueError("--media-root debe ser un directorio absoluto sin enlace simbólico")
    data = snapshot(args, media_root)
    digest = fingerprint(data)
    if args.apply:
        if args.expect != digest:
            raise ValueError("--expect no coincide con la vista previa actual")
        moved = quarantine(args, media_root, data, digest)
        print(json.dumps({"moved": moved, "quarantine_dir": str(args.quarantine_dir),
                          "snapshot_sha256": digest}, ensure_ascii=False))
    else:
        print(json.dumps({"snapshot_sha256": digest, "database": args.db_name,
                          "min_age_hours": args.min_age_hours,
                          "skipped_recent": data["skipped_recent"],
                          "candidates": data["candidates"]}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1) from None
