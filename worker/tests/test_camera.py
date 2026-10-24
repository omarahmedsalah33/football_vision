"""Moving-camera support, checked against synthetic footage with exact ground truth (see synthetic_camera.py)."""

from __future__ import annotations

import numpy as np
import pytest

pytest.importorskip("cv2", reason="computer-vision extra not installed (pip install -e '.[cv]')")

from fa_worker.analysis import camera as cam  # noqa: E402

from . import synthetic_camera as sc  # noqa: E402

SECONDS = 24.0


@pytest.fixture(scope="module")
def texture():
    return sc.world_texture()


def follow(texture, seconds=SECONDS, cut=None, fps=4):
    target, focal = sc.pan_path(0, seconds)
    H0 = np.linalg.inv(sc.pitch_to_image(target, focal))
    f = cam.CameraFollower(sc.render(texture, target, focal), H0, sc.L, sc.W, 11)
    other = np.random.default_rng(3).integers(0, 255, (sc.IMG_H, sc.IMG_W, 3), dtype=np.uint8)
    out = []
    for i in range(1, int(seconds * fps)):
        t = i / fps
        target, focal = sc.pan_path(t, seconds)
        in_cut = cut is not None and cut[0] <= t < cut[1]
        H = f.update(other if in_cut else sc.render(texture, target, focal), t)
        out.append((t, in_cut, None if H is None else sc.mapping_error_m(H, target, focal)))
    return f, out


def test_follows_a_panning_zooming_camera_to_within_centimetres(texture):
    f, out = follow(texture)
    errors = [e for _, _, e in out]
    assert all(e is not None for e in errors), "every frame of a continuous shot is followed"
    assert np.median(errors) < 0.3, "median position error on the pitch"
    assert np.percentile(errors, 95) < 1.0
    s = f.summary()
    assert s["followedShare"] == 1.0 and s["lineAgreementMedian"] > 0.9
    assert s["keyframes"] < 40, "keyframes are added only when the view moves on"


def test_cuts_produce_no_positions_and_following_resumes(texture):
    f, out = follow(texture, cut=(10.0, 13.0))
    during = [e for t, c, e in out if c]
    after = [e for t, c, e in out if not c and t >= 13.0]
    assert during and all(e is None for e in during), "a replay or close-up is never placed on the pitch"
    assert after[0] is None, "the first frame back waits for the next one to confirm it"
    assert after[1] is not None and after[1] < 2.0, "from the second frame on, the camera is followed again"
    assert np.median([e for e in after if e is not None]) < 0.4
    assert f.summary()["lostFrames"] == len(during) + 1


def test_line_check_rejects_a_wrong_placement(texture):
    target, focal = sc.pan_path(3.0, SECONDS)
    img = sc.render(texture, target, focal)
    gray, k = cam.to_gray(img)
    dist, usable = cam.line_evidence(gray)
    model = cam.pitch_model_points(sc.L, sc.W, True)
    S = np.diag([k, k, 1.0])
    true_H = np.linalg.inv(sc.pitch_to_image(target, focal)) @ np.linalg.inv(S)  # working px → pitch
    shifted = np.array([[1, 0, 3.0], [0, 1, 0], [0, 0, 1]]) @ true_H  # 3 m off along the pitch
    assert cam.line_agreement(true_H, model, dist, usable) > 0.85
    assert cam.line_agreement(shifted, model, dist, usable) < cam.MIN_AGREEMENT


def test_line_refinement_corrects_a_small_drift(texture):
    target, focal = sc.pan_path(5.0, SECONDS)
    img = sc.render(texture, target, focal)
    gray, k = cam.to_gray(img)
    dist, usable = cam.line_evidence(gray)
    model = cam.pitch_model_points(sc.L, sc.W, True)
    S = np.diag([k, k, 1.0])
    true_H = np.linalg.inv(sc.pitch_to_image(target, focal)) @ np.linalg.inv(S)
    drifted = np.array([[1, 0, 0.6], [0, 1, -0.4], [0, 0, 1]]) @ true_H
    refined = cam.refine_with_lines(drifted, model, dist, usable)
    assert refined is not None
    before = sc.mapping_error_m(drifted @ S, target, focal)
    after = sc.mapping_error_m(refined @ S, target, focal)
    assert after < before / 2 and after < 0.3


def test_classifies_fixed_and_moving_cameras(texture):
    target, focal = sc.pan_path(0, SECONDS)
    still = sc.render(texture, target, focal)
    rng = np.random.default_rng(1)
    fixed_frames = []
    for _ in range(4):  # same view; small players moving around
        f = still.copy()
        for _ in range(20):
            x, y = int(rng.integers(0, sc.IMG_W - 20)), int(rng.integers(200, sc.IMG_H - 40))
            f[y : y + 36, x : x + 14] = rng.integers(0, 255, 3)
        fixed_frames.append(f)
    moving_frames = [sc.render(texture, *sc.pan_path(t, SECONDS)) for t in (0, 4, 8, 12)]
    flat = [np.full((sc.IMG_H, sc.IMG_W, 3), v, np.uint8) for v in (60, 120, 180)]
    assert cam.classify_motion(fixed_frames) == "fixed"
    assert cam.classify_motion(moving_frames) == "moving"
    assert cam.classify_motion(flat) == "unknown", "featureless frames can't be judged"


def test_rejects_implausible_placements():
    ground = cam.ground_pixels((sc.IMG_H, sc.IMG_W))
    H = np.linalg.inv(sc.pitch_to_image((52.5, 30), 1100))
    assert cam.plausible(H, ground)
    zoomed = np.linalg.inv(sc.pitch_to_image((8, 34), 2600))  # close-up of one goal: half the pitch is behind the camera
    assert cam.plausible(zoomed, ground)
    mirror = np.array([[-1.0, 0, sc.L], [0, 1, 0], [0, 0, 1]])  # left and right swapped
    assert not cam.plausible(mirror @ H, ground)
    sky = np.array([[sc.IMG_W / 2, 5.0], [sc.IMG_W / 2, sc.IMG_H - 5.0]])
    assert not cam.plausible(H, sky), "a point above the horizon is not on the pitch"
