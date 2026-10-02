#!/usr/bin/env python3
"""Prueba la cuarentena reversible sin tocar la base ni la media operativas."""

from __future__ import annotations

from argparse import Namespace
import base64
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import quarantine_local_media as cleanup


PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII="
)


class QuarantineLocalMediaTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="algym-quarantine-", dir="/private/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.media = self.root / "media"
        (self.media / "exercises").mkdir(parents=True)
        (self.media / "products").mkdir()
        self.filename = hashlib.sha256(PNG).hexdigest() + ".png"
        self.referenced = self.media / "exercises" / self.filename
        self.orphan = self.media / "products" / self.filename
        self.referenced.write_bytes(PNG)
        self.orphan.write_bytes(PNG)
        self.url = "/api/media/exercises/" + self.filename
        self.orphan_url = "/api/media/products/" + self.filename
        self.args = Namespace(db_name="algym_test", min_age_hours=0,
                              writers_stopped=True, backup=None,
                              quarantine_dir=self.root / "quarantine")

    def test_moves_only_unreferenced_file_and_preserves_restore_manifest(self) -> None:
        with patch.object(cleanup.auditor, "read_references", return_value=({self.url}, 0, 0, [])):
            data = cleanup.snapshot(self.args, self.media)
            digest = cleanup.fingerprint(data)
            self.assertEqual([row["file"] for row in data["candidates"]],
                             ["products/" + self.filename])
            self.assertEqual(cleanup.quarantine(self.args, self.media, data, digest), 1)
        self.assertEqual(self.referenced.read_bytes(), PNG)
        self.assertFalse(self.orphan.exists())
        moved = self.args.quarantine_dir / "products" / self.filename
        self.assertEqual(moved.read_bytes(), PNG)
        manifest = json.loads((self.args.quarantine_dir / "manifest.json").read_text())
        self.assertEqual(manifest["snapshot_sha256"], digest)
        self.assertEqual(manifest["source_media_root"], str(self.media))
        self.assertEqual((self.args.quarantine_dir / "manifest.json").stat().st_mode & 0o777, 0o600)

    def test_new_reference_rejects_stale_preview(self) -> None:
        with patch.object(cleanup.auditor, "read_references", return_value=({self.url}, 0, 0, [])):
            data = cleanup.snapshot(self.args, self.media)
        with patch.object(cleanup.auditor, "read_references",
                          return_value=({self.url, self.orphan_url}, 0, 0, [])):
            with self.assertRaisesRegex(ValueError, "Cambió la auditoría"):
                cleanup.quarantine(self.args, self.media, data, cleanup.fingerprint(data))
        self.assertTrue(self.orphan.exists())
        self.assertFalse(self.args.quarantine_dir.exists())

    def test_reference_appearing_after_move_restores_file(self) -> None:
        with patch.object(cleanup.auditor, "read_references", return_value=({self.url}, 0, 0, [])):
            data = cleanup.snapshot(self.args, self.media)
        with patch.object(cleanup.auditor, "read_references", side_effect=[
            ({self.url}, 0, 0, []), ({self.url}, 0, 0, []),
            ({self.url, self.orphan_url}, 0, 0, []),
        ]):
            with self.assertRaisesRegex(ValueError, "Apareció una referencia"):
                cleanup.quarantine(self.args, self.media, data, cleanup.fingerprint(data))
        self.assertEqual(self.orphan.read_bytes(), PNG)
        self.assertFalse((self.args.quarantine_dir / "products" / self.filename).exists())

    def test_rejects_changed_file_and_requires_writers_stopped(self) -> None:
        with patch.object(cleanup.auditor, "read_references", return_value=({self.url}, 0, 0, [])):
            data = cleanup.snapshot(self.args, self.media)
            self.args.writers_stopped = False
            with self.assertRaisesRegex(ValueError, "writers-stopped"):
                cleanup.quarantine(self.args, self.media, data, cleanup.fingerprint(data))
            self.args.writers_stopped = True
            os.utime(self.orphan, None)
            with self.assertRaisesRegex(ValueError, "Cambió la auditoría"):
                cleanup.quarantine(self.args, self.media, data, cleanup.fingerprint(data))

    def test_production_requires_verified_backup(self) -> None:
        self.args.db_name = "algym"
        with patch.object(cleanup.auditor, "read_references", return_value=({self.url}, 0, 0, [])):
            data = cleanup.snapshot(self.args, self.media)
            with self.assertRaisesRegex(ValueError, "backup"):
                cleanup.quarantine(self.args, self.media, data, cleanup.fingerprint(data))
        self.assertTrue(self.orphan.exists())

    def test_recent_file_is_not_candidate(self) -> None:
        self.args.min_age_hours = 24
        with patch.object(cleanup.auditor, "read_references", return_value=({self.url}, 0, 0, [])):
            data = cleanup.snapshot(self.args, self.media)
        self.assertEqual(data["candidates"], [])
        self.assertEqual(data["skipped_recent"], 1)


if __name__ == "__main__":
    unittest.main()
