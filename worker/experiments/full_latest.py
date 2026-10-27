"""Opt-in full 180s run with current production analysis options; no website writes."""
import argparse
import json
import time
from pathlib import Path
from threading import RLock
from types import SimpleNamespace
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

from experiments.compare_tracking import ExperimentProvider, LocalSaved
from fa_worker.errors import JobFailure
from fa_worker.video_events import analyze


class FullProvider(ExperimentProvider):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.metrics_lock = RLock()
        self.requests = []
        (self.directory.parent/"requests.json").write_text("[]")
        self.stage = "setup"

    def _send(self, request, provider):
        # Unlike the old comparison benchmark, no artificial 60s spacing.
        # Only actual transient failures trigger bounded retry delays.
        for attempt in range(4):
            started = time.monotonic()
            outcome = "succeeded"
            wait = 0
            try:
                with urlopen(request, timeout=260) as response:
                    return json.load(response)
            except HTTPError as exc:
                outcome = f"http_{exc.code}"
                if exc.code not in (429, 500, 502, 503, 504) or attempt == 3:
                    raise JobFailure("ai_rate_limited" if exc.code == 429 else "ai_provider_error",
                                     f"{provider}: HTTP {exc.code} after bounded attempts.") from None
                try:
                    retry_after = max(0, float(exc.headers.get("Retry-After", "0")))
                except (ValueError, TypeError):
                    retry_after = 0
                if retry_after > 600:
                    raise JobFailure("ai_rate_limited", "Provider requested a longer cooldown.") from None
                wait = max(60 * 2**attempt, retry_after)
            except (TimeoutError, URLError):
                outcome = "transport_failure"
                if attempt == 3:
                    raise JobFailure("ai_provider_unavailable", "Provider did not complete.") from None
                wait = 30 * 2**attempt
            finally:
                with self.metrics_lock:
                    self.requests.append({"provider":provider, "stage":self.stage,
                        "attempt":attempt+1, "status":outcome,
                        "seconds":round(time.monotonic()-started, 3), "retryDelaySeconds":wait})
                    (self.directory.parent/"requests.json").write_text(json.dumps(self.requests, indent=2))
            if wait:
                print("FULL_RUN_RETRY", provider, attempt+1, outcome, wait, flush=True)
                time.sleep(wait)


def run(out, drain_seconds=0, parallel_postprocessing=False):
    out.mkdir(parents=True, exist_ok=True)
    status_path = out/"status.json"
    status_path.write_text(json.dumps({"status":"draining_previous_request", "waitSeconds":drain_seconds}))
    if drain_seconds:
        time.sleep(drain_seconds)
    provider = FullProvider(SimpleNamespace(storage_provider="replit",
        worker_storage_url="https://experiment.invalid/internal/storage", worker_storage_token="unused",
        worker_id="full-latest"), SimpleNamespace(id=out.name),
        LocalSaved(), out/"checkpoints", lambda:None)
    started = time.monotonic()
    warm_resume = bool(provider.cache)
    def progress(stage, fraction):
        provider.stage = stage
        status_path.write_text(json.dumps({"status":"running", "stage":stage, "progress":fraction,
            "elapsedSeconds":round(time.monotonic()-started), "warmResume":warm_resume,
            "discoveryConcurrency":10,"parallelPostprocessing":parallel_postprocessing}))
        print("FULL_RUN_PROGRESS", stage, round(fraction,3), flush=True)
    progress("setup", 0)
    try:
        options={"parallel_postprocessing":True} if parallel_postprocessing else {}
        result = analyze(Path("generated-artifacts/football-first-three-minutes.mp4"), out, 180,
            provider, progress, fast=True, game_stats=True, select_photos=True,
            review_strategy="focused", discovery_concurrency=10,**options)
        data = result["summary"]["videoEvents"]
        report = {"status":"succeeded", "seconds":time.monotonic()-started,
            "warmResume":warm_resume, "discoveryConcurrency":10,
            "parallelPostprocessing":parallel_postprocessing,"players":len(data["catalog"]),
            "events":len(data["events"]), "counted":sum(e["included"] for e in data["events"]),
            "unassigned":sum(e["actorId"] is None for e in data["events"]),
            "providerAttempts":len(provider.requests), "report":str(out/"result.json")}
        baseline=out/"before-parallel-result.json"
        if parallel_postprocessing and baseline.exists():
            previous=json.loads(baseline.read_text())["summary"]["videoEvents"]
            checks={key:previous.get(key)==data.get(key) for key in ("events","catalog","players")}
            report["consistency"]={"allMatch":all(checks.values()),"checks":checks,
                "note":"Checkpoint-assisted comparison checks consistency, not cold-run speed or ground-truth accuracy."}
    except Exception as exc:
        report = {"status":"failed", "errorType":type(exc).__name__, "code":getattr(exc,"code",None),
                  "seconds":time.monotonic()-started, "warmResume":warm_resume}
        status_path.write_text(json.dumps(report, indent=2))
        print("FULL_RUN_FAILED", str(status_path), flush=True)
        raise
    status_path.write_text(json.dumps(report, indent=2))
    print("FULL_RUN_COMPLETE", str(status_path), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--drain-seconds", type=int, default=0)
    parser.add_argument("--parallel-postprocessing",action="store_true")
    args = parser.parse_args()
    run(args.out, max(0, args.drain_seconds),args.parallel_postprocessing)
