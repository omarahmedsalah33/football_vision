"""Runs one claimed job through the pipeline stages.

Two kinds of job:
- prepare: validate the upload and extract reference frames for pitch calibration (free);
- analyze: computer-vision analysis of the calibrated video (counted against the plan).

Results are written in the same transaction that marks the job succeeded, so a failed or cancelled
job can never leave behind results that look real.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import asdict
from pathlib import Path

import av
from psycopg.types.json import Jsonb

from . import queue
from .config import Settings
from .errors import JobCancelled, JobFailure, LeaseLost
from .queue import ClaimedJob
from .stages.validate import validate_and_extract
from .storage import Storage

log = logging.getLogger("fa_worker.pipeline")

PREPARE_VERSION = "v0.2-prepare"
ANALYSIS_TIMEOUT_FACTOR = 4.0  # an analysis may take at most 4× the video length (plus a minute)


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
            """select v.storage_key, v.size_bytes, v.status, v.duration_seconds, m.deleted_at as match_deleted_at
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


def model_versions(stages: list[str]) -> dict:
    return {
        "pipeline": PREPARE_VERSION,
        "pyav": av.__version__,
        "libavformat": ".".join(str(x) for x in av.library_versions.get("libavformat", ())),
        "stages": stages,
    }


def frames_prefix(storage_key: str) -> str:
    """orgs/<org>/matches/<match>/videos/<video>/source → orgs/.../videos/<video>/frames/"""
    return storage_key.rsplit("/", 1)[0] + "/frames/"


def _prepare(conn, storage: Storage, settings: Settings, job: ClaimedJob, hb: Heartbeat, workdir: Path) -> None:
    video = _load_video(conn, job)
    _checkpoint(conn, settings, job, hb, "download", 0.05)
    path = storage.download(video["storage_key"], workdir / "source", int(video["size_bytes"]))

    _checkpoint(conn, settings, job, hb, "validate", 0.5)
    max_duration = float(job.config.get("maxDurationSeconds", 0)) or 0.0
    if max_duration <= 0:
        raise JobFailure("invalid_job", "This analysis request is invalid.")
    info, frames, camera_motion = validate_and_extract(path, workdir / "frames", max_duration, settings.probe_timeout_seconds)

    _checkpoint(conn, settings, job, hb, "frames", 0.8)
    if not frames:
        raise JobFailure("no_frames", "No usable frames could be extracted from the video.", reject_video=True)
    stored = []
    prefix = frames_prefix(video["storage_key"])
    for f in frames:
        key = prefix + f["file"]
        storage.put_file(key, workdir / "frames" / f["file"], "image/jpeg")
        stored.append({"key": key, "timeSeconds": f["time_seconds"], "width": f["width"], "height": f["height"]})

    _checkpoint(conn, settings, job, hb, "finalize", 0.95)

    def persist(cur) -> None:
        cur.execute(
            """update videos set status = 'validated', container = %s, video_codec = %s,
                      duration_seconds = %s, width = %s, height = %s, fps = %s, frames = %s, camera_motion = %s
                where id = %s and org_id = %s""",
            (info.container, info.video_codec, info.duration_seconds, info.width, info.height, info.fps,
             Jsonb(stored), camera_motion, job.video_id, job.org_id),
        )

    if not queue.complete(conn, job.id, settings.worker_id, model_versions(["download", "validate", "frames"]), persist_results=persist):
        raise LeaseLost()
    log.info("prepare succeeded", extra={"job_id": job.id, "video": asdict(info)})


def _run_analysis_child(conn, settings: Settings, job: ClaimedJob, hb: Heartbeat, video_path: Path, cfg: dict, out_dir: Path, timeout_s: float) -> None:
    """Runs fa_worker.analysis.run in a child process, relaying progress and honouring cancellation."""
    out_dir.mkdir(parents=True, exist_ok=True)
    cfg_path = out_dir / "config.json"
    cfg_path.write_text(json.dumps(cfg))
    cmd = [sys.executable, "-I", "-m", "fa_worker.analysis.run", str(video_path), str(cfg_path), str(out_dir)]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=Path(__file__).resolve().parents[1])
    deadline = time.monotonic() + timeout_s
    last_report = 0.0
    stderr_tail: list[str] = []

    def drain_stderr() -> None:
        # Keep the pipe from filling up; keep only a short tail for the logs.
        for line in proc.stderr:
            stderr_tail.append(line.rstrip())
            del stderr_tail[:-20]

    reader = threading.Thread(target=drain_stderr, daemon=True)
    reader.start()
    failure: tuple[str, str] | None = None
    try:
        for line in proc.stdout:
            if line.startswith("FAILURE "):
                _, code, message = line.rstrip("\n").split(" ", 2)
                failure = (code, message)
            if line.startswith("PROGRESS ") and time.monotonic() - last_report > 3:
                _, stage, fraction = line.split()
                _checkpoint(conn, settings, job, hb, stage, float(fraction))
                last_report = time.monotonic()
            if hb.cancel_requested.is_set():
                raise JobCancelled()
            if hb.lost.is_set():
                raise LeaseLost()
            if time.monotonic() > deadline:
                raise JobFailure("analysis_timeout", "The analysis took too long and was stopped.")
        code = proc.wait(timeout=30)
    except BaseException:
        proc.kill()
        proc.wait()
        raise
    finally:
        reader.join(timeout=5)
    if code == 3 and failure is not None:
        raise JobFailure(failure[0], failure[1])
    if code != 0:
        log.error("analysis child failed", extra={"job_id": job.id, "code": code, "stderr": stderr_tail[-5:]})
        raise JobFailure("analysis_failed", "The analysis could not be completed.", retryable=True)


