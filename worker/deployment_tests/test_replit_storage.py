from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError

from football_vision.worker.fa_worker.config import Settings
from football_vision.worker.fa_worker.errors import JobFailure
from football_vision.worker.fa_worker.replit_storage import ReplitStorage


class ReplitStorageTests(unittest.TestCase):
    def setUp(self):
        self.storage = ReplitStorage(Settings(
            database_url="postgresql://unused.invalid/test",
            storage_provider="replit",
            worker_storage_url="https://app.example.test/api/internal/worker-storage",
            worker_storage_token="test-only-not-a-real-secret-0123456789",
        ))

    def response(self, body=b"content", declared="7"):
        response = MagicMock()
        response.__enter__.return_value = response
        response.headers = {"Content-Length": declared}
        response.read.side_effect = io.BytesIO(body).read
        response.status = 200
        return response

    def test_broker_requires_https_and_a_long_key(self):
        for url, token in [("http://example.test", "x" * 32), ("https://example.test", "short")]:
            with self.assertRaises(RuntimeError):
                ReplitStorage(Settings(database_url="unused", worker_storage_url=url, worker_storage_token=token))

    def test_object_url_cannot_redirect_to_other_hosts(self):
        for url in ["http://storage.googleapis.com/a", "https://example.test/a", "https://storage.googleapis.com.attacker.test/a"]:
            with patch.object(self.storage, "_request", return_value={"url": url}):
                with self.assertRaises(JobFailure):
                    self.storage._object_url("download", key="unused")

    def test_download_streams_and_checks_exact_size(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(
            self.storage, "_object_url", return_value="https://storage.googleapis.com/test"
        ), patch("football_vision.worker.fa_worker.replit_storage.urlopen", return_value=self.response()):
            dest = Path(tmp) / "source"
            self.assertEqual(self.storage.download("source", dest, 7).read_bytes(), b"content")

    def test_size_mismatch_removes_partial_file(self):
        for body, declared in [(b"too much content", "7"), (b"short", "7"), (b"content", "12")]:
            with tempfile.TemporaryDirectory() as tmp, patch.object(
                self.storage, "_object_url", return_value="https://storage.googleapis.com/test"
            ), patch("football_vision.worker.fa_worker.replit_storage.urlopen", return_value=self.response(body, declared)):
                dest = Path(tmp) / "source"
                with self.assertRaises(JobFailure):
                    self.storage.download("source", dest, 7)
                self.assertFalse(dest.exists())

    def test_failed_http_request_does_not_leak_signed_urls(self):
        signed = "https://storage.googleapis.com/test?signature=do-not-leak"
        error = HTTPError(signed, 403, "denied", {}, None)
        with patch("football_vision.worker.fa_worker.replit_storage.urlopen", side_effect=error):
            with self.assertRaises(JobFailure) as result:
                self.storage._request("download", key="source")
            self.assertNotIn("do-not-leak", str(result.exception))
            self.assertTrue(result.exception.__suppress_context__)

    def test_file_upload_is_streamed_with_type_and_size(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(
            self.storage, "_object_url", return_value="https://storage.googleapis.com/test"
        ), patch("football_vision.worker.fa_worker.replit_storage.urlopen", return_value=self.response()) as urlopen:
            path = Path(tmp) / "crop.jpg"
            path.write_bytes(b"content")
            self.storage.put_file("frame.jpg", path, "image/jpeg")
            req = urlopen.call_args.args[0]
            self.assertEqual(req.get_method(), "PUT")
            self.assertEqual(req.get_header("Content-length"), "7")
            self.assertEqual(req.get_header("Content-type"), "image/jpeg")
            self.assertTrue(hasattr(req.data, "read"))

    def test_provider_config_does_not_require_s3_credentials(self):
        env = {
            "DATABASE_URL": "postgresql://unused.invalid/test",
            "STORAGE_PROVIDER": "replit",
            "WORKER_STORAGE_URL": "https://app.example.test/api/internal/worker-storage",
            "WORKER_STORAGE_TOKEN": "test-only-not-a-real-secret-0123456789",
        }
        with patch.dict("os.environ", env, clear=True):
            settings = Settings.from_env()
        self.assertEqual(settings.storage_provider, "replit")
        self.assertEqual(settings.s3_access_key_id, "")
        self.assertNotIn(env["WORKER_STORAGE_TOKEN"], repr(settings))


if __name__ == "__main__":
    unittest.main()
