"""Retention and clean-up sweeps.

Each sweep deletes the stored object first and records the result second. If the process dies in
between, the next sweep simply deletes again (deleting a missing object is a no-op), so nothing is
ever recorded as purged while its footage still exists.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Protocol

import psycopg

log = logging.getLogger("fa_worker.maintenance")

# Arbitrary constant: only one worker at a time runs the sweeps.
MAINTENANCE_LOCK_ID = 7_310_442
STALE_UPLOAD_HOURS = 24
DELETED_GRACE_DAYS = 7
BATCH = 100


class Purger(Protocol):
    def delete_object(self, key: str) -> None: ...
    def abort_multipart_upload(self, key: str, upload_id: str) -> None: ...


@dataclass
class SweepReport:
    aborted_uploads: int = 0
    purged_videos: int = 0
    purged_matches: int = 0
    purged_orgs: int = 0
    errors: list[str] = field(default_factory=list)


def _fetch(conn: psycopg.Connection, query: str, params: tuple = ()) -> list[dict]:
    with conn.transaction(), conn.cursor() as cur:
        cur.execute(query, params)
        return cur.fetchall()


def abort_stale_uploads(conn, storage: Purger, report: SweepReport) -> None:
    rows = _fetch(
        conn,
        """select id, storage_key, multipart_upload_id from videos
            where status = 'uploading' and created_at < now() - make_interval(hours => %s)
            limit %s""",
        (STALE_UPLOAD_HOURS, BATCH),
    )
    for r in rows:
        try:
            if r["multipart_upload_id"]:
                storage.abort_multipart_upload(r["storage_key"], r["multipart_upload_id"])
            with conn.transaction():
                conn.execute(
                    "update videos set status = 'aborted', multipart_upload_id = null where id = %s and status = 'uploading'",
                    (r["id"],),
                )
            report.aborted_uploads += 1
        except Exception as exc:  # keep sweeping other items
            report.errors.append(f"abort {r['id']}: {type(exc).__name__}")


def _footage_keys(video: dict) -> list[str]:
    """The source video and its reference frames (frames show players, so they are footage too)."""
    return [video["storage_key"], *(f["key"] for f in (video.get("frames") or []) if f.get("key"))]


def _player_photo_keys(conn, where_sql: str, param) -> list[str]:
    rows = _fetch(
        conn,
        f"""select t.crop_key from analysis_tracks t join analysis_jobs j on j.id = t.job_id
             where j.{where_sql} and t.crop_key is not null""",
        (param,),
    )
    return [r["crop_key"] for r in rows]


def _purge_video_object(conn, storage: Purger, video: dict) -> None:
    photos = _player_photo_keys(conn, "video_id = %s", video["id"])
    for key in [*_footage_keys(video), *photos]:
        storage.delete_object(key)
    with conn.transaction():
        conn.execute("update videos set status = 'purged' where id = %s", (video["id"],))
        conn.execute(
            "update analysis_tracks set crop_key = null where job_id in (select id from analysis_jobs where video_id = %s)",
            (video["id"],),
        )


def purge_expired_footage(conn, storage: Purger, report: SweepReport) -> None:
    rows = _fetch(
        conn,
        """select v.id, v.storage_key, v.frames from videos v
            where v.delete_after < now() and v.status in ('uploaded', 'validated')
              and not exists (select 1 from analysis_jobs j
                              where j.video_id = v.id and j.status in ('queued', 'running'))
            limit %s""",
        (BATCH,),
    )
    for r in rows:
        try:
            _purge_video_object(conn, storage, r)
            report.purged_videos += 1
        except Exception as exc:
            report.errors.append(f"purge video {r['id']}: {type(exc).__name__}")


def _delete_stored_objects(conn, storage: Purger, where_sql: str, param) -> None:
    """Deletes every stored object of a match or organisation: footage, frames and analysis tracks."""
    for v in _fetch(
        conn,
        f"select id, storage_key, frames, status, multipart_upload_id from videos where {where_sql} and status not in ('purged', 'aborted', 'rejected')",
        (param,),
    ):
        if v["status"] == "uploading" and v["multipart_upload_id"]:
            storage.abort_multipart_upload(v["storage_key"], v["multipart_upload_id"])
        for key in _footage_keys(v):
            storage.delete_object(key)
    for r in _fetch(conn, f"select tracks_key from analysis_results where {where_sql} and tracks_key is not null", (param,)):
        storage.delete_object(r["tracks_key"])
    for key in _player_photo_keys(conn, where_sql, param):
        storage.delete_object(key)


def purge_deleted_matches(conn, storage: Purger, report: SweepReport) -> None:
    rows = _fetch(
        conn,
        """select m.id from matches m
            where m.deleted_at < now() - make_interval(days => %s)
              and not exists (select 1 from analysis_jobs j where j.match_id = m.id and j.status = 'running')
            limit %s""",
        (DELETED_GRACE_DAYS, BATCH),
    )
    for r in rows:
        try:
            _delete_stored_objects(conn, storage, "match_id = %s", r["id"])
            with conn.transaction():
                conn.execute("delete from matches where id = %s", (r["id"],))  # cascades videos and jobs
            report.purged_matches += 1
        except Exception as exc:
            report.errors.append(f"purge match {r['id']}: {type(exc).__name__}")


def purge_deleted_orgs(conn, storage: Purger, report: SweepReport) -> None:
    rows = _fetch(
        conn,
        """select o.id from organizations o
            where o.deleted_at < now() - make_interval(days => %s)
              and not exists (select 1 from analysis_jobs j where j.org_id = o.id and j.status = 'running')
            limit %s""",
        (DELETED_GRACE_DAYS, BATCH),
    )
    for r in rows:
        try:
            _delete_stored_objects(conn, storage, "org_id = %s", r["id"])
            with conn.transaction():
                conn.execute("delete from organizations where id = %s", (r["id"],))  # cascades everything
            report.purged_orgs += 1
        except Exception as exc:
            report.errors.append(f"purge org {r['id']}: {type(exc).__name__}")


def run_sweeps(conn: psycopg.Connection, storage: Purger) -> SweepReport | None:
    """Runs every sweep once. Returns None if another worker holds the maintenance lock."""
    with conn.transaction(), conn.cursor() as cur:
        cur.execute("select pg_try_advisory_lock(%s) as ok", (MAINTENANCE_LOCK_ID,))
        if not cur.fetchone()["ok"]:
            return None
    report = SweepReport()
    try:
        abort_stale_uploads(conn, storage, report)
        purge_expired_footage(conn, storage, report)
        purge_deleted_matches(conn, storage, report)
        purge_deleted_orgs(conn, storage, report)
    finally:
        with conn.transaction():
            conn.execute("select pg_advisory_unlock(%s)", (MAINTENANCE_LOCK_ID,))
    if report.errors:
        log.warning("maintenance finished with errors: %s", report.errors[:10])
    log.info(
        "maintenance: aborted=%d purged_videos=%d purged_matches=%d purged_orgs=%d",
        report.aborted_uploads,
        report.purged_videos,
        report.purged_matches,
        report.purged_orgs,
    )
    return report
