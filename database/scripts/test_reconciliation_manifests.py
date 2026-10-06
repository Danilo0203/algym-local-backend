#!/usr/bin/env python3
"""Casos que podrían ocultar diferencias durante un corte de datos."""

from __future__ import annotations

import csv
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from compare_reconciliation_manifests import compare, private_output
from export_reconciliation_manifest import copy_rows


class ReconciliationManifestTests(unittest.TestCase):
    def test_copy_preserves_multiline_values(self) -> None:
        # Una celda CSV puede contener un salto real, no solo el escape JSON.
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(['["id-1"]', 'primera línea\nsegunda línea'])
        writer.writerow(['["id-2"]', 'otra'])
        with patch("export_reconciliation_manifest.subprocess.run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = buffer.getvalue()
            self.assertEqual(
                copy_rows(["psql"], "COPY (SELECT 1) TO STDOUT WITH CSV"),
                [['["id-1"]', 'primera línea\nsegunda línea'], ['["id-2"]', 'otra']],
            )

    def test_same_counts_with_changed_ids_and_values_are_detected(self) -> None:
        source = {
            "captured_utc": "source",
            "entities": {"public.payments": {"[1]": "a", "[2]": "b"}, "public.empty": {}},
            "media": {"products/a.png": "a"},
        }
        target = {
            "captured_utc": "target",
            "entities": {"public.payments": {"[1]": "z", "[3]": "b"}},
            "media": {"products/b.png": "a"},
        }
        result = compare(source, target)
        self.assertEqual(result["entities"]["public.payments"], {
            "source_count": 2,
            "target_count": 2,
            "missing_in_target": ["[2]"],
            "extra_in_target": ["[3]"],
            "changed": ["[1]"],
        })
        self.assertEqual(result["missing_entities_in_target"], ["public.empty"])
        self.assertEqual(result["media"]["missing_in_target"], ["products/a.png"])

    def test_private_report_cannot_be_written_inside_checkout(self) -> None:
        with self.assertRaisesRegex(ValueError, "fuera de ambos repositorios"):
            private_output(Path(__file__).resolve().parent / "report.json")
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(private_output(Path(directory) / "report.json"), Path(directory).resolve() / "report.json")


if __name__ == "__main__":
    unittest.main()