def tracks_key(storage_key: str, job_id: str) -> str:
    """orgs/<org>/matches/<match>/videos/<video>/source → orgs/<org>/matches/<match>/analysis/<job>/tracks.jsonl.gz"""
    return storage_key.rsplit("/videos/", 1)[0] + f"/analysis/{job_id}/tracks.jsonl.gz"


def _analyze(conn, storage: Storage, settings: Settings, job: ClaimedJob, hb: Heartbeat, workdir: Path) -> None:
    video = _load_video(conn, job)
    if video["status"] != "validated":
        raise JobFailure("video_not_ready", "The video has not been checked yet.")
    calibration = job.config.get("calibration")
    if not calibration or not calibration.get("homography"):
        raise JobFailure("invalid_job", "This analysis has no pitch calibration.")

    _checkpoint(conn, settings, job, hb, "download", 0.02)
    path = storage.download(video["storage_key"], workdir / "source", int(video["size_bytes"]))

    out_dir = workdir / "analysis"
    cfg = {
        "pipelineVersion": job.config.get("pipelineVersion"),
        "calibration": calibration,
        "sampleFps": job.config.get("sampleFps", settings.analysis_sample_fps),
        "detector": job.config.get("detector", settings.detector_config()),
        "cameraMotion": job.config.get("cameraMotion"),
    }
    duration = float(video.get("duration_seconds") or 0) or 600.0
    _checkpoint(conn, settings, job, hb, "detect", 0.05)
    _run_analysis_child(conn, settings, job, hb, path, cfg, out_dir, timeout_s=60 + duration * ANALYSIS_TIMEOUT_FACTOR)

    result = json.loads((out_dir / "result.json").read_text())
    key = tracks_key(video["storage_key"], job.id)
    storage.put_file(key, out_dir / "tracks.jsonl.gz", "application/gzip")
    # Player photos: footage of people, stored privately next to the analysis and purged with the footage.
    crop_keys: dict[int, str] = {}
    for t in result["tracks"]:
        if t.get("crop_file"):
            crop_keys[t["track_no"]] = key.rsplit("/", 1)[0] + f"/players/{t['crop_file']}"
            storage.put_file(crop_keys[t["track_no"]], out_dir / "crops" / t["crop_file"], "image/jpeg")
    _checkpoint(conn, settings, job, hb, "finalize", 0.97)

    def persist(cur) -> None:
        # Results exist if and only if the job is recorded as succeeded (same transaction).
        cur.execute("delete from analysis_tracks where job_id = %s", (job.id,))
        cur.execute(
            """insert into analysis_results (job_id, org_id, match_id, calibration_id, summary, tracks_key)
               values (%s, %s, %s, %s, %s, %s)
               on conflict (job_id) do update set summary = excluded.summary, tracks_key = excluded.tracks_key""",
            (job.id, job.org_id, job.match_id, calibration.get("id"), Jsonb(result["summary"]), key),
        )
        for t in result["tracks"]:
            cur.execute(
                """insert into analysis_tracks (job_id, org_id, track_no, team, first_seconds, last_seconds,
                                               coverage, avg_x, avg_y, distance_m, heatmap, metrics, crop_key)
                   values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (job.id, job.org_id, t["track_no"], t["team"], t["first_seconds"], t["last_seconds"], t["coverage"],
                 t["avg_x"], t["avg_y"], t["distance_m"], Jsonb(t["heatmap"]),
                 Jsonb({**t.get("profile", {}), "fragments": t.get("fragments", 1)}), crop_keys.get(t["track_no"])),
            )

    versions = {**result["summary"]["models"], "pipeline": job.config.get("pipelineVersion")}
    if not queue.complete(conn, job.id, settings.worker_id, versions, persist_results=persist):
        raise LeaseLost()
    log.info("analysis succeeded", extra={"job_id": job.id, "tracks": len(result["tracks"])})


def process(conn, storage: Storage, settings: Settings, job: ClaimedJob) -> str:
    """Processes a claimed job and returns its final status for logging."""
    workdir = settings.work_dir / job.id
    ctx = {"job_id": job.id, "attempt": job.attempts, "kind": job.kind}
    try:
        with Heartbeat(settings, job.id) as hb:
            if job.kind == "analyze":
                _analyze(conn, storage, settings, job, hb, workdir)
            else:
                _prepare(conn, storage, settings, job, hb, workdir)
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
            # Only the prepare stage judges the uploaded file itself; analysis failures never blame it.
            if failure.reject_video and job.kind == "prepare":
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
