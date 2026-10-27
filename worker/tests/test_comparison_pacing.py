import io
from unittest.mock import patch
from urllib.error import HTTPError
from email.message import Message

import pytest

from experiments.compare_tracking import ExperimentProvider
from fa_worker.errors import JobFailure


def provider():
    result = object.__new__(ExperimentProvider)
    result.next_request = {}
    return result


def limited(retry_after="0"):
    headers = Message()
    headers["Retry-After"] = retry_after
    return HTTPError("https://example.invalid", 429, "limited", headers, None)


def test_requests_are_spaced_and_retries_are_bounded():
    p = provider()
    with patch("experiments.compare_tracking.time.monotonic", return_value=0), \
         patch("experiments.compare_tracking.time.sleep") as sleep, \
         patch("experiments.compare_tracking.urlopen", side_effect=[
             limited(), limited(), limited(), limited()]) as request:
        with pytest.raises(JobFailure) as raised:
            p._send(None, "gemini")
    assert raised.value.code == "ai_rate_limited"
    assert request.call_count == 4
    assert [c.args[0] for c in sleep.call_args_list] == [60, 120, 240]


def test_retry_after_and_success_spacing():
    p = provider()
    with patch("experiments.compare_tracking.time.monotonic", return_value=0), \
         patch("experiments.compare_tracking.time.sleep") as sleep, \
         patch("experiments.compare_tracking.urlopen", side_effect=[
             limited("180"), io.BytesIO(b'{"ok":true}'), io.BytesIO(b'{"ok":true}')]):
        assert p._send(None, "gemini") == {"ok": True}
        assert p._send(None, "gemini") == {"ok": True}
    assert [c.args[0] for c in sleep.call_args_list] == [180, 60]


def test_non_rate_errors_and_long_retry_after_do_not_loop():
    for error in [limited("1800"), HTTPError("https://example.invalid",400,"bad",Message(),None)]:
        with patch("experiments.compare_tracking.urlopen", side_effect=error) as request:
            with pytest.raises(JobFailure):
                provider()._send(None, "gemini")
        assert request.call_count == 1


def test_report_separates_match_events_from_player_attribution():
    from experiments.report_completed_comparison import summarize
    event = {"type":"shot", "outcome":"goal", "matchIncluded":True, "included":False,
             "goalAccepted":True, "review":{"identity":"contradicted","outcome":"inconclusive"}}
    data = {"events":[event], "catalog":[{"id":"Unknown1"}], "players":[],
            "audit":{"reviewed":1}, "completedWindows":9, "totalWindows":9}
    counts = summarize(data)
    assert counts["matchShots"] == counts["goals"] == counts["shotsOnTarget"] == 1
    assert counts["playerAttributedEvents"] == 0
    assert counts["matchEventsWithoutCountedPlayer"] == 1
    event.update(goalAccepted=False, review={"outcome":"contradicted"})
    counts = summarize(data)
    assert counts["matchShots"] == 1
    assert counts["goals"] == counts["shotsOnTarget"] == 0


def test_action_first_run_is_untracked_and_preserves_baseline(tmp_path,monkeypatch):
    import json
    from experiments import compare_tracking
    monkeypatch.chdir(tmp_path)
    root = tmp_path/"generated-artifacts"/"tracking-comparison"
    baseline = root/"baseline"/"result.json"
    baseline.parent.mkdir(parents=True)
    baseline.write_text('{"original":"unchanged"}')
    def analyze(source,out,duration,provider,progress,tracking=None):
        assert tracking is None and duration == 180
        assert out == root.relative_to(tmp_path)/"action-first"
        return {"summary":{"videoEvents":{"catalog":[]}}}
    monkeypatch.setattr(compare_tracking,"analyze",analyze)
    compare_tracking.run("action-first")
    assert json.loads((root/"action-first"/"status.json").read_text())["status"] == "succeeded"
    assert baseline.read_text() == '{"original":"unchanged"}'


def test_unexpected_experiment_failure_records_failed_status(tmp_path,monkeypatch):
    import json
    from experiments import compare_tracking
    monkeypatch.chdir(tmp_path)
    def fail(*args,**kwargs):
        raise ValueError("test failure")
    monkeypatch.setattr(compare_tracking,"analyze",fail)
    with pytest.raises(ValueError):
        compare_tracking.run("action-first")
    status = tmp_path/"generated-artifacts"/"tracking-comparison"/"action-first"/"status.json"
    assert json.loads(status.read_text())["status"] == "failed"
