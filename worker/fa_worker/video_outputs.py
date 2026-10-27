"""Register private outputs before upload, so interrupted jobs cannot orphan player photos."""
import re

from psycopg.types.json import Jsonb

from .errors import LeaseLost
from .website_api import is_remote


def output_keys(job: dict, photos_only=False) -> list[str]:
    manifest = job.get("config",{}).get("_videoOutputs",{})
    if not isinstance(manifest,dict):return []
    root=f"orgs/{job['org_id']}/matches/{job['match_id']}/analysis/{job['id']}/"
    photos=manifest.get("photos",[])
    values=photos if isinstance(photos,list) else []
    allowed=[k for k in values if isinstance(k,str) and
             re.fullmatch(re.escape(root)+r"players/[1-9][0-9]*\.jpg",k)]
    if not photos_only and manifest.get("ledger")==root+"tracks.jsonl.gz":
        allowed.append(manifest["ledger"])
    return list(dict.fromkeys(allowed))


def register(conn,settings,job,count):
    if is_remote(conn):
        conn.request("outputs", jobId=job.id, count=count)
        return
    root=f"orgs/{job.org_id}/matches/{job.match_id}/analysis/{job.id}/"
    manifest={"photos":[f"{root}players/{i}.jpg" for i in range(1,count+1)],
              "ledger":root+"tracks.jsonl.gz"}
    with conn.transaction(),conn.cursor() as cur:
        cur.execute("""update analysis_jobs set config=jsonb_set(config,'{_videoOutputs}',%s)
                       where id=%s and lease_owner=%s and status='running'
                       and not cancel_requested and lease_expires_at>now()""",
                    (Jsonb(manifest),job.id,settings.worker_id))
        if cur.rowcount!=1:raise LeaseLost()
