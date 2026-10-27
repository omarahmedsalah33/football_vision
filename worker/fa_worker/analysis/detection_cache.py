"""Replay cached detections, not tracker objects: retrying preserves chronological tracking.

Only completed batches are announced to the parent. GPU construction is lazy, so a fully cached
analysis can regenerate metrics and player photos without loading the detector at all.
"""
from __future__ import annotations

import gzip
import json
from pathlib import Path

import numpy as np

from ..checkpoints import file_digest

BATCH = 120
MAX_JSON = 32 * 1024 * 1024


class DetectionCache:
    def __init__(self, factory, directory: Path, restored=(), publish=None):
        self.factory, self.directory, self.publish = factory, directory, publish
        self.detector = None
        self.saved_version = None
        self.cached = {}
        self.pending = {}
        self.hits = 0
        for path in restored:
            if not path.name.startswith("detections-"):
                continue
            with gzip.open(path, "rb") as stream:
                data = stream.read(MAX_JSON + 1)
            if len(data) > MAX_JSON:
                raise ValueError("Detection checkpoint too large")
            payload = json.loads(data)
            if payload["format"] != 1 or not isinstance(payload["version"], str):
                raise ValueError("Invalid detection checkpoint")
            if self.saved_version is not None and self.saved_version != payload["version"]:
                raise ValueError("Conflicting detection versions")
            self.saved_version = payload["version"]
            if not isinstance(payload["frames"], dict) or len(payload["frames"]) > BATCH:
                raise ValueError("Invalid detection batch")
            for key, rows in payload["frames"].items():
                if not np.isfinite(float.fromhex(key)):
                    raise ValueError("Invalid detection time")
                boxes = self._boxes(rows)
                if key in self.cached and not np.array_equal(self.cached[key], boxes):
                    raise ValueError("Conflicting detection checkpoints")
                self.cached[key] = boxes

    @staticmethod
    def _boxes(rows):
        boxes = np.asarray(rows, dtype=np.float64)
        if boxes.size == 0:
            return np.zeros((0, 5))
        if boxes.ndim != 2 or boxes.shape[1] != 5 or len(boxes) > 10000 or not np.isfinite(boxes).all():
            raise ValueError("Invalid detection boxes")
        return boxes

    @property
    def version(self):
        if self.saved_version is None:
            self.detector = self.detector or self.factory()
            self.saved_version = self.detector.version
        return self.saved_version

    def detect(self, image, time_s):
        key = float(time_s).hex()
        if key in self.cached:
            self.hits += 1
            return self.cached[key].copy()
        if self.detector is None:
            self.detector = self.factory()
            if self.saved_version is not None and self.saved_version != self.detector.version:
                raise ValueError("Detector version changed during retry")
            self.saved_version = self.detector.version
        boxes = self._boxes(self.detector.detect(image, time_s))
        if self.publish is not None:
            self.cached[key] = boxes.copy()
            self.pending[key] = boxes.tolist()
        if len(self.pending) >= BATCH:
            self.flush()
        return boxes

    def flush(self):
        if not self.pending or self.publish is None:
            return
        self.directory.mkdir(parents=True, exist_ok=True)
        pending = self.directory / "detections.pending"
        with gzip.open(pending, "wt", encoding="utf-8") as stream:
            json.dump({"format": 1, "version": self.version, "frames": self.pending}, stream, allow_nan=False)
        target = self.directory / f"detections-{file_digest(pending)}.json.gz"
        pending.rename(target)
        self.publish(target)
        self.pending = {}
