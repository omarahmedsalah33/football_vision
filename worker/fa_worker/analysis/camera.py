"""Following a moving camera (auto-tracking cameras such as XbotGo or Veo, broadcast footage).

Such cameras pan, tilt and zoom from one spot. For a camera that rotates and zooms about a fixed
point, any two of its images are related by a homography, whatever the depth of the scene. So the
user calibrates one frame (the anchor), and every other frame is placed on the pitch by matching
image features against keyframes whose calibration is already known:

    H(frame → pitch) = H(keyframe → pitch) · H(frame → keyframe)

Keyframes form a bank. Each one records how many matching steps separate it from the anchor
("depth"); a frame is matched to the shallowest keyframe that overlaps it, so when the camera returns
to a view it has seen before, accumulated drift is discarded instead of growing.

Every estimate is checked against the white pitch lines: the pitch model is drawn into the frame and
must land on line pixels. Frames that fail the check, or that can't be matched (cuts to replays or
close-ups), are reported as "not followed" and produce no positions. Nothing is guessed.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

WORK_WIDTH = 960  # frames are matched at this width
MIN_INLIERS = 30
MIN_INLIER_RATIO = 0.3
MIN_LINE_POINTS = 40  # fewer visible line points can't confirm or refute an estimate
MIN_GROUP_POINTS = 15  # per direction (along / across the pitch), see line_agreement
LINE_TOL_PX = 3.0  # at WORK_WIDTH
MIN_AGREEMENT = 0.35  # below this, the estimate is rejected
REFINE_BELOW = 0.92  # refine against the lines when agreement is below this
MAX_UNVERIFIED_RUN = 8  # samples (2 s at 4 fps) followed without any line in view to confirm them
VISIBLE_LINE_PIXELS = 800  # this many line pixels on grass means lines are in view and must be matched
KEYFRAME_OVERLAP = 0.7  # add a keyframe once the view overlaps the current keyframe less than this
KEYFRAME_MIN_INLIERS = 150
MAX_BANK = 400
GOAL_AREA_HALF, PEN_HALF, PEN_DEPTH, GOAL_AREA_DEPTH, CIRCLE_R = 9.16, 20.16, 16.5, 5.5, 9.15


def has_standard_boxes(length: float, width: float, players_per_side: int) -> bool:
    """Mirrors the web app: box markings only exist on full-size 11-a-side pitches."""
    return players_per_side == 11 and length >= 90 and width >= 45


def pitch_model_points(length: float, width: float, boxes: bool, step: float = 0.5) -> np.ndarray:
    """Points along the painted lines of the pitch, in metres: N×3 [x, y, direction], where direction
    is 0 for lines along the pitch, 1 for lines across it and 2 for the centre circle."""
    L, W = length, width
    segs = [((0, 0), (L, 0)), ((0, W), (L, W)), ((0, 0), (0, W)), ((L, 0), (L, W)), ((L / 2, 0), (L / 2, W))]
    if boxes:
        for side in (0, 1):
            x = (lambda d: d) if side == 0 else (lambda d: L - d)
            y1, y2 = W / 2 - PEN_HALF, W / 2 + PEN_HALF
            g1, g2 = W / 2 - GOAL_AREA_HALF, W / 2 + GOAL_AREA_HALF
            segs += [((x(0), y1), (x(PEN_DEPTH), y1)), ((x(PEN_DEPTH), y1), (x(PEN_DEPTH), y2)), ((x(PEN_DEPTH), y2), (x(0), y2))]
            segs += [((x(0), g1), (x(GOAL_AREA_DEPTH), g1)), ((x(GOAL_AREA_DEPTH), g1), (x(GOAL_AREA_DEPTH), g2)), ((x(GOAL_AREA_DEPTH), g2), (x(0), g2))]
    pts = []
    for (ax, ay), (bx, by) in segs:
        n = max(2, int(math.hypot(bx - ax, by - ay) / step))
        direction = 0.0 if abs(by - ay) < 1e-9 else 1.0
        pts.append(np.stack([np.linspace(ax, bx, n), np.linspace(ay, by, n), np.full(n, direction)], axis=1))
    if boxes:
        a = np.linspace(0, 2 * np.pi, int(2 * np.pi * CIRCLE_R / step), endpoint=False)
        pts.append(np.stack([L / 2 + CIRCLE_R * np.cos(a), W / 2 + CIRCLE_R * np.sin(a), np.full(len(a), 2.0)], axis=1))
    return np.vstack(pts)


def apply_h(H: np.ndarray, pts: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Maps N×2 points; returns (N×2 points, N projective w)."""
    homog = np.hstack([pts, np.ones((len(pts), 1))]) @ H.T
    w = homog[:, 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        out = homog[:, :2] / w[:, None]
    return out, w


def plausible(H_img_to_pitch: np.ndarray, pixels: np.ndarray) -> bool:
    """The pixels (ground points in view) must be in front of the camera and the pitch not mirrored.
    Same rule as assertPlausible in web/src/lib/pitch/homography.ts."""
    w = np.hstack([pixels, np.ones((len(pixels), 1))]) @ H_img_to_pitch[2]
    if not (np.all(w > 1e-12) or np.all(w < -1e-12)):
        return False
    return float(np.linalg.det(H_img_to_pitch)) * float(w[0]) > 0


def ground_pixels(shape: tuple[int, int]) -> np.ndarray:
    """Pixels that show the pitch in any sensible football shot: the lower part of the frame."""
    h, w = shape
    return np.array([[w * fx, h * fy] for fx in (0.2, 0.5, 0.8) for fy in (0.65, 0.9)], float)


def to_small(rgb: np.ndarray) -> tuple[np.ndarray, float]:
    """RGB at WORK_WIDTH and the scale factor from video pixels to working pixels."""
    import cv2

    k = WORK_WIDTH / rgb.shape[1]
    return cv2.resize(rgb, (WORK_WIDTH, round(rgb.shape[0] * k)), interpolation=cv2.INTER_AREA), k


def to_gray(rgb: np.ndarray) -> tuple[np.ndarray, float]:
    """Grayscale at WORK_WIDTH and the scale factor from video pixels to working pixels."""
    import cv2

    small, k = to_small(rgb)
    return cv2.cvtColor(small, cv2.COLOR_RGB2GRAY), k


def grass_mask(small_rgb: np.ndarray) -> np.ndarray:
    """Where the pitch surface is: green, saturated enough, with the painted lines inside it filled in."""
    import cv2

    hsv = cv2.cvtColor(small_rgb, cv2.COLOR_RGB2HSV)
    green = cv2.inRange(hsv, (28, 45, 35), (95, 255, 255))
    green = cv2.morphologyEx(green, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    # Close over lines and players' feet, but not over the stands.
    green = cv2.morphologyEx(green, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (17, 17)))
    return green > 0


def line_evidence(gray: np.ndarray, boxes: np.ndarray | None = None, small_rgb: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """(distance to the nearest line-like pixel, mask of where lines can be checked).

    Painted lines are thin and brighter than the grass around them: a morphological top-hat finds
    them under any lighting, floodlights included. Only the grass is used: a crowd is full of small
    bright specks that look like lines. Players are masked out: white shirts are not lines.
    """
    import cv2

    tophat = cv2.morphologyEx(gray, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    lines = (tophat > 22).astype(np.uint8)
    usable = np.ones_like(gray, dtype=np.uint8)
    usable[gray < 12] = 0  # outside the rendered/visible image
    if small_rgb is not None:
        grass = grass_mask(small_rgb)
        usable[~grass] = 0
        lines[~grass] = 0
    if boxes is not None:
        for x1, y1, x2, y2 in boxes[:, :4]:
            pad_x, pad_y = 0.25 * (x2 - x1), 0.1 * (y2 - y1)
            xa, ya = max(0, int(x1 - pad_x)), max(0, int(y1 - pad_y))
            xb, yb = min(gray.shape[1], int(x2 + pad_x) + 1), min(gray.shape[0], int(y2 + pad_y) + 1)
            lines[ya:yb, xa:xb] = 0
            usable[ya:yb, xa:xb] = 0
    dist = cv2.distanceTransform((1 - lines).astype(np.uint8), cv2.DIST_L2, 3)
    return dist, usable.astype(bool)


def _visible(H_img_to_pitch: np.ndarray, model: np.ndarray, shape: tuple[int, int], usable: np.ndarray) -> np.ndarray:
    """Visible model points in image pixels: M×3 [u, v, direction]."""
    try:
        inv = np.linalg.inv(H_img_to_pitch)
    except np.linalg.LinAlgError:
        return np.zeros((0, 3))
    img, w = apply_h(inv, model[:, :2])
    img = np.hstack([img, model[:, 2:3]])
    h, wd = shape
    ok = np.isfinite(img).all(axis=1) & (w > 0) if np.median(w) > 0 else np.isfinite(img).all(axis=1) & (w < 0)
    ok &= (img[:, 0] >= 1) & (img[:, 0] < wd - 1) & (img[:, 1] >= 1) & (img[:, 1] < h - 1)
    img = img[ok]
    keep = usable[img[:, 1].astype(int), img[:, 0].astype(int)]
    return img[keep]


def line_agreement(H_img_to_pitch: np.ndarray, model: np.ndarray, dist: np.ndarray, usable: np.ndarray) -> float | None:
    """Share of the visible pitch-line model that lands on a line in the image (None: too few visible).

    Lines along the pitch and lines across it are scored separately and the lower score counts: a
    placement slid along the touchline still has its touchline points on a line, but not its goal
    lines, halfway line or box fronts.
    """
    pts = _visible(H_img_to_pitch, model, dist.shape, usable)
    if len(pts) < MIN_LINE_POINTS:
        return None
    hit = dist[pts[:, 1].astype(int), pts[:, 0].astype(int)] <= LINE_TOL_PX
    scores = []
    for direction in (0.0, 1.0, 2.0):
        sel = pts[:, 2] == direction
        if sel.sum() >= MIN_GROUP_POINTS:
            scores.append(float(hit[sel].mean()))
    return min(scores) if scores else float(hit.mean())


def refine_with_lines(H_img_to_pitch: np.ndarray, model: np.ndarray, dist: np.ndarray, usable: np.ndarray, cap: float = 8.0) -> np.ndarray | None:
    """Nudges the estimate so the drawn pitch lines sit on the image lines. Returns None when the
    lines don't support a confident correction."""
    from scipy.ndimage import map_coordinates
    from scipy.optimize import least_squares

    pts = _visible(H_img_to_pitch, model, dist.shape, usable)[:, :2]
    if len(pts) < MIN_LINE_POINTS:
        return None
    h, w = dist.shape
    c = np.array([w / 2, h / 2])
    s = max(w, h) / 2
    norm = (pts - c) / s  # well-conditioned parameters

    def correction(p):
        return np.array([[1 + p[0], p[1], p[2]], [p[3], 1 + p[4], p[5]], [p[6], p[7], 1.0]])

    def residuals(p):
        q, _ = apply_h(correction(p), norm)
        q = q * s + c
        d = map_coordinates(dist, [q[:, 1], q[:, 0]], order=1, mode="nearest")
        return np.minimum(d, cap)

    res = least_squares(residuals, np.zeros(8), loss="soft_l1", f_scale=min(2.0, cap / 3), max_nfev=60, x_scale=0.01)
    C = correction(res.x)
    # Back to pixel coordinates: C_px = T⁻¹ C T, with T the normalisation.
    T = np.array([[1 / s, 0, -c[0] / s], [0, 1 / s, -c[1] / s], [0, 0, 1]])
    C_px = np.linalg.inv(T) @ C @ T
    corners = np.array([[0, 0], [w, 0], [w, h], [0, h]], float)
    moved, _ = apply_h(C_px, corners)
    if not np.all(np.isfinite(moved)) or np.max(np.linalg.norm(moved - corners, axis=1)) > 0.05 * w:
        return None
    return H_img_to_pitch @ np.linalg.inv(C_px)


@dataclass(eq=False)  # keyframes are compared by identity
class Keyframe:
    keypoints: np.ndarray  # N×2 working pixels
    descriptors: np.ndarray
    H: np.ndarray  # working pixels → pitch metres
    depth: int
    t: float
    footprint: tuple[float, float, float, float]  # pitch bbox the frame covers (clipped)


@dataclass
class CameraStats:
    frames: int = 0
    followed: int = 0
    lost: int = 0
    rejected_by_lines: int = 0
    refined: int = 0
    unverified: int = 0  # followed, but too few lines in view to check
    agreements: list[float] = field(default_factory=list)

    def summary(self, keyframes: int) -> dict:
        return {
            "mode": "moving",
            "framesSampled": self.frames,
            "followedShare": self.followed / self.frames if self.frames else 0.0,
            "lostFrames": self.lost,
            "rejectedByLines": self.rejected_by_lines,
            "refinedFrames": self.refined,
            "unverifiedFrames": self.unverified,
            "lineAgreementMedian": float(np.median(self.agreements)) if self.agreements else None,
            "keyframes": keyframes,
        }


class CameraFollower:
    """Places each frame of a moving-camera video on the pitch, starting from one calibrated frame."""

    version = "orb-keyframes-lines-v1"

    def __init__(self, anchor_rgb: np.ndarray, H_video_to_pitch: np.ndarray, length: float, width: float, players_per_side: int = 11, anchor_t: float = 0.0, anchor_boxes: np.ndarray | None = None):
        import cv2

        self._cv2 = cv2
        self.length, self.width = length, width
        self._orb = cv2.ORB_create(nfeatures=2500, fastThreshold=12)
        self._matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
        self.model = pitch_model_points(length, width, has_standard_boxes(length, width, players_per_side))
        gray, k = to_gray(anchor_rgb)
        self.k = k
        self.S = np.diag([k, k, 1.0])  # video pixels → working pixels
        H_work = H_video_to_pitch @ np.linalg.inv(self.S)
        kf = self._keyframe(gray, H_work, depth=0, t=anchor_t, boxes=self._scale_boxes(anchor_boxes))
        if kf is None:
            raise ValueError("the calibrated frame has too little texture to follow the camera")
        self.bank: list[Keyframe] = [kf]
        self.current = kf
        self.last_H: np.ndarray | None = H_work
        self.unverified_run = 0
        self.pending = False  # picked up again after a loss, waiting for a second frame to confirm
        self.stats = CameraStats()

    # -- helpers -------------------------------------------------------------------------------
    def _scale_boxes(self, boxes: np.ndarray | None) -> np.ndarray | None:
        if boxes is None or len(boxes) == 0:
            return None
        return boxes[:, :4] * self.k

    def _features(self, gray: np.ndarray, boxes: np.ndarray | None):
        mask = np.full(gray.shape, 255, np.uint8)
        mask[gray < 12] = 0
        if boxes is not None:
            for x1, y1, x2, y2 in boxes:
                mask[max(0, int(y1) - 4) : int(y2) + 4, max(0, int(x1) - 4) : int(x2) + 4] = 0  # players move on their own
        kps, des = self._orb.detectAndCompute(gray, mask)
        if des is None or len(kps) < MIN_INLIERS:
            return None, None
        return np.array([kp.pt for kp in kps], np.float32), des

    def _footprint(self, H: np.ndarray, shape) -> tuple[float, float, float, float]:
        h, w = shape
        corners = np.array([[0, 0], [w, 0], [w, h], [0, h], [w / 2, h / 2]], float)
        p, _ = apply_h(H, corners)
        p = np.clip(np.nan_to_num(p, nan=0.0), [-30, -30], [self.length + 30, self.width + 30])
        return float(p[:, 0].min()), float(p[:, 1].min()), float(p[:, 0].max()), float(p[:, 1].max())

    def _keyframe(self, gray, H, depth, t, boxes) -> Keyframe | None:
        pts, des = self._features(gray, boxes)
        if pts is None:
            return None
        return Keyframe(pts, des, H, depth, t, self._footprint(H, gray.shape))

    def _match(self, pts, des, kf: Keyframe) -> tuple[np.ndarray, int] | None:
        cv2 = self._cv2
        pairs = self._matcher.knnMatch(des, kf.descriptors, k=2)
        good = [m for m, *rest in pairs if rest and m.distance < 0.8 * rest[0].distance]
        if len(good) < MIN_INLIERS:
            return None
        src = pts[[m.queryIdx for m in good]]
        dst = kf.keypoints[[m.trainIdx for m in good]]
        H, inl = cv2.findHomography(src, dst, cv2.RANSAC, 3.0, maxIters=2000, confidence=0.995)
        if H is None or inl is None:
            return None
        n = int(inl.sum())
        if n < MIN_INLIERS or n / len(good) < MIN_INLIER_RATIO:
            return None
        a = H[:2, :2]
        if not (0.2 < abs(np.linalg.det(a)) < 5):  # wild scale change: a false match
            return None
        return H, n

    @staticmethod
    def _overlap(a, b) -> float:
        ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
        iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
        area = lambda r: max(1e-6, (r[2] - r[0]) * (r[3] - r[1]))  # noqa: E731
        return ix * iy / min(area(a), area(b))

    # -- main entry point ----------------------------------------------------------------------
    def update(self, rgb: np.ndarray, t: float, boxes: np.ndarray | None = None) -> np.ndarray | None:
        """Returns this frame's homography (video pixels → pitch metres), or None if not followed."""
        self.stats.frames += 1
        import cv2

        small, _ = to_small(rgb)
        gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
        sboxes = self._scale_boxes(boxes)
        pts, des = self._features(gray, sboxes)
        if pts is None:
            return self._lose()

        # Candidates: the current keyframe, then the shallowest keyframes overlapping the predicted view.
        predicted = self._footprint(self.last_H, gray.shape) if self.last_H is not None else None
        ordered = sorted(self.bank, key=lambda k: (k.depth, -k.t))
        near = [k for k in ordered if predicted is not None and k is not self.current and self._overlap(predicted, k.footprint) > 0.3][:3]
        candidates = [self.current, *near]
        continuing = self.last_H is not None
        found = self._best(pts, des, candidates)
        if found is None:
            # Re-acquire after a cut or a fast swing: try the whole bank, shallowest first.
            found = self._best(pts, des, [k for k in ordered if k not in candidates][:30])
            continuing = False
        if found is None:
            return self._lose()
        kf, H_fk, inliers = found
        H = kf.H @ H_fk

        if not plausible(H, ground_pixels(gray.shape)):
            return self._lose()
        dist, usable = line_evidence(gray, sboxes, small)
        agree = line_agreement(H, self.model, dist, usable)
        if agree is not None and agree < REFINE_BELOW:
            better = refine_with_lines(H, self.model, dist, usable)
            if better is not None and plausible(better, ground_pixels(gray.shape)):
                agree2 = line_agreement(better, self.model, dist, usable)
                if agree2 is not None and agree2 >= agree + 0.02:
                    H, agree = better, agree2
                    self.stats.refined += 1
        if agree is not None and agree < MIN_AGREEMENT:
            self.stats.rejected_by_lines += 1
            return self._lose()
        if agree is None:
            # No pitch line where this placement says lines should be. That's only acceptable when
            # the frame really shows no lines, briefly, and straight after a confirmed frame:
            # picking up after a cut needs lines (repeated adverts can match the wrong place), and
            # lines in view but not where they belong mean the placement is wrong.
            lines_in_view = int(((dist == 0) & usable).sum()) >= VISIBLE_LINE_PIXELS
            if not continuing or lines_in_view or self.unverified_run >= MAX_UNVERIFIED_RUN:
                return self._lose()
            self.unverified_run += 1
            self.stats.unverified += 1
        else:
            self.unverified_run = 0
        if not continuing:
            # First frame back after a loss: keep it as the starting point, but only report
            # positions once the next frame confirms the camera is really where we think.
            self.last_H = H
            self.current = kf
            self.pending = True
            self.stats.lost += 1
            return None
        self.pending = False
        if agree is not None:
            self.stats.agreements.append(agree)
        self.stats.followed += 1
        self.last_H = H

        # New keyframe when the view has moved on, so later frames still overlap a known view.
        if kf is not self.current:
            self.current = kf
        footprint = self._footprint(H, gray.shape)
        moved_on = self._overlap(footprint, kf.footprint) < KEYFRAME_OVERLAP or inliers < KEYFRAME_MIN_INLIERS
        if moved_on and (agree is None or agree >= 0.6):
            new = Keyframe(pts, des, H, kf.depth + 1, t, footprint)
            self.bank.append(new)
            self.current = new
            if len(self.bank) > MAX_BANK:
                # Forget the deepest (least trustworthy) keyframe, never the anchor.
                deepest = max(self.bank[1:], key=lambda k: (k.depth, -k.t))
                self.bank.remove(deepest)
        return H @ self.S

    def _lose(self) -> None:
        """This frame isn't placed, and the next one must find the camera again from scratch."""
        self.stats.lost += 1
        self.last_H = None
        self.pending = False
        self.unverified_run = 0
        return None

    def _best(self, pts, des, candidates: list[Keyframe]):
        best = None
        for kf in candidates:
            m = self._match(pts, des, kf)
            if m is None:
                continue
            H_fk, n = m
            # Prefer shallow keyframes (less drift) unless a deeper one matches far better.
            if best is None or kf.depth < best[0].depth and n >= 0.6 * best[2] or n > 2 * best[2]:
                best = (kf, H_fk, n)
        return best

    def summary(self) -> dict:
        return {**self.stats.summary(len(self.bank)), "method": self.version}


def classify_motion(frames_rgb: list[np.ndarray]) -> str:
    """'fixed' when every pair of consecutive reference frames shows the same view (within a few
    pixels), 'moving' when they show different views, 'unknown' when the frames have too little
    detail to tell. Frames far apart in time are compared, so players have moved away and only the
    static scene can match."""
    import cv2

    if len(frames_rgb) < 2:
        return "unknown"
    orb = cv2.ORB_create(nfeatures=2000)
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    feats, thumbs = [], []
    for rgb in frames_rgb:
        gray, _ = to_gray(rgb)
        kps, des = orb.detectAndCompute(gray, None)
        feats.append((np.array([k.pt for k in kps], np.float32) if kps else np.zeros((0, 2), np.float32), des, gray.shape))
        thumbs.append(cv2.GaussianBlur(cv2.resize(gray, (160, 90), interpolation=cv2.INTER_AREA), (5, 5), 0).astype(np.int16))
    # Most of the picture unchanged between frames: the camera hasn't moved (whatever the players did).
    stable = [float(np.mean(np.abs(a - b) < 8)) >= 0.85 for a, b in zip(thumbs, thumbs[1:])]
    if all(stable):
        return "fixed"
    if any(d is None or len(p) < MIN_INLIERS for p, d, _ in feats):
        return "unknown"
    for (pa, da, shape), (pb, db, _), still in zip(feats, feats[1:], stable):
        if still:
            continue
        pairs = matcher.knnMatch(da, db, k=2)
        good = [m for m, *rest in pairs if rest and m.distance < 0.8 * rest[0].distance]
        if len(good) < MIN_INLIERS:
            return "moving"
        H, inl = cv2.findHomography(pa[[m.queryIdx for m in good]], pb[[m.trainIdx for m in good]], cv2.RANSAC, 3.0)
        if H is None or int(inl.sum()) < MIN_INLIERS:
            return "moving"
        h, w = shape
        corners = np.array([[0, 0], [w, 0], [w, h], [0, h]], float)
        moved, _ = apply_h(H, corners)
        if not np.all(np.isfinite(moved)) or np.max(np.linalg.norm(moved - corners, axis=1)) > 6.0:
            return "moving"
    return "fixed"
