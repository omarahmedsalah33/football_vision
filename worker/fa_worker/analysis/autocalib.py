"""Automatic pitch calibration: find where the pitch is in a frame from its white lines.

No learned model: a physical camera (position, the point it looks at, zoom) is searched so that the
pitch-line model, drawn through that camera, lands on the white lines detected on the grass
(camera.line_evidence). Coarse random search, then shrinking local search around the best cameras,
then a least-squares refinement of the full homography against the lines (camera.refine_with_lines).

The result is only used when it is unambiguous: enough lines visible, the drawn model landing on
the lines AND the detected lines explained by the model (both directions), lines along and across
the pitch both matched. Otherwise the user calibrates by hand. Nothing is guessed.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .camera import (
    has_standard_boxes,
    line_agreement,
    line_evidence,
    pitch_model_points,
    plausible,
    refine_with_lines,
    to_small,
)

SIGMA_PX = 3.0
MIN_VISIBLE = 60
CONFIDENT_AGREEMENT = 0.85  # model → lines, worst of along/across (correct fits score 0.95+)
CONFIDENT_EXPLAINED = 0.35  # lines → model: a floor only; players and TV graphics keep it low on real footage
CONFIDENT_UNCERTAINTY_M = 0.75  # 90th percentile position uncertainty over the visible grass
LINE_NOISE_PX = 1.5  # how precisely a line's position is known in the image
MIN_LINE_PIXELS = 600


@dataclass
class AutoCalibration:
    H: np.ndarray  # video pixels → pitch metres
    agreement: float  # share of the visible line model on image lines (worst direction)
    explained: float  # share of detected line pixels near the drawn model
    visible_points: int
    uncertainty_m: float  # 90th percentile of position uncertainty over the visible grass
    confident: bool


def position_uncertainty(H: np.ndarray, model: np.ndarray, dist: np.ndarray, usable: np.ndarray, rng: np.random.Generator) -> float:
    """How precisely the visible lines pin positions down, in metres (90th percentile over grass).

    Lines only constrain the fit across their direction: a view with the halfway line and the centre
    circle but nothing near the camera fits equally well with the near grass stretched or squeezed.
    The 8 homography parameters get a covariance from how the line distances change with each
    (Gauss-Newton, line positions known to LINE_NOISE_PX), propagated to pitch positions of grass pixels.
    """
    from scipy.ndimage import map_coordinates

    h, w = dist.shape
    inv = np.linalg.inv(H)
    P = np.hstack([model[:, :2], np.ones((len(model), 1))]) @ inv.T
    front = P[:, 2] > 0
    uv = P[front, :2] / P[front, 2:3]
    inside = (uv[:, 0] >= 1) & (uv[:, 0] < w - 2) & (uv[:, 1] >= 1) & (uv[:, 1] < h - 2)
    uv = uv[inside]
    on = usable[uv[:, 1].astype(int), uv[:, 0].astype(int)]
    uv = uv[on]
    d0 = map_coordinates(dist, [uv[:, 1], uv[:, 0]], order=1)
    uv = uv[d0 <= 3.0]  # inliers: model points sitting on a detected line
    if len(uv) < MIN_VISIBLE:
        return float("inf")
    c, s = np.array([w / 2, h / 2]), max(w, h) / 2
    norm = (uv - c) / s

    def warp(p, pts):
        C = np.array([[1 + p[0], p[1], p[2]], [p[3], 1 + p[4], p[5]], [p[6], p[7], 1.0]])
        q = np.hstack([pts, np.ones((len(pts), 1))]) @ C.T
        return q[:, :2] / q[:, 2:3] * s + c

    eps = 1e-4
    base = map_coordinates(dist, [uv[:, 1], uv[:, 0]], order=1)
    J = np.zeros((len(uv), 8))
    for i in range(8):
        p = np.zeros(8)
        p[i] = eps
        q = warp(p, norm)
        J[:, i] = (map_coordinates(dist, [q[:, 1], q[:, 0]], order=1) - base) / eps
    cov = LINE_NOISE_PX**2 * np.linalg.pinv(J.T @ J + 1e-9 * np.eye(8))

    ys, xs = np.nonzero(usable)
    pick = rng.choice(len(xs), size=min(300, len(xs)), replace=False)
    grass = np.stack([xs[pick], ys[pick]], axis=1).astype(float)
    gnorm = (grass - c) / s
    T = np.array([[1 / s, 0, -c[0] / s], [0, 1 / s, -c[1] / s], [0, 0, 1]])

    def pitch_of(p):
        C = np.array([[1 + p[0], p[1], p[2]], [p[3], 1 + p[4], p[5]], [p[6], p[7], 1.0]])
        Hp = H @ np.linalg.inv(np.linalg.inv(T) @ C @ T)
        q = np.hstack([grass, np.ones((len(grass), 1))]) @ Hp.T
        return q[:, :2] / q[:, 2:3]

    x0 = pitch_of(np.zeros(8))
    Jp = np.zeros((len(grass), 2, 8))
    for i in range(8):
        p = np.zeros(8)
        p[i] = eps
        Jp[:, :, i] = (pitch_of(p) - x0) / eps
    var = np.einsum("nai,ij,naj->n", Jp, cov, Jp)
    del gnorm
    return float(np.percentile(np.sqrt(np.maximum(var, 0)), 90))


def line_like(dist: np.ndarray, usable: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Keeps only line-shaped marks: long and thin (painted lines, the centre circle), dropping
    compact blobs (players in white, TV graphics). Returns a new (distance, usable) pair."""
    import cv2

    lines = ((dist == 0) & usable).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(lines, connectivity=8)
    keep = np.zeros(n, bool)
    for i in range(1, n):
        w, h, area = stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT], stats[i, cv2.CC_STAT_AREA]
        longest = max(w, h)
        keep[i] = longest >= 100 or (longest >= 25 and area <= 0.4 * w * h)
    clean = keep[labels].astype(np.uint8)
    return cv2.distanceTransform((1 - clean).astype(np.uint8), cv2.DIST_L2, 3), usable


