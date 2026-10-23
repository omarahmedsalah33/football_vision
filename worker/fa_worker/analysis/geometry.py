from __future__ import annotations

import numpy as np

# Detections whose feet land further than this outside the pitch are spectators, substitutes or
# staff on the touchline, and are ignored.
PITCH_MARGIN_M = 3.0


def to_matrix(h: list[float]) -> np.ndarray:
    m = np.asarray(h, dtype=np.float64).reshape(3, 3)
    if not np.all(np.isfinite(m)) or abs(np.linalg.det(m)) < 1e-15:
        raise ValueError("invalid homography")
    return m


def foot_points(xyxy: np.ndarray) -> np.ndarray:
    """Bottom-centre of each box: the point of a standing player that touches the pitch."""
    return np.stack([(xyxy[:, 0] + xyxy[:, 2]) / 2, xyxy[:, 3]], axis=1)


def project(H: np.ndarray, pixels: np.ndarray) -> np.ndarray:
    """Maps N×2 image pixels to N×2 pitch metres."""
    if len(pixels) == 0:
        return np.zeros((0, 2))
    homog = np.hstack([pixels, np.ones((len(pixels), 1))]) @ H.T
    return homog[:, :2] / homog[:, 2:3]


def on_pitch(points: np.ndarray, length: float, width: float, margin: float = PITCH_MARGIN_M) -> np.ndarray:
    return (
        (points[:, 0] >= -margin)
        & (points[:, 0] <= length + margin)
        & (points[:, 1] >= -margin)
        & (points[:, 1] <= width + margin)
    )
