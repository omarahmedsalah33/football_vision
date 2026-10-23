"""Multi-object tracking: assigns persistent ids to detections across frames.

Uses ByteTrack from Roboflow's `trackers` package (Apache-2.0, clean-room implementations
benchmarked on SoccerNet among others). BoT-SORT / OC-SORT from the same package can be swapped in
behind the same interface when identity switches need to come down.
"""

from __future__ import annotations

from typing import Protocol

import numpy as np


class Tracker(Protocol):
    version: str

    def update(self, boxes: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Takes N×5 [x1, y1, x2, y2, score]; returns (M×4 boxes, M track ids) for confirmed tracks."""


class ByteTrackTracker:
    def __init__(self, frame_rate: float, lost_seconds: float = 2.0, activation: float = 0.5, high_conf: float = 0.5, min_frames: int = 2):
        import supervision as sv
        import trackers

        self._sv = sv
        lost = max(1, int(round(frame_rate * lost_seconds)))
        self._tracker = trackers.ByteTrackTracker(
            lost_track_buffer=lost,
            frame_rate=frame_rate,
            track_activation_threshold=activation,
            high_conf_det_threshold=high_conf,
            minimum_consecutive_frames=min_frames,
        )
        version = getattr(trackers, "__version__", None)
        if version is None:
            from importlib.metadata import version as pkg_version

            version = pkg_version("trackers")
        self.version = f"bytetrack(trackers {version}):lost{lost_seconds}s:act{activation}:high{high_conf}:min{min_frames}"

    def update(self, boxes: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        dets = self._sv.Detections(
            xyxy=boxes[:, :4].astype(np.float32) if len(boxes) else np.zeros((0, 4), dtype=np.float32),
            confidence=boxes[:, 4].astype(np.float32) if len(boxes) else np.zeros((0,), dtype=np.float32),
            class_id=np.zeros(len(boxes), dtype=int),
        )
        out = self._tracker.update(dets)
        if out.tracker_id is None or len(out) == 0:
            return np.zeros((0, 4)), np.zeros((0,), dtype=int)
        confirmed = out.tracker_id != -1
        return out.xyxy[confirmed].astype(np.float64), out.tracker_id[confirmed].astype(int)
