import shutil
from pathlib import Path

from fa_worker import queue
from fa_worker.errors import JobFailure
from fa_worker.pipeline import process

from .conftest import job_row, make_job, usage, write_video


class FakeStorage:
    """Serves a local file as if it were the stored upload."""

    def __init__(self, source: Path | None = None, error: JobFailure | None = None):
        self.source = source
        self.error = error

    def download(self, key, dest, expected_size):
        if self.error:
            raise self.error
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(self.source, dest)
        return dest


def claim_specific(conn, settings, job_id):
    while (job := queue.claim(conn, settings.worker_id, settings.lease_seconds)) is not None:
        if job.id == str(job_id):
            return job
    raise AssertionError("job was not claimable")


def video_row(conn, video_id):
    return conn.execute("select * from videos where id = %s", (video_id,)).fetchone()


def run(conn, settings, storage, **job_kwargs):
    src = getattr(storage, "source", None)
    job = make_job(conn, size_bytes=src.stat().st_size if src else 1000, **job_kwargs)
    status = process(conn, storage, settings, claim_specific(conn, settings, job["id"]))
    return job, status


def test_valid_video_succeeds_records_metadata_and_consumes_allowance(conn, settings, tmp_path):
    job, status = run(conn, settings, FakeStorage(write_video(tmp_path / "m.mp4")))
    assert status == "succeeded"
    row = job_row(conn, job["id"])
    assert row["status"] == "succeeded" and row["progress"] == 1
    assert row["model_versions"]["pipeline"] == "v0.1-validate"
    assert row["model_versions"]["pyav"]
    v = video_row(conn, job["video_id"])
    assert v["status"] == "validated" and (v["width"], v["height"]) == (640, 368)
    assert usage(conn, job["org_id"]) == (1, 0)
    assert not (settings.work_dir / str(job["id"])).exists(), "temporary files are removed"


def test_invalid_file_fails_without_fabricated_results(conn, settings, tmp_path):
    bad = tmp_path / "bad.mp4"
    bad.write_bytes(b"\x00\x00\x00\x20ftypisom" + b"\x00" * 5000)
    job, status = run(conn, settings, FakeStorage(bad))
    assert status == "failed"
    row = job_row(conn, job["id"])
    assert row["error_code"] == "undecodable" and "could not be decoded" in row["error_message"]
    v = video_row(conn, job["video_id"])
    assert v["status"] == "rejected" and v["duration_seconds"] is None and v["width"] is None
    assert usage(conn, job["org_id"]) == (0, 0)


def test_video_longer_than_plan_allows_is_rejected(conn, settings, tmp_path):
    job, status = run(conn, settings, FakeStorage(write_video(tmp_path / "m.mp4", seconds=15)), max_duration=12)
    assert status == "failed"
    assert job_row(conn, job["id"])["error_code"] == "too_long"


def test_transient_storage_error_is_retried_not_failed(conn, settings):
    storage = FakeStorage(error=JobFailure("storage_unavailable", "Storage was temporarily unavailable.", retryable=True))
    job, status = run(conn, settings, storage)
    assert status == "queued"
    assert job_row(conn, job["id"])["status"] == "queued"
    assert video_row(conn, job["video_id"])["status"] == "uploaded", "the video is not blamed for infrastructure errors"
    assert usage(conn, job["org_id"]) == (0, 1)


def test_cancel_requested_job_stops_and_releases_allowance(conn, settings, tmp_path):
    job, status = run(conn, settings, FakeStorage(write_video(tmp_path / "m.mp4")), cancel_requested=True)
    assert status == "cancelled"
    assert job_row(conn, job["id"])["status"] == "cancelled"
    assert video_row(conn, job["video_id"])["status"] == "uploaded"
    assert usage(conn, job["org_id"]) == (0, 0)


def test_deleted_match_is_not_processed(conn, settings, tmp_path):
    src = write_video(tmp_path / "m.mp4")
    job = make_job(conn, size_bytes=src.stat().st_size)
    with conn.transaction():
        conn.execute("update matches set deleted_at = now() where id = %s", (job["match_id"],))
    status = process(conn, FakeStorage(src), settings, claim_specific(conn, settings, job["id"]))
    assert status == "cancelled"
    assert usage(conn, job["org_id"]) == (0, 0)


def test_unexpected_crash_is_retried_with_a_generic_message(conn, settings):
    class Boom:
        def download(self, *a):
            raise RuntimeError("internal detail: s3://secret-bucket/key")

    job, status = run(conn, settings, Boom())
    assert status == "queued"
    row = job_row(conn, job["id"])
    assert row["error_code"] == "internal_error"
    assert "secret" not in row["error_message"]
