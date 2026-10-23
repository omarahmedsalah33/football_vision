"""Runs one claimed job through the pipeline stages.

Results are written in the same transaction that marks the job succeeded, so a failed or cancelled
job can never leave behind results that look real.
"""

from __future__ import annotations

import logging
import shutil
import threading
from dataclasses import asdict

import av

from . import queue
from .config import Settings
from .errors import JobCancelled, JobFailure, LeaseLost
from .queue import ClaimedJob
from .stages.validate import VideoInfo, validate
from .storage import Storage

log = logging.getLogger("fa_worker.pipeline")

PIPELINE_VERSION = "v0.1-validate"


class Heartbeat:
    """Renews the lease on its own connection and records cancel requests / lease loss."""

    def __init__(self, settings: Settings, job_id: str):
        self._settings = settings
        self._job_id = job_id
        self._stop = threading.Event()
        self.lost = threading.Event()
        self.cancel_requested = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"heartbeat-{job_id[:8]}", daemon=True)

    def __enter__(self) -> Heartbeat:
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    def _run(self) -> None:
        interval = max(1.0, self._settings.lease_seconds / 3)
        try:
            with queue.connect(self._settings.database_url) as conn:
                while not self._stop.wait(interval):
                    flag = queue.heartbeat(conn, self._job_id, self._settings.worker_id, self._settings.lease_seconds)
                    if flag is None:
                        self.lost.set()
                        return
                    if flag:
                        self.cancel_requested.set()
        except Exception:  # a dead heartbeat must surface as lost lease, not silently pass
            log.exception("heartbeat failed", extra={"job_id": self._job_id})
            self.lost.set()


def _checkpoint(conn, settings: Settings, job: ClaimedJob, hb: Heartbeat, stage: str, progress: float) -> None:
    if hb.lost.is_set():
        raise LeaseLost()
    flag = queue.report_progress(conn, job.id, settings.worker_id, stage, progress)
    if flag is None:
        raise LeaseLost()
    if flag or hb.cancel_requested.is_set():
        raise JobCancelled()


def _load_video(conn, job: ClaimedJob) -> dict:
    with conn.transaction(), conn.cursor() as cur:
        cur.execute(
            """select v.storage_key, v.size_bytes, v.status, m.deleted_at as match_deleted_at
                 from videos v join matches m on m.id = v.match_id
                where v.id = %s and v.org_id = %s and m.org_id = %s""",
            (job.video_id, job.org_id, job.org_id),
        )
        row = cur.fetchone()
    if row is None or row["size_bytes"] is None:
        raise JobFailure("video_missing", "The uploaded video could not be found.")
    if row["match_deleted_at"] is not None:
        raise JobCancelled()
    return row


def model_versions() -> dict:
    return {
        "pipeline": PIPELINE_VERSION,
        "pyav": av.__version__,
        "libavformat": ".".join(str(x) for x in av.library_versions.get("libavformat", ())),
        "stages": ["download", "validate"],
    }


def process(conn, storage: Storage, settings: Settings, job: ClaimedJob) -> str:
    """Processes a claimed job and returns its final status for logging."""
    workdir = settings.work_dir / job.id
    ctx = {"job_id": job.id, "attempt": job.attempts}
    try:
        with Heartbeat(settings, job.id) as hb:
            video = _load_video(conn, job)
            _checkpoint(conn, settings, job, hb, "download", 0.05)
            path = storage.download(video["storage_key"], workdir / "source", int(video["size_bytes"]))

            _checkpoint(conn, settings, job, hb, "validate", 0.5)
            max_duration = float(job.config.get("maxDurationSeconds", 0)) or 0.0
            if max_duration <= 0:
                raise JobFailure("invalid_job", "This analysis request is invalid.")
            info: VideoInfo = validate(path, max_duration, settings.probe_timeout_seconds)

            _checkpoint(conn, settings, job, hb, "finalize", 0.95)

            def persist(cur) -> None:
                cur.execute(
                    """update videos set status = 'validated', container = %s, video_codec = %s,
                              duration_seconds = %s, width = %s, height = %s, fps = %s
                        where id = %s and org_id = %s""",
                    (info.container, info.video_codec, info.duration_seconds, info.width, info.height, info.fps,
                     job.video_id, job.org_id),
                )

            if not queue.complete(conn, job.id, settings.worker_id, model_versions(), persist_results=persist):
                raise LeaseLost()
            log.info("job succeeded", extra={**ctx, "video": asdict(info)})
            return "succeeded"
    except JobCancelled:
        queue.cancel(conn, job.id, settings.worker_id)
        log.info("job cancelled", extra=ctx)
        return "cancelled"
    except LeaseLost:
        log.warning("lease lost; abandoning job without writing", extra=ctx)
        return "lease_lost"
    except JobFailure as failure:
        def reject(cur) -> None:
            if failure.reject_video:
                cur.execute(
                    "update videos set status = 'rejected', rejection_reason = %s where id = %s and org_id = %s",
                    (failure.code, job.video_id, job.org_id),
                )

        status = queue.fail(
            conn, job.id, settings.worker_id, failure.code, failure.user_message,
            retryable=failure.retryable, attempts=job.attempts, max_attempts=job.max_attempts, on_terminal=reject,
        )
        log.warning("job failed", extra={**ctx, "code": failure.code, "result": status})
        return status or "lease_lost"
    except Exception:
        log.exception("unexpected error", extra=ctx)
        status = queue.fail(
            conn, job.id, settings.worker_id, "internal_error",
            "Processing failed because of an internal error. Our team has been notified.",
            retryable=True, attempts=job.attempts, max_attempts=job.max_attempts,
        )
        return status or "lease_lost"
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
