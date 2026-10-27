import io
import gzip
import json
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError

import pytest

from fa_worker.errors import JobFailure
from fa_worker.video_provider import VideoProvider, WindowLimit


def settings():
    return SimpleNamespace(storage_provider="replit",worker_storage_url="https://website.test/api/internal/worker-storage",
                           worker_storage_token="test-only-service-key",worker_id="worker-1")


def response(**changes):
    return {"modelVersion":"gemini-3.8-flash","candidates":[{"finishReason":"STOP",
            "content":{"parts":[{"text":'{"events":[]}'}]}}],
            "usageMetadata":{"promptTokensDetails":[{"modality":"VIDEO","tokenCount":660}]},**changes}


def provider(tmp_path, restored=(), config=None):
    cp = Mock()
    cp.restore.return_value = restored
    return VideoProvider(config or settings(),SimpleNamespace(id="job-1"),cp,tmp_path,Mock())


def test_successful_call_is_reused_after_worker_identity_changes(tmp_path):
    first = provider(tmp_path)
    with patch("fa_worker.video_provider.urlopen",return_value=io.BytesIO(json.dumps(response()).encode())) as network:
        assert first.call("gemini","events",video=b"video") == {"events":[]}
        saved = list(tmp_path.glob("llm-*.json.gz"))
        cfg = settings()
        cfg.worker_id = "worker-2"
        second = provider(tmp_path,saved,cfg)
        assert second.call("gemini","events",video=b"video") == {"events":[]}
        assert network.call_count == 1
    first.checkpoints.publish.assert_called_once()


def test_token_limit_is_preserved_and_not_retried_with_identical_input(tmp_path):
    p = provider(tmp_path)
    raw = response(candidates=[{"finishReason":"MAX_TOKENS","content":{"parts":[{"text":"partial"}]}}])
    with patch("fa_worker.video_provider.urlopen",return_value=io.BytesIO(json.dumps(raw).encode())) as network:
        with pytest.raises(WindowLimit):p.call("gemini","events",video=b"video")
        with pytest.raises(WindowLimit):p.call("gemini","events",video=b"video")
        assert network.call_count == 1


def test_native_video_modality_must_be_acknowledged(tmp_path):
    p = provider(tmp_path)
    with patch("fa_worker.video_provider.urlopen",return_value=io.BytesIO(json.dumps(response(usageMetadata={})).encode())):
        with pytest.raises(JobFailure):p.call("gemini","events",video=b"video")
    p.checkpoints.publish.assert_not_called()


def test_authorization_error_does_not_expose_upstream_urls(tmp_path):
    p = provider(tmp_path)
    with patch("fa_worker.video_provider.urlopen",side_effect=HTTPError("https://private.invalid/?credential=DO_NOT_LEAK",401,"Unauthorized",{},None)):
        with pytest.raises(JobFailure) as error:p.call("gemini","events",video=b"video")
    assert "DO_NOT_LEAK" not in str(error.value)


def http_error(status, code=None, headers=None):
    return HTTPError("https://private.invalid/?secret=DO_NOT_LEAK", status, "upstream detail",
                     headers or {}, io.BytesIO(json.dumps({"code": code}).encode()))


@pytest.mark.parametrize("status,code", [
    (429, "ai_rate_limited"), (503, "ai_provider_unavailable"),
    (504, "ai_provider_timeout"), (408, "ai_provider_timeout"),
])
def test_temporary_http_errors_retry_same_input_without_poisoning_cache(tmp_path, status, code):
    p = provider(tmp_path)
    success = io.BytesIO(json.dumps(response()).encode())
    with patch("fa_worker.video_provider.urlopen", side_effect=[http_error(status, code), success]) as network, \
         patch("fa_worker.video_provider.time.sleep") as sleep:
        assert p.call("gemini", "events", video=b"video") == {"events": []}
    assert network.call_count == 2
    assert network.call_args_list[0].args[0].data == network.call_args_list[1].args[0].data
    sleep.assert_called_once()
    assert len(list(tmp_path.glob("llm-*.json.gz"))) == 1  # successful response only


