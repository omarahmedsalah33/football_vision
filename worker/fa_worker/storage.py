from __future__ import annotations

from pathlib import Path
from typing import Protocol

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from .config import Settings
from .errors import JobFailure

CHUNK = 8 * 1024 * 1024


class Storage(Protocol):
    def download(self, key: str, dest: Path, expected_size: int) -> Path: ...


class S3Storage:
    def __init__(self, settings: Settings):
        self._bucket = settings.s3_bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint,
            region_name=settings.s3_region,
            aws_access_key_id=settings.s3_access_key_id,
            aws_secret_access_key=settings.s3_secret_access_key,
            config=Config(s3={"addressing_style": "path"}, retries={"max_attempts": 5, "mode": "standard"}),
        )

    def download(self, key: str, dest: Path, expected_size: int) -> Path:
        """Streams the object to disk, refusing anything other than the size verified at upload."""
        try:
            obj = self._client.get_object(Bucket=self._bucket, Key=key)
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code")
            if code in ("NoSuchKey", "404"):
                raise JobFailure("video_missing", "The uploaded video could not be found.") from exc
            raise JobFailure("storage_unavailable", "Storage was temporarily unavailable.", retryable=True) from exc
        except BotoCoreError as exc:
            raise JobFailure("storage_unavailable", "Storage was temporarily unavailable.", retryable=True) from exc

        if obj.get("ContentLength") != expected_size:
            raise JobFailure("size_mismatch", "The stored video does not match the uploaded file.")
        written = 0
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            with dest.open("wb") as fh:
                for chunk in obj["Body"].iter_chunks(CHUNK):
                    written += len(chunk)
                    if written > expected_size:
                        raise JobFailure("size_mismatch", "The stored video does not match the uploaded file.")
                    fh.write(chunk)
        except (BotoCoreError, OSError) as exc:
            raise JobFailure("storage_unavailable", "Downloading the video failed.", retryable=True) from exc
        if written != expected_size:
            raise JobFailure("storage_unavailable", "Downloading the video was incomplete.", retryable=True)
        return dest
