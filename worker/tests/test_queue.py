import threading

import psycopg
from psycopg.rows import dict_row

from fa_worker import queue

from .conftest import job_row, make_job, usage


def expire_lease(conn, job_id):
    with conn.transaction():
        conn.execute(
            "update analysis_jobs set lease_expires_at = now() - interval '1 second' where id = %s", (job_id,)
        )


def drain(conn, worker):
    """Claims everything currently runnable (other tests' jobs included) and returns the ids."""
    ids = []
    while (job := queue.claim(conn, worker, 30)) is not None:
        ids.append(job.id)
    return ids


def test_concurrent_workers_never_claim_the_same_job(conn, database_url):
    created = {str(make_job(conn)["id"]) for _ in range(6)}
    claimed: list[str] = []
    lock = threading.Lock()

    def worker(name):
        with psycopg.connect(database_url, row_factory=dict_row) as c:
            ids = drain(c, name)
            with lock:
                claimed.extend(ids)

    threads = [threading.Thread(target=worker, args=(f"w{i}",)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert created <= set(claimed)
    assert len(claimed) == len(set(claimed)), "a job was claimed twice"


def test_crashed_worker_job_is_reclaimed_and_stale_worker_is_fenced(conn):
    job = make_job(conn)
    drain(conn, "worker-a")  # worker A claims (among others) then "crashes"
    expire_lease(conn, job["id"])

    reclaimed = queue.claim(conn, "worker-b", 30)
    while reclaimed and reclaimed.id != str(job["id"]):
        reclaimed = queue.claim(conn, "worker-b", 30)
    assert reclaimed is not None and reclaimed.attempts == 2

    # Worker A wakes up: every write it attempts is refused.
    assert queue.heartbeat(conn, str(job["id"]), "worker-a", 30) is None
    assert queue.complete(conn, str(job["id"]), "worker-a", {}) is False
    assert queue.fail(conn, str(job["id"]), "worker-a", "x", "y", retryable=False, attempts=1, max_attempts=3) is None
    assert job_row(conn, job["id"])["lease_owner"] == "worker-b"

    assert queue.complete(conn, str(job["id"]), "worker-b", {"pipeline": "t"}) is True
    assert usage(conn, job["org_id"]) == (1, 0)


def test_completion_settles_usage_exactly_once(conn):
    job = make_job(conn)
    drain(conn, "w")
    assert queue.complete(conn, str(job["id"]), "w", {"pipeline": "t"}) is True
    assert queue.complete(conn, str(job["id"]), "w", {"pipeline": "t"}) is False
    assert usage(conn, job["org_id"]) == (1, 0)
    row = job_row(conn, job["id"])
    assert row["status"] == "succeeded" and row["usage_settled"] and row["model_versions"] == {"pipeline": "t"}


def test_retryable_failure_requeues_with_backoff_then_fails_terminally(conn):
    job = make_job(conn, max_attempts=2)
    jid = str(job["id"])
    drain(conn, "w")
    assert queue.fail(conn, jid, "w", "storage_unavailable", "Try later", retryable=True, attempts=1, max_attempts=2) == "queued"
    row = job_row(conn, jid)
    assert row["status"] == "queued" and row["lease_owner"] is None
    assert conn.execute("select run_after > now() as later from analysis_jobs where id = %s", (jid,)).fetchone()["later"]
    assert usage(conn, job["org_id"]) == (0, 1), "reservation is kept while retrying"

    with conn.transaction():
        conn.execute("update analysis_jobs set run_after = now() where id = %s", (jid,))
    drain(conn, "w")
    assert job_row(conn, jid)["attempts"] == 2
    assert queue.fail(conn, jid, "w", "storage_unavailable", "Try later", retryable=True, attempts=2, max_attempts=2) == "failed"
    assert usage(conn, job["org_id"]) == (0, 0), "failed jobs never consume allowance"


def test_reaper_finalizes_exhausted_and_cancelled_abandoned_jobs(conn):
    exhausted = make_job(conn, max_attempts=1)
    cancelled = make_job(conn)
    drain(conn, "ghost")
    with conn.transaction():
        conn.execute("update analysis_jobs set cancel_requested = true where id = %s", (cancelled["id"],))
    expire_lease(conn, exhausted["id"])
    expire_lease(conn, cancelled["id"])

    assert queue.reap_expired(conn) >= 2
    assert job_row(conn, exhausted["id"])["status"] == "failed"
    assert job_row(conn, exhausted["id"])["error_code"] == "worker_lost"
    assert job_row(conn, cancelled["id"])["status"] == "cancelled"
    assert usage(conn, exhausted["org_id"]) == (0, 0)
    assert usage(conn, cancelled["org_id"]) == (0, 0)


def test_heartbeat_reports_cancel_requests(conn):
    job = make_job(conn)
    drain(conn, "w")
    assert queue.heartbeat(conn, str(job["id"]), "w", 30) is False
    with conn.transaction():
        conn.execute("update analysis_jobs set cancel_requested = true where id = %s", (job["id"],))
    assert queue.heartbeat(conn, str(job["id"]), "w", 30) is True
    assert queue.cancel(conn, str(job["id"]), "w") is True
    assert usage(conn, job["org_id"]) == (0, 0)
