from __future__ import annotations

import os
import uuid
from datetime import date
from fractions import Fraction
from pathlib import Path

import av
import numpy as np
import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from fa_worker.config import Settings

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "web" / "drizzle"
ADMIN_URL = os.environ.get("WORKER_TEST_ADMIN_URL", "postgres://fa_dev:fa_dev_password@127.0.0.1:5433/footballanalyzer")
DB_NAME = "footballanalyzer_worker_test"
TEST_URL = ADMIN_URL.rsplit("/", 1)[0] + "/" + DB_NAME


@pytest.fixture(scope="session")
def database_url() -> str:
    """A dedicated database rebuilt from the web app's migrations, so both sides share one schema."""
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        exists = admin.execute("select 1 from pg_database where datname = %s", (DB_NAME,)).fetchone()
        if not exists:
            admin.execute(f'create database "{DB_NAME}"')
    with psycopg.connect(TEST_URL, autocommit=True) as conn:
        conn.execute("drop schema if exists public cascade; create schema public;")
        for sql_file in sorted(MIGRATIONS.glob("*.sql")):
            for statement in sql_file.read_text(encoding="utf-8").split("--> statement-breakpoint"):
                if statement.strip():
                    conn.execute(statement)
    return TEST_URL


@pytest.fixture
def conn(database_url):
    with psycopg.connect(database_url, row_factory=dict_row) as c:
        yield c


@pytest.fixture
def settings(database_url, tmp_path) -> Settings:
    return Settings(
        database_url=database_url,
        s3_bucket="unused",
        s3_access_key_id="unused",
        s3_secret_access_key="unused",
        work_dir=tmp_path / "jobs",
        lease_seconds=30,
        probe_timeout_seconds=60,
        worker_id=f"test-{uuid.uuid4().hex[:6]}",
    )


def period() -> date:
    today = date.today()
    return date(today.year, today.month, 1)


def make_job(conn, *, kind: str = "analyze", size_bytes: int = 1000, max_duration: int = 7800, max_attempts: int = 3, config: dict | None = None, video_status: str = "uploaded", **job_fields) -> dict:
    """Inserts org → match → video → queued job. Analyze jobs hold a reserved usage unit; prepare
    jobs are free and reserve nothing."""
    with conn.transaction():
        org = conn.execute(
            "insert into organizations (name, slug, kind) values ('Club', %s, 'club') returning id",
            (f"club-{uuid.uuid4().hex[:10]}",),
        ).fetchone()["id"]
        match = conn.execute(
            "insert into matches (org_id, title) values (%s, 'Test match') returning id", (org,)
        ).fetchone()["id"]
        video = conn.execute(
            """insert into videos (org_id, match_id, storage_key, declared_size_bytes, size_bytes, part_size_bytes,
                                   part_count, status)
               values (%s, %s, %s, %s, %s, %s, 1, %s) returning id""",
            (org, match, f"orgs/{org}/matches/{match}/videos/{uuid.uuid4()}/source", size_bytes, size_bytes, size_bytes, video_status),
        ).fetchone()["id"]
        analyze = kind == "analyze"
        if analyze:
            conn.execute(
                """insert into usage_periods (org_id, period_start, analyses_reserved) values (%s, %s, 1)""",
                (org, period()),
            )
        job = conn.execute(
            """insert into analysis_jobs (org_id, match_id, video_id, kind, idempotency_key, usage_period_start,
                                          usage_settled, config, max_attempts)
               values (%s, %s, %s, %s, %s, %s, %s, %s, %s) returning *""",
            (org, match, video, kind, f"video:{video}:{kind}:1", period() if analyze else None, not analyze,
             Jsonb({"maxDurationSeconds": max_duration, **(config or {})}), max_attempts),
        ).fetchone()
        if job_fields:
            sets = ", ".join(f"{k} = %s" for k in job_fields)
            job = conn.execute(
                f"update analysis_jobs set {sets} where id = %s returning *", (*job_fields.values(), job["id"])
            ).fetchone()
    return job


def usage(conn, org_id) -> tuple[int, int]:
    row = conn.execute(
        "select analyses_used, analyses_reserved from usage_periods where org_id = %s and period_start = %s",
        (org_id, period()),
    ).fetchone()
    return (row["analyses_used"], row["analyses_reserved"]) if row else (0, 0)


def job_row(conn, job_id) -> dict:
    return conn.execute("select * from analysis_jobs where id = %s", (job_id,)).fetchone()


def write_video(path: Path, *, seconds: float = 12, fps: int = 10, width: int = 640, height: int = 368,
                container: str = "mp4") -> Path:
    """Synthesizes a small, valid test video (moving gradient) with PyAV."""
    with av.open(str(path), mode="w", format=container) as out:
        stream = out.add_stream("mpeg4", rate=Fraction(fps, 1))
        stream.width, stream.height, stream.pix_fmt = width, height, "yuv420p"
        for i in range(int(seconds * fps)):
            img = np.zeros((height, width, 3), dtype=np.uint8)
            img[:, :, 1] = 90
            img[:, (i * 7) % width :, 0] = 200
            for packet in stream.encode(av.VideoFrame.from_ndarray(img, format="rgb24")):
                out.mux(packet)
        for packet in stream.encode():
            out.mux(packet)
    return path


def write_audio_only(path: Path) -> Path:
    with av.open(str(path), mode="w", format="mp4") as out:
        stream = out.add_stream("aac", rate=44100)
        frame_samples = 1024
        for i in range(50):
            samples = np.zeros((1, frame_samples), dtype=np.float32)
            frame = av.AudioFrame.from_ndarray(samples, format="fltp", layout="mono")
            frame.sample_rate = 44100
            frame.pts = i * frame_samples
            for packet in stream.encode(frame):
                out.mux(packet)
        for packet in stream.encode():
            out.mux(packet)
    return path
