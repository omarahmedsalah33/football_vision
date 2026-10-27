"""Opt-in sequential gold baseline/optimized benchmark; never touches website reports."""
import json
import time
from pathlib import Path
from types import SimpleNamespace
from experiments.compare_tracking import ExperimentProvider, LocalSaved
from fa_worker.video_events import analyze


class TimedProvider(ExperimentProvider):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.stage="setup"
        self.timings=[]

    def call(self,provider,*args,**kwargs):
        start=time.monotonic()
        cached=len(self.cache)
        cooldown=getattr(self,"cooldown_seconds",0)
        attempts=getattr(self,"http_attempts",0)
        try:
            return super().call(provider,*args,**kwargs)
        finally:
            self.timings.append({"stage":self.stage,"provider":provider,
                "seconds":round(time.monotonic()-start,3),"newCacheEntries":len(self.cache)-cached,
                "cooldownSeconds":round(getattr(self,"cooldown_seconds",0)-cooldown,3),
                "httpAttempts":getattr(self,"http_attempts",0)-attempts})
            (self.directory.parent/"timings.json").write_text(json.dumps(self.timings,indent=2))


def run(mode):
    out=Path("generated-artifacts/speed-comparison")/mode
    out.mkdir(parents=True,exist_ok=True)
    if (out/"status.json").exists() and json.loads((out/"status.json").read_text()).get("status")=="succeeded":
        return
    provider=TimedProvider(SimpleNamespace(storage_provider="replit",
        worker_storage_url="https://experiment.invalid/internal/storage",worker_storage_token="unused",
        worker_id="speed-benchmark"),SimpleNamespace(id=f"speed-{mode}"),LocalSaved(),out/"checkpoints",lambda:None)
    warm_resume=bool(provider.cache)
    def progress(stage,fraction):
        provider.stage=stage
        print(mode,stage,round(fraction,3),flush=True)
    started=time.monotonic()
    (out/"status.json").write_text(json.dumps({"status":"running","mode":mode}))
    try:
        result=analyze(Path("generated-artifacts/football-first-three-minutes.mp4"),out,180,provider,progress,
            review_strategy="focused" if mode=="optimized" else "selective",game_stats=True,
            select_photos=True,fast=mode=="optimized")
        data=result["summary"]["videoEvents"]
        status={"status":"succeeded","seconds":time.monotonic()-started,"warmResume":warm_resume,
            "players":len(data["catalog"]),"events":len(data["events"]),
            "counted":sum(e["included"] for e in data["events"]),
            "unassigned":sum(e["actorId"] is None for e in data["events"]),
            "photos":data["audit"].get("photoSelection")}
    except Exception as error:
        status={"status":"failed","errorType":type(error).__name__,"code":getattr(error,"code",None),
                "seconds":time.monotonic()-started}
        (out/"status.json").write_text(json.dumps(status))
        raise
    (out/"status.json").write_text(json.dumps(status,indent=2))
    print(mode,status,flush=True)


if __name__=="__main__":
    # Identical pacing, models and footage. Finish one run before starting the other.
    run("optimized")
    run("baseline")
