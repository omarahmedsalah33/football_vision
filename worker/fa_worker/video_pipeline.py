"""Lease-fenced website persistence for the Modal Gemini/Astra pipeline."""
from __future__ import annotations

import json
from threading import RLock

from psycopg.types.json import Jsonb

from .checkpoints import Checkpoints, binding, compatible_bindings, pack_result, unpack_result
from .errors import JobFailure, LeaseLost
from .video_events import POLICY, analyze, analyze_gallery
from .video_provider import VideoProvider
from .video_provider import WindowLimit
from .video_outputs import register
from . import queue
from .website_api import is_remote


def run(conn, storage, settings, job, hb, workdir, video, checkpoint):
    duration = float(video.get("duration_seconds") or 0)
    if not 0 < duration <= float(job.config.get("maxDurationSeconds", 4*3600)):
        raise JobFailure("invalid_duration", "The video duration is missing or exceeds this job's allowance.")
    if job.config.get("engine") != "llm":
        raise JobFailure("analysis_replaced", "Player tracking has been replaced. Start a new AI analysis.")
    out = workdir / "analysis"
    out.mkdir(parents=True, exist_ok=True)
    cfg = {"pipelineVersion":"llm-video-v1","models":["gemini-3.8-flash","gpt-6-astra"],
           "fps":10,"windowSeconds":20,"policy":POLICY}
    tracking_enabled = job.config.get("playerTracking") is True
    action_first = not tracking_enabled and job.config.get("pipelineVersion")=="action-first-v1"
    review_strategy = "selective" if action_first and job.config.get("reviewStrategy")=="selective" else "all"
    fast = action_first and job.config.get("optimizationVersion")==1
    if fast:
        cfg["optimizationVersion"]=1
        review_strategy="focused"
    parallel_postprocessing=fast and job.config.get("parallelPostprocessingVersion")==1
    if parallel_postprocessing:
        cfg["parallelPostprocessingVersion"]=1
    configured_concurrency = job.config.get("discoveryConcurrency")
    discovery_concurrency = configured_concurrency if fast and configured_concurrency in (5,10) else 1
    if discovery_concurrency>1:
        cfg["discoveryConcurrency"]=discovery_concurrency
    game_stats = action_first and job.config.get("gameStatsVersion")==1
    if game_stats:
        cfg["gameStatsVersion"] = 1
    select_photos = action_first and job.config.get("photoSelectionVersion")==1
    if select_photos:
        cfg["photoSelectionVersion"] = 1
    if tracking_enabled:
        cfg["playerTracking"] = "rfdetr-bytetrack-v1"
    else:
        cfg["catalogPolicy"] = "action-first-v1" if action_first else "full-video-gallery-v1"
    if review_strategy!="all":
            cfg["reviewStrategy"] = review_strategy
    saved = Checkpoints(conn,storage,settings,job,video["storage_key"],binding(job,video,cfg),
                        compatible=compatible_bindings(job,video,cfg))
    current = ["resume_llm",0.0]
    state_lock = RLock()
    def notify(stage,fraction):
        with state_lock:
            current[:] = [stage,max(current[1],fraction)]
            checkpoint(conn,settings,job,hb,*current)
    notify("resume_llm",.01)
    restored = saved.restore(out/"checkpoints",lambda:notify("resume_llm",.01))
    complete = next((p for p in restored if p.name.startswith("result-")),None)
    if complete:
        unpack_result(complete,out)
        result = json.loads((out/"result.json").read_text())
    else:
        notify("download",.02)
        source = storage.download(video["storage_key"],workdir/"source",int(video["size_bytes"]))
        provider = VideoProvider(settings,job,saved,out/"checkpoints",
                                 lambda:checkpoint(conn,settings,job,hb,*current),restored,state_lock=state_lock)
        tracking = None
        if tracking_enabled:
            import hashlib
            import modal
            from .player_tracking import TrackingEvidence, unpack_tracks
            notify("player_tracking", .025)
            name = "detections-" + hashlib.sha256(b"player-tracks-v1").hexdigest() + ".json.gz"
            cached = next((p for p in restored if p.name == name), None)
            if cached:
                payload = cached.read_bytes()
            else:
                try:
                    payload = modal.Function.from_name("football-vision-replit", "track_players").remote(
                        settings.worker_id, job.id, video)
                except Exception:
                    # Do not hide failure by silently running the untracked mode.
                    checkpoint(conn,settings,job,hb,*current)
                    raise JobFailure("tracking_unavailable", "The GPU tracking step failed. Retry or choose Gemini–Astra mode.",
                                     retryable=True) from None
                path = out/"checkpoints"/name
                path.write_bytes(payload)
                saved.publish(path)
            tracking = TrackingEvidence(unpack_tracks(payload))
        try:
            analysis = analyze if action_first or tracking_enabled else analyze_gallery
            options = {"tracking":tracking}
            if review_strategy!="all":
                options["review_strategy"] = review_strategy
            if fast:
                options["fast"] = True
            if discovery_concurrency>1:
                options["discovery_concurrency"] = discovery_concurrency
            if parallel_postprocessing:
                options["parallel_postprocessing"] = True
            if game_stats:
                options["game_stats"] = True
            if select_photos:
                options["select_photos"] = True
            result = analysis(source,out,duration,provider,notify,**options)
        except WindowLimit as limit:
            raise JobFailure(limit.code, "The AI input or output exceeded its limit.",
                             retryable=False) from None
    prefix = video["storage_key"].rsplit("/videos/",1)[0] + f"/analysis/{job.id}"
    # Register before upload so interrupted jobs are covered by private-media retention.
    # Reference photos are not CV trajectories or persistent player identities.
    catalog = result["summary"]["videoEvents"]["catalog"]
    # Save the completed inference BEFORE fallible public-output registration/
    # uploads. A retry can then finish persistence without repeating model calls.
    notify("finalize",.95)
    if not complete:
        (out/"result.json").write_text(json.dumps(result,allow_nan=False))
        saved.publish(pack_result(out,out/"checkpoints"))
    register(conn,settings,job,len(catalog))
    for i,p in enumerate(catalog,1):
        if p.get("photoSelection") and not p["photoSelection"].get("bodyComplete"):
            p["photoKey"] = None
            continue
        p["photoKey"] = f"{prefix}/players/{i}.jpg"
        storage.put_file(p["photoKey"],out/"crops"/f"{i}.jpg","image/jpeg")
        notify("finalize",.96)
    tracks_key = f"{prefix}/tracks.jsonl.gz"
    storage.put_file(tracks_key,out/"tracks.jsonl.gz","application/gzip")
    (out/"result.json").write_text(json.dumps(result,allow_nan=False))
    notify("finalize",.98)

    def persist(cur):
        cur.execute("delete from analysis_tracks where job_id = %s",(job.id,))
        cur.execute("""insert into analysis_results (job_id,org_id,match_id,calibration_id,summary,tracks_key)
                       values (%s,%s,%s,null,%s,%s)
                       on conflict (job_id) do update set summary=excluded.summary,tracks_key=excluded.tracks_key""",
                    (job.id,job.org_id,job.match_id,Jsonb(result["summary"]),tracks_key))
    if is_remote(conn):
        conn.request("complete_analysis", jobId=job.id, summary=result["summary"],
                     models={"pipeline":"llm-video-v1",**result["summary"]["models"]})
    elif not queue.complete(
        conn,job.id,settings.worker_id,{"pipeline":"llm-video-v1",**result["summary"]["models"]},
        persist_results=persist,
    ):
        raise LeaseLost()
