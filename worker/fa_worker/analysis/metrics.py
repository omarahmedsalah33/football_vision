"""Metrics from tracked pitch positions, each with explicit provenance and quality gates.

Coordinate system: x 0..length from the left goal line, y 0..width from the far touchline (metres).
"""

from __future__ import annotations

import math
from collections import defaultdict

import numpy as np

CELL_M = 5.0
MAX_SPEED_MPS = 12.0  # faster than any footballer: such jumps are identity switches, not running
MIN_TEAM_PLAYERS = 8  # a team shape needs most of the team in view
WINDOW_S = 10.0


def heatmap_shape(length: float, width: float) -> tuple[int, int]:
    return math.ceil(length / CELL_M), math.ceil(width / CELL_M)


def track_summary(samples: list[tuple[float, float, float]], dt: float, length: float, width: float) -> dict:
    """samples: [(t, x, y)] sorted by t for one track."""
    t = np.array([s[0] for s in samples])
    xy = np.array([[s[1], s[2]] for s in samples])
    first, last = float(t[0]), float(t[-1])
    expected = (last - first) / dt + 1
    coverage = float(min(1.0, len(t) / expected)) if expected > 0 else 1.0

    # Light smoothing (3-sample centred mean) reduces box jitter before measuring distance.
    if len(xy) >= 3:
        sm = xy.copy()
        sm[1:-1] = (xy[:-2] + xy[1:-1] + xy[2:]) / 3
    else:
        sm = xy
    dist = 0.0
    counted = 0.0
    for i in range(1, len(sm)):
        gap = t[i] - t[i - 1]
        step = float(np.linalg.norm(sm[i] - sm[i - 1]))
        if gap <= 2.5 * dt and step <= MAX_SPEED_MPS * gap:
            dist += step
            counted += gap
    span = last - first

    nx, ny = heatmap_shape(length, width)
    grid = np.zeros((ny, nx), dtype=int)
    ix = np.clip((xy[:, 0] // CELL_M).astype(int), 0, nx - 1)
    iy = np.clip((xy[:, 1] // CELL_M).astype(int), 0, ny - 1)
    np.add.at(grid, (iy, ix), 1)

    return {
        "first_seconds": first,
        "last_seconds": last,
        "samples": len(t),
        "coverage": coverage,
        "avg_x": float(xy[:, 0].mean()),
        "avg_y": float(xy[:, 1].mean()),
        "distance_m": dist,
        # Share of the track's time span over which distance could be measured.
        "distance_time_share": float(counted / span) if span > 0 else 0.0,
        "heatmap": grid.tolist(),
    }


def _hull_area(points: np.ndarray) -> float:
    pts = sorted(map(tuple, points))
    if len(pts) < 3:
        return 0.0

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    hull = np.array(lower[:-1] + upper[:-1])
    x, y = hull[:, 0], hull[:, 1]
    return float(0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1))))


def frame_shape(team_xy: np.ndarray, defends_left: bool, length: float) -> dict | None:
    """Shape of one team in one frame, or None when too few players are visible."""
    if len(team_xy) < MIN_TEAM_PLAYERS:
        return None
    depth_from_goal = team_xy[:, 0] if defends_left else length - team_xy[:, 0]
    order = np.argsort(depth_from_goal)
    # With (nearly) the whole team in view, the deepest player is almost always the goalkeeper:
    # leave them out of outfield shape metrics.
    outfield = team_xy[order[1:]] if len(team_xy) >= 10 else team_xy[order]
    outfield_depth = depth_from_goal[order[1:]] if len(team_xy) >= 10 else depth_from_goal[order]
    return {
        "width": float(outfield[:, 1].max() - outfield[:, 1].min()),
        "depth": float(outfield[:, 0].max() - outfield[:, 0].min()),
        "line_height": float(np.mean(np.sort(outfield_depth)[:3])),
        "area": _hull_area(outfield),
        "players": int(len(team_xy)),
    }


def team_shape_windows(frames: list[tuple[float, dict[str, np.ndarray]]], length: float, window_s: float = WINDOW_S) -> list[dict]:
    """frames: [(t, {"a": N×2, "b": M×2})]. Returns one entry per window with the median shape of
    each team, or None for a team when fewer than half of the window's frames had enough players."""
    buckets: dict[int, list] = defaultdict(list)
    for t, teams in frames:
        buckets[int(t // window_s)].append(teams)
    out = []
    for k in sorted(buckets):
        frames_in = buckets[k]
        entry = {"start": k * window_s, "end": (k + 1) * window_s, "frames": len(frames_in)}
        for team in ("a", "b"):
            shapes = []
            for teams in frames_in:
                me, them = teams.get(team, np.zeros((0, 2))), teams.get("b" if team == "a" else "a", np.zeros((0, 2)))
                if len(me) == 0:
                    continue
                # The team whose centroid is further left defends the left goal in this frame.
                defends_left = len(them) == 0 or me[:, 0].mean() <= them[:, 0].mean()
                s = frame_shape(me, defends_left, length)
                if s:
                    shapes.append(s)
            if len(shapes) * 2 >= len(frames_in) and shapes:
                entry[team] = {key: float(np.median([s[key] for s in shapes])) for key in ("width", "depth", "line_height", "area", "players")}
            else:
                entry[team] = None
        out.append(entry)
    return out
