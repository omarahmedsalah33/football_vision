from fa_worker import maintenance

from .conftest import make_job


class RecordingStorage:
    def __init__(self, fail_on: set[str] | None = None):
        self.deleted: list[str] = []
        self.aborted: list[tuple[str, str]] = []
        self.fail_on = fail_on or set()

    def delete_object(self, key):
        if key in self.fail_on:
            raise RuntimeError("storage down")
        self.deleted.append(key)

    def abort_multipart_upload(self, key, upload_id):
        self.aborted.append((key, upload_id))


def video(conn, video_id):
    return conn.execute("select * from videos where id = %s", (video_id,)).fetchone()


def sweep(conn, storage):
    report = maintenance.run_sweeps(conn, storage)
    assert report is not None
    return report


def test_expired_footage_is_deleted_from_storage_then_marked_purged(conn):
    job = make_job(conn, status="succeeded")
    with conn.transaction():
        conn.execute("update videos set status = 'validated', delete_after = now() - interval '1 day' where id = %s", (job["video_id"],))
    storage = RecordingStorage()
    sweep(conn, storage)
    v = video(conn, job["video_id"])
    assert v["status"] == "purged"
    assert v["storage_key"] in storage.deleted


def test_footage_within_retention_or_being_analysed_is_kept(conn):
    fresh = make_job(conn, status="succeeded")
    busy = make_job(conn)  # queued: analysis in progress
    with conn.transaction():
        conn.execute("update videos set delete_after = now() + interval '5 days' where id = %s", (fresh["video_id"],))
        conn.execute("update videos set delete_after = now() - interval '1 day' where id = %s", (busy["video_id"],))
    storage = RecordingStorage()
    sweep(conn, storage)
    assert video(conn, fresh["video_id"])["status"] == "uploaded"
    assert video(conn, busy["video_id"])["status"] == "uploaded"
    assert video(conn, fresh["video_id"])["storage_key"] not in storage.deleted


def test_a_storage_failure_never_marks_footage_purged(conn):
    job = make_job(conn, status="succeeded")
    with conn.transaction():
        conn.execute("update videos set delete_after = now() - interval '1 day' where id = %s", (job["video_id"],))
    key = video(conn, job["video_id"])["storage_key"]
    report = sweep(conn, RecordingStorage(fail_on={key}))
    assert video(conn, job["video_id"])["status"] == "uploaded"
    assert any("purge video" in e for e in report.errors)
    sweep(conn, RecordingStorage())  # next sweep succeeds
    assert video(conn, job["video_id"])["status"] == "purged"


def test_abandoned_uploads_are_aborted(conn):
    job = make_job(conn, status="cancelled")
    with conn.transaction():
        conn.execute(
            """update videos set status = 'uploading', multipart_upload_id = 'up-1',
                      created_at = now() - interval '2 days' where id = %s""",
            (job["video_id"],),
        )
    storage = RecordingStorage()
    sweep(conn, storage)
    v = video(conn, job["video_id"])
    assert v["status"] == "aborted" and v["multipart_upload_id"] is None
    assert (v["storage_key"], "up-1") in storage.aborted


def test_deleted_matches_are_purged_after_the_grace_period_only(conn):
    old = make_job(conn, status="succeeded")
    recent = make_job(conn, status="succeeded")
    with conn.transaction():
        conn.execute("update matches set deleted_at = now() - interval '8 days' where id = %s", (old["match_id"],))
        conn.execute("update matches set deleted_at = now() - interval '1 day' where id = %s", (recent["match_id"],))
    storage = RecordingStorage()
    sweep(conn, storage)
    assert conn.execute("select 1 from matches where id = %s", (old["match_id"],)).fetchone() is None
    assert video(conn, old["video_id"]) is None  # cascaded
    assert conn.execute("select 1 from matches where id = %s", (recent["match_id"],)).fetchone() is not None
    assert len(storage.deleted) >= 1


def test_deleted_organizations_are_purged_with_all_their_footage(conn):
    job = make_job(conn, status="succeeded")
    key = video(conn, job["video_id"])["storage_key"]
    with conn.transaction():
        conn.execute("update organizations set deleted_at = now() - interval '8 days' where id = %s", (job["org_id"],))
    storage = RecordingStorage()
    sweep(conn, storage)
    assert conn.execute("select 1 from organizations where id = %s", (job["org_id"],)).fetchone() is None
    assert conn.execute("select 1 from analysis_jobs where id = %s", (job["id"],)).fetchone() is None
    assert key in storage.deleted


def test_only_one_worker_runs_maintenance_at_a_time(conn, database_url):
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(database_url, row_factory=dict_row, autocommit=True) as other:
        other.execute("select pg_advisory_lock(%s)", (maintenance.MAINTENANCE_LOCK_ID,))
        assert maintenance.run_sweeps(conn, RecordingStorage()) is None
        other.execute("select pg_advisory_unlock(%s)", (maintenance.MAINTENANCE_LOCK_ID,))
    assert maintenance.run_sweeps(conn, RecordingStorage()) is not None


def _player_photo(conn, job, key):
    with conn.transaction():
        conn.execute(
            """insert into analysis_tracks (job_id, org_id, track_no, team, first_seconds, last_seconds, coverage, heatmap, crop_key)
               values (%s, %s, 1, 'a', 0, 60, 1, '[]', %s)""",
            (job["id"], job["org_id"], key),
        )


def test_player_photos_are_deleted_with_the_footage(conn):
    job = make_job(conn, status="succeeded")
    _player_photo(conn, job, "orgs/x/matches/y/analysis/z/players/1.jpg")
    with conn.transaction():
        conn.execute("update videos set status = 'validated', delete_after = now() - interval '1 day' where id = %s", (job["video_id"],))
    storage = RecordingStorage()
    sweep(conn, storage)
    assert "orgs/x/matches/y/analysis/z/players/1.jpg" in storage.deleted, "photos of people are footage"
    row = conn.execute("select crop_key, metrics from analysis_tracks where job_id = %s", (job["id"],)).fetchone()
    assert row["crop_key"] is None, "the analysis numbers stay; the photo reference goes"


def test_player_photos_are_deleted_when_a_match_is_purged(conn):
    job = make_job(conn, status="succeeded")
    _player_photo(conn, job, "orgs/x/matches/y/analysis/z/players/2.jpg")
    with conn.transaction():
        conn.execute("update matches set deleted_at = now() - interval '8 days' where id = %s", (job["match_id"],))
    storage = RecordingStorage()
    sweep(conn, storage)
    assert "orgs/x/matches/y/analysis/z/players/2.jpg" in storage.deleted
