import json
import pytest
from experiments import full_latest


@pytest.mark.parametrize("parallel",[False,True])
def test_full_run_uses_all_current_options_without_paid_calls(tmp_path, monkeypatch,parallel):
    class FakeProvider:
        cache = {}
        requests = []
        def __init__(self,*args): pass
    monkeypatch.setattr(full_latest,"FullProvider",FakeProvider)
    def analyze(source,out,duration,provider,progress,**options):
        assert duration == 180
        expected=dict(fast=True,game_stats=True,select_photos=True,
                      review_strategy="focused",discovery_concurrency=10)
        if parallel: expected["parallel_postprocessing"]=True
        assert options==expected
        progress("llm_identity",.4)
        return {"summary":{"videoEvents":{"catalog":[],"events":[]}}}
    monkeypatch.setattr(full_latest,"analyze",analyze)
    if parallel:
        (tmp_path/"test").mkdir()
        (tmp_path/"test/before-parallel-result.json").write_text(
            json.dumps({"summary":{"videoEvents":{"catalog":[],"events":[]}}}))
    full_latest.run(tmp_path/"test",parallel_postprocessing=parallel)
    status=json.loads((tmp_path/"test/status.json").read_text())
    assert status["status"]=="succeeded" and not status["warmResume"]
    if parallel: assert status["consistency"]["allMatch"]
