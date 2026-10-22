"""Synthetic downloader checks: no external network, model or account data."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("asr_environment", Path(__file__).parents[1] / "scripts/asr_environment.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "model"
        self.content = b"synthetic weights"
        self.row = {"name": "model.bin", "bytes": len(self.content), "sha256": hashlib.sha256(self.content).hexdigest()}
        self.spec = {"repository": "Systran/faster-whisper-small", "revision": "0" * 40, "files": [self.row]}
        self.addCleanup(patch.stopall)
        patch.object(module, "SPEC", self.spec).start()

    def test_download_is_bounded_and_hash_verified_without_authorization(self):
        def source(request, timeout):
            self.assertEqual(request.full_url, "https://huggingface.co/Systran/faster-whisper-small/resolve/" + "0" * 40 + "/model.bin")
            self.assertNotIn("Authorization", dict(request.header_items()))
            self.assertEqual(timeout, 60)
            return io.BytesIO(self.content)
        with patch.object(module.urllib.request, "urlopen", source):
            self.assertEqual(module.download(self.root)["status"], "downloaded_verified")
        self.assertEqual((self.root / "model.bin").read_bytes(), self.content)

    def test_valid_local_cache_does_not_download(self):
        self.root.mkdir()
        (self.root / "model.bin").write_bytes(self.content)
        with patch.object(module.urllib.request, "urlopen", side_effect=AssertionError("Unexpected network")):
            module.download(self.root)

    def test_size_overflow_leaves_no_claimed_model(self):
        with patch.object(module.urllib.request, "urlopen", return_value=io.BytesIO(self.content + b"overflow")):
            self.assertRaises(ValueError, module.download, self.root)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_wrong_hash_is_not_installed(self):
        with patch.object(module.urllib.request, "urlopen", return_value=io.BytesIO(b"x" * len(self.content))):
            self.assertRaises(ValueError, module.download, self.root)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_preexisting_partial_is_preserved(self):
        self.root.mkdir()
        partial = self.root / "model.bin.partial"
        partial.write_bytes(b"unrelated")
        self.assertRaises(FileExistsError, module.download, self.root)
        self.assertEqual(partial.read_bytes(), b"unrelated")


if __name__ == "__main__":
    unittest.main()