def _homographies(params: np.ndarray, length: float, width: float, img_w: int, img_h: int) -> np.ndarray:
    """params: B×6 [cam_x, cam_y, cam_z, target_x, target_y, focal]. Returns B×3×3 pitch → image."""
    C = params[:, :3]
    T = np.stack([params[:, 3], params[:, 4], np.zeros(len(params))], axis=1)
    f = params[:, 5]
    fwd = T - C
    fwd /= np.linalg.norm(fwd, axis=1, keepdims=True)
    up = np.array([0.0, 0.0, 1.0])
    right = np.cross(up, fwd)
    right /= np.linalg.norm(right, axis=1, keepdims=True) + 1e-12
    down = np.cross(right, fwd)
    flip = down[:, 2] > 0
    down[flip] *= -1
    R = np.stack([right, down, fwd], axis=1)  # B×3×3
    K = np.zeros((len(params), 3, 3))
    K[:, 0, 0] = f
    K[:, 1, 1] = f
    K[:, 0, 2] = img_w / 2
    K[:, 1, 2] = img_h / 2
    K[:, 2, 2] = 1
    A = np.zeros((len(params), 3, 3))
    A[:, 0, 0] = 1
    A[:, 1, 1] = 1
    A[:, 0, 2] = -C[:, 0]
    A[:, 1, 2] = -C[:, 1]
    A[:, 2, 2] = -C[:, 2]
    return K @ R @ A


