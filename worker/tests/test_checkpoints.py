"""Retry safety without a GPU or a live database."""
import gzip
import io
import json
import shutil
import tarfile
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from fa_worker.analysis.detection_cache import BATCH, DetectionCache
from fa_worker.checkpoints import Checkpoints, FIELD, binding, pack_result, unpack_result
from fa_worker.errors import JobCancelled, JobFailure, LeaseLost

SOURCE = "orgs/11111111-1111-4111-8111-111111111111/matches/22222222-2222-4222-8222-222222222222/videos/33333333-3333-4333-8333-333333333333/source"
JOB = "44444444-4444-4444-8444-444444444444"


class MemoryStorage:
    def __init__(self):
        self.objects = {}
        self.fail = False

    def put_file(self, key, path, mime):
        if self.fail:
            raise JobFailure("storage_unavailable", "Unavailable", retryable=True)
        self.objects[key] = path.read_bytes()

    def download(self, key, dest, size):
        if key not in self.objects:
            raise JobFailure("video_missing", "Missing")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(self.objects[key])
        return dest


class Conn:
    allowed = True

    def transaction(self):
        return nullcontext()

    def cursor(self):
        return nullcontext(self)

    def execute(self, sql, params):
        self.sql, self.params = sql, params
        if "jsonb_set" in sql:
            self.recorded = params[0].obj

    def fetchone(self):
        return {"id": JOB} if self.allowed else None


@pytest.fixture
def store():
    job = SimpleNamespace(id=JOB, org_id="org", video_id="video", config={})
    return Checkpoints(Conn(), MemoryStorage(), SimpleNamespace(worker_id="worker"), job, SOURCE, "a" * 64)


class Detector:
    version = "test-detector-v1"

    def __init__(self):
        self.calls = []

    def detect(self, image, second):
        self.calls.append(second)
        return np.array([[second, 1, second + 2, 3, 0.9]])


def batch(tmp_path, store, count=3):
    detector = Detector()
    cache = DetectionCache(lambda: detector, tmp_path, publish=store.publish)
    for i in range(count):
        cache.detect(None, i / 4)
    cache.flush()
    return detector, cache


def test_completed_batches_reused_after_worker_disk_disappears(store, tmp_path):
    original, _ = batch(tmp_path / "first", store, BATCH + 5)
    assert len(store.entries) == 2
    shutil.rmtree(tmp_path / "first")
    paths = store.restore(tmp_path / "retry")
    replacement = Detector()
    replay = DetectionCache(lambda: replacement, tmp_path / "retry", paths, store.publish)
    for i in range(BATCH + 8):
        np.testing.assert_array_equal(replay.detect(None, i / 4), [[i / 4, 1, i / 4 + 2, 3, 0.9]])
    assert replacement.calls == [(BATCH + i) / 4 for i in (5, 6, 7)]
    assert replay.hits == len(original.calls)


def test_crash_only_loses_unfinished_batch(store, tmp_path):
    detector = Detector()
    cache = DetectionCache(lambda: detector, tmp_path / "first", publish=store.publish)
    for i in range(BATCH + 7):
        cache.detect(None, i / 4)
    assert len(store.entries) == 1  # No flush: simulate an abrupt process death.
    recovered = DetectionCache(lambda: Detector(), tmp_path / "retry", store.restore(tmp_path / "retry"), store.publish)
    for i in range(BATCH + 7):
        recovered.detect(None, i / 4)
    assert len(recovered.detector.calls) == 7


def test_all_cached_detections_do_not_construct_gpu_model(store, tmp_path):
    batch(tmp_path / "first", store)
    def forbidden():
        pytest.fail("GPU model was constructed during a cache-only replay")
    replay = DetectionCache(forbidden, tmp_path / "retry", store.restore(tmp_path / "retry"))
    for i in range(3):
        replay.detect(None, i / 4)
    assert replay.version == "test-detector-v1"


def test_missing_registered_upload_is_a_cache_miss(store, tmp_path):
    store.storage.fail = True
    with pytest.raises(JobFailure):
        batch(tmp_path, store)
    assert store.job.config[FIELD] == store.conn.recorded
    assert store.entries and not store.storage.objects
    store.storage.fail = False
    assert store.restore(tmp_path / "retry") == []


