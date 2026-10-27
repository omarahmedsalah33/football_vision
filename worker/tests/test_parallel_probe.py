import json
import threading
import pytest
from experiments import probe_parallel


@pytest.mark.parametrize("count",[2,5,10])
def test_probe_issues_overlapping_calls_without_network(tmp_path,monkeypatch,count):
    monkeypatch.chdir(tmp_path)
    (tmp_path/"generated-artifacts/speed-comparison/optimized").mkdir(parents=True)
    monkeypatch.setattr(probe_parallel.time,"sleep",lambda seconds:None)
    def capture(source,out,duration,recorder,*args,**kwargs):
        for i in range(min(count,9)):
            recorder.call("gemini",f"section {i}",video=b"clip")
        raise probe_parallel.Collected()
    monkeypatch.setattr(probe_parallel,"analyze",capture)
    barrier=threading.Barrier(count)
    seen=[]
    def fake_call(self,provider,prompt,images,video):
        seen.append(prompt)
        barrier.wait(timeout=3)
        return {"events":[],"photoCandidates":[]}
    monkeypatch.setattr(probe_parallel.ProbeProvider,"call",fake_call)
    probe_parallel.main(count)
    assert len(seen)==count
    assert len(set(seen))==min(count,9)
    report=json.loads(next((tmp_path/"generated-artifacts/concurrency-probe").glob("*/status.json")).read_text())
    assert report["status"]=="completed"
    assert all(r["status"]=="succeeded" for r in report["requests"])
    assert sum(r["repeatedForCapacityTest"] for r in report["requests"])==(1 if count==10 else 0)
