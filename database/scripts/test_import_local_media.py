#!/usr/bin/env python3
"""Prueba el importador solo sobre algym_test y un directorio temporal."""

from __future__ import annotations

from argparse import Namespace
import base64
from dataclasses import replace
import getpass
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

from database.scripts import import_local_media as importer


SCRIPT = Path(__file__).with_name("import_local_media.py")
EXPORTER = Path(__file__).with_name("export_media_inventory.py")
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII="
)
GIF = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==")


def psql(sql: str) -> str:
    result = subprocess.run(
        ["psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
         "--host", "127.0.0.1", "--dbname", "algym_test", "-c", sql],
        capture_output=True, text=True, check=True,
    )
    return result.stdout.strip()


class ImportLocalMediaTest(unittest.TestCase):
    def test_distinct_historical_animation_needs_explicit_mapping_or_clear(self) -> None:
        with tempfile.TemporaryDirectory(prefix="algym-animation-manifest-", dir="/private/tmp") as temporary:
            root = Path(temporary)
            source = root / "exercise.png"
            source.write_bytes(PNG)
            manifest = root / "manifest.json"
            row = {"kind": "exercises", "id": "123", "file": str(source),
                   "expected_image_url": "https://old.example/image.png",
                   "expected_animation_url": "https://old.example/animation.gif"}
            manifest.write_text(json.dumps({"version": 1, "items": [row]}))
            with self.assertRaisesRegex(ValueError, "animación histórica es distinta"):
                importer.read_manifest(manifest)
            row["animation_file"] = str(source)
            row["animation_sha256"] = "0" * 64
            manifest.write_text(json.dumps({"version": 1, "items": [row]}))
            with self.assertRaisesRegex(ValueError, "SHA-256 incorrecto para animation_file"):
                importer.read_manifest(manifest)
            row.pop("animation_sha256")
            row["animation_file"] = None
            manifest.write_text(json.dumps({"version": 1, "items": [row]}))
            self.assertIsNone(importer.read_manifest(manifest)[0].animation_url)
            row.pop("animation_file")
            row["expected_animation_url"] = row["expected_image_url"]
            manifest.write_text(json.dumps({"version": 1, "items": [row]}))
            item = importer.read_manifest(manifest)[0]
            self.assertEqual(item.animation_url, item.url)
            link = root / "linked.png"
            link.symlink_to(source)
            row["file"] = str(link)
            manifest.write_text(json.dumps({"version": 1, "items": [row]}))
            with self.assertRaisesRegex(ValueError, "enlace simbólico"):
                importer.read_manifest(manifest)

    def test_dry_run_apply_and_stale_guard(self) -> None:
        with tempfile.TemporaryDirectory(prefix="algym-import-media-", dir="/private/tmp") as temporary:
            root = Path(temporary)
            media_root = root / "media"
            media_root.mkdir()
            source = root / "exercise.png"
            source.write_bytes(PNG)
            animation_source = root / "exercise.gif"
            animation_source.write_bytes(GIF)
            digest = hashlib.sha256(PNG).hexdigest()
            animation_digest = hashlib.sha256(GIF).hexdigest()
            exercise_id = psql(
                "INSERT INTO public.exercises (name, image_url, animation_url) "
                "VALUES ('ZZTEST IMPORT MEDIA ejercicio', 'https://old.example/exercise.png', "
                "'https://old.example/animation.gif') RETURNING id"
            )
            product_id = psql(
                "INSERT INTO public.products (name, sale_price, image_url) "
                "VALUES ('ZZTEST IMPORT MEDIA producto', 10, 'https://old.example/product.png') RETURNING id"
            )
            avatar_id = str(uuid.uuid4())
            psql("INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, created_at, updated_at) "
                 f"VALUES ('{avatar_id}', '{avatar_id}@media-import.test.local', 'unused', '{{}}'::jsonb, now(), now())")
            psql("INSERT INTO public.profiles "
                 "(id, full_name, phone, birth_date, gender, role, biometric_id, is_active, avatar_url) "
                 f"VALUES ('{avatar_id}', 'ZZTEST IMPORT MEDIA avatar', '55540000', DATE '1990-01-01', "
                 f"'male', 'client', {int(avatar_id.replace('-', '')[:7], 16) % 9000000 + 1000000}, true, "
                 "'https://old.example/avatar.png')")
            try:
                inventory = root / "inventory.json"
                subprocess.run(["python3", str(EXPORTER), "--output", str(inventory)],
                               capture_output=True, text=True, check=True)
                exported = json.loads(inventory.read_text())["items"]
                by_key = {(item["kind"], item["id"]): item for item in exported}
                self.assertEqual(by_key[("exercises", exercise_id)]["expected_animation_url"],
                                 "https://old.example/animation.gif")
                self.assertEqual(by_key[("exercises", exercise_id)]["animation_file"], "")
                self.assertEqual(by_key[("products", product_id)]["file"], "")
                self.assertEqual(by_key[("avatars", avatar_id)]["expected_avatar_url"],
                                 "https://old.example/avatar.png")
                self.assertEqual(inventory.stat().st_mode & 0o777, 0o600)
                duplicate_export = subprocess.run(
                    ["python3", str(EXPORTER), "--output", str(inventory)],
                    capture_output=True, text=True, check=False,
                )
                self.assertNotEqual(duplicate_export.returncode, 0)
                self.assertEqual(json.loads(inventory.read_text())["items"], exported)

                manifest = root / "manifest.json"
                manifest.write_text(json.dumps({"version": 1, "items": [
                    {"kind": "exercises", "id": exercise_id, "file": str(source),
                     "expected_image_url": "https://old.example/exercise.png",
                     "expected_animation_url": "https://old.example/animation.gif", "sha256": digest,
                     "animation_file": str(animation_source), "animation_sha256": animation_digest},
                    {"kind": "products", "id": product_id, "file": str(source),
                     "expected_image_url": "https://old.example/product.png", "sha256": digest},
                    {"kind": "avatars", "id": avatar_id, "file": str(source),
                     "expected_avatar_url": "https://old.example/avatar.png", "sha256": digest},
                ]}), encoding="utf-8")
                command = ["python3", str(SCRIPT), str(manifest), "--media-root", str(media_root)]

                dry = subprocess.run(command, capture_output=True, text=True, check=True)
                self.assertIn("Validación sin escritura: 3", dry.stdout)
                self.assertIn(f"/api/media/exercises/{animation_digest}.gif", dry.stdout)
                no_backup = subprocess.run(command + ["--db-name", "algym", "--apply"],
                                           capture_output=True, text=True, check=False)
                self.assertNotEqual(no_backup.returncode, 0)
                self.assertIn("se requiere --backup", no_backup.stderr)
                self.assertEqual(psql(f"SELECT image_url FROM public.exercises WHERE id = {exercise_id}"),
                                 "https://old.example/exercise.png")
                self.assertEqual(list(media_root.iterdir()), [])

                applied = subprocess.run(command + ["--apply"], capture_output=True, text=True, check=True)
                self.assertIn("Importados 3 registros y 4 archivos nuevos", applied.stdout)
                expected_exercise_url = f"/api/media/exercises/{digest}.png"
                expected_animation_url = f"/api/media/exercises/{animation_digest}.gif"
                expected_product_url = f"/api/media/products/{digest}.png"
                expected_avatar_url = f"/api/media/avatars/{digest}.png"
                self.assertEqual(psql(f"SELECT image_url || '|' || animation_url "
                                      f"FROM public.exercises WHERE id = {exercise_id}"),
                                 f"{expected_exercise_url}|{expected_animation_url}")
                self.assertEqual(psql(f"SELECT image_url FROM public.products WHERE id = '{product_id}'"),
                                 expected_product_url)
                self.assertEqual(psql(f"SELECT avatar_url FROM public.profiles WHERE id = '{avatar_id}'"),
                                 expected_avatar_url)
                self.assertEqual((media_root / "exercises" / f"{digest}.png").read_bytes(), PNG)
                self.assertEqual((media_root / "exercises" / f"{animation_digest}.gif").read_bytes(), GIF)
                self.assertEqual((media_root / "products" / f"{digest}.png").read_bytes(), PNG)
                self.assertEqual((media_root / "avatars" / f"{digest}.png").read_bytes(), PNG)
                inventory_after = root / "inventory-after.json"
                subprocess.run(["python3", str(EXPORTER), "--output", str(inventory_after)],
                               capture_output=True, text=True, check=True)
                exported_after = json.loads(inventory_after.read_text())["items"]
                self.assertNotIn(("exercises", exercise_id),
                                 {(item["kind"], item["id"]) for item in exported_after})
                self.assertNotIn(("products", product_id),
                                 {(item["kind"], item["id"]) for item in exported_after})
                self.assertNotIn(("avatars", avatar_id),
                                 {(item["kind"], item["id"]) for item in exported_after})

                items = importer.read_manifest(manifest)
                first = replace(items[0], expected_image_url=expected_exercise_url,
                                expected_animation_url=expected_animation_url, digest="f" * 64)
                second = replace(items[1], expected_image_url="https://wrong.example/product.png")
                args = Namespace(db_mode="host", db_name="algym_test", db_host="127.0.0.1",
                                 db_port=5432, db_user=getpass.getuser(), project_name=None)
                with self.assertRaisesRegex(RuntimeError, "PostgreSQL rechazó"):
                    importer.update_rows(args, [first, second])
                self.assertEqual(psql(f"SELECT image_url FROM public.exercises WHERE id = {exercise_id}"),
                                 expected_exercise_url)

                stale = subprocess.run(command + ["--apply"], capture_output=True, text=True, check=False)
                self.assertNotEqual(stale.returncode, 0)
                self.assertIn("generar un manifiesto nuevo", stale.stderr)
            finally:
                psql(f"DELETE FROM public.exercises WHERE id = {exercise_id}")
                psql(f"DELETE FROM public.products WHERE id = '{product_id}'")
                psql(f"DELETE FROM public.profiles WHERE id = '{avatar_id}'")
                psql(f"DELETE FROM auth.users WHERE id = '{avatar_id}'")


if __name__ == "__main__":
    unittest.main()
