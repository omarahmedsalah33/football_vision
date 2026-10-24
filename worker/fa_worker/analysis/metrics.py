"""Metrics from tracked pitch positions, each with explicit provenance and quality gates.

Coordinate system: x 0..length from the left goal line, y 0..width from the far touchline (metres).
"""

from __future__ import annotations

import math
from collections import defaultdict

import numpy as np

CELL_M = 5.0
MAX_SPEED_MPS = 12.0  # faster than any footballer: such jumps are identity switches, not running
WINDOW_S = 10.0


def min_team_players(players_per_side: int = 11) -> int:
    """A team shape needs most of the team in view: 8 of 11, 4 of 5 (about 70 %, at least 3)."""
    return max(3, math.ceil(0.7 * players_per_side))


def expected_people(players_per_side: int = 11) -> int:
    """Players plus officials a perfect tracker would follow: 22 + 3 on a full pitch, n×2 + 1 in small-sided games."""
    return 2 * players_per_side + (3 if players_per_side == 11 else 1)


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


def frame_shape(team_xy: np.ndarray, defends_left: bool, length: float, players_per_side: int = 11) -> dict | None:
    """Shape of one team in one frame, or None when too few players are visible."""
    if len(team_xy) < min_team_players(players_per_side):
        return None
    depth_from_goal = team_xy[:, 0] if defends_left else length - team_xy[:, 0]
    order = np.argsort(depth_from_goal)
    # With (nearly) the whole team in view, the deepest player is almost always the goalkeeper:
    # leave them out of outfield shape metrics.
    with_keeper = len(team_xy) >= players_per_side - 1
    outfield = team_xy[order[1:]] if with_keeper else team_xy[order]
    outfield_depth = depth_from_goal[order[1:]] if with_keeper else depth_from_goal[order]
    return {
        "width": float(outfield[:, 1].max() - outfield[:, 1].min()),
        "depth": float(outfield[:, 0].max() - outfield[:, 0].min()),
        "line_height": float(np.mean(np.sort(outfield_depth)[:3])),
        "area": _hull_area(outfield),
        "players": int(len(team_xy)),
    }


def team_shape_windows(
    frames: list[tuple[float, dict[str, np.ndarray]]], length: float, window_s: float = WINDOW_S, players_per_side: int = 11
) -> list[dict]:
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
                s = frame_shape(me, defends_left, length, players_per_side)
                if s:
                    shapes.append(s)
            if len(shapes) * 2 >= len(frames_in) and shapes:
                entry[team] = {key: float(np.median([s[key] for s in shapes])) for key in ("width", "depth", "line_height", "area", "players")}
            else:
                entry[team] = None
        out.append(entry)
    return out


# Speed bands used by elite clubs (approximately 19.8 and 25.2 km/h).
HIGH_INTENSITY_MPS = 5.5
SPRINT_MPS = 7.0
SPRINT_MIN_S = 1.0


def physical_profile(samples: list[tuple[float, float, float]], dt: float) -> dict:
    """Running profile of one player from [(t, x, y)] in metres. Estimated: the speeds come from
    tracked foot positions sampled a few times per second, smoothed over about a second."""
    t = np.array([s[0] for s in samples])
    xy = np.array([[s[1], s[2]] for s in samples])
    window = max(3, int(round(1.0 / dt)) | 1)  # odd, about one second
    # Contiguous stretches: a gap longer than a few samples is a disappearance, not running.
    cuts = np.where(np.diff(t) > 2.5 * dt)[0] + 1
    seg_starts = np.concatenate([[0], cuts])
    seg_ends = np.concatenate([cuts, [len(t)]])

    steps, gaps, speeds, times = [], [], [], []
    for a, b in zip(seg_starts, seg_ends):
        if b - a < 3:
            continue
        seg_xy = xy[a:b]
        n_seg = b - a
        k = min(window, n_seg if n_seg % 2 else n_seg - 1)
        kernel = np.ones(k) / k
        pad = k // 2
        padded = np.pad(seg_xy, ((pad, pad), (0, 0)), mode="edge")
        smooth = np.stack([np.convolve(padded[:, i], kernel, mode="valid") for i in range(2)], axis=1)
        seg_t = t[a:b]
        for i in range(1, len(smooth)):
            gap = float(seg_t[i] - seg_t[i - 1])
            step = float(np.linalg.norm(smooth[i] - smooth[i - 1]))
            if gap <= 0 or step > MAX_SPEED_MPS * gap:
                continue
            steps.append(step)
            gaps.append(gap)
            speeds.append(step / gap)
            times.append(float(seg_t[i]))
        steps.append(np.nan)  # segment boundary marker for sprint runs
        gaps.append(0.0)
        speeds.append(0.0)
        times.append(float(seg_t[-1]))

    st, gp, sp = np.array(steps, float), np.array(gaps, float), np.array(speeds, float)
    valid = ~np.isnan(st)
    counted = float(gp[valid].sum())
    distance = float(np.nansum(st))
    hi = float(np.nansum(np.where(sp >= HIGH_INTENSITY_MPS, st, 0.0)))

    sprints, run = 0, 0.0
    for s, g, ok in zip(sp, gp, valid):
        if ok and s >= SPRINT_MPS:
            run += g
        else:
            if run >= SPRINT_MIN_S:
                sprints += 1
            run = 0.0
    if run >= SPRINT_MIN_S:
        sprints += 1

    # Top speed: the fastest one-second average, so a single noisy step can't set it.
    top = 0.0
    n = max(1, int(round(1.0 / dt)))
    for i in range(len(sp) - n + 1):
        if valid[i : i + n].all():
            top = max(top, float(sp[i : i + n].mean()))

    late_vs_early = None
    if counted >= 6 * 60:
        stv, gpv = st[valid], gp[valid]
        cum = np.cumsum(gpv)
        first = cum <= counted / 3
        last = cum > 2 * counted / 3
        early = stv[first].sum() / max(gpv[first].sum(), 1e-6)
        late = stv[last].sum() / max(gpv[last].sum(), 1e-6)
        late_vs_early = float(late / early) if early > 0 else None

    minutes = counted / 60
    return {
        "minutes": minutes,
        "distance_m": distance,
        "distance_per_min": distance / minutes if minutes > 0 else 0.0,
        "hi_distance_m": hi,
        "hi_per_min": hi / minutes if minutes > 0 else 0.0,
        "sprints": sprints,
        "sprints_per_10min": sprints / minutes * 10 if minutes > 0 else 0.0,
        "top_speed_ms": top,
        "late_vs_early": late_vs_early,
    }