def test_lost_or_cancelled_lease_cannot_publish(store, tmp_path):
    store.conn.allowed = False
    with pytest.raises(LeaseLost):
        batch(tmp_path, store)
    assert not store.storage.objects and FIELD not in store.job.config
    assert "lease_expires_at > now()" in store.conn.sql
    assert "not cancel_requested" in store.conn.sql


def test_corrupted_checkpoint_is_not_reused(store, tmp_path):
    batch(tmp_path / "first", store)
    key = store.entries[0]["key"]
    data = store.storage.objects[key]
    store.storage.objects[key] = b"!" + data[1:]
    with pytest.raises(JobFailure, match="integrity"):
        store.restore(tmp_path / "retry")


def test_changed_binding_does_not_reuse_saved_detections(store, tmp_path):
    batch(tmp_path / "first", store)
    store.binding = "b" * 64
    assert store.restore(tmp_path / "retry") == []


@pytest.mark.parametrize("field,value", [("key", "../another-tenant"), ("size", -1), ("name", "../source")])
def test_metadata_cannot_escape_job_namespace(store, tmp_path, field, value):
    batch(tmp_path, store)
    store.job.config[FIELD][0][field] = value
    with pytest.raises(JobFailure):
        Checkpoints(store.conn, store.storage, store.settings, store.job, SOURCE, store.binding)


def test_binding_changes_for_video_calibration_model_and_sampling(store):
    video = {"storage_key": SOURCE, "size_bytes": 100}
    cfg = {"calibration": {"matrix": [1]}, "detector": {"size": "medium"}, "sampleFps": 4}
    original = binding(store.job, video, cfg)
    for updated in [
        {**cfg, "sampleFps": 8},
        {**cfg, "calibration": {"matrix": [2]}},
        {**cfg, "detector": {"size": "small"}},
    ]:
        assert binding(store.job, video, updated) != original
    assert binding(store.job, {**video, "size_bytes": 101}, cfg) != original
    assert binding(store.job, {**video, "storage_key": SOURCE + "changed"}, cfg) != original


def test_result_bundle_restores_photos_and_tracks_and_is_preferred(store, tmp_path):
    batch(tmp_path / "detections", store)
    directory = tmp_path / "output"
    (directory / "crops").mkdir(parents=True)
    (directory / "result.json").write_text('{"summary": {}, "tracks": []}')
    (directory / "tracks.jsonl.gz").write_bytes(gzip.compress(b'{"t":0,"p":[]}'))
    (directory / "crops" / "1.jpg").write_bytes(b"private player photo")
    store.publish(pack_result(directory, tmp_path / "packed"))
    paths = store.restore(tmp_path / "retry")
    assert len(paths) == 1 and paths[0].name.startswith("result-")
    unpack_result(paths[0], tmp_path / "unpacked")
    for name in ("result.json", "tracks.jsonl.gz", "crops/1.jpg"):
        assert (directory / name).read_bytes() == (tmp_path / "unpacked" / name).read_bytes()


@pytest.mark.parametrize("name", ["../escape", "/escape", "crops/../escape", "config.json"])
def test_result_archive_refuses_unexpected_paths(tmp_path, name):
    path = tmp_path / "invalid.tar.gz"
    with tarfile.open(path, "w:gz") as archive:
        info = tarfile.TarInfo(name)
        info.size = 1
        archive.addfile(info, io.BytesIO(b"x"))
    with pytest.raises(JobFailure):
        unpack_result(path, tmp_path / "output")
    assert not (tmp_path / "escape").exists()


def test_restoration_honours_cancellation(store, tmp_path):
    batch(tmp_path / "first", store)
    def cancelled():
        raise JobCancelled()
    with pytest.raises(JobCancelled):
        store.restore(tmp_path / "retry", cancelled)


