"""Team assignment from shirt colour.

Colour: the median CIE Lab colour of the torso with grass removed, taken from each player's clearest
sighting: the largest one with the whole body in frame and nobody overlapping (the same kind of
sighting the player's photo is taken from, so the team matches what staff see). Averaging every
sighting mixes in blurry and half-hidden ones, and the largest box is often two players merged.

Grouping, in two steps:

1. Over-cluster the players into up to six colour groups (k-means++, several restarts), so referees,
   goalkeepers and lit/shaded versions of a kit get groups of their own.
2. A team has many players on screen at the same time; referees and goalkeepers are rarely more
   than one or two at once. Groups seldom seen together are "other" (unless their colour is a
   team's colour: over-clustering can split a team). The rest is split into the two teams.

Players far from their team's colour are "other" rather than forced into a team.

Measured on real broadcast footage (Real Madrid v Barcelona highlights):
- 170 hand-labelled tracks across the clip (130 players, 40 referees, goalkeepers, staff, close-ups):
  125 of 130 players assigned a team, 114 of those (91 %) in the right team. The previous method
  (2-means from the two most different colours, every sighting averaged) scored 89 %. Of the 40
  non-players, 27 were put in a team; most are staff and TV close-ups, which the on-pitch filter
  removes in a real analysis.
- One 6-second shot analysed end to end: 17 of 17 photographed players in the right team, the
  referee and goalkeeper "other". The previous method put 17 of 20 tracks in "other", because the
  referee and goalkeeper were the two most different colours and hijacked its starting point.
"""

from __future__ import annotations

import heapq
from collections import defaultdict

import numpy as np

MAX_GROUPS = 6
CLEAREST_SIGHTINGS = 1  # the clearest sighting decides (see the measurements above)
TEAM_GROUP_MIN_AT_ONCE = 2.5  # 90th percentile of members on screen together
OUTLIER_FACTOR = 2.0  # × the team's median distance to its own colour
# In Lab units. Never stricter than this; on real footage players sit well within it, referees and
# goalkeepers well outside.
OUTLIER_FLOOR = 20.0
METHOD = "lab-clearest-overcluster-v3"


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


def sighting_quality(box: np.ndarray, others: np.ndarray, shape: tuple[int, ...]) -> float:
    """How clear a sighting is: its height in pixels when the whole body is in frame and nobody
    overlaps it, otherwise 1 % of that (kept only as a fallback)."""
    h_img, w_img = shape[:2]
    x1, y1, x2, y2 = (float(v) for v in box[:4])
    bw, bh = x2 - x1, y2 - y1
    clear = bh >= 16 and x1 >= 2 and y1 >= 2 and x2 <= w_img - 2 and y2 <= h_img - 2
    for o in others if clear else []:
        ox1, oy1, ox2, oy2 = (float(v) for v in o[:4])
        if (ox1, oy1, ox2, oy2) == (x1, y1, x2, y2):
            continue
        iw = max(0.0, min(x2, ox2) - max(x1, ox1))
        ih = max(0.0, min(y2, oy2) - max(y1, oy1))
        if iw * ih > 0.05 * bw * bh:
            clear = False
            break
    return bh if clear else 0.01 * bh


class SightingBank:
    """Keeps the colour of each player's clearest sightings (see sighting_quality)."""

    def __init__(self, keep: int = 5):
        self.keep = keep
        self._samples: dict[int, list[tuple[float, int, np.ndarray]]] = defaultdict(list)
        self._n = 0

    def wants(self, tid: int, quality: float) -> bool:
        heap = self._samples.get(tid)
        return heap is None or len(heap) < self.keep or quality > heap[0][0]

    def add(self, tid: int, quality: float, colour: np.ndarray) -> None:
        self._n += 1
        heap = self._samples[tid]
        item = (quality, self._n, colour)
        if len(heap) < self.keep:
            heapq.heappush(heap, item)
        elif quality > heap[0][0]:
            heapq.heapreplace(heap, item)

    def samples(self, tids) -> dict[int, list[tuple[float, np.ndarray]]]:
        return {t: [(q, c) for q, _, c in self._samples.get(t, [])] for t in tids}


