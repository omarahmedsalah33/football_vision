from __future__ import annotations

import os
import socket
import uuid
from dataclasses import dataclass, field
from pathlib import Path


def load_env_file(path: Path) -> None:
    """Development convenience: KEY=VALUE lines; real environment variables take precedence."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


@dataclass(frozen=True)
class Settings:
    database_url: str
    s3_bucket: str
    s3_access_key_id: str
    s3_secret_access_key: str
    s3_endpoint: str | None = None
    s3_region: str = "us-east-1"
    work_dir: Path = Path(".cache/jobs")
    lease_seconds: int = 60
    poll_seconds: float = 2.0
    # Hard ceiling for the isolated probe/decoding subprocess.
    probe_timeout_seconds: int = 120
    worker_id: str = field(default_factory=lambda: f"{socket.gethostname()}:{uuid.uuid4().hex[:8]}")

    @staticmethod
    def from_env() -> Settings:
        return Settings(
            database_url=_required("DATABASE_URL"),
            s3_bucket=_required("S3_BUCKET"),
            s3_access_key_id=_required("S3_ACCESS_KEY_ID"),
            s3_secret_access_key=_required("S3_SECRET_ACCESS_KEY"),
            s3_endpoint=os.environ.get("S3_ENDPOINT") or None,
            s3_region=os.environ.get("S3_REGION", "us-east-1"),
            work_dir=Path(os.environ.get("WORKER_WORK_DIR", ".cache/jobs")),
            lease_seconds=int(os.environ.get("WORKER_LEASE_SECONDS", "60")),
            poll_seconds=float(os.environ.get("WORKER_POLL_SECONDS", "2")),
        )
