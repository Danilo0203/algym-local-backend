#!/usr/bin/env python3
"""Coincidencias de media histórica sin DB ni red."""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from database.scripts import match_local_media as matcher


SCRIPT = Path(__file__).with_name("match_local_media.py")
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII="
)
GIF = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==")


class MatchLocalMediaTest(unittest.TestCase):
    def test_rejects_invalid_file_and_existing_digest_mismatch(self) -> None:
        with tempfile.TemporaryDirectory(prefix="algym-match-invalid-") as temporary:
            root = Path(temporary)
            files = root / "files"
            (files / "bucket").mkdir(parents=True)
            (files / "bucket" / "invalid.png").write_bytes(b"not an image")
            (files / "bucket" / "valid.png").write_bytes(PNG)
            raw = {"version": 1, "items": [
                {"kind": "products", "id": "00000000-0000-4000-8000-000000000001",
                 "expected_image_url": "https://old.example/bucket/invalid.png", "file": ""},
                {"kind": "avatars", "id": "00000000-0000-4000-8000-000000000002",
                 "expected_avatar_url": "https://old.example/bucket/valid.png",
                 "file": "", "sha256": "0" * 64},
            ]}
            completed, counts = matcher.complete_manifest(raw, matcher.index_files(files))
            self.assertEqual([row["file"] for row in completed["items"]], ["", ""])
            self.assertEqual(counts["archivo_invalido"], 1)
            self.assertEqual(counts["hash_distinto"], 1)
            alias = root / "alias"
            alias.symlink_to(files, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "directorio absoluto normal"):
                matcher.index_files(alias)

    def test_exact_paths_animation_avatar_and_private_output(self) -> None:
        with tempfile.TemporaryDirectory(prefix="algym-match-media-") as temporary:
            root = Path(temporary)
            files = root / "files"
            (files / "bucket" / "ejercicios").mkdir(parents=True)
            (files / "bucket" / "avatares").mkdir()
            image = files / "bucket" / "ejercicios" / "sentadilla 1.png"
            image.write_bytes(PNG)
            animation = files / "bucket" / "ejercicios" / "sentadilla.gif"
            animation.write_bytes(GIF)
            avatar = files / "bucket" / "avatares" / "persona.png"
            avatar.write_bytes(PNG)
            raw = {"version": 1, "items": [
                {"kind": "exercises", "id": "123",
                 "expected_image_url": "https://old.example/storage/v1/object/public/bucket/ejercicios/sentadilla%201.png?token=private",
                 "expected_animation_url": "https://old.example/storage/v1/object/public/bucket/ejercicios/sentadilla.gif",
                 "file": "", "animation_file": ""},
                {"kind": "avatars", "id": "00000000-0000-4000-8000-000000000001",
                 "expected_avatar_url": "https://old.example/storage/v1/object/public/bucket/avatares/persona.png",
                 "file": ""},
            ]}
            source = root / "inventory.json"
            target = root / "matched.json"
            source.write_text(json.dumps(raw))
            result = subprocess.run(
                ["python3", str(SCRIPT), str(source), "--files-root", str(files),
                 "--output", str(target)], capture_output=True, text=True, check=True,
            )
            self.assertIn("emparejado=3", result.stdout)
            self.assertNotIn("token=private", result.stdout)
            matched = json.loads(target.read_text())["items"]
            self.assertEqual(matched[0]["file"], str(image))
            self.assertEqual(matched[0]["sha256"], hashlib.sha256(PNG).hexdigest())
            self.assertEqual(matched[0]["animation_file"], str(animation))
            self.assertEqual(matched[0]["animation_sha256"], hashlib.sha256(GIF).hexdigest())
            self.assertEqual(matched[1]["file"], str(avatar))
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            repeated = subprocess.run(
                ["python3", str(SCRIPT), str(source), "--files-root", str(files),
                 "--output", str(target)], capture_output=True, text=True,
            )
            self.assertNotEqual(repeated.returncode, 0)
            self.assertEqual(json.loads(target.read_text())["items"], matched)

    def test_ambiguity_symlinks_and_manual_decisions_remain_unmatched(self) -> None:
        with tempfile.TemporaryDirectory(prefix="algym-match-ambiguous-") as temporary:
            root = Path(temporary)
            files = root / "files"
            for folder in ("a/folder", "b/folder"):
                destination = files / folder
                destination.mkdir(parents=True)
                (destination / "imagen.png").write_bytes(PNG)
            (files / "bucket").mkdir()
            (files / "bucket" / "enlace.png").symlink_to(files / "a/folder/imagen.png")
            index = matcher.index_files(files)
            image_url = "https://old.example/public/folder/imagen.png"
            self.assertEqual(matcher.find_file(image_url, index), (None, "ambigua"))
            self.assertEqual(matcher.find_file("https://old.example/imagen.png", index),
                             (None, "sin_ruta_segura"))
            self.assertEqual(matcher.find_file("https://old.example/bucket/enlace.png", index),
                             (None, "sin_archivo"))
            self.assertEqual(matcher.find_file("https://old.example/a/%2e%2e/imagen.png", index),
                             (None, "sin_ruta_segura"))
            self.assertEqual(matcher.find_file("/api/media/exercises/foo.png", index),
                             (None, "sin_ruta_segura"))
            raw = {"version": 1, "items": [
                {"kind": "exercises", "id": "123", "expected_image_url": image_url,
                 "expected_animation_url": "https://old.example/a/folder/imagen.png",
                 "file": "", "animation_file": None},
                {"kind": "products", "id": "00000000-0000-4000-8000-000000000001",
                 "expected_image_url": "https://old.example/a/folder/imagen.png",
                 "file": str(files / "b/folder/imagen.png")},
            ]}
            completed, counts = matcher.complete_manifest(raw, index)
            self.assertEqual(completed["items"][0]["file"], "")
            self.assertIsNone(completed["items"][0]["animation_file"])
            self.assertEqual(completed["items"][1]["file"], raw["items"][1]["file"])
            self.assertEqual(counts["ambigua"], 1)
            self.assertEqual(counts["manual"], 2)


if __name__ == "__main__":
    unittest.main()
