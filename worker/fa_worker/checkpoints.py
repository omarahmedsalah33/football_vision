"""Private, integrity-checked retry artifacts. Database metadata is registered BEFORE upload.

An interrupted upload is therefore discoverable by cleanup; a missing object is a cache miss,
not permission to trust a partial file. No pickle, model state, or browser-supplied paths.
"""
from __future__ import annotations

import hashlib
import json
import re
import tarfile
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from psycopg.types.json import Jsonb

from .errors import JobFailure, LeaseLost
from .website_api import is_remote

FIELD = "_workerCheckpoints"
MAX_BYTES = 256 * 1024 * 1024
MAX_EXPANDED = 1024 * 1024 * 1024
NAME = re.compile(r"^((?:detections|llm)-[0-9a-f]{64}\.json\.gz|result-[0-9a-f]{64}\.tar\.gz)$")
MEMBER = re.compile(r"^(result\.json|tracks\.jsonl\.gz|crops/[1-9][0-9]*\.jpg)$")

# Bump for incompatible prompts, identity/statistics policies, result schemas or
# dependency semantics. Infrastructure-only edits must not invalidate paid work.
LLM_CHECKPOINT_CONTRACT = "llm-recovery-1"
# Audited pre-contract worker snapshots: identical analysis semantics for the
# same cfg; the only difference between these snapshots was concurrency support.
# Never accept arbitrary historical bindings, or cross job/source/config bounds.
COMPATIBLE_LLM_CODE = (
    "2e4f6263429b6bb0fc07fdae7ba71cd81a2e0ba11a2d61783ae0959df6a78428",
    "3aaa3f4903dae45d7d3615a77d46d5e8b9433e3e23b26b09ab5db8c8bfecb71d",
)


def file_digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def binding(job, video: dict, cfg: dict) -> str:
    if cfg.get("pipelineVersion") == "llm-video-v1" and not cfg.get("playerTracking"):
        return _binding(job, video, cfg, LLM_CHECKPOINT_CONTRACT, format_version=2)
    root = Path(__file__).parent
    code = hashlib.sha256()
    for path in sorted(root.rglob("*.py")):
        code.update(str(path.relative_to(root)).encode())
        code.update(path.read_bytes())
    return _binding(job, video, cfg, code.hexdigest())


def compatible_bindings(job, video: dict, cfg: dict) -> tuple[str, ...]:
    if (cfg.get("pipelineVersion") != "llm-video-v1" or cfg.get("playerTracking")
            or LLM_CHECKPOINT_CONTRACT != "llm-recovery-1"):
        return ()
    return tuple(_binding(job, video, cfg, code) for code in COMPATIBLE_LLM_CODE)


def _binding(job, video, cfg, code, format_version=1):
    packages = {}
    for name in ("av", "numpy", "rfdetr", "supervision", "trackers", "scipy", "opencv-python-headless", "Pillow", "torch"):
        try:
            packages[name] = version(name)
        except PackageNotFoundError:
            packages[name] = None
    value = {
        "format": format_version, "job": job.id, "org": job.org_id, "video": job.video_id,
        "source": video["storage_key"], "bytes": int(video["size_bytes"]),
        "config": cfg, "code": code, "packages": packages,
    }
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()


