"""Team assignment from shirt colour.

For each track we sample the torso region of its boxes, drop grass-coloured pixels and keep the
median colour in CIE Lab. Tracks are then split into two clusters; tracks far from both clusters
(referees, goalkeepers, unclear sightings) are labelled "other" rather than forced into a team.
"""

from __future__ import annotations

import numpy as np

MIN_SAMPLES_PER_TRACK = 3


def _rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    c = rgb.astype(np.float64) / 255.0
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    xyz = c @ np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]).T
    xyz /= np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 216 / 24389, np.cbrt(xyz), (24389 / 27 * xyz + 16) / 116)
    return np.stack([116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])], axis=1)


def _is_grass(rgb: np.ndarray) -> np.ndarray:
    r, g, b = rgb[:, 0].astype(int), rgb[:, 1].astype(int), rgb[:, 2].astype(int)
    return (g > r + 12) & (g > b + 12)


def shirt_colour(image: np.ndarray, box: np.ndarray) -> np.ndarray | None:
    """Median Lab colour of the torso (upper body, centre strip) without grass pixels."""
    x1, y1, x2, y2 = (int(round(v)) for v in box[:4])
    h, w = y2 - y1, x2 - x1
    if h < 8 or w < 4:
        return None
    ty1, ty2 = y1 + int(0.15 * h), y1 + int(0.5 * h)
    tx1, tx2 = x1 + int(0.2 * w), x2 - int(0.2 * w)
    H, W = image.shape[:2]
    crop = image[max(0, ty1) : min(H, ty2), max(0, tx1) : min(W, tx2)].reshape(-1, 3)
    if len(crop) < 6:
        return None
    crop = crop[~_is_grass(crop)]
    if len(crop) < 4:
        return None
    return np.median(_rgb_to_lab(crop), axis=0)


def _kmeans2(x: np.ndarray, iters: int = 50) -> tuple[np.ndarray, np.ndarray]:
    """Deterministic 2-means: start from the two mutually farthest points."""
    d = np.linalg.norm(x[:, None, :] - x[None, :, :], axis=2)
    i, j = np.unravel_index(np.argmax(d), d.shape)
    centres = np.stack([x[i], x[j]])
    for _ in range(iters):
        labels = np.argmin(np.linalg.norm(x[:, None, :] - centres[None], axis=2), axis=1)
        new = np.stack([x[labels == k].mean(axis=0) if np.any(labels == k) else centres[k] for k in (0, 1)])
        if np.allclose(new, centres):
            break
        centres = new
    return centres, labels


def assign_teams(samples: dict[int, list[np.ndarray]]) -> tuple[dict[int, int | None], dict]:
    """Returns {track_id: 0 | 1 | None} and quality facts. None means "other"."""
    colours = {t: np.median(np.stack(v), axis=0) for t, v in samples.items() if len(v) >= MIN_SAMPLES_PER_TRACK}
    result: dict[int, int | None] = {t: None for t in samples}
    if len(colours) < 4:
        return result, {"clustered_tracks": len(colours), "separation": None}
    ids = list(colours)
    x = np.stack([colours[t] for t in ids])
    centres, labels = _kmeans2(x)
    dist = np.linalg.norm(x - centres[labels], axis=1)
    separation = float(np.linalg.norm(centres[0] - centres[1]))
    # A track belongs to a team only if it is clearly closer to that team's colour than half the
    # distance between the two teams; otherwise (referee, keeper, ambiguous) it is "other".
    limit = max(6.0, 0.45 * separation)
    for t, lab, d in zip(ids, labels, dist):
        result[t] = int(lab) if d <= limit else None
    return result, {"clustered_tracks": len(colours), "separation": separation}
