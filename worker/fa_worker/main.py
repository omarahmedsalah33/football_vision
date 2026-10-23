"""Worker entry point: `python -m fa_worker.main`."""

from __future__ import annotations

import logging
import signal
import sys
import threading
from pathlib import Path

from . import queue
from .config import Settings, load_env_file
from .pipeline import process
from .storage import S3Storage

log = logging.getLogger("fa_worker")


def run(settings: Settings, stop: threading.Event, *, once: bool = False) -> None:
    """Processes jobs until stopped. With `once`, exits as soon as the queue is empty."""
    storage = S3Storage(settings)
    settings.work_dir.mkdir(parents=True, exist_ok=True)
    log.info("worker started", extra={"worker_id": settings.worker_id})
    with queue.connect(settings.database_url) as conn:
        while not stop.is_set():
            try:
                reaped = queue.reap_expired(conn)
                if reaped:
                    log.warning("finalized %d abandoned jobs", reaped)
                job = queue.claim(conn, settings.worker_id, settings.lease_seconds)
            except Exception:
                log.exception("queue unavailable; backing off")
                stop.wait(settings.poll_seconds * 5)
                continue
            if job is None:
                if once:
                    break
                stop.wait(settings.poll_seconds)
                continue
            log.info("claimed job", extra={"job_id": job.id, "attempt": job.attempts})
            process(conn, storage, settings, job)
    log.info("worker stopped")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    stop = threading.Event()

    def shutdown(signum, _frame):
        log.info("signal %s received; finishing current job then exiting", signum)
        stop.set()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    load_env_file(Path(__file__).resolve().parents[1] / ".env")
    run(Settings.from_env(), stop, once="--once" in sys.argv)


if __name__ == "__main__":
    main()