class Checkpoints:
    def __init__(self, conn, storage, settings, job, source_key: str, fingerprint: str,
                 compatible=()):
        self.conn, self.storage, self.settings, self.job = conn, storage, settings, job
        self.binding = fingerprint
        self.compatible = set(compatible)
        self.prefix = source_key.rsplit("/videos/", 1)[0] + f"/analysis/{job.id}/checkpoints/"
        self.entries = list(job.config.get(FIELD, []))
        self._validate()

    def _validate(self):
        if len(self.entries) > 2048:
            raise JobFailure("checkpoint_invalid", "Saved analysis metadata is invalid.")
        for entry in self.entries:
            if (not isinstance(entry, dict) or not re.fullmatch(r"[0-9a-f]{64}", entry.get("binding", ""))
                    or not NAME.fullmatch(entry.get("name", ""))
                    or entry.get("key") != self.prefix + entry["binding"] + "/" + entry["name"]
                    or not re.fullmatch(r"[0-9a-f]{64}", entry.get("sha256", ""))
                    or type(entry.get("size")) is not int or not 0 < entry["size"] <= MAX_BYTES):
                raise JobFailure("checkpoint_invalid", "Saved analysis metadata is invalid.")

    def publish(self, path: Path):
        if not NAME.fullmatch(path.name):
            raise ValueError("Invalid checkpoint filename")
        digest = file_digest(path)
        if digest not in path.name or not 0 < path.stat().st_size <= MAX_BYTES:
            raise ValueError("Invalid checkpoint file")
        entry = {
            "binding": self.binding, "name": path.name, "sha256": digest,
            "size": path.stat().st_size, "key": self.prefix + self.binding + "/" + path.name,
        }
        entries = [e for e in self.entries if e["key"] != entry["key"]] + [entry]
        if len(entries) > 2048:
            raise JobFailure("checkpoint_limit", "The analysis produced too many saved batches.")
        # Register first, so even an upload interrupted by process death is retained for cleanup.
        if is_remote(self.conn):
            self.conn.request("checkpoints", jobId=self.job.id, entries=entries)
        else:
            self._register(entries)
        self.entries = entries
        self.job.config[FIELD] = entries
        self.storage.put_file(entry["key"], path, "application/gzip")

    def _register(self, entries):
        with self.conn.transaction(), self.conn.cursor() as cur:
            cur.execute(
                """update analysis_jobs set config = jsonb_set(config, '{_workerCheckpoints}', %s)
                     where id = %s and lease_owner = %s and status = 'running'
                       and lease_expires_at > now() and not cancel_requested
                   returning id""",
                (Jsonb(entries), self.job.id, self.settings.worker_id),
            )
            if cur.fetchone() is None:
                raise LeaseLost()

    def restore(self, directory: Path, check=None) -> list[Path]:
        directory.mkdir(parents=True, exist_ok=True)
        restored = []
        entries = [e for e in self.entries if e["binding"] == self.binding or e["binding"] in self.compatible]
        # Prefer a finished result. Older detection batches need not be downloaded in that case.
        entries.sort(key=lambda e: (not e["name"].startswith("result-"), e["binding"] != self.binding))
        for entry in entries:
            if check:
                check()
            target = directory / entry["name"]
            try:
                self.storage.download(entry["key"], target, entry["size"])
            except JobFailure as exc:
                if exc.code == "video_missing":
                    # Registration succeeded, but the previous worker died before its upload.
                    continue
                raise
            if target.stat().st_size != entry["size"] or file_digest(target) != entry["sha256"]:
                target.unlink(missing_ok=True)
                raise JobFailure("checkpoint_invalid", "Saved analysis failed its integrity check.")
            restored.append(target)
            if target.name.startswith("result-"):
                return restored
        return restored


def pack_result(directory: Path, destination: Path) -> Path:
    files = [directory / "result.json", directory / "tracks.jsonl.gz"]
    files += sorted((directory / "crops").glob("*.jpg")) if (directory / "crops").exists() else []
    if sum(p.stat().st_size for p in files) > MAX_EXPANDED:
        raise ValueError("Analysis output exceeds checkpoint limit")
    destination.mkdir(parents=True, exist_ok=True)
    pending = destination / "result.pending"
    with tarfile.open(pending, "w:gz") as archive:
        for path in files:
            name = str(path.relative_to(directory))
            if not MEMBER.fullmatch(name) or path.is_symlink():
                raise ValueError("Invalid analysis output")
            archive.add(path, arcname=name, recursive=False)
    target = destination / f"result-{file_digest(pending)}.tar.gz"
    pending.rename(target)
    return target


def unpack_result(path: Path, directory: Path):
    directory.mkdir(parents=True, exist_ok=True)
    seen, total = set(), 0
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            total += member.size
            if (not member.isfile() or not MEMBER.fullmatch(member.name) or member.name in seen
                    or len(seen) >= 10000 or total > MAX_EXPANDED):
                raise JobFailure("checkpoint_invalid", "Saved analysis contains invalid files.")
            seen.add(member.name)
            target = directory / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, target.open("wb") as output:
                import shutil
                shutil.copyfileobj(source, output)
    if not {"result.json", "tracks.jsonl.gz"} <= seen:
        raise JobFailure("checkpoint_invalid", "Saved analysis is incomplete.")
