"""Private storage access from Modal. Only short-lived object URLs cross the network."""
from __future__ import annotations

import json
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from .config import Settings
from .errors import JobFailure

CHUNK = 8 * 1024 * 1024


class ReplitStorage:
    def __init__(self, settings: Settings):
        self._url = settings.worker_storage_url or ""
        self._token = settings.worker_storage_token or ""
        parsed = urlparse(self._url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.fragment:
            raise RuntimeError("WORKER_STORAGE_URL must be an HTTPS endpoint without credentials or fragments.")
        if len(self._token) < 32:
            raise RuntimeError("WORKER_STORAGE_TOKEN must contain at least 32 characters.")

    def _request(self, operation: str, **fields) -> dict:
        req = Request(
            self._url,
            data=json.dumps({"operation": operation, **fields}).encode(),
            headers={"Content-Type": "application/json", "X-Worker-Storage-Token": self._token},
            method="POST",
        )
        try:
            with urlopen(req, timeout=120) as response:
                body = response.read(8193)
                if len(body) > 8192:
                    raise ValueError("Oversized storage response")
                result = json.loads(body)
                if not isinstance(result, dict):
                    raise ValueError("Invalid storage response")
                return result
        except HTTPError as exc:
            if exc.code == 404 and operation == "download":
                raise JobFailure("video_missing", "The uploaded video could not be found.") from None
            # Never include an HTTPError/Request in an exception chain: URLs can contain signatures.
            raise JobFailure("storage_unavailable", "Private storage access failed.", retryable=True) from None
        except (URLError, TimeoutError, OSError, ValueError):
            raise JobFailure("storage_unavailable", "Private storage was temporarily unavailable.", retryable=True) from None

    def _object_url(self, operation: str, **fields) -> str:
        result = self._request(operation, **fields)
        url = result.get("url", "")
        parsed = urlparse(url)
        if parsed.scheme != "https" or not (
            parsed.hostname == "storage.googleapis.com" or (parsed.hostname or "").endswith(".storage.googleapis.com")
        ) or parsed.username or parsed.fragment:
            raise JobFailure("storage_unavailable", "Private storage returned an invalid object address.", retryable=True)
        return url

    def download(self, key: str, dest: Path, expected_size: int) -> Path:
        url = self._object_url("download", key=key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        written = 0
        try:
            with urlopen(Request(url, method="GET"), timeout=120) as response, dest.open("wb") as output:
                declared = response.headers.get("Content-Length")
                if declared is not None and int(declared) != expected_size:
                    raise JobFailure("size_mismatch", "The stored video does not match the uploaded file.")
                while chunk := response.read(CHUNK):
                    written += len(chunk)
                    if written > expected_size:
                        raise JobFailure("size_mismatch", "The stored video does not match the uploaded file.")
                    output.write(chunk)
            if written != expected_size:
                raise JobFailure("storage_unavailable", "Downloading the video was incomplete.", retryable=True)
            return dest
        except JobFailure:
            dest.unlink(missing_ok=True)
            raise
        except (URLError, TimeoutError, OSError, ValueError):
            dest.unlink(missing_ok=True)
            raise JobFailure("storage_unavailable", "Downloading the video failed.", retryable=True) from None

    def put_file(self, key: str, path: Path, content_type: str) -> None:
        url = self._object_url("upload", key=key, contentType=content_type)
        try:
            with path.open("rb") as body:
                req = Request(url, data=body, method="PUT", headers={
                    "Content-Type": content_type, "Content-Length": str(path.stat().st_size),
                })
                with urlopen(req, timeout=120) as response:
                    if response.status not in (200, 201):
                        raise OSError("Storage upload failed")
        except (URLError, TimeoutError, OSError):
            raise JobFailure("storage_unavailable", "Uploading an analysis artifact failed.", retryable=True) from None

    def delete_object(self, key: str) -> None:
        self._request("delete", key=key)

    def abort_multipart_upload(self, key: str, upload_id: str) -> None:
        self._request("abort", key=key, uploadId=upload_id)

    def cleanup_stale_uploads(self) -> int:
        return int(self._request("sweep").get("deleted", 0))