def test_finished_analysis_retry_skips_child_and_source_download(store, tmp_path, monkeypatch):
    """Fail after analysis, discard the local disk, and recover through the actual orchestrator."""
    import threading
    from fa_worker import pipeline

    video = {"storage_key": SOURCE, "size_bytes": 5, "status": "validated", "duration_seconds": 5}
    cfg = {"calibration": {"homography": {"matrix": [1]}}, "sampleFps": 4}
    job = SimpleNamespace(id=JOB, org_id="org", match_id="match", video_id="video", config=cfg)
    settings = SimpleNamespace(worker_id="worker", analysis_sample_fps=4, detector_config=lambda: {"kind": "synthetic"})
    hb = SimpleNamespace(lost=threading.Event(), cancel_requested=threading.Event())
    calls = []
    monkeypatch.setattr(pipeline, "_load_video", lambda *a: video)
    monkeypatch.setattr(pipeline, "_checkpoint", lambda *a: None)
    monkeypatch.setattr(pipeline.queue, "complete", lambda *a, **kw: calls.append("complete") or True)
    def child(conn, settings, job, hb, source, cfg, out, **kwargs):
        calls.append("child")
        (out / "result.json").write_text(json.dumps({"summary": {"models": {"detector": "test"}}, "tracks": []}))
        (out / "tracks.jsonl.gz").write_bytes(gzip.compress(b"tracks"))
    monkeypatch.setattr(pipeline, "_run_analysis_child", child)
    storage = store.storage
    storage.objects[SOURCE] = b"video"
    original_put, original_download = storage.put_file, storage.download
    def put(key, path, mime):
        if key.endswith("/tracks.jsonl.gz"):
            raise JobFailure("storage_unavailable", "temporary", retryable=True)
        original_put(key, path, mime)
    storage.put_file = put
    with pytest.raises(JobFailure):
        pipeline._analyze_tracking_legacy(store.conn, storage, settings, job, hb, tmp_path / "first")
    assert calls == ["child"]  # No successful result was published.
    shutil.rmtree(tmp_path / "first")
    storage.put_file = original_put
    def download(key, dest, size):
        assert key != SOURCE, "A completed analysis retry must not download the source video"
        return original_download(key, dest, size)
    storage.download = download
    pipeline._analyze_tracking_legacy(store.conn, storage, settings, job, hb, tmp_path / "retry")
    assert calls == ["child", "complete"]


def test_parent_uploads_and_acknowledges_actual_child_checkpoint(store, tmp_path, monkeypatch):
    import subprocess
    import sys
    import threading
    from fa_worker import pipeline

    original = subprocess.Popen
    observed = []
    def publish(path):
        observed.append(path.name)
    script = (
        "import sys;print('CHECKPOINT detections-'+'a'*64+'.json.gz',flush=True);"
        "assert sys.stdin.readline().strip()=='saved';print('DONE',flush=True)"
    )
    monkeypatch.setattr(pipeline.subprocess, "Popen", lambda *a, **kw: original(
        [sys.executable, "-c", script], **kw))
    monkeypatch.setattr(pipeline, "_checkpoint", lambda *a: None)
    hb = SimpleNamespace(lost=threading.Event(), cancel_requested=threading.Event())
    pipeline._run_analysis_child(None, None, store.job, hb, tmp_path / "video", {}, tmp_path / "out",
                                  timeout_s=10, checkpoints=SimpleNamespace(publish=publish))
    assert observed == ["detections-" + "a" * 64 + ".json.gz"]


def test_silent_child_still_honours_timeout_and_cancellation(store, tmp_path, monkeypatch):
    import subprocess
    import sys
    import threading
    from fa_worker import pipeline

    original = subprocess.Popen
    processes = []
    def spawn(*args, **kwargs):
        proc = original([sys.executable, "-c", "import time;time.sleep(60)"], **kwargs)
        processes.append(proc)
        return proc
    monkeypatch.setattr(pipeline.subprocess, "Popen", spawn)
    hb = SimpleNamespace(lost=threading.Event(), cancel_requested=threading.Event())
    with pytest.raises(JobFailure, match="analysis_timeout"):
        pipeline._run_analysis_child(None, None, store.job, hb, tmp_path / "video", {}, tmp_path / "out", timeout_s=0.1)
    hb.cancel_requested.set()
    with pytest.raises(JobCancelled):
        pipeline._run_analysis_child(None, None, store.job, hb, tmp_path / "video", {}, tmp_path / "out", timeout_s=10)
    assert all(p.poll() is not None for p in processes)


