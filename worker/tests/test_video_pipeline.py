import gzip
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from fa_worker.errors import JobFailure, LeaseLost
from fa_worker.video_provider import WindowLimit
from fa_worker import video_pipeline


@pytest.mark.parametrize("version",["llm-video-v1","action-first-v1"])
@pytest.mark.parametrize("failure_point",["commit","output_upload"])
def test_completed_llm_analysis_recovers_without_repeating_paid_calls(tmp_path,monkeypatch,version,failure_point):
    blobs = {}
    class Saved:
        def __init__(self,*args,**kwargs):pass
        def restore(self,directory,check):
            directory.mkdir(parents=True,exist_ok=True)
            result=[]
            for name,data in blobs.items():
                path=directory/name
                path.write_bytes(data)
                result.append(path)
            return result
        def publish(self,path):blobs[path.name]=path.read_bytes()
    native = Mock()
    def analyze(source,out,duration,provider,notify,tracking=None):
        assert tracking is None
        native()
        (out/"crops").mkdir()
        if version=="llm-video-v1":
            (out/"crops"/"1.jpg").write_bytes(b"test-only-photo")
        result={"summary":{"models":{"events":"gemini-3.8-flash"},
                           "videoEvents":{"catalog":[{"id":"Unknown1","photoKey":None,"referenceSeconds":2}]
                                           if version=="llm-video-v1" else []}}}
        (out/"result.json").write_text(json.dumps(result))
        (out/"tracks.jsonl.gz").write_bytes(gzip.compress(b""))
        return result
    monkeypatch.setattr(video_pipeline,"Checkpoints",Saved)
    monkeypatch.setattr(video_pipeline,"VideoProvider",Mock())
    current,legacy = Mock(side_effect=analyze),Mock(side_effect=analyze)
    monkeypatch.setattr(video_pipeline,"analyze",current)
    monkeypatch.setattr(video_pipeline,"analyze_gallery",legacy)
    monkeypatch.setattr(video_pipeline,"binding",lambda *args:"test-binding")
    monkeypatch.setattr(video_pipeline,"compatible_bindings",lambda *args:())
    monkeypatch.setattr(video_pipeline,"register",Mock())
    monkeypatch.setattr(video_pipeline.queue,"complete",Mock(side_effect=[False,True] if failure_point=="commit" else [True]))
    storage=Mock()
    if failure_point=="output_upload":
        storage.put_file.side_effect=JobFailure("storage_unavailable","Temporary",retryable=True)
    storage.download.return_value=tmp_path/"source"
    job=SimpleNamespace(id="job",org_id="org",match_id="match",video_id="video",
                        config={"engine":"llm","pipelineVersion":version})
    settings=SimpleNamespace(worker_id="worker")
    video={"duration_seconds":5,"storage_key":"orgs/org/matches/match/videos/video/source","size_bytes":10}
    with pytest.raises(LeaseLost if failure_point=="commit" else JobFailure):
        video_pipeline.run(Mock(),storage,settings,job,Mock(),tmp_path/"first",video,Mock())
    storage.put_file.side_effect=None
    video_pipeline.run(Mock(),storage,settings,job,Mock(),tmp_path/"retry",video,Mock())
    assert native.call_count==1
    assert storage.download.call_count==1
    assert len(blobs)==1
    assert current.call_count==(version=="action-first-v1")
    assert legacy.call_count==(version=="llm-video-v1")
    assert video_pipeline.register.call_args.args[-1]==(1 if version=="llm-video-v1" else 0)


@pytest.mark.parametrize("code", ["ai_input_limit", "ai_output_limit"])
def test_pipeline_preserves_limit_cause_instead_of_retrying_as_a_timeout(tmp_path, monkeypatch, code):
    checkpoints = Mock()
    checkpoints.restore.return_value = []
    monkeypatch.setattr(video_pipeline, "Checkpoints", Mock(return_value=checkpoints))
    monkeypatch.setattr(video_pipeline, "binding", lambda *args: "test-binding")
    monkeypatch.setattr(video_pipeline, "compatible_bindings", lambda *args: ())
    monkeypatch.setattr(video_pipeline, "VideoProvider", Mock())
    monkeypatch.setattr(video_pipeline, "analyze", Mock(side_effect=WindowLimit(code)))
    job = SimpleNamespace(id="job", config={"engine": "llm","pipelineVersion":"action-first-v1"})
    video = {"duration_seconds": 180, "storage_key": "orgs/org/matches/match/videos/video/source", "size_bytes": 10}
    with pytest.raises(JobFailure) as error:
        video_pipeline.run(Mock(), Mock(), SimpleNamespace(worker_id="worker"), job, Mock(), tmp_path, video, Mock())
    assert error.value.code == code and not error.value.retryable


@pytest.mark.parametrize("enabled",[False,True])
def test_parallel_postprocessing_is_job_version_gated(tmp_path,monkeypatch,enabled):
    checkpoints=Mock()
    checkpoints.restore.return_value=[]
    monkeypatch.setattr(video_pipeline,"Checkpoints",Mock(return_value=checkpoints))
    configs=[]
    monkeypatch.setattr(video_pipeline,"binding",lambda job,video,cfg: configs.append(dict(cfg)) or "binding")
    monkeypatch.setattr(video_pipeline,"compatible_bindings",lambda *a:())
    analyze=Mock(side_effect=RuntimeError("stop before paid work"))
    monkeypatch.setattr(video_pipeline,"analyze",analyze)
    monkeypatch.setattr(video_pipeline,"VideoProvider",Mock())
    config={"engine":"llm","pipelineVersion":"action-first-v1","optimizationVersion":1}
    if enabled: config["parallelPostprocessingVersion"]=1
    job=SimpleNamespace(id="job",config=config)
    video={"duration_seconds":180,"storage_key":"source","size_bytes":10}
    with pytest.raises(RuntimeError,match="stop before paid"):
        video_pipeline.run(Mock(),Mock(),SimpleNamespace(worker_id="worker"),job,Mock(),tmp_path,video,Mock())
    assert analyze.call_args.kwargs.get("parallel_postprocessing",False)==enabled
    assert ("parallelPostprocessingVersion" in configs[0])==enabled