def _kmeans(x: np.ndarray, k: int, restarts: int = 12) -> tuple[np.ndarray, np.ndarray]:
    """k-means++ with several deterministic restarts; returns the best (centres, labels)."""
    from scipy.cluster.vq import kmeans2

    best = None
    for seed in range(restarts):
        centres, labels = kmeans2(x, k, minit="++", seed=seed)
        inertia = float(((x - centres[labels]) ** 2).sum())
        if best is None or inertia < best[0]:
            best = (inertia, centres, labels)
    return best[1], best[2]


def _at_once(members: list[int], seen: dict[int, list[float]]) -> float:
    """90th percentile of how many of these players are on screen together, over the times any is."""
    counts: dict[float, int] = defaultdict(int)
    for tid in members:
        for t in set(round(v, 2) for v in seen.get(tid, [])):
            counts[t] += 1
    return float(np.percentile(list(counts.values()), 90)) if counts else 0.0


def track_colour(samples: list[tuple[float, np.ndarray]]) -> np.ndarray | None:
    """Colour of the largest sighting(s)."""
    if not samples:
        return None
    best = sorted(samples, key=lambda s: -s[0])[:CLEAREST_SIGHTINGS]
    return np.median(np.stack([c for _, c in best]), axis=0)


def assign_teams(samples: dict[int, list[tuple[float, np.ndarray]]], seen: dict[int, list[float]] | None = None) -> tuple[dict[int, int | None], dict]:
    """samples: {track: [(quality, Lab colour), ...]}; seen: {track: [times on screen]}.
    Returns {track: 0 | 1 | None} and quality facts. None means "other"."""
    colours = {t: c for t, s in samples.items() if (c := track_colour(s)) is not None}
    result: dict[int, int | None] = {t: None for t in samples}
    if len(colours) < 4:
        return result, {"clustered_tracks": len(colours), "separation": None, "method": METHOD}
    ids = list(colours)
    x = np.stack([colours[t] for t in ids])

    # 1. Fine-grained colour groups.
    k = int(min(MAX_GROUPS, max(2, len(ids) // 3)))
    group_centres, groups = _kmeans(x, k)
    # 2. Groups seldom seen together are officials or goalkeepers. Without timing, keep every group.
    team_groups = [g for g in range(k) if np.any(groups == g)]
    if seen:
        crowded = [g for g in team_groups if _at_once([ids[i] for i in np.where(groups == g)[0]], seen) >= TEAM_GROUP_MIN_AT_ONCE]
        if sum(int(np.sum(groups == g)) for g in crowded) >= 4:
            # A small group in a team's colour (over-clustering split the team) still belongs to it.
            near = [
                g
                for g in team_groups
                if g not in crowded and min(np.linalg.norm(group_centres[g] - group_centres[c]) for c in crowded) < OUTLIER_FLOOR
            ]
            team_groups = crowded + near
    in_team = np.isin(groups, team_groups)
    if in_team.sum() < 4:
        return result, {"clustered_tracks": len(ids), "separation": None, "method": METHOD}

    centres, labels = _kmeans(x[in_team], 2)
    member_ids = [t for t, keep in zip(ids, in_team) if keep]
    dist = np.linalg.norm(x[in_team] - centres[labels], axis=1)
    for team in (0, 1):
        sel = labels == team
        if not np.any(sel):
            continue
        limit = max(OUTLIER_FLOOR, OUTLIER_FACTOR * float(np.median(dist[sel])))
        for t, d, keep in zip(member_ids, dist, sel):
            if keep:
                result[t] = team if d <= limit else None
    quality = {
        "clustered_tracks": len(ids),
        "separation": float(np.linalg.norm(centres[0] - centres[1])),
        "colourGroups": k,
        "officialGroups": k - len(team_groups),
        "method": METHOD,
    }
    return result, quality
