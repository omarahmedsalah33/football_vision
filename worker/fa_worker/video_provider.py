"""Job-scoped AI calls through the website's authenticated provider broker.

Provider credentials never leave the website. Successful calls and bounded failures are
checkpointed privately within this job, so worker retries do not repeat completed inference.
"""
from __future__ import annotations

import base64
import gzip
import hashlib
import json
import logging
import time
from threading import RLock
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .errors import JobFailure


log = logging.getLogger(__name__)


class WindowLimit(JobFailure):
    """Reduce temporal input instead of retrying the same oversized reasoning task."""

    def __init__(self, code="ai_output_limit"):
        super().__init__(code, "The AI input or output reached its size limit.")


def encoded(data: bytes) -> str:
    return base64.b64encode(data).decode()


class VideoProvider:
    def __init__(self, settings, job, checkpoints, directory: Path, progress, restored=None, state_lock=None):
        if settings.storage_provider != "replit":
            raise JobFailure("ai_not_configured", "AI analysis requires the Replit worker broker.")
        self.url = settings.worker_storage_url.rsplit("/", 1)[0] + "/worker-analysis"
        self.token, self.worker, self.job = settings.worker_storage_token, settings.worker_id, job.id
        self.checkpoints, self.directory = checkpoints, directory
        self.state_lock = state_lock or RLock()
        def safe_progress():
            with self.state_lock:
                progress()
        self.progress = safe_progress
        self.cache = {}
        for path in restored if restored is not None else checkpoints.restore(directory, progress):
            if path.name.startswith("llm-"):
                with gzip.open(path, "rb") as source:
                    data = source.read(4 * 1024 * 1024 + 1)
                if len(data) > 4 * 1024 * 1024:
                    raise JobFailure("checkpoint_invalid", "Saved AI response exceeds its limit.")
                record = json.loads(data)
                # Old workers incorrectly persisted temporary failures as size limits.
                if record.get("error") == "provider_timeout_or_unavailable":
                    continue
                self.cache[record["fingerprint"]] = record

    def _save(self, fingerprint, **data):
        with self.state_lock:
            self._save_locked(fingerprint, **data)

    def _save_locked(self, fingerprint, **data):
        record = {"fingerprint": fingerprint, **data}
        compressed = gzip.compress(json.dumps(record, allow_nan=False).encode(), mtime=0)
        path = self.directory / f"llm-{hashlib.sha256(compressed).hexdigest()}.json.gz"
        path.write_bytes(compressed)
        self.checkpoints.publish(path)
        self.cache[fingerprint] = record

    def call(self, provider, prompt, images=(), video=None):
        body = {"jobId": self.job, "workerId": self.worker, "provider": provider,
                "prompt": prompt, "images": [encoded(i) for i in images]}
        if video is not None:
            body["video"] = encoded(video)
        # Worker id changes between attempts; it is authorization, not inference input.
        inference = {k: v for k, v in body.items() if k not in ("workerId",)}
        fingerprint = hashlib.sha256(json.dumps(inference, sort_keys=True).encode()).hexdigest()
        saved = self.cache.get(fingerprint)
        if saved:
            if saved.get("limited"):
                raise WindowLimit(saved.get("code", "ai_output_limit"))
            return saved["result"]
        payload = json.dumps(body).encode()
        if len(payload) > 9_500_000 or (video is not None and len(body["video"]) > 7_500_000):
            raise WindowLimit("ai_input_limit")
        raw = self._request(payload, provider, fingerprint)
        try:
            if provider == "gemini":
                model = raw.get("modelVersion", "")
                candidate = raw.get("candidates", [{}])[0]
                finish = candidate.get("finishReason")
                usage = raw.get("usageMetadata", {})
                if not model.startswith("gemini-3.8-flash"):
                    raise JobFailure("ai_provider_model", "The provider returned a different model than configured.")
                if finish in {"SAFETY", "PROHIBITED_CONTENT", "RECITATION", "BLOCKLIST"}:
                    raise JobFailure("ai_response_blocked", "The AI provider declined this section.")
                if finish == "MAX_TOKENS":
                    self._save(fingerprint, limited=True, code="ai_output_limit", model=model, usage=usage, finish=finish)
                    raise WindowLimit()
                if finish != "STOP":
                    raise ValueError("Incomplete response")
                if video is not None and not any(p.get("modality") == "VIDEO" and p.get("tokenCount", 0) > 0
                                                 for p in usage.get("promptTokensDetails", [])):
                    raise ValueError("Native-video input was not acknowledged")
                text = "".join(p.get("text", "") for p in candidate.get("content", {}).get("parts", [])
                               if not p.get("thought"))
            else:
                model = raw.get("model", "")
                choice = raw.get("choices", [{}])[0]
                usage = raw.get("usage", {})
                if not model.startswith("gpt-6-astra"):
                    raise JobFailure("ai_provider_model", "The provider returned a different model than configured.")
                if choice.get("finish_reason") == "content_filter":
                    raise JobFailure("ai_response_blocked", "The AI provider declined this section.")
                if model.startswith("gpt-6-astra") and choice.get("finish_reason") == "length":
                    self._save(fingerprint, limited=True, code="ai_output_limit", model=model, usage=usage)
                    raise WindowLimit()
                if choice.get("finish_reason") != "stop":
                    raise ValueError("Incomplete Astra response")
                text = choice["message"]["content"]
            result = json.loads(text)
            self._save(fingerprint, result=result, model=model, usage=usage)
            return result
        except (ValueError, KeyError, TypeError, IndexError):
            raise JobFailure("ai_invalid_response", "The AI response was incomplete or invalid; completed sections are saved.",
                             retryable=True) from None

    def _request(self, payload, provider, fingerprint):
        """Bounded same-input retries; never cache temporary failures or split for them."""
        retryable_codes = {"ai_rate_limited", "ai_broker_busy", "ai_provider_timeout",
                           "ai_provider_unavailable", "ai_broker_unavailable", "ai_invalid_response"}
        permanent_codes = {"ai_provider_credentials", "ai_provider_model", "ai_request_invalid",
                           "ai_not_configured", "ai_provider_error"}
        for attempt in range(3):
            self.progress()
            delay = 2 ** (attempt + 1)
            code, status = "ai_provider_unavailable", None
            request = Request(self.url, data=payload, method="POST", headers={"Content-Type": "application/json"})
            request.add_unredirected_header("X-Worker-Storage-Token", self.token)
            try:
                with urlopen(request, timeout=290) as response:
                    raw = response.read(4 * 1024 * 1024 + 1)
                if len(raw) > 4 * 1024 * 1024:
                    raise JobFailure("ai_invalid_response", "The AI service returned an oversized response.", retryable=True)
                try:
                    parsed = json.loads(raw)
                    if not isinstance(parsed, dict):
                        raise ValueError("Expected a provider object")
                    return parsed
                except ValueError:
                    code = "ai_invalid_response"
            except HTTPError as error:
                status = error.code
                if status in (401, 403, 409):
                    raise JobFailure("ai_authorization", "The AI worker is not authorized for this job.") from None
                detail = {}
                try:
                    detail = json.loads(error.read(8192))
                    if not isinstance(detail, dict):
                        detail = {}
                except (ValueError, OSError):
                    pass
                declared = detail.get("code")
                if status == 413:
                    self._save(fingerprint, limited=True, code="ai_input_limit")
                    raise WindowLimit("ai_input_limit") from None
                code = (declared if isinstance(declared, str) and declared in retryable_codes | permanent_codes else
                        "ai_rate_limited" if status == 429 else
                        "ai_provider_timeout" if status in (408, 504) else
                        "ai_provider_unavailable" if status >= 500 else "ai_request_invalid")
                if code in permanent_codes:
                    raise JobFailure(code, "The AI service rejected this request; check its configuration.") from None
                try:
                    delay = max(delay, min(60, max(0, float(error.headers.get("Retry-After", 0)))))
                except (ValueError, TypeError, AttributeError):
                    pass
            except (TimeoutError, URLError, OSError) as error:
                code = "ai_provider_timeout" if isinstance(error, TimeoutError) or isinstance(
                    getattr(error, "reason", None), TimeoutError) else "ai_provider_unavailable"
            log.warning("AI request failed provider=%s code=%s http=%s attempt=%s/3",
                        provider, code, status, attempt + 1)
            if attempt == 2:
                raise JobFailure(code, "The AI service did not complete after bounded retries. Completed sections are saved.",
                                 retryable=True) from None
            time.sleep(delay)
