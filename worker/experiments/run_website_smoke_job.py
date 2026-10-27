"""Run ONE development-only website smoke-test job using the Modal worker code."""
import argparse
import os
import tempfile
from pathlib import Path
from uuid import UUID

from fa_worker import queue
from fa_worker.config import Settings
from fa_worker.pipeline import process
from fa_worker.storage import get_storage


def run(job_id):
    UUID(job_id)
    if os.environ.get("REPLIT_DEPLOYMENT") or not os.environ.get("REPLIT_DEV_DOMAIN"):
        raise RuntimeError("This helper is development-only")
    with tempfile.TemporaryDirectory(prefix="website-ai-smoke-") as temp:
        settings = Settings(database_url=os.environ["DATABASE_URL"],storage_provider="replit",
            worker_storage_url=f'https://{os.environ["REPLIT_DEV_DOMAIN"]}/api/internal/worker-storage',
            worker_storage_token=os.environ["WORKER_STORAGE_TOKEN"],worker_id="website-ai-smoke",
            work_dir=Path(temp))
        with queue.connect(settings.database_url) as conn:
            with conn.transaction(),conn.cursor() as cur:
                cur.execute("""update analysis_jobs j set status='running',lease_owner=%s,
                               lease_expires_at=now()+interval '60 seconds',heartbeat_at=now(),
                               attempts=j.attempts+1,started_at=coalesce(j.started_at,now())
                               from matches m where j.id=%s and m.id=j.match_id
                               and m.title='AI integration smoke test' and j.status='queued'
                               returning j.id,j.kind,j.org_id,j.match_id,j.video_id,j.attempts,
                               j.max_attempts,j.config""",(settings.worker_id,job_id))
                row = cur.fetchone()
            if not row:
                raise RuntimeError("Only queued jobs for the named smoke-test match are allowed")
            for key in ("id","org_id","match_id","video_id"):
                row[key] = str(row[key])
            job = queue.ClaimedJob(**row)
            print(process(conn,get_storage(settings),settings,job),flush=True)


if __name__ == "__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--job-id",required=True)
    run(p.parse_args().job_id)