def _forward_scores(G: np.ndarray, model: np.ndarray, dist: np.ndarray, usable: np.ndarray, sigma: float = SIGMA_PX) -> np.ndarray:
    """How well each candidate's drawn line model lands on detected lines (soft, 0–1)."""
    h, w = dist.shape
    P = np.hstack([model[:, :2], np.ones((len(model), 1))])  # N×3
    proj = np.einsum("bij,nj->bni", G, P)  # B×N×3
    z = proj[:, :, 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        u = proj[:, :, 0] / z
        v = proj[:, :, 1] / z
    inside = (z > 0) & (u >= 0) & (u < w - 1) & (v >= 0) & (v < h - 1)
    ui = np.where(inside, u, 0).astype(int)
    vi = np.where(inside, v, 0).astype(int)
    ok = inside & usable[vi, ui]
    d = dist[vi, ui]
    s = np.where(ok, np.exp(-0.5 * (d / sigma) ** 2), 0.0).sum(axis=1)
    # Lines drawn over the stands or the sky count against the camera: painted lines are on grass.
    n = inside.sum(axis=1)
    return s / np.maximum(n, MIN_VISIBLE)


class PitchDistance:
    """Distance (metres) from any pitch-plane point to the nearest painted line, on a 0.2 m grid."""

    RES = 0.2
    MARGIN = 15.0

    def __init__(self, model: np.ndarray, length: float, width: float):
        import cv2

        self.nx = int((length + 2 * self.MARGIN) / self.RES) + 1
        self.ny = int((width + 2 * self.MARGIN) / self.RES) + 1
        grid = np.ones((self.ny, self.nx), np.uint8)
        dense = model[:, :2]
        ix = ((dense[:, 0] + self.MARGIN) / self.RES).astype(int)
        iy = ((dense[:, 1] + self.MARGIN) / self.RES).astype(int)
        grid[iy, ix] = 0
        self.dist = cv2.distanceTransform(grid, cv2.DIST_L2, 3) * self.RES

    def lookup(self, xy: np.ndarray) -> np.ndarray:
        ix = ((xy[..., 0] + self.MARGIN) / self.RES).astype(int)
        iy = ((xy[..., 1] + self.MARGIN) / self.RES).astype(int)
        out = (ix < 0) | (iy < 0) | (ix >= self.nx) | (iy >= self.ny)
        d = self.dist[np.clip(iy, 0, self.ny - 1), np.clip(ix, 0, self.nx - 1)]
        return np.where(out, 50.0, d)


def _backward_scores(G: np.ndarray, line_px: np.ndarray, field: PitchDistance, sigma_m: float = 0.6) -> np.ndarray:
    """How well each candidate explains the detected line pixels: they should map onto painted lines."""
    Ginv = np.linalg.inv(G)  # B×3×3 image → pitch
    P = np.hstack([line_px, np.ones((len(line_px), 1))])
    q = np.einsum("bij,nj->bni", Ginv, P)
    z = q[:, :, 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        xy = q[:, :, :2] / z[:, :, None]
    # In front of the camera means the same sign of w as the image centre of the pitch.
    front = z * np.sign(np.median(z, axis=1, keepdims=True)) > 0
    d = field.lookup(np.nan_to_num(xy, nan=1e6, posinf=1e6, neginf=-1e6))
    return np.where(front, np.exp(-0.5 * (d / sigma_m) ** 2), 0.0).mean(axis=1)


def _explained(H_img_to_pitch: np.ndarray, model: np.ndarray, dist: np.ndarray, usable: np.ndarray) -> float:
    """Share of detected line pixels on the grass that lie near the drawn model."""
    import cv2

    h, w = dist.shape
    mask = np.zeros((h, w), np.uint8)
    inv = np.linalg.inv(H_img_to_pitch)
    P = np.hstack([model[:, :2], np.ones((len(model), 1))]) @ inv.T
    good = P[:, 2] > 0
    uv = (P[good, :2] / P[good, 2:3]).astype(int)
    inside = (uv[:, 0] >= 0) & (uv[:, 0] < w) & (uv[:, 1] >= 0) & (uv[:, 1] < h)
    mask[uv[inside, 1], uv[inside, 0]] = 1
    near = cv2.distanceTransform((1 - cv2.dilate(mask, np.ones((3, 3), np.uint8))).astype(np.uint8), cv2.DIST_L2, 3)
    lines = (dist == 0) & usable
    if lines.sum() == 0:
        return 0.0
    return float((near[lines] <= 4.0).mean())


def auto_calibrate(rgb: np.ndarray, length: float = 105.0, width: float = 68.0, players_per_side: int = 11, attempts: int = 3) -> AutoCalibration | None:
    """Finds the pitch in one frame: independent searches until one is confident (or the best one).
    Returns None when there isn't enough line evidence to try."""
    best = None
    for seed in range(attempts):
        r = _search(rgb, length, width, players_per_side, seed)
        if r is None:
            return None
        if best is None or (r.confident, r.agreement + 0.25 * r.explained) > (best.confident, best.agreement + 0.25 * best.explained):
            best = r
        if best.confident:
            break
    return best


def _search(rgb: np.ndarray, length: float, width: float, players_per_side: int, seed: int, samples: int = 40_000) -> AutoCalibration | None:
    import cv2

    small, k = to_small(rgb)
    gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
    # Model → lines uses every bright line-like pixel; lines → model only the line-shaped marks,
    # so players in white and TV graphics don't count as unexplained lines.
    dist, usable = line_evidence(gray, None, small)
    clean_dist, _ = line_like(dist, usable)
    if usable.mean() < 0.15 or int(((clean_dist == 0) & usable).sum()) < MIN_LINE_PIXELS:
        return None
    h, w = gray.shape
    boxes = has_standard_boxes(length, width, players_per_side)
    model = pitch_model_points(length, width, boxes, step=1.0)
    rng = np.random.default_rng(seed)
    field = PitchDistance(pitch_model_points(length, width, boxes, step=0.1), length, width)
    ys, xs = np.nonzero((clean_dist == 0) & usable)
    pick = rng.choice(len(xs), size=min(500, len(xs)), replace=False)
    line_px = np.stack([xs[pick], ys[pick]], axis=1).astype(float)

    # Plausible cameras, raised and looking at the pitch: along the near touchline (main cameras),
    # or behind/near the left goal line (auto-tracking cameras on a pole at an end or a corner).
    # Other placements are the same views of a symmetric pitch.
    side_lo, side_hi = np.array([-30, width + 2, 2.0, -5, -5, 0.3 * w]), np.array([length + 30, width + 90, 45.0, length + 5, width + 5, 4.0 * w])
    end_lo, end_hi = np.array([-70, -15, 2.0, -5, -5, 0.3 * w]), np.array([-2, width + 15, 45.0, length + 5, width + 5, 4.0 * w])
    half = samples // 2
    cand = np.vstack([side_lo + rng.random((half, 6)) * (side_hi - side_lo), end_lo + rng.random((samples - half, 6)) * (end_hi - end_lo)])
    cand[:, 5] = 0.3 * w * np.exp(rng.random(samples) * np.log(4.0 / 0.3))  # zoom: log-uniform
    lo, hi = np.minimum(side_lo, end_lo), np.maximum(side_hi, end_hi)

    def score(c, sigma_px, sigma_m):
        # Both ways: the drawn model must land on lines, and the lines must land on the model.
        out = []
        for i in range(0, len(c), 2000):
            G = _homographies(c[i : i + 2000], length, width, w, h)
            out.append(_forward_scores(G, model, dist, usable, sigma_px) * _backward_scores(G, line_px, field, sigma_m))
        return np.concatenate(out)

    # Loose matching first (a wide basin to find the right region), then progressively tighter.
    schedule = [(14.0, 3.0), (10.0, 2.0), (7.0, 1.4), (5.0, 1.0), (4.0, 0.8), (3.0, 0.6), (3.0, 0.6)]
    s = score(cand, *schedule[0])
    top = cand[np.argsort(-s)[:96]]
    span = (hi - lo) * 0.06
    for sig_px, sig_m in schedule[1:]:
        jitter = top[:, None, :] + rng.normal(0, 1, (len(top), 48, 6)) * span
        jitter[:, :, 5] = np.clip(jitter[:, :, 5], 0.2 * w, 6.0 * w)
        pool = np.vstack([top, jitter.reshape(-1, 6)])
        ps = score(pool, sig_px, sig_m)
        top = pool[np.argsort(-ps)[: max(16, len(top) // 2)]]
        span *= 0.6

    best = None
    for cam in top[:10]:
        G = _homographies(cam[None], length, width, w, h)[0]
        try:
            H = np.linalg.inv(G)  # working pixels → pitch
        except np.linalg.LinAlgError:
            continue
        # Fine-tune against the lines: first with a wide reach, then only nearby lines (so a
        # neighbouring line can't pull the fit away).
        for cap in (8.0, 8.0, 8.0, 5.0, 3.0, 3.0, 3.0):
            better = refine_with_lines(H, model, dist, usable, cap=cap)
            if better is None:
                break
            H = better
        agree = line_agreement(H, model, dist, usable)
        if agree is None:
            continue
        explained = _explained(H, model, clean_dist, usable)
        cand_score = agree + 0.25 * explained
        if best is None or cand_score > best[0]:
            best = (cand_score, H, agree, explained)
    if best is None:
        return None
    _, H, agree, explained = best
    S = np.diag([k, k, 1.0])
    H_video = H @ S
    ground = np.array([[w * fx, h * fy] for fx in (0.2, 0.5, 0.8) for fy in (0.65, 0.9)]) / k
    P = np.hstack([model[:, :2], np.ones((len(model), 1))]) @ np.linalg.inv(H).T
    vis = int(((P[:, 2] > 0) & (np.abs(P[:, 0] / P[:, 2] - w / 2) < w / 2) & (np.abs(P[:, 1] / P[:, 2] - h / 2) < h / 2)).sum())
    uncertainty = position_uncertainty(H, model, dist, usable, rng)
    confident = (
        agree >= CONFIDENT_AGREEMENT
        and explained >= CONFIDENT_EXPLAINED
        and vis >= 2 * MIN_VISIBLE
        and uncertainty <= CONFIDENT_UNCERTAINTY_M
        and plausible(H_video, ground)
    )
    return AutoCalibration(
        H=H_video, agreement=float(agree), explained=float(explained), visible_points=vis, uncertainty_m=uncertainty, confident=bool(confident)
    )
