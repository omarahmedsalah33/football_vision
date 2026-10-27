"""Stable LLM recovery contracts retain tenant/source/integrity boundaries."""
from types import SimpleNamespace

import pytest

from fa_worker import checkpoints as cp
from fa_worker.errors import JobFailure
from .test_checkpoints import Conn, MemoryStorage, SOURCE, JOB, batch


def context():
    return (SimpleNamespace(id=JOB, org_id="org", video_id="video", config={}),
            {"storage_key": SOURCE, "size_bytes": 123},
            {"pipelineVersion": "llm-video-v1", "policy": "test"})


def test_llm_binding_survives_infrastructure_source_edits(monkeypatch):
    job, video, cfg = context()
    before = cp.binding(job, video, cfg)
    monkeypatch.setattr(cp.Path, "rglob", lambda *args: pytest.fail("LLM binding hashed implementation files"))
    assert cp.binding(job, video, cfg) == before
    monkeypatch.setattr(cp, "LLM_CHECKPOINT_CONTRACT", "llm-recovery-2")
    assert cp.binding(job, video, cfg) != before
    assert cp.compatible_bindings(job, video, cfg) == ()


@pytest.mark.parametrize("changed", ["job", "org", "video", "source", "size", "policy", "packages"])
def test_contract_and_legacy_aliases_remain_scoped(changed, monkeypatch):
    job, video, cfg = context()
    before = cp.binding(job, video, cfg)
    old = set(cp.compatible_bindings(job, video, cfg))
    if changed in ("job","org","video"):
        setattr(job, {"job":"id","org":"org_id","video":"video_id"}[changed], "different")
    elif changed=="source": video["storage_key"] += "-different"
    elif changed=="size": video["size_bytes"] += 1
    elif changed=="policy": cfg["policy"] = "different"
    else: monkeypatch.setattr(cp, "version", lambda name: "changed-dependency")
    assert cp.binding(job, video, cfg) != before
    assert not old.intersection(cp.compatible_bindings(job, video, cfg))


@pytest.mark.parametrize("tamper", [False, True])
def test_only_audited_legacy_bindings_restore_with_integrity_checks(tmp_path, tamper):
    job, video, cfg = context()
    storage = MemoryStorage()
    args = (Conn(), storage, SimpleNamespace(worker_id="worker"), job, SOURCE)
    old_binding = cp.compatible_bindings(job, video, cfg)[0]
    old = cp.Checkpoints(*args, old_binding)
    batch(tmp_path/"batch", old)
    if tamper:
        key = old.entries[0]["key"]
        storage.objects[key] = b"tampered"
    # An unaudited binding must never be selected, even for the same job.
    stranger = cp.Checkpoints(*args, "b"*64)
    batch(tmp_path/"stranger", stranger)
    current = cp.Checkpoints(*args, cp.binding(job, video, cfg),
                             compatible=cp.compatible_bindings(job, video, cfg))
    if tamper:
        with pytest.raises(JobFailure, match="checkpoint_invalid"):
            current.restore(tmp_path/"retry")
    else:
        paths = current.restore(tmp_path/"retry")
        assert len(paths)==len(old.entries)


def test_tracking_keeps_strict_code_binding_and_no_aliases():
    job, video, cfg = context()
    cfg["playerTracking"] = "rfdetr-bytetrack-v1"
    assert cp.compatible_bindings(job, video, cfg) == ()


def test_real_pipeline_recovers_legacy_archive_after_output_upload_failure(tmp_path, monkeypatch):
    import gzip
    from unittest.mock import Mock
    from fa_worker import video_pipeline as pipeline

    job, video, _ = context()
    job.match_id = "match"
    job.config = {"engine":"llm", "pipelineVersion":"action-first-v1"}
    video["duration_seconds"] = 20
    storage = MemoryStorage()
    storage.objects[SOURCE] = b"source"
    original_put = storage.put_file
    def fail_output(key, path, mime):
        if key.endswith("/tracks.jsonl.gz"):
            raise JobFailure("storage_unavailable", "Temporary", retryable=True)
        original_put(key, path, mime)
    storage.put_file = fail_output
    inference = Mock()
    def analyze(source, out, *args, **kwargs):
        inference()
        (out/"tracks.jsonl.gz").write_bytes(gzip.compress(b""))
        return {"summary":{"models":{}, "videoEvents":{"catalog":[]}}}
    monkeypatch.setattr(pipeline, "analyze", analyze)
    monkeypatch.setattr(pipeline, "VideoProvider", Mock())
    monkeypatch.setattr(pipeline, "register", Mock())
    completed = Mock(return_value=True)
    monkeypatch.setattr(pipeline.queue, "complete", completed)
    # First attempt represents an audited worker before stable contracts.
    monkeypatch.setattr(pipeline, "binding",
                        lambda j,v,c: cp.compatible_bindings(j,v,c)[0])
    args = (Conn(), storage, SimpleNamespace(worker_id="worker"), job, Mock())
    with pytest.raises(JobFailure):
        pipeline.run(*args, tmp_path/"first", video, Mock())
    assert any(e["name"].startswith("result-") for e in job.config[cp.FIELD])
    assert not completed.called
    # Fresh disk + changed worker binding: no inference or source download allowed.
    monkeypatch.setattr(pipeline, "binding", cp.binding)
    storage.put_file = original_put
    original_download = storage.download
    def download(key, dest, size):
        assert key != SOURCE, "Recovery downloaded the original video"
        return original_download(key, dest, size)
    storage.download = download
    pipeline.run(*args, tmp_path/"retry", video, Mock())
    assert inference.call_count == 1
    completed.assert_called_once()
