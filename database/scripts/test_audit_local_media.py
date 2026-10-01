#!/usr/bin/env python3
"""Ensaya el inventario de media sobre algym_test sin borrar archivos ni filas."""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("audit_local_media.py")
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII="
)


def psql(sql: str) -> str:
    result = subprocess.run(
        ["psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
         "--host", "127.0.0.1", "--dbname", "algym_test", "-c", sql],
        capture_output=True, text=True, check=True,
    )
    return result.stdout.strip()


class AuditLocalMediaTest(unittest.TestCase):
    def test_reports_orphans_missing_files_and_corruption_without_writes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="algym-audit-media-", dir="/private/tmp") as temporary:
            root = Path(temporary)
            media_root = root / "media"
            exercise_dir = media_root / "exercises"
            product_dir = media_root / "products"
            exercise_dir.mkdir(parents=True)
            product_dir.mkdir()
            digest = hashlib.sha256(PNG).hexdigest()
            filename = f"{digest}.png"
            exercise_file = exercise_dir / filename
            orphan_file = product_dir / filename
            exercise_file.write_bytes(PNG)
            orphan_file.write_bytes(PNG)
            corrupt_file = exercise_dir / f"{'0' * 64}.png"
            corrupt_file.write_bytes(PNG)
            (product_dir / "link.png").symlink_to(exercise_file)
            exercise_url = f"/api/media/exercises/{filename}"
            missing_url = f"/api/media/products/{'f' * 64}.png"

            exercise_id = psql(
                "INSERT INTO public.exercises (name, image_url, animation_url) "
                f"VALUES ('ZZTEST AUDIT MEDIA ejercicio', '{exercise_url}', '{exercise_url}') RETURNING id"
            )
            product_id = psql(
                "INSERT INTO public.products (name, sale_price, image_url) "
                f"VALUES ('ZZTEST AUDIT MEDIA producto', 10, '{missing_url}') RETURNING id"
            )
            remote_product_id = psql(
                "INSERT INTO public.products (name, sale_price, image_url) "
                "VALUES ('ZZTEST AUDIT MEDIA remoto', 10, 'https://old.example/image.png') RETURNING id"
            )
            try:
                before = psql(
                    "SELECT image_url FROM public.products "
                    f"WHERE id = '{product_id}'"
                )
                result = subprocess.run(
                    ["python3", str(SCRIPT), "--media-root", str(media_root)],
                    capture_output=True, text=True, check=True,
                )
                report = json.loads(result.stdout)
                self.assertEqual(report["database"], "algym_test")
                self.assertEqual(report["local_reference_count"], 2)
                self.assertGreaterEqual(report["external_reference_count"], 1)
                self.assertEqual(report["referenced_file_count"], 1)
                self.assertIn(f"products/{filename}", report["unreferenced_files"])
                self.assertIn(missing_url, report["missing_references"])
                self.assertIn(f"exercises/{'0' * 64}.png",
                              {row["file"] for row in report["invalid_files"]})
                self.assertIn("products/link.png", {row["file"] for row in report["invalid_files"]})
                self.assertEqual(exercise_file.read_bytes(), PNG)
                self.assertEqual(orphan_file.read_bytes(), PNG)
                self.assertEqual(psql(f"SELECT image_url FROM public.products WHERE id = '{product_id}'"), before)

                denied = subprocess.run(
                    ["python3", str(SCRIPT), "--media-root", str(media_root),
                     "--db-host", "remote.example"],
                    capture_output=True, text=True, check=False,
                )
                self.assertNotEqual(denied.returncode, 0)
            finally:
                psql(f"DELETE FROM public.exercises WHERE id = {exercise_id}")
                psql(f"DELETE FROM public.products WHERE id IN ('{product_id}', '{remote_product_id}')")


if __name__ == "__main__":
    unittest.main()
