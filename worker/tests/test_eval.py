import json

import numpy as np
import pytest

pytest.importorskip("scipy")

from fa_worker.eval.scoring import GtPerson, PredPerson, evaluate  # noqa: E402
from fa_worker.eval.soccertrack import fit_homography, frame_of, stream_gt, to_ours  # noqa: E402


def test_coordinate_conversion_and_frame_ids():
    assert to_ours(-52.5, 34.0) == (0.0, 0.0)  # left goal line, far touchline
    assert to_ours(52.5, -34.0) == (105.0, 68.0)
    assert to_ours(0, 0) == (52.5, 34.0)
    assert frame_of("3000001") == 0 and frame_of("3067650") == 67649


def test_streams_only_people_in_the_window(tmp_path):
    def rec(img, tid, x, y, role="player", team="left", sc="object"):
        return {
            "image_id": img,
            "track_id": tid,
            "supercategory": sc,
            "attributes": {"role": role, "team": team, "jersey": "9"},
            "bbox_image": {"x": 100, "y": 200, "w": 20, "h": 50, "x_center": 110.0, "y_center": 225.0},
            "bbox_pitch": {k: v for k, v in [("x_bottom_middle", x), ("y_bottom_middle", y), ("x_bottom_left", x), ("y_bottom_left", y)]},
        }

    data = {
        "info": {"frame_rate": 25},
        "images": [],
        "annotations": [
            rec("3000001", 1, -10.0, 5.0),
            rec("3000002", 1, -9.9, 5.0),
            rec("3000003", 2, 0.0, 0.0, role="referee", team=None),
            rec("3000002", 9, 0.0, 0.0, sc="pitch"),
            rec("3000099", 1, 0.0, 0.0),
        ],
        "categories": [],
    }
    path = tmp_path / "gsr.json"
    path.write_text(json.dumps(data))
    rows = list(stream_gt(path, 1, 2))
    assert [(f, p.track_id, p.role) for f, p, _ in rows] == [(1, 1, "player"), (2, 2, "referee")]
    f, p, foot = rows[0]
    assert (p.x, p.y) == pytest.approx((42.6, 29.0)) and foot == (110.0, 250.0)


def test_scoring_counts_matches_switches_and_team_accuracy():
    gt = {0.0: [GtPerson(1, "player", "left", 10, 10), GtPerson(2, "player", "right", 50, 30)]}
    gt[0.25] = [GtPerson(1, "player", "left", 10.5, 10), GtPerson(2, "player", "right", 50, 30.5)]
    pred = {
        0.0: [PredPerson(7, "a", 10.4, 10.2), PredPerson(8, "b", 50.3, 30.0), PredPerson(9, "a", 90, 60)],  # 1 false positive
        0.25: [PredPerson(11, "a", 10.6, 10.1)],  # identity switch for gt 1 (7 → 11), gt 2 missed
    }
    s = evaluate(gt, pred, radius=2.0)
    assert s["detectionRecall"] == pytest.approx(3 / 4)
    assert s["detectionPrecision"] == pytest.approx(3 / 4)
    assert s["teamAccuracy"] == 1.0 and s["teamMapping"] == {"a": "left", "b": "right"}
    assert s["idSwitchesPerMinute"] == pytest.approx(1 / (0.25 / 60))
    assert s["localisationErrorM"]["mean"] < 0.5


def test_oracle_homography_recovers_a_known_camera():
    true = np.array([[0.08, 0.01, -5], [0.002, 0.11, -8], [0.0001, 0.0009, 1.0]])
    rng = np.random.default_rng(0)
    px = rng.uniform([0, 200], [3800, 1500], size=(400, 2))
    proj = np.hstack([px, np.ones((400, 1))]) @ true.T
    pitch = proj[:, :2] / proj[:, 2:3] + rng.normal(0, 0.1, size=(400, 2))
    pitch[:10] += 30  # outliers (mislabelled boxes) must not spoil the fit
    H = fit_homography(px, pitch)
    test_px = np.array([[1900.0, 800.0, 1.0]])
    a, b = test_px @ H.T, test_px @ true.T
    assert np.linalg.norm(a[0, :2] / a[0, 2] - b[0, :2] / b[0, 2]) < 0.2
