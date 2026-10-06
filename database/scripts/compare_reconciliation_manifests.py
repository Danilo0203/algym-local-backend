#!/usr/bin/env python3
"""Compara dos manifiestos privados sin mostrar datos de las filas."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys


FORMAT = "algym-reconciliation-v1"
BACKEND_ROOT = Path(__file__).resolve().parents[2]
WEB_ROOT = BACKEND_ROOT.parent / "al-gym-sys"


def private_output(path: Path) -> Path:
    if not path.is_absolute():
        raise ValueError("El reporte requiere una ruta absoluta")
    destination = path.parent.resolve(strict=True) / path.name
    if any(destination.is_relative_to(root) for root in (BACKEND_ROOT, WEB_ROOT)):
        raise ValueError("Guardar el reporte privado fuera de ambos repositorios")
    if destination.exists() or destination.is_symlink():
        raise ValueError("El reporte ya existe; no se sobrescribirá")
    return destination


def validate_items(items: object, label: str) -> None:
    if not isinstance(items, dict) or any(
        not isinstance(key, str) or not isinstance(value, str) or len(value) != 64
        or any(char not in "0123456789abcdef" for char in value)
        for key, value in items.items()
    ):
        raise ValueError(f"Huellas inválidas: {label}")


def read_manifest(path: Path) -> dict:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Manifiesto inválido: {path}")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError(f"Contenido inválido: {path}")
    if manifest.get("format") != FORMAT:
        raise ValueError(f"Formato inválido: {path}")
    if not isinstance(manifest.get("entities"), dict):
        raise ValueError(f"Contenido inválido: {path}")
    for name, items in manifest["entities"].items():
        if not isinstance(name, str):
            raise ValueError(f"Entidad inválida: {path}")
        validate_items(items, name)
    validate_items(manifest.get("media"), "media")
    return manifest


def compare_items(source: dict[str, str], target: dict[str, str]) -> dict:
    return {
        "source_count": len(source),
        "target_count": len(target),
        "missing_in_target": sorted(source.keys() - target.keys()),
        "extra_in_target": sorted(target.keys() - source.keys()),
        "changed": sorted(key for key in source.keys() & target.keys() if source[key] != target[key]),
    }


def compare(source: dict, target: dict) -> dict:
    source_entities = source["entities"]
    target_entities = target["entities"]
    entities = {}
    for name in sorted(source_entities.keys() | target_entities.keys()):
        entities[name] = compare_items(source_entities.get(name, {}), target_entities.get(name, {}))
    return {
        "format": "algym-reconciliation-diff-v1",
        "source_captured_utc": source.get("captured_utc"),
        "target_captured_utc": target.get("captured_utc"),
        "missing_entities_in_target": sorted(source_entities.keys() - target_entities.keys()),
        "extra_entities_in_target": sorted(target_entities.keys() - source_entities.keys()),
        "entities": entities,
        "media": compare_items(source["media"], target["media"]),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    result = compare(read_manifest(args.source), read_manifest(args.target))
    different = bool(result["missing_entities_in_target"] or result["extra_entities_in_target"])
    if different:
        print(
            "Tablas/vistas: faltan="
            f"{len(result['missing_entities_in_target'])} "
            f"sobran={len(result['extra_entities_in_target'])}"
        )
    for name, differences in [*result["entities"].items(), ("media", result["media"])]:
        counts = tuple(len(differences[key]) for key in ("missing_in_target", "extra_in_target", "changed"))
        if any(counts):
            different = True
            print(
                f"{name}: origen={differences['source_count']} "
                f"destino={differences['target_count']} "
                f"faltan={counts[0]} sobran={counts[1]} cambiaron={counts[2]}"
            )
    if not different:
        print("Sin diferencias de IDs, valores de filas ni archivos")
    if args.report:
        destination = private_output(args.report)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(destination, flags, 0o600), "w", encoding="utf-8") as output:
            json.dump(result, output, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
            output.write("\n")
        print(f"Detalle privado: {destination}")
    if different:
        sys.exit(2)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Comparación detenida: {error}", file=sys.stderr)
        sys.exit(1)
