"""Modal hosting for the website-API worker; no database credentials leave Replit.

Deploy only after configuring the named Modal Secret; see docs/REPLIT_MODAL.md.
No public HTTP endpoint is exposed, and no credentials are copied into the image.
"""

from __future__ import annotations

import os
from pathlib import Path

import modal

WORKER_DIR = Path(__file__).resolve().parent
app = modal.App("football-vision-replit")
worker_secret = modal.Secret.from_name(
    os.environ.get("FOOTBALL_MODAL_SECRET", "football-vision-production-api"),
    required_keys=["WORKER_API_URL", "STORAGE_PROVIDER", "WORKER_STORAGE_URL", "WORKER_STORAGE_TOKEN"],
)

# Copy only Python source, never worker/.env, customer footage, or a developer's model cache.
runtime_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg", "libgl1", "libglib2.0-0")
    # Match worker/pyproject.toml's runtime dependencies. No local .env is read here.
    .pip_install("psycopg[binary]>=3.2", "boto3>=1.40", "av>=15", "numpy>=2", "pillow>=13")
    .env({"PYTHONPATH": "/opt", "PYTHONUNBUFFERED": "1"})
)
base_image = (runtime_image.pip_install("opencv-python-headless>=4.12")
              .add_local_dir(str(WORKER_DIR / "fa_worker"), "/opt/fa_worker", copy=True,
                             ignore=["**/__pycache__/**", "**/*.pyc"]))
# Expensive dependencies precede source copies, so source edits reuse CUDA layers.
tracking_image = (
    runtime_image
    .pip_install("torch==2.8.0", "torchvision==0.23.0", index_url="https://download.pytorch.org/whl/cu128")
    .pip_install("rfdetr>=1.11,<2", "supervision>=0.29", "trackers>=2.6,<3", "opencv-python-headless>=4.12")
    .add_local_dir(str(WORKER_DIR / "fa_worker"), "/opt/fa_worker", copy=True,
                   ignore=["**/__pycache__/**", "**/*.pyc"])
)


@app.function(image=tracking_image, gpu="T4", cpu=4, memory=16384, timeout=7200,
              max_containers=1, scaledown_window=2, secrets=[worker_secret])
def track_players(worker_id: str, job_id: str, video: dict) -> bytes:
    """GPU exists only during detection/tracking, not during remote Gemini/Astra calls."""
    import tempfile
    from dataclasses import replace
    from fa_worker.config import Settings
    from fa_worker.website_api import WebsiteAPI
    from fa_worker.storage import get_storage
    from fa_worker.player_tracking import collect_tracks, pack_tracks
    from fa_worker.errors import JobCancelled

    settings = replace(Settings.from_env(), worker_id=worker_id)
    api = WebsiteAPI(settings)
    def alive():
        state = api.request("heartbeat", jobId=job_id)
        if state.get("cancelRequested"):
            raise JobCancelled()
    alive()
    with tempfile.TemporaryDirectory(prefix="football-tracking-") as temp:
        source = get_storage(settings).download(video["storage_key"], Path(temp)/"source", int(video["size_bytes"]))
        return pack_tracks(collect_tracks(source, alive))

@app.function(
    image=base_image,
    cpu=4,
    memory=16384,
    # Long videos include many bounded remote-model requests, not GPU inference.
    timeout=18 * 60 * 60,
    max_containers=1,
    min_containers=0,
    scaledown_window=2,
    secrets=[worker_secret],
)
def process_one() -> dict:
    """Claim exactly one job. Existing leases, heartbeats, retries and usage settlement stay intact."""
    import logging
    import tempfile
    from dataclasses import replace

    from fa_worker.queue import ClaimedJob
    from fa_worker.config import Settings
    from fa_worker.pipeline import process
    from fa_worker.storage import get_storage
    from fa_worker.website_api import WebsiteAPI

    logging.basicConfig(level=logging.INFO)
    with tempfile.TemporaryDirectory(prefix="football-vision-") as tmp:
        settings = replace(Settings.from_env(), work_dir=Path(tmp))
        api = WebsiteAPI(settings)
        claimed = api.request("claim")
        if claimed.get("job") is None:
            return {"status": "idle"}
        job = ClaimedJob(**claimed["job"])
        api.video = claimed.get("video")
        settings = replace(settings, lease_seconds=claimed["leaseSeconds"])
        outcome = process(api, get_storage(settings), settings, job)
        return {"status": outcome, "jobId": job.id, "kind": job.kind}


@app.function(
    image=base_image,
    cpu=0.25,
    memory=512,
    schedule=modal.Cron("* * * * *"),
    timeout=120,
    max_containers=1,
    secrets=[worker_secret],
)
def dispatch() -> dict:
    """Poll each minute; start the CPU orchestration worker only when a job exists."""
    import logging

    from fa_worker.config import Settings
    from fa_worker.website_api import WebsiteAPI

    logging.basicConfig(level=logging.INFO)
    settings = Settings.from_env()
    api = WebsiteAPI(settings)
    try:
        state = api.request()
    except Exception:
        return {"status": "waiting_for_website"}
    if state.get("ready") is not True or state.get("protocol") != "worker-api-v1":
        return {"status": "waiting_for_website"}
    try:
        api.request("maintenance")
    except Exception:
        logging.warning("Website maintenance deferred; metadata retained for the next sweep.")
    if not state.get("pending"):
        return {"status": "idle"}
    stats = process_one.get_current_stats()
    if stats.num_running_inputs or stats.backlog:
        return {"status": "busy"}
    call = process_one.spawn()
    return {"status": "dispatched", "callId": call.object_id}


def _website_ready(settings) -> bool:
    """Do not claim jobs before the matching website brokers have been published."""
    from fa_worker.website_api import WebsiteAPI
    try:
        state = WebsiteAPI(settings).request()
        return state.get("ready") is True and state.get("protocol") == "worker-api-v1"
    except Exception:
        # No upstream URLs, database details or tokens in scheduler logs.
        return False


@app.function(
    image=base_image, cpu=0.25, memory=512,
    schedule=modal.Cron("0 3 * * *"), timeout=900,
    max_containers=1, secrets=[worker_secret],
)
def cleanup_uploads() -> dict:
    """Remove expired temporary chunks, including late PUTs after cancellation."""
    from fa_worker.config import Settings
    from fa_worker.storage import get_storage

    storage = get_storage(Settings.from_env())
    sweep = getattr(storage, "cleanup_stale_uploads", None)
    return {"deleted": sweep() if sweep else 0}
