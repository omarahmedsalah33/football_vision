"""Synthetic footage from a camera that pans, tilts and zooms from one spot, with exact ground truth.

The world is the pitch plane (metres) with stands around it. A pinhole camera stands on a gantry
beyond the near touchline and follows a known target, so every frame's true pitch↔image mapping is
known and the camera follower's estimate can be checked to the centimetre.
"""

from __future__ import annotations

import numpy as np

L, W = 105.0, 68.0
IMG_W, IMG_H = 1280, 720
PX_PER_M = 10.0
X0, Y0, X1, Y1 = -30.0, -40.0, 135.0, 90.0  # world texture extent in metres
CAMERA = np.array([52.5, W + 22.0, 14.0])  # raised gantry behind the near touchline


def _rng(seed=7):
    return np.random.default_rng(seed)


def world_texture(seed: int = 7) -> np.ndarray:
    """RGB texture of the world plane: stands with a crowd, grass with stripes and grain, white lines."""
    import cv2

    rng = _rng(seed)
    w, h = int((X1 - X0) * PX_PER_M), int((Y1 - Y0) * PX_PER_M)
    tex = np.zeros((h, w, 3), np.uint8)
    # Crowd / stands: coloured speckle, slightly blurred (rich in features, like a real crowd).
    crowd = rng.integers(0, 255, size=(h // 3, w // 3, 3), dtype=np.uint8)
    tex[:] = cv2.resize(crowd, (w, h), interpolation=cv2.INTER_NEAREST)
    tex = cv2.GaussianBlur(tex, (3, 3), 0)

    def px(x, y):
        return int(round((x - X0) * PX_PER_M)), int(round((y - Y0) * PX_PER_M))

    # Grass surround and pitch, with mowing stripes and grain.
    ax, ay = px(-6, -6)
    bx, by = px(L + 6, W + 6)
    grass = np.zeros((by - ay, bx - ax, 3), np.float32)
    grass[:] = (45, 125, 55)
    xs = (np.arange(bx - ax) / PX_PER_M - 6.0)
    stripe = ((xs // 5.25) % 2 == 0)[None, :, None]
    grass = grass + np.where(stripe, 12.0, -6.0)
    grain = cv2.GaussianBlur(rng.normal(0, 14, size=grass.shape[:2]).astype(np.float32), (0, 0), 1.2)
    grass += grain[..., None]
    # Small worn patches: the kind of irregular texture real turf has.
    for _ in range(900):
        cx, cy = rng.integers(0, grass.shape[1]), rng.integers(0, grass.shape[0])
        cv2.circle(grass, (int(cx), int(cy)), int(rng.integers(2, 6)), tuple(float(v) for v in rng.normal(0, 18, 3) + (45, 120, 50)), -1)
    tex[ay:by, ax:bx] = np.clip(grass, 0, 255).astype(np.uint8)

    white = (235, 235, 235)
    thick = 2
    lines = [((0, 0), (L, 0)), ((0, W), (L, W)), ((0, 0), (0, W)), ((L, 0), (L, W)), ((L / 2, 0), (L / 2, W))]
    for side in (0, 1):
        x = (lambda d: d) if side == 0 else (lambda d: L - d)
        for (a, b) in [((0, 13.84), (16.5, 13.84)), ((16.5, 13.84), (16.5, 54.16)), ((16.5, 54.16), (0, 54.16)),
                       ((0, 24.84), (5.5, 24.84)), ((5.5, 24.84), (5.5, 43.16)), ((5.5, 43.16), (0, 43.16))]:
            lines.append(((x(a[0]), a[1]), (x(b[0]), b[1])))
    for (a, b) in lines:
        cv2.line(tex, px(*a), px(*b), white, thick, cv2.LINE_AA)
    cv2.circle(tex, px(L / 2, W / 2), int(9.15 * PX_PER_M), white, thick, cv2.LINE_AA)
    return tex


def camera_matrices(target: tuple[float, float], focal: float):
    """Rotation rows (right, down, forward) and intrinsics for a camera at CAMERA looking at target."""
    fwd = np.array([target[0], target[1], 0.0]) - CAMERA
    fwd /= np.linalg.norm(fwd)
    up = np.array([0.0, 0.0, 1.0])
    right = np.cross(up, fwd)
    right /= np.linalg.norm(right)
    down = np.cross(right, fwd)
    down = -down if down[2] > 0 else down
    R = np.stack([right, down, fwd])
    K = np.array([[focal, 0, IMG_W / 2], [0, focal, IMG_H / 2], [0, 0, 1.0]])
    return R, K


def pitch_to_image(target, focal) -> np.ndarray:
    """Homography: pitch metres (z = 0) → image pixels."""
    R, K = camera_matrices(target, focal)
    A = np.array([[1, 0, -CAMERA[0]], [0, 1, -CAMERA[1]], [0, 0, -CAMERA[2]]], float)
    G = K @ R @ A
    return G / G[2, 2]


def project3d(target, focal, P) -> tuple[float, float]:
    R, K = camera_matrices(target, focal)
    c = R @ (np.asarray(P, float) - CAMERA)
    u = K @ c
    return u[0] / u[2], u[1] / u[2]


def texture_to_world() -> np.ndarray:
    return np.array([[1 / PX_PER_M, 0, X0], [0, 1 / PX_PER_M, Y0], [0, 0, 1.0]])


def render(tex: np.ndarray, target, focal) -> np.ndarray:
    import cv2

    G = pitch_to_image(target, focal) @ texture_to_world()
    return cv2.warpPerspective(tex, G, (IMG_W, IMG_H), flags=cv2.INTER_LINEAR, borderValue=(8, 8, 8))


def pan_path(t: float, seconds: float) -> tuple[tuple[float, float], float]:
    """A camera following play: sweeps right, then back left, zooming in and out."""
    phase = t / seconds
    x = 52.5 + 22 * np.sin(2 * np.pi * phase)
    y = 30 + 5 * np.sin(4 * np.pi * phase)
    focal = 1150 + 250 * np.sin(2 * np.pi * phase + 1.0)
    return (x, y), focal


def mapping_error_m(H_est_img_to_pitch: np.ndarray, target, focal, grid_step: float = 5.0) -> float:
    """Median distance (metres) between estimated and true pitch positions of visible pitch points."""
    G = pitch_to_image(target, focal)
    xs, ys = np.meshgrid(np.arange(0, L + 1e-6, grid_step), np.arange(0, W + 1e-6, grid_step))
    pts = np.stack([xs.ravel(), ys.ravel()], 1)
    img = np.hstack([pts, np.ones((len(pts), 1))]) @ G.T
    img = img[:, :2] / img[:, 2:3]
    vis = (img[:, 0] >= 0) & (img[:, 0] < IMG_W) & (img[:, 1] >= 0) & (img[:, 1] < IMG_H)
    back = np.hstack([img[vis], np.ones((vis.sum(), 1))]) @ H_est_img_to_pitch.T
    back = back[:, :2] / back[:, 2:3]
    return float(np.median(np.linalg.norm(back - pts[vis], axis=1)))
