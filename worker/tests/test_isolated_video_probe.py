import subprocess
from pathlib import Path

# Import the REAL parent that also loads PyAV and starts heartbeat threads in production.
from fa_worker import pipeline
from fa_worker.stages.validate import validate_and_extract,run_probe


def test_valid_upload_decodes_in_isolated_source_worker(tmp_path):
    source=tmp_path/"video.mp4"
    subprocess.run(["ffmpeg","-v","error","-f","lavfi","-i","color=green:s=1280x720:d=10:r=10",
                    "-c:v","libx264","-threads","2",str(source)],check=True,timeout=20)
    info,frames,_=validate_and_extract(source,tmp_path/"frames",600,30)
    assert info.duration_seconds==10
    assert len(frames)==8


def test_decoder_has_no_worker_credentials_or_unbounded_math_threads(tmp_path,monkeypatch):
    def child(cmd,**kwargs):
        assert kwargs["env"]["OPENBLAS_NUM_THREADS"]=="1"
        assert "WORKER_STORAGE_TOKEN" not in kwargs["env"]
        assert "DATABASE_URL" not in kwargs["env"]
        assert "preexec_fn" not in kwargs
        assert "-I" in cmd
        return subprocess.CompletedProcess(cmd,0,stdout=b"{}",stderr=b"")
    monkeypatch.setattr(subprocess,"run",child)
    assert run_probe(tmp_path/"video.mp4",30)=={}
