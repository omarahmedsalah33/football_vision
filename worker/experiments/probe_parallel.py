"""Isolated concurrent Gemini video requests; no production jobs are touched."""
import argparse
import concurrent.futures
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from urllib.request import urlopen
from urllib.error import HTTPError, URLError
from experiments.compare_tracking import ExperimentProvider, LocalSaved
from fa_worker.video_events import analyze
from fa_worker.errors import JobFailure


class Collected(Exception):
    pass


class Recorder:
    def __init__(self,count=2):
        self.requests=[]
        self.count=count

    def call(self, provider, prompt, images=(), video=None):
        if len(self.requests)==self.count:
            raise Collected()
        assert provider=="gemini" and video
        self.requests.append((prompt,images,video))
        return {"events":[],"photoCandidates":[]}


class ProbeProvider(ExperimentProvider):
    def _send(self,request,provider):
        # No hidden pacing or retries: a 429 must appear in this probe's result.
        try:
            with urlopen(request,timeout=260) as response:
                return json.load(response)
        except HTTPError as error:
            raise JobFailure("ai_rate_limited" if error.code==429 else "ai_provider_error",
                             f"Provider HTTP {error.code}") from None
        except (TimeoutError,URLError):
            raise JobFailure("ai_provider_unavailable","Provider request did not complete.") from None


def main(count=2,drain_seconds=280):
    if count not in (2,5,10):
        raise ValueError("Probe supports two, five or ten requests")
    root=Path("generated-artifacts/concurrency-probe")/datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    root.mkdir(parents=True)
    benchmark=Path("generated-artifacts/speed-comparison/optimized")
    if (benchmark/"timings.json").exists():
        (benchmark/f"timings-before-{root.name}.json").write_bytes((benchmark/"timings.json").read_bytes())
    (benchmark/"interruption.json").write_text(json.dumps({
        "reason":"Paused for isolated concurrency test; subsequent elapsed time is a warm resume, not a fresh-run comparison.",
        "probe":str(root)}))
    status=root/"status.json"
    status.write_text(json.dumps({"status":"draining_previous_request","waitSeconds":drain_seconds}))
    print(f"Waiting {drain_seconds} seconds for any previous provider request to settle.",flush=True)
    time.sleep(drain_seconds)
    unique_sections=min(count,9)
    recorder=Recorder(unique_sections)
    try:
        # Capture the real optimized discovery prompts/clips without invoking AI.
        analyze(Path("generated-artifacts/football-first-three-minutes.mp4"),root/"inputs",
                min((unique_sections+1)*20,180),recorder,lambda *args:None,game_stats=True,select_photos=True,fast=True)
    except Collected:
        pass
    assert len(recorder.requests)==unique_sections
    if count>unique_sections:
        # Separate provider instances/job IDs ensure this is a real tenth
        # request, not a cache hit. Never merge probe actions into a match report.
        recorder.requests.append(recorder.requests[0])
    status.write_text(json.dumps({"status":"running","concurrency":count}))
    started=time.monotonic()

    def request(index):
        provider=ProbeProvider(SimpleNamespace(storage_provider="replit",
            worker_storage_url="https://experiment.invalid/internal/storage",worker_storage_token="unused",
            worker_id=f"parallel-probe-{index}"),SimpleNamespace(id=f"parallel-probe-{index}"),
            LocalSaved(),root/f"request-{index}",lambda:None)
        prompt,images,video=recorder.requests[index]
        begin=time.monotonic()
        result={"request":index+1,"section":index+1 if index<unique_sections else 1,
                "repeatedForCapacityTest":index>=unique_sections,
                "videoBytes":len(video),"startedAfterSeconds":begin-started}
        try:
            response=provider.call("gemini",prompt,images,video)
            from fa_worker.video_events import validate_events
            from fa_worker.player_photos import collect_candidates
            events=validate_events(response,22,set())
            photos=collect_candidates(response,0,20,22)
            result.update(status="succeeded",events=len(events),photoCandidates=len(photos))
        except JobFailure as error:
            result.update(status="failed",code=error.code,message=error.user_message)
        except Exception as error:
            result.update(status="invalid_response",errorType=type(error).__name__)
        result["seconds"]=time.monotonic()-begin
        (root/f"request-{index}.json").write_text(json.dumps(result,indent=2))
        print("PROBE_REQUEST",json.dumps(result),flush=True)
        return result

    with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
        results=list(pool.map(request,range(count)))
    report={"status":"completed","concurrency":count,"uniqueSections":unique_sections,"seconds":time.monotonic()-started,
            "requests":results,"note":"One probe cannot establish a guaranteed quota or sustained safe concurrency."}
    status.write_text(json.dumps(report,indent=2))
    print("PARALLEL_PROBE_COMPLETE",str(status),flush=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--parallel",type=int,choices=[2,5,10],default=2)
    parser.add_argument("--drain-seconds",type=int,default=280)
    args=parser.parse_args()
    main(args.parallel,max(0,args.drain_seconds))