def test_actual_analysis_replay_keeps_metrics_tracks_and_photos_identical(tmp_path, monkeypatch):
    from fa_worker.analysis import run
    from .conftest import write_video

    class StableTracker:
        version = "test-stable-tracker"
        def __init__(self, **kwargs):
            pass
        def update(self, boxes):
            return boxes[:, :4], np.arange(1, len(boxes) + 1)

    class People:
        version = "test-people"
        def detect(self, image, second):
            return np.array([[20, 20, 50, 80, 0.9], [200, 30, 230, 95, 0.95]])

    monkeypatch.setattr(run, "ByteTrackTracker", StableTracker)
    monkeypatch.setattr(run, "build_detector", lambda cfg: People())
    monkeypatch.setattr("sys.stdin", io.StringIO("saved\n" * 100))
    video = write_video(tmp_path / "video.mp4", seconds=4)
    cfg = {
        "pipelineVersion": "test", "cameraMotion": "fixed", "sampleFps": 4, "reuseDetections": True,
        "calibration": {
            "homography": {"matrix": [[0.1, 0, 0], [0, 0.1, 0], [0, 0, 1]]},
            "rmsErrorM": 0.2,
        },
    }
    first, retry = tmp_path / "first", tmp_path / "retry"
    first.mkdir()
    result = run.analyse(video, cfg, first)
    assert list((first / "checkpoints").glob("detections-*.json.gz"))
    shutil.copytree(first / "checkpoints", retry / "checkpoints")
    def forbidden(cfg):
        pytest.fail("Cached analysis rebuilt the GPU detector")
    monkeypatch.setattr(run, "build_detector", forbidden)
    resumed = run.analyse(video, cfg, retry)
    result["summary"]["quality"].pop("processingSeconds")
    resumed["summary"]["quality"].pop("processingSeconds")
    assert resumed == result
    assert gzip.decompress((first / "tracks.jsonl.gz").read_bytes()) == gzip.decompress((retry / "tracks.jsonl.gz").read_bytes())
    assert [p.read_bytes() for p in sorted((first / "crops").glob("*.jpg"))] == [
        p.read_bytes() for p in sorted((retry / "crops").glob("*.jpg"))]


@pytest.mark.parametrize("status", ["succeeded", "failed", "cancelled", "queued", "running"])
def test_cleanup_removes_terminal_batches_but_retains_retryable_work(store, tmp_path, status):
    from fa_worker.maintenance import purge_job_checkpoints
    batch(tmp_path, store)
    row = {"id": JOB, "config": store.job.config, "storage_key": SOURCE}
    class CleanupConn(Conn):
        def execute(self, sql, params):
            if sql.startswith("update"):
                row["config"].pop(FIELD)
            else:
                assert "for update of j" in sql and "not in ('queued', 'running')" in sql
        def fetchone(self):
            return row if status not in ("queued", "running") else None
    deleted = []
    store.storage.delete_object = lambda key: deleted.append(key)
    purge_job_checkpoints(CleanupConn(), store.storage, JOB)
    assert bool(deleted) == (status not in ("queued", "running"))
    assert (FIELD in row["config"]) == (status in ("queued", "running"))


def test_cleanup_storage_failure_retains_registry_for_later_sweep(store, tmp_path):
    from fa_worker.maintenance import purge_job_checkpoints
    batch(tmp_path, store)
    row = {"id": JOB, "config": store.job.config, "storage_key": SOURCE}
    class CleanupConn(Conn):
        def execute(self, sql, params):
            assert not sql.startswith("update"), "Metadata must remain when deletion fails"
        def fetchone(self):
            return row
    def broken(key):
        raise OSError("Temporary storage outage")
    store.storage.delete_object = broken
    with pytest.raises(OSError):
        purge_job_checkpoints(CleanupConn(), store.storage, JOB)
    assert FIELD in row["config"]
