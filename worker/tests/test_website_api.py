import json
import io
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError

import pytest

from fa_worker.config import Settings
from fa_worker.website_api import WebsiteAPI
from fa_worker import queue
from fa_worker.errors import JobCancelled, JobFailure, LeaseLost


def settings():
    return Settings(database_url="", storage_provider="replit", worker_id="test-owner",
                    worker_api_url="https://website.test/api/internal/worker-jobs",
                    worker_storage_token="test-only-worker-token-0123456789abcdef")


def test_api_configuration_does_not_require_or_use_database_credentials(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("WORKER_API_URL", settings().worker_api_url)
    monkeypatch.setenv("STORAGE_PROVIDER", "replit")
    monkeypatch.setenv("WORKER_STORAGE_URL", "https://website.test/api/internal/worker-storage")
    monkeypatch.setenv("WORKER_STORAGE_TOKEN", settings().worker_storage_token)
    assert Settings.from_env().database_url == ""
    with patch("psycopg.connect") as forbidden:
        with pytest.raises(RuntimeError):
            queue.connect("")
        forbidden.assert_not_called()


def test_fixed_operations_are_authenticated_without_sql_or_credentials():
    api = WebsiteAPI(settings())
    response = MagicMock()
    response.__enter__.return_value.read.return_value = b'{"cancelRequested":false}'
    with patch("fa_worker.website_api.urlopen", return_value=response) as send, patch("psycopg.connect") as forbidden:
        assert queue.report_progress(api, "test-job", "test-owner", "llm_events", .4) is False
        request = send.call_args.args[0]
        assert json.loads(request.data) == {"op": "progress", "jobId": "test-job",
            "workerId": "test-owner", "stage": "llm_events", "progress": .4}
        assert request.get_header("X-worker-storage-token") == settings().worker_storage_token
        forbidden.assert_not_called()


def test_lost_lease_never_falls_back_to_database():
    with patch("fa_worker.website_api.urlopen", side_effect=HTTPError("https://website.test",409,"conflict",{},
               io.BytesIO(b'{"error":"No active worker lease."}'))), \
         patch("psycopg.connect") as forbidden:
        with pytest.raises(LeaseLost):
            queue.heartbeat(WebsiteAPI(settings()), "test-job", "test-owner", 120)
        forbidden.assert_not_called()


@pytest.mark.parametrize("body,exception,code", [
    ({"code": "worker_lease_lost"}, LeaseLost, None),
    ({"code": "worker_cancelled"}, JobCancelled, None),
    ({"error": "Cancellation requested."}, JobCancelled, None),
    ({"code": "worker_result_invalid"}, JobFailure, "worker_result_invalid"),
    ({"error": "Invalid result for this job."}, JobFailure, "worker_result_invalid"),
    ({}, JobFailure, "worker_api_rejected"),
    ([], JobFailure, "worker_api_rejected"),
])
def test_conflicts_are_not_all_lease_loss(body, exception, code):
    error = HTTPError("https://website.test", 409, "conflict", {}, io.BytesIO(json.dumps(body).encode()))
    with patch("fa_worker.website_api.urlopen", side_effect=error) as send:
        with pytest.raises(exception) as caught:
            WebsiteAPI(settings()).request("complete_analysis", jobId="test-job")
        assert send.call_count == 1
        if code:
            assert caught.value.code == code
            assert not caught.value.retryable


def test_schema_rejection_is_a_report_error_without_logging_payload(caplog):
    error = HTTPError("https://website.test", 422, "invalid", {}, io.BytesIO(b"sensitive-payload"))
    with patch("fa_worker.website_api.urlopen", side_effect=error):
        with pytest.raises(JobFailure) as caught:
            WebsiteAPI(settings()).request("complete_analysis", jobId="test-job")
    assert caught.value.code == "worker_result_invalid"
    assert "operation=complete_analysis" in caplog.text
    assert "sensitive-payload" not in caplog.text


def test_private_checkpoint_registration_precedes_upload(tmp_path):
    from fa_worker.checkpoints import Checkpoints, file_digest
    api = WebsiteAPI(settings())
    order = []
    api.request = lambda *a, **kw: order.append("registered")
    storage = SimpleNamespace(put_file=lambda *a: order.append("uploaded"))
    job = SimpleNamespace(id="job",config={})
    path = tmp_path/"pending"
    path.write_bytes(b"synthetic checkpoint")
    path = path.rename(tmp_path/f"llm-{file_digest(path)}.json.gz")
    saved = Checkpoints(api,storage,settings(),job,"orgs/org/matches/match/videos/video/source","a"*64)
    saved.publish(path)
    assert order == ["registered","uploaded"]
