"""Durable job queue on PostgreSQL.

Jobs are claimed with `FOR UPDATE SKIP LOCKED` and held through a time-limited lease that the
worker renews with heartbeats. Every write a worker makes is fenced on (job id, lease owner,
status = 'running'), so a worker whose lease expired - and whose job was re-claimed - can never
overwrite the new owner's state. Usage reservations are settled exactly once, in the same
transaction that finalizes the job.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from .website_api import is_remote


@dataclass(frozen=True)
class ClaimedJob:
    id: str
    kind: str
    org_id: str
    match_id: str
    video_id: str
    attempts: int
    max_attempts: int
    config: dict[str, Any]


def connect(database_url: str) -> psycopg.Connection:
    if not database_url:
        raise RuntimeError("Database connections are disabled for the website-API worker.")
    return psycopg.connect(database_url, row_factory=dict_row, autocommit=False)


def _settle_usage(cur: psycopg.Cursor, org_id: str, period_start: Any, consumed: bool) -> None:
    if period_start is None:
        return  # prepare jobs are free and never reserved anything
    if consumed:
        cur.execute(
            """update usage_periods
                  set analyses_reserved = greatest(analyses_reserved - 1, 0),
                      analyses_used = analyses_used + 1
                where org_id = %s and period_start = %s""",
            (org_id, period_start),
        )
    else:
        cur.execute(
            """update usage_periods set analyses_reserved = greatest(analyses_reserved - 1, 0)
                where org_id = %s and period_start = %s""",
            (org_id, period_start),
        )


def reap_expired(conn: psycopg.Connection) -> int:
    """Finalizes running jobs whose worker vanished and that must not be retried."""
    with conn.transaction(), conn.cursor() as cur:
        cur.execute(
            """update analysis_jobs
                  set status = case when cancel_requested then 'cancelled'::job_status else 'failed'::job_status end,
                      error_code = case when cancel_requested then null else 'worker_lost' end,
                      error_message = case when cancel_requested then null
                                           else 'Processing stopped unexpectedly and could not be completed.' end,
                      lease_owner = null, lease_expires_at = null,
                      finished_at = now(), usage_settled = true
                where status = 'running' and lease_expires_at < now()
                  and (attempts >= max_attempts or cancel_requested)
                  and usage_settled = false
            returning org_id, usage_period_start"""
        )
        rows = cur.fetchall()
        for row in rows:
            _settle_usage(cur, row["org_id"], row["usage_period_start"], consumed=False)
        return len(rows)


def claim(conn: psycopg.Connection, worker_id: str, lease_seconds: int) -> ClaimedJob | None:
    """Claims the oldest runnable job: queued, or running with an expired lease (crashed worker)."""
    with conn.transaction(), conn.cursor() as cur:
        cur.execute(
            """with next as (
                   select id from analysis_jobs
                    where (status = 'queued' and run_after <= now())
                       or (status = 'running' and lease_expires_at < now()
                           and attempts < max_attempts and not cancel_requested)
                    order by created_at
                    for update skip locked
                    limit 1)
               update analysis_jobs j
                  set status = 'running', lease_owner = %(owner)s,
                      lease_expires_at = now() + make_interval(secs => %(lease)s),
                      heartbeat_at = now(), attempts = j.attempts + 1,
                      started_at = coalesce(j.started_at, now()),
                      stage = null, progress = 0, error_code = null, error_message = null
                 from next where j.id = next.id
            returning j.id, j.kind, j.org_id, j.match_id, j.video_id, j.attempts, j.max_attempts, j.config""",
            {"owner": worker_id, "lease": lease_seconds},
        )
        row = cur.fetchone()
    if not row:
        return None
    return ClaimedJob(
        id=str(row["id"]),
        kind=row["kind"],
        org_id=str(row["org_id"]),
        match_id=str(row["match_id"]),
        video_id=str(row["video_id"]),
        attempts=row["attempts"],
        max_attempts=row["max_attempts"],
        config=row["config"] or {},
    )


def heartbeat(conn: psycopg.Connection, job_id: str, worker_id: str, lease_seconds: int) -> bool | None:
    """Extends the lease. Returns the cancel flag, or None when the lease was lost."""
    if is_remote(conn):
        return conn.request("heartbeat", jobId=job_id)["cancelRequested"]
    with conn.transaction(), conn.cursor() as cur:
        cur.execute(
            """update analysis_jobs
                  set lease_expires_at = now() + make_interval(secs => %s), heartbeat_at = now()
                where id = %s and lease_owner = %s and status = 'running'
            returning cancel_requested""",
            (lease_seconds, job_id, worker_id),
        )
        row = cur.fetchone()
    return None if row is None else bool(row["cancel_requested"])


def report_progress(conn: psycopg.Connection, job_id: str, worker_id: str, stage: str, progress: float) -> bool | None:
    """Records stage/progress. Returns the cancel flag, or None when the lease was lost."""
    if is_remote(conn):
        return conn.request("progress", jobId=job_id, stage=stage, progress=progress)["cancelRequested"]
    with conn.transaction(), conn.cursor() as cur:
        cur.execute(
            """update analysis_jobs set stage = %s, progress = %s
                where id = %s and lease_owner = %s and status = 'running'
            returning cancel_requested""",
            (stage, max(0.0, min(1.0, progress)), job_id, worker_id),
        )
        row = cur.fetchone()
    return None if row is None else bool(row["cancel_requested"])


def _finalize(
    cur: psycopg.Cursor,
    job_id: str,
    worker_id: str,
    status: str,
    *,
    error_code: str | None = None,
    error_message: str | None = None,
    model_versions: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    cur.execute(
        """update analysis_jobs
              set status = %s, error_code = %s, error_message = %s,
                  model_versions = coalesce(%s, model_versions),
                  progress = case when %s = 'succeeded' then 1 else progress end,
                  lease_owner = null, lease_expires_at = null, finished_at = now(), usage_settled = true
            where id = %s and lease_owner = %s and status = 'running'
        returning org_id, usage_period_start""",
        (
            status,
            error_code,
            error_message,
            Jsonb(model_versions) if model_versions is not None else None,
            status,
            job_id,
            worker_id,
        ),
    )
    return cur.fetchone()


def complete(
    conn: psycopg.Connection,
    job_id: str,
    worker_id: str,
    model_versions: dict[str, Any],
    persist_results=None,
) -> bool:
    """Marks the job succeeded and consumes its reservation. `persist_results(cur)` runs in the same
    transaction, so results exist if and only if the job is recorded as succeeded."""
    with conn.transaction(), conn.cursor() as cur:
        row = _finalize(cur, job_id, worker_id, "succeeded", model_versions=model_versions)
        if row is None:
            return False
        if persist_results is not None:
            persist_results(cur)
        _settle_usage(cur, row["org_id"], row["usage_period_start"], consumed=True)
        return True


def fail(
    conn: psycopg.Connection,
    job_id: str,
    worker_id: str,
    code: str,
    user_message: str,
    *,
    retryable: bool,
    attempts: int,
    max_attempts: int,
    on_terminal=None,
    reject_video=False,
) -> str | None:
    """Re-queues a retryable failure with exponential backoff, otherwise fails the job and releases
    its reservation. Returns the resulting status, or None if the lease was already lost."""
    if is_remote(conn):
        return conn.request("fail", jobId=job_id, code=code, retryable=retryable, rejectVideo=reject_video)["status"]
    with conn.transaction(), conn.cursor() as cur:
        if retryable and attempts < max_attempts:
            cur.execute(
                """update analysis_jobs
                      set status = 'queued', lease_owner = null, lease_expires_at = null,
                          run_after = now() + make_interval(secs => %s),
                          error_code = %s, error_message = %s, stage = null, progress = 0
                    where id = %s and lease_owner = %s and status = 'running'
                returning id""",
                (30 * 2 ** (attempts - 1), code, user_message, job_id, worker_id),
            )
            return "queued" if cur.fetchone() else None
        row = _finalize(cur, job_id, worker_id, "failed", error_code=code, error_message=user_message)
        if row is None:
            return None
        if on_terminal is not None:
            on_terminal(cur)
        _settle_usage(cur, row["org_id"], row["usage_period_start"], consumed=False)
        return "failed"


def cancel(conn: psycopg.Connection, job_id: str, worker_id: str) -> bool:
    if is_remote(conn):
        return conn.request("cancel", jobId=job_id)["status"] == "cancelled"
    with conn.transaction(), conn.cursor() as cur:
        row = _finalize(cur, job_id, worker_id, "cancelled")
        if row is None:
            return False
        _settle_usage(cur, row["org_id"], row["usage_period_start"], consumed=False)
        return True
