"""Fixed-operation website client. Never accepts SQL or contains database credentials."""
from __future__ import annotations

import json
import logging
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from .errors import JobCancelled, JobFailure, LeaseLost

log = logging.getLogger(__name__)


class WebsiteAPI:
    remote_worker_api = True

    def __init__(self, settings):
        self.url = settings.worker_api_url
        if not self.url or urlsplit(self.url).scheme != "https":
            raise RuntimeError("An HTTPS WORKER_API_URL is required.")
        self.token = settings.worker_storage_token
        self.owner = settings.worker_id
        self.video = None

    def request(self, op=None, **values):
        payload = {"op": op, **values} if op else None
        if payload is not None and op not in ("cleanup", "maintenance"):
            payload["workerId"] = self.owner
        data = json.dumps(payload, allow_nan=False).encode() if payload is not None else None
        if data and len(data) > 12_000_000:
            raise JobFailure("worker_api_limit", "The analysis result exceeds the website's safe request limit.")
        attempts = 1 if op in ("cleanup", "maintenance") else 3
        for attempt in range(attempts):
            try:
                req = Request(self.url, data=data, headers={"Content-Type": "application/json"})
                # Do not forward the service credential if a hosting/login layer redirects.
                req.add_unredirected_header("X-Worker-Storage-Token", self.token)
                with urlopen(req, timeout=90 if op == "maintenance" else 25) as response:
                    return json.loads(response.read(12_000_000))
            except HTTPError as error:
                if error.code == 409:
                    try:
                        detail = json.loads(error.read(4096))
                    except (ValueError, OSError):
                        detail = {}
                    if not isinstance(detail, dict):
                        detail = {}
                    # Legacy websites have no code. Match only known, fixed messages;
                    # an unknown conflict must not silently abandon an active lease.
                    code = detail.get("code")
                    legacy = detail.get("error") if not code else None
                    if code == "worker_lease_lost" or legacy == "No active worker lease.":
                        raise LeaseLost() from None
                    if code == "worker_cancelled" or legacy == "Cancellation requested.":
                        raise JobCancelled() from None
                    if code == "worker_result_invalid" or legacy == "Invalid result for this job.":
                        log.warning("worker API rejected operation=%s status=409 code=worker_result_invalid", op)
                        raise JobFailure("worker_result_invalid",
                                         "The website rejected the analysis report during validation.") from None
                    log.warning("worker API rejected operation=%s status=409 code=worker_api_rejected", op)
                    raise JobFailure("worker_api_rejected", "The website rejected a worker operation.") from None
                if error.code not in (429, 500, 502, 503, 504):
                    code = "worker_result_invalid" if error.code == 422 and op in (
                        "complete_analysis", "complete_prepare") else "worker_api_rejected"
                    log.warning("worker API rejected operation=%s status=%s code=%s", op, error.code, code)
                    raise JobFailure(code, "The website rejected a worker operation.") from None
            except (URLError, TimeoutError, OSError, ValueError):
                pass
            if attempt + 1 < attempts:
                time.sleep(attempt + 1)
        raise JobFailure("worker_api_unavailable", "The website is temporarily unavailable. Saved progress is retained.",
                         retryable=True) from None


def is_remote(conn):
    return getattr(conn, "remote_worker_api", False) is True