@pytest.mark.parametrize("failure,code", [
    (TimeoutError("DO_NOT_LEAK"), "ai_provider_timeout"),
    (URLError("DO_NOT_LEAK"), "ai_provider_unavailable"),
])
def test_network_failures_are_bounded_retryable_not_window_limits(tmp_path, failure, code):
    p = provider(tmp_path)
    with patch("fa_worker.video_provider.urlopen", side_effect=failure) as network, \
         patch("fa_worker.video_provider.time.sleep"):
        with pytest.raises(JobFailure) as error:
            p.call("gemini", "events", video=b"video")
    assert not isinstance(error.value, WindowLimit)
    assert error.value.code == code and error.value.retryable
    assert network.call_count == 3
    assert "DO_NOT_LEAK" not in str(error.value)
    p.checkpoints.publish.assert_not_called()


def test_exhausted_temporary_failure_can_succeed_on_next_worker_attempt(tmp_path):
    p = provider(tmp_path)
    with patch("fa_worker.video_provider.urlopen", side_effect=http_error(503)), \
         patch("fa_worker.video_provider.time.sleep"):
        with pytest.raises(JobFailure):
            p.call("gemini", "events", video=b"video")
    assert not p.cache
    with patch("fa_worker.video_provider.urlopen", return_value=io.BytesIO(json.dumps(response()).encode())):
        assert p.call("gemini", "events", video=b"video") == {"events": []}


@pytest.mark.parametrize("status,code", [
    (502, "ai_provider_credentials"), (502, "ai_provider_model"),
    (422, "ai_request_invalid"), (503, "ai_not_configured"),
])
def test_configuration_errors_are_not_retried_or_split(tmp_path, status, code):
    p = provider(tmp_path)
    with patch("fa_worker.video_provider.urlopen", side_effect=http_error(status, code)) as network:
        with pytest.raises(JobFailure) as error:
            p.call("gemini", "events", video=b"video")
    assert error.value.code == code and not error.value.retryable
    assert not isinstance(error.value, WindowLimit)
    assert network.call_count == 1
    p.checkpoints.publish.assert_not_called()


def test_true_input_limit_is_distinct_and_reused(tmp_path):
    p = provider(tmp_path)
    with patch("fa_worker.video_provider.urlopen", side_effect=http_error(413)) as network:
        for _ in range(2):
            with pytest.raises(WindowLimit) as error:
                p.call("gemini", "events", video=b"video")
            assert error.value.code == "ai_input_limit"
    assert network.call_count == 1


def test_obsolete_transient_checkpoints_do_not_block_new_attempts(tmp_path):
    p = provider(tmp_path)
    raw = response(candidates=[{"finishReason": "MAX_TOKENS"}])
    with patch("fa_worker.video_provider.urlopen", return_value=io.BytesIO(json.dumps(raw).encode())):
        with pytest.raises(WindowLimit):
            p.call("gemini", "events", video=b"video")
    saved = next(tmp_path.glob("llm-*.json.gz"))
    record = json.loads(gzip.decompress(saved.read_bytes()))
    record["error"] = "provider_timeout_or_unavailable"
    saved.write_bytes(gzip.compress(json.dumps(record).encode()))
    restored = provider(tmp_path, [saved])
    with patch("fa_worker.video_provider.urlopen", return_value=io.BytesIO(json.dumps(response()).encode())):
        assert restored.call("gemini", "events", video=b"video") == {"events": []}


def test_rate_limit_retry_after_is_bounded(tmp_path):
    p = provider(tmp_path)
    with patch("fa_worker.video_provider.urlopen", side_effect=[
        http_error(429, headers={"Retry-After": "9000"}), io.BytesIO(json.dumps(response()).encode()),
    ]), patch("fa_worker.video_provider.time.sleep") as sleep:
        p.call("gemini", "events", video=b"video")
    sleep.assert_called_once_with(60)


def test_video_field_limit_is_checked_before_the_broker_request(tmp_path):
    with patch("fa_worker.video_provider.urlopen") as network:
        with pytest.raises(WindowLimit) as error:
            provider(tmp_path).call("gemini", "events", video=b"x" * 5_625_001)
    assert error.value.code == "ai_input_limit"
    network.assert_not_called()


@pytest.mark.parametrize("raw,code", [
    (response(modelVersion="unexpected-model"), "ai_provider_model"),
    (response(candidates=[{"finishReason": "SAFETY"}]), "ai_response_blocked"),
])
def test_model_mismatch_and_provider_blocks_are_not_temporary_limits(tmp_path, raw, code):
    with patch("fa_worker.video_provider.urlopen", return_value=io.BytesIO(json.dumps(raw).encode())):
        with pytest.raises(JobFailure) as error:
            provider(tmp_path).call("gemini", "events", video=b"video")
    assert error.value.code == code and not error.value.retryable
    assert not isinstance(error.value, WindowLimit)
