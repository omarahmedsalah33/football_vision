"""Person detection.

`Detector` is the interface the pipeline depends on. `RFDETRDetector` wraps RF-DETR (Apache-2.0
code and weights; the PML-licensed "plus" models are refused). `SyntheticDetector` replays known
boxes and exists for deterministic tests.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Protocol

import numpy as np

# Apache-2.0 RF-DETR sizes only (see docs/ARCHITECTURE.md, "Detection model licensing").
RFDETR_SIZES = {"nano": "RFDETRNano", "small": "RFDETRSmall", "medium": "RFDETRMedium", "large": "RFDETRLarge"}


class Detector(Protocol):
    #: Recorded with every analysis so results can be traced to the exact model.
    version: str

    def detect(self, image: np.ndarray, time_s: float) -> np.ndarray:
        """Returns N×5 float array [x1, y1, x2, y2, score] of people, in image pixels."""


def nms(boxes: np.ndarray, iou: float = 0.5) -> np.ndarray:
    """Greedy non-maximum suppression on N×5 [x1, y1, x2, y2, score]; returns kept rows."""
    if len(boxes) == 0:
        return boxes
    order = np.argsort(-boxes[:, 4])
    keep: list[int] = []
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1) * (y2 - y1)
    while len(order):
        i = order[0]
        keep.append(int(i))
        rest = order[1:]
        ix1 = np.maximum(x1[i], x1[rest])
        iy1 = np.maximum(y1[i], y1[rest])
        ix2 = np.minimum(x2[i], x2[rest])
        iy2 = np.minimum(y2[i], y2[rest])
        inter = np.clip(ix2 - ix1, 0, None) * np.clip(iy2 - iy1, 0, None)
        overlap = inter / (areas[i] + areas[rest] - inter + 1e-9)
        order = rest[overlap <= iou]
    return boxes[keep]


def tile_grid(width: int, height: int, tile: int, overlap: float) -> list[tuple[int, int, int, int]]:
    """Overlapping square-ish tiles covering the frame: (x0, y0, x1, y1)."""
    if width <= tile and height <= tile:
        return [(0, 0, width, height)]
    step = int(tile * (1 - overlap))
    cols = max(1, math.ceil((width - tile) / step) + 1) if width > tile else 1
    rows = max(1, math.ceil((height - tile) / step) + 1) if height > tile else 1
    out = []
    for r in range(rows):
        for c in range(cols):
            x0 = min(c * step, max(0, width - tile))
            y0 = min(r * step, max(0, height - tile))
            out.append((x0, y0, min(x0 + tile, width), min(y0 + tile, height)))
    return out


class RFDETRDetector:
    """RF-DETR on overlapping tiles, so distant players stay large enough to detect."""

    def __init__(self, size: str = "medium", threshold: float = 0.35, tile: int = 960, overlap: float = 0.2, batch: int = 4):
        if size not in RFDETR_SIZES:
            raise ValueError(f"Unsupported RF-DETR size {size!r}; allowed: {sorted(RFDETR_SIZES)}")
        import rfdetr
        from rfdetr.assets.coco_classes import COCO_CLASSES

        self._model = getattr(rfdetr, RFDETR_SIZES[size])()
        self._person = next(k for k, v in COCO_CLASSES.items() if v == "person")
        self.threshold, self.tile, self.overlap, self.batch = threshold, tile, overlap, batch
        from importlib.metadata import version as pkg_version

        self.version = f"rfdetr-{size}@{pkg_version('rfdetr')}:coco:tile{tile}:thr{threshold}"

    def detect(self, image: np.ndarray, time_s: float) -> np.ndarray:
        from PIL import Image

        h, w = image.shape[:2]
        tiles = tile_grid(w, h, self.tile, self.overlap)
        found: list[np.ndarray] = []
        for i in range(0, len(tiles), self.batch):
            chunk = tiles[i : i + self.batch]
            crops = [Image.fromarray(image[y0:y1, x0:x1]) for x0, y0, x1, y1 in chunk]
            results = self._model.predict(crops, threshold=self.threshold)
            if not isinstance(results, list):
                results = [results]
            for (x0, y0, _, _), det in zip(chunk, results):
                mask = det.class_id == self._person
                if not mask.any():
                    continue
                xyxy = det.xyxy[mask] + np.array([x0, y0, x0, y0])
                found.append(np.hstack([xyxy, det.confidence[mask][:, None]]))
        boxes = np.vstack(found) if found else np.zeros((0, 5))
        return nms(boxes, iou=0.5)


class SyntheticDetector:
    """Replays boxes from a JSON file {"<time_s rounded to 0.01>": [[x1, y1, x2, y2, score], ...]}."""

    version = "synthetic-ground-truth"

    def __init__(self, boxes_file: str):
        self._boxes = {round(float(k), 2): np.asarray(v, dtype=np.float64).reshape(-1, 5) for k, v in json.loads(Path(boxes_file).read_text()).items()}

    def detect(self, image: np.ndarray, time_s: float) -> np.ndarray:
        return self._boxes.get(round(time_s, 2), np.zeros((0, 5)))


def build_detector(cfg: dict) -> Detector:
    kind = cfg.get("kind", "rfdetr")
    if kind == "rfdetr":
        return RFDETRDetector(
            size=cfg.get("size", "medium"),
            threshold=float(cfg.get("threshold", 0.35)),
            tile=int(cfg.get("tile", 960)),
            overlap=float(cfg.get("overlap", 0.2)),
        )
    if kind == "synthetic":
        return SyntheticDetector(cfg["boxes_file"])
    raise ValueError(f"unknown detector kind {kind!r}")
