"""Actual PostgreSQL fencing, retry persistence, usage and retention checks."""
import pytest

from fa_worker import maintenance, queue
from fa_worker.checkpoints import Checkpoints, FIELD
from fa_worker.errors import LeaseLost

from .conftest import job_row, make_job, usage
from .test_checkpoints import MemoryStorage, batch
from .test_pipeline import claim_specific


def saved_job(conn, settings, tmp_path):
    row = make_job(conn, video_status="validated")
    job = claim_specific(conn, settings, row["id"])
    source = conn.execute("select storage_key from videos where id = %s", (job.video_id,)).fetchone()["storage_key"]
    storage = MemoryStorage()
    storage.delete_object = lambda key: storage.objects.pop(key, None)
    saved = Checkpoints(conn, storage, settings, job, source, "a" * 64)
    return job, saved, storage


def test_retry_survives_a_new_claim_and_settles_usage_once(conn, settings, tmp_path):
    job, saved, storage = saved_job(conn, settings, tmp_path)
    batch(tmp_path / "first", saved)
    assert FIELD in job_row(conn, job.id)["config"]
    assert queue.fail(conn, job.id, settings.worker_id, "storage_unavailable", "retry",
                      retryable=True, attempts=job.attempts, max_attempts=job.max_attempts) == "queued"
    maintenance.purge_job_checkpoints(conn, storage, job.id)
    assert storage.objects, "A retryable job retains its private checkpoints"
    with conn.transaction():
        conn.execute("update analysis_jobs set run_after = now() - interval '1 second' where id = %s", (job.id,))
    retry = claim_specific(conn, settings, job.id)
    resumed = Checkpoints(conn, storage, settings, retry, saved.prefix.split("/analysis/")[0] +
                          f"/videos/{retry.video_id}/source", saved.binding)
    assert len(resumed.restore(tmp_path / "retry")) == 1
    assert usage(conn, job.org_id) == (0, 1)
    assert queue.complete(conn, job.id, settings.worker_id, {"test": True})
    assert not queue.complete(conn, job.id, settings.worker_id, {"test": True})
    assert usage(conn, job.org_id) == (1, 0)
    maintenance.purge_job_checkpoints(conn, storage, job.id)
    assert not storage.objects
    assert FIELD not in job_row(conn, job.id)["config"]


@pytest.mark.parametrize("condition", ["expired", "wrong_owner", "cancelled"])
def test_real_database_refuses_unowned_expired_or_cancelled_publication(conn, settings, tmp_path, condition):
    job, saved, storage = saved_job(conn, settings, tmp_path)
    with conn.transaction():
        if condition == "expired":
            conn.execute("update analysis_jobs set lease_expires_at = now() - interval '1 second' where id = %s", (job.id,))
        elif condition == "wrong_owner":
            conn.execute("update analysis_jobs set lease_owner = 'replacement' where id = %s", (job.id,))
        else:
            conn.execute("update analysis_jobs set cancel_requested = true where id = %s", (job.id,))
    with pytest.raises(LeaseLost):
        batch(tmp_path / condition, saved)
    assert not storage.objects
    assert FIELD not in job_row(conn, job.id)["config"]


def test_cancelled_job_deletes_snapshots_and_releases_reservation(conn, settings, tmp_path):
    job, saved, storage = saved_job(conn, settings, tmp_path)
    batch(tmp_path / "first", saved)
    queue.cancel(conn, job.id, settings.worker_id)
    maintenance.purge_job_checkpoints(conn, storage, job.id)
    assert usage(conn, job.org_id) == (0, 0)
    assert not storage.objects and FIELD not in job_row(conn, job.id)["config"]
